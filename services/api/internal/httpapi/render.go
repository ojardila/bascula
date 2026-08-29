package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// errorBody is the error envelope every failure uses. The client branches on
// `code`; the translation lives in the client, which is why `message` is
// English and never shown to a picker.
type errorBody struct {
	Error struct {
		Code    domain.Code    `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details,omitempty"`
	} `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v != nil {
		if err := json.NewEncoder(w).Encode(v); err != nil {
			slog.Error("write response", "err", err)
		}
	}
}

// writeError renders any error as the contract envelope. Anything that is not
// already a domain error is a 500 with no detail: an internal message is for
// the log, not for the wire.
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	de, ok := domain.AsError(err)
	if !ok {
		switch {
		case errors.Is(err, pgx.ErrNoRows), errors.Is(err, store.NoRows):
			de = domain.NotFound("resource not found")
		case isInvalidTextRepresentation(err):
			// A path or body id that is not a UUID at all. It is not a server
			// fault and it is not worth a distinct code: nothing with that id
			// exists, which is precisely 404. Answering 500 here would also
			// make a scan for malformed ids look like a way to hurt the API.
			de = domain.NotFound("resource not found")
		default:
			slog.ErrorContext(r.Context(), "unhandled error",
				"err", err, "path", r.URL.Path, "method", r.Method)
			de = domain.Internal("unexpected error")
		}
	}
	if de.Status >= 500 {
		slog.ErrorContext(r.Context(), "server error",
			"err", de.Error(), "code", de.Code, "path", r.URL.Path)
	}

	var body errorBody
	body.Error.Code = de.Code
	body.Error.Message = de.Message
	body.Error.Details = de.Details
	writeJSON(w, de.Status, body)
}

// isInvalidTextRepresentation spots Postgres 22P02, which is what a string
// that is not a UUID (or not a date, or not an enum value) produces.
func isInvalidTextRepresentation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "22P02"
}

// decode reads a JSON body with a size cap and rejects unknown fields, so a
// typo in a client's payload is a 400 and not a silently ignored value.
func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	dec.UseNumber()
	if err := dec.Decode(v); err != nil {
		return domain.BadRequest(decodeMessage(err)).WithCause(err)
	}
	return nil
}

// decodeMessage keeps the field name when the decoder knows it. A bare
// "malformed request body" sends a client hunting through its own payload for
// something the server could have named: the one that prompted this was a
// plain `2026-08-25` in localDay, which the contract asks for and time.Time
// refuses.
func decodeMessage(err error) string {
	var ute *json.UnmarshalTypeError
	if errors.As(err, &ute) && ute.Field != "" {
		return fmt.Sprintf("%s: expected %s", ute.Field, ute.Type)
	}
	// Errors a field's own UnmarshalJSON returned already say which field they
	// are about, and say it better than we could from out here.
	var se *json.SyntaxError
	if !errors.As(err, &se) && !errors.Is(err, io.EOF) &&
		!strings.HasPrefix(err.Error(), "json: unknown field") {
		return err.Error()
	}
	if strings.HasPrefix(err.Error(), "json: unknown field") {
		return err.Error()
	}
	return "malformed request body"
}

// decodeOptional is decode for a body that need not be there. A POST whose
// every field is optional must still work with no body at all, which is what
// several clients send today.
func decodeOptional(r *http.Request, v any) error {
	if r.ContentLength == 0 {
		return nil
	}
	return decode(r, v)
}

// createdStatus is the one place the idempotent writes decide between "this is
// new" and "this is the row that was already there". 201 the first time, 200
// on the retry — so a client can tell them apart without the answer to a
// resent payment ever being an error.
func createdStatus(created bool) int {
	if created {
		return http.StatusCreated
	}
	return http.StatusOK
}

// checkFixedScale refuses an optional decimal the column cannot hold exactly.
//
// Every fixed-scale numeric that takes a value from a client goes through this
// or through domain.CheckNumeric. Postgres does not refuse a decimal place a
// numeric(p, s) has no room for — it ROUNDS it, on the way in, and answers 200 —
// so the caller is told their number was accepted and a different one is
// stored. On `quantity` that is somebody's pay; on an area or a sale line it is
// smaller and it is the same bug, and a rule enforced on one field and not its
// four neighbours is a rule nobody can rely on.
//
// Nil is fine: an absent optional field is not a wrong one.
func checkFixedScale(field string, v *float64, precision, scale int) error {
	if v == nil {
		return nil
	}
	return domain.CheckNumericFloat(field, *v, precision, scale)
}
