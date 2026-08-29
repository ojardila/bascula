package httpapi

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// maxImportBytes is a season, not a page. A farm's year is on the order of
// 55 000 rows; at the shape below that is a few megabytes of JSON, and the
// ordinary 1 MB body cap that protects every other endpoint would refuse it.
//
// It is still a cap, because the alternative to a large number is no number,
// and no number is how a single request takes a process down.
const maxImportBytes = 64 << 20

// handleImportSeason is §8 phases 3 and 4: the season that is already on a
// handset, moved onto the server WITHOUT changing a single identifier.
//
// Why it exists at all, in one sentence from decisiones.md: "una liquidación
// creada en el servidor reclamaría pesadas que el servidor no tiene". Until
// this has run, settling on the server is settling against half a season.
//
// Three things about this handler and none of them is incidental.
//
// It is the OWNER's, and it is Money. It writes payroll, settlements and the
// ledger of a whole season in one act; an administrator does not get to do
// that, and a weigher is not within a mile of it.
//
// It writes in the request transaction and reconciles inside it. An answer of
// 4xx never commits — that is what tenant.Middleware does — so a reconciliation
// that fails leaves the server byte-for-byte as it was. The handset is not
// touched by any of this, which is the entire safety argument of phase 4:
// "el teléfono no se ha modificado, así que no hay nada que deshacer".
//
// It is idempotent by (farm_id, id) like every other write here, and it reports
// what it skipped rather than what it "merged". The rehearsal of phase 3 is
// meant to be run until it comes out clean.
func (s *Server) handleImportSeason(w http.ResponseWriter, r *http.Request) {
	var in store.SeasonImport
	dec := json.NewDecoder(io.LimitReader(r.Body, maxImportBytes))
	dec.DisallowUnknownFields()
	dec.UseNumber()
	if err := dec.Decode(&in); err != nil {
		writeError(w, r, domain.BadRequest(decodeMessage(err)).WithCause(err))
		return
	}
	if in.DeviceID == "" {
		writeError(w, r, domain.BadRequest(
			"deviceId is required: an import is a named handset's season, not an anonymous file"))
		return
	}
	// A file with no balances is a file with no reconciliation, and an import
	// with no reconciliation is exactly the thing this endpoint exists to
	// refuse. It is not a convenience field.
	if len(in.Balances) == 0 {
		writeError(w, r, domain.BadRequest(
			"balances is required: it is what the import is checked against, to the cent"))
		return
	}

	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	farmID, err := tenant.FarmID(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	p, _ := auth.PrincipalFrom(r.Context())

	report, err := store.ImportSeason(r.Context(), tx, farmID, p.UserID, in, newID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}
