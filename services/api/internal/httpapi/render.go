package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"

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

// decode reads a JSON body with a size cap and rejects unknown fields, so a
// typo in a client's payload is a 400 and not a silently ignored value.
func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	dec.UseNumber()
	if err := dec.Decode(v); err != nil {
		return domain.BadRequest("malformed request body").WithCause(err)
	}
	return nil
}
