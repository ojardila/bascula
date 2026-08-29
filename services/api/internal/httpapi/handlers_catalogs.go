package httpapi

import (
	"net/http"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// The per-farm name catalogues. They resolve the "with an option to add it if
// it is not there" that RSP-001 and RSP-011 ask for, which is exactly why none
// of them is a Postgres enum: a farm inventing a category must not be a
// migration. POST is idempotent by (farm_id, lower(name)) and answers 200 with
// the existing row, so the autocomplete can never produce two of anything.

func (s *Server) handleListCatalog(c store.Catalog) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tx, err := tenant.Tx(r.Context())
		if err != nil {
			writeError(w, r, err)
			return
		}
		items, err := store.ListCatalog(r.Context(), tx, c)
		if err != nil {
			writeError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
	}
}

func (s *Server) handleCreateCatalogItem(c store.Catalog) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := decode(r, &body); err != nil {
			writeError(w, r, err)
			return
		}
		if body.Name == "" {
			writeError(w, r, domain.BadRequest("name is required"))
			return
		}
		if body.ID == "" {
			body.ID = newID()
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
		item, err := store.EnsureCatalogItem(r.Context(), tx, c, farmID, body.ID, body.Name)
		if err != nil {
			writeError(w, r, err)
			return
		}
		// 200, never 201: the caller does not need to know whether it existed,
		// only that this is the row that name means on this farm.
		writeJSON(w, http.StatusOK, item)
	}
}
