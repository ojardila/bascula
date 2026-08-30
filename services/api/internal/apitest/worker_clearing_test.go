package apitest

import (
	"net/http"
	"testing"
)

// A worker's phone number can be removed, not only replaced.
//
// It could not be. `UpdateEmployee` used coalesce on every optional column, so
// a nil *string kept the stored value -- and a nil *string is what BOTH "I did
// not mention this field" and "clear this field" decode to. The console sends
// an explicit null for an emptied box (`endpoints.ts:500`, `body.phone || null`),
// so an owner who typed a wrong number could change it to another number and
// never to nothing.
//
// This is the third instance of one family in a day: `location` on plots got it
// right, `kgFactor` on work units got it wrong, and this was found by grepping
// for the rest, which is what docs/auditorias.md now says to do.
func TestAWorkerFieldCanBeClearedAndNotOnlyReplaced(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del telefono", 80000)

	res := h.mustDo(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
		"name": "Ana", "lastName": "Ruiz", "docId": "123",
		"phone": "3001112233", "address": "Vereda equivocada",
	}, http.StatusCreated)
	id, _ := res.Body["id"].(string)
	if id == "" {
		t.Fatalf("no worker created: %s", res.Raw)
	}

	t.Run("a field nobody mentioned keeps its value", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPatch, "/v1/workers/"+id, f.OwnerToken,
			map[string]any{"name": "Ana María"}, http.StatusOK)
		if res.Body["phone"] != "3001112233" {
			t.Fatalf("renaming the worker lost her phone: %s", res.Raw)
		}
	})

	t.Run("an explicit null clears it", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPatch, "/v1/workers/"+id, f.OwnerToken,
			map[string]any{"phone": nil, "address": nil}, http.StatusOK)
		if res.Body["phone"] != nil {
			t.Fatalf("the wrong phone survived being cleared: %s", res.Raw)
		}
		if res.Body["address"] != nil {
			t.Fatalf("the wrong address survived being cleared: %s", res.Raw)
		}
	})

	t.Run("the farm has the same hole, and it is closed too", func(t *testing.T) {
		// Found by grepping the other PATCH/PUT routes the same day, which is
		// the whole point of the section this was written for. The console
		// sends null for an emptied box here as well (`endpoints.ts:499-502`).
		h.mustDo(t, http.MethodPut, "/v1/farm", f.OwnerToken,
			map[string]any{"phone": "3005556677", "address": "Kilometro 4"}, http.StatusOK)
		res := h.mustDo(t, http.MethodPut, "/v1/farm", f.OwnerToken,
			map[string]any{"phone": nil, "address": nil}, http.StatusOK)
		if res.Body["phone"] != nil {
			t.Fatalf("the farm's wrong phone survived being cleared: %s", res.Raw)
		}
		if res.Body["address"] != nil {
			t.Fatalf("the farm's wrong address survived being cleared: %s", res.Raw)
		}
		// And the timezone is NOT clearable: a settlement week is a local date,
		// so an empty zone moves which day a weighing belongs to.
		res = h.mustDo(t, http.MethodPut, "/v1/farm", f.OwnerToken,
			map[string]any{"timezone": nil}, http.StatusOK)
		if res.Body["timezone"] == nil || res.Body["timezone"] == "" {
			t.Fatalf("the farm lost its timezone: %s", res.Raw)
		}
	})

	t.Run("the name is not clearable, because a worker without one is not a worker", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPatch, "/v1/workers/"+id, f.OwnerToken,
			map[string]any{"name": nil}, http.StatusOK)
		if res.Body["name"] != "Ana María" {
			t.Fatalf("the worker lost her name: %s", res.Raw)
		}
	})
}
