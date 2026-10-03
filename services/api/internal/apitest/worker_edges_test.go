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
		if res := h.do(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
			"name": "Grupo", "kind": "cuadrilla",
		}); res.Status != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d %s", res.Status, res.Raw)
		}
	})

	t.Run("the same document twice is a conflict", func(t *testing.T) {
		if res := h.do(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
			"name": "Otra Rosa", "documentType": "CC", "docId": "72000111", "tag": "C999",
		}); res.Status != http.StatusConflict {
			t.Fatalf("expected 409, got %d %s", res.Status, res.Raw)
		}
	})

	t.Run("the same tag twice is a conflict, on create and on edit", func(t *testing.T) {
		if res := h.do(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
			"name": "Pedro", "documentType": "CC", "docId": "72000222", "tag": "C72000111",
		}); res.Status != http.StatusConflict {
			t.Fatalf("expected 409 on create, got %d %s", res.Status, res.Raw)
		}
		pedro := h.createWorker(t, f, "Pedro Ríos", "72000333")
		if res := h.do(t, http.MethodPatch, "/v1/workers/"+pedro, f.OwnerToken, map[string]any{
			"tag": "C72000111",
		}); res.Status != http.StatusConflict {
			t.Fatalf("expected 409 on edit, got %d %s", res.Status, res.Raw)
		}
	})

	t.Run("payables refuse a malformed range and accept a good one", func(t *testing.T) {
		for _, q := range []string{"?from=ayer", "?to=hoy"} {
			if res := h.do(t, http.MethodGet, "/v1/workers/"+rosa+"/payables"+q, f.OwnerToken, nil); res.Status != http.StatusBadRequest {
				t.Fatalf("%s: expected 400, got %d %s", q, res.Status, res.Raw)
			}
		}
		h.mustDo(t, http.MethodGet, "/v1/workers/"+rosa+"/payables?from=2026-01-01&to=2026-12-31",
			f.OwnerToken, nil, http.StatusOK)
	})

	t.Run("a note can come in the old note field, with a date", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/workers/"+rosa+"/notes", f.OwnerToken, map[string]any{
			"note": "Llegó tarde", "date": "2026-09-30",
		}, http.StatusCreated)
		if res := h.do(t, http.MethodPost, "/v1/workers/"+rosa+"/notes", f.OwnerToken, map[string]any{
			"text": "Mal día", "date": "30/09/2026",
		}); res.Status != http.StatusBadRequest {
			t.Fatalf("expected 400 for a bad date, got %d %s", res.Status, res.Raw)
		}
		if res := h.do(t, http.MethodPost, "/v1/workers/"+rosa+"/notes", f.OwnerToken, map[string]any{
			"text": "   ",
		}); res.Status != http.StatusBadRequest {
			t.Fatalf("expected 400 for a blank note, got %d %s", res.Status, res.Raw)
		}
	})

	t.Run("list paging ignores nonsense and the legacy includeDeleted works", func(t *testing.T) {
		for _, q := range []string{"?limit=abc&offset=-3", "?limit=0&offset=x", "?limit=100000", "?includeDeleted=true"} {
			h.mustDo(t, http.MethodGet, "/v1/workers"+q, f.OwnerToken, nil, http.StatusOK)
		}
	})
}
