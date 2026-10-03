package apitest

import (
	"net/http"
	"testing"
)

// The corners of the worker routes the screens rarely reach: a kind nobody
// meant, a second worker with the same document or tag, a malformed range on
// the payables, a note sent the old way, and list paging that is asked for
// too much or nonsense.
func TestWorkerEdges(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de los bordes", 80000)
	rosa := h.createWorker(t, f, "Rosa Cardona", "72000111")

	t.Run("a kind other than persona or equipo is refused", func(t *testing.T) {
		expectStatus(t, "unknown kind", h.do(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
			"name": "Grupo", "kind": "cuadrilla",
		}), http.StatusBadRequest)
	})

	t.Run("the same document twice is a conflict", func(t *testing.T) {
		expectStatus(t, "duplicate document", h.do(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
			"name": "Otra Rosa", "documentType": "CC", "docId": "72000111", "tag": "C999",
		}), http.StatusConflict)
	})

	t.Run("the same tag twice is a conflict, on create and on edit", func(t *testing.T) {
		expectStatus(t, "duplicate tag on create", h.do(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
			"name": "Pedro", "documentType": "CC", "docId": "72000222", "tag": "C72000111",
		}), http.StatusConflict)
		pedro := h.createWorker(t, f, "Pedro Ríos", "72000333")
		expectStatus(t, "duplicate tag on edit", h.do(t, http.MethodPatch, "/v1/workers/"+pedro, f.OwnerToken, map[string]any{
			"tag": "C72000111",
		}), http.StatusConflict)
	})

	t.Run("payables refuse a malformed range and accept a good one", func(t *testing.T) {
		for _, q := range []string{"?from=ayer", "?to=hoy"} {
			expectStatus(t, q, h.do(t, http.MethodGet, "/v1/workers/"+rosa+"/payables"+q, f.OwnerToken, nil), http.StatusBadRequest)
		}
		h.mustDo(t, http.MethodGet, "/v1/workers/"+rosa+"/payables?from=2026-01-01&to=2026-12-31",
			f.OwnerToken, nil, http.StatusOK)
	})

	t.Run("a note can come in the old note field, with a date", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/workers/"+rosa+"/notes", f.OwnerToken, map[string]any{
			"note": "Llegó tarde", "date": "2026-09-30",
		}, http.StatusCreated)
		expectStatus(t, "bad note date", h.do(t, http.MethodPost, "/v1/workers/"+rosa+"/notes", f.OwnerToken, map[string]any{
			"text": "Mal día", "date": "30/09/2026",
		}), http.StatusBadRequest)
		expectStatus(t, "blank note", h.do(t, http.MethodPost, "/v1/workers/"+rosa+"/notes", f.OwnerToken, map[string]any{
			"text": "   ",
		}), http.StatusBadRequest)
	})

	t.Run("list paging ignores nonsense and the legacy includeDeleted works", func(t *testing.T) {
		for _, q := range []string{"?limit=abc&offset=-3", "?limit=0&offset=x", "?limit=100000", "?includeDeleted=true"} {
			h.mustDo(t, http.MethodGet, "/v1/workers"+q, f.OwnerToken, nil, http.StatusOK)
		}
	})
}
