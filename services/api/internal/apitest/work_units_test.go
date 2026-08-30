package apitest

import (
	"net/http"
	"testing"
)

// A farm can retire a unit it stopped using, and rename one it mistyped.
//
// The owner's words were "no hay forma de borrar o editar". Units could be
// created and listed and nothing else, since migration 00004 -- so a farm that
// typed "canata" lived with it, and a unit it stopped using stayed in every
// picker forever.
//
// The asserted property is not that PATCH and DELETE exist. It is that DELETE
// does the right one of two different things, and that the destructive one is
// impossible on a unit any pay record points at.
func TestWorkUnitsCanBeEditedAndRetired(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de las unidades", 80000)

	create := func(code, label string, kg float64) string {
		res := h.mustDo(t, http.MethodPost, "/v1/catalogs/work-units", f.OwnerToken,
			map[string]any{"code": code, "label": label, "kgFactor": kg}, http.StatusOK)
		id, _ := res.Body["id"].(string)
		if id == "" {
			t.Fatalf("no id back from creating %q: %s", code, res.Raw)
		}
		return id
	}

	t.Run("a mistyped code can be corrected", func(t *testing.T) {
		id := create("canata", "Canata", 12.5)
		res := h.mustDo(t, http.MethodPatch, "/v1/catalogs/work-units/"+id, f.OwnerToken,
			map[string]any{"code": "canasta", "label": "Canasta"}, http.StatusOK)
		if res.Body["code"] != "canasta" || res.Body["label"] != "Canasta" {
			t.Fatalf("the correction did not take: %s", res.Raw)
		}
		// The factor was not sent, and a unit's weight is not something to
		// lose by editing its name -- kg_factor is what converts a canasta
		// into kilos, so wiping it silently changes what a picker is paid.
		if res.Body["kgFactor"] != 12.5 {
			t.Fatalf("renaming the unit wiped its factor: %s", res.Raw)
		}
	})

	t.Run("the factor can still be cleared on purpose, by sending null", func(t *testing.T) {
		id := create("jornal", "Jornal", 1)
		res := h.mustDo(t, http.MethodPatch, "/v1/catalogs/work-units/"+id, f.OwnerToken,
			map[string]any{"kgFactor": nil}, http.StatusOK)
		if res.Body["kgFactor"] != nil {
			t.Fatalf("an explicit null did not clear the factor: %s", res.Raw)
		}
	})

	t.Run("a unit nobody used is deleted outright", func(t *testing.T) {
		id := create("bulto", "Bulto", 50)
		res := h.mustDo(t, http.MethodDelete, "/v1/catalogs/work-units/"+id, f.OwnerToken,
			nil, http.StatusOK)
		if res.Body["archived"] != false {
			t.Fatalf("an unused unit was archived instead of deleted: %s", res.Raw)
		}
		list := h.mustDo(t, http.MethodGet, "/v1/catalogs/work-units", f.OwnerToken, nil, http.StatusOK)
		if containsCode(list.Raw, "bulto") {
			t.Fatalf("the deleted unit is still listed: %s", list.Raw)
		}
	})

	t.Run("a unit that pay records point at is retired, never deleted", func(t *testing.T) {
		// The kilo the farm was seeded with is the one its activities use, so
		// it is the unit with history behind it.
		list := h.mustDo(t, http.MethodGet, "/v1/catalogs/work-units", f.OwnerToken, nil, http.StatusOK)
		var kiloID string
		var inUse bool
		for _, raw := range list.Body["items"].([]any) {
			u := raw.(map[string]any)
			if u["code"] == "kg" {
				kiloID, _ = u["id"].(string)
				inUse, _ = u["inUse"].(bool)
			}
		}
		if kiloID == "" {
			t.Fatalf("no kilo in the seeded farm: %s", list.Raw)
		}
		if !inUse {
			t.Fatalf("the seeded kilo reports no use, so this test proves nothing: %s", list.Raw)
		}

		res := h.mustDo(t, http.MethodDelete, "/v1/catalogs/work-units/"+kiloID, f.OwnerToken,
			nil, http.StatusOK)
		if res.Body["archived"] != true {
			t.Fatalf("a unit with history behind it was DELETED: %s", res.Raw)
		}

		// Gone from the pickers...
		after := h.mustDo(t, http.MethodGet, "/v1/catalogs/work-units", f.OwnerToken, nil, http.StatusOK)
		if containsCode(after.Raw, `"code":"kg"`) {
			t.Fatalf("the retired unit is still offered: %s", after.Raw)
		}
		// ...and still there for whatever referenced it. If the row had gone,
		// the activity's unit_id would dangle and a record saying "40" would be
		// 40 of something nobody can name.
		acts := h.mustDo(t, http.MethodGet, "/v1/activities", f.OwnerToken, nil, http.StatusOK)
		if acts.Status != http.StatusOK {
			t.Fatalf("the activities that used it stopped loading: %s", acts.Raw)
		}
	})

	t.Run("the freed code can be used again", func(t *testing.T) {
		// The uniqueness of a code is over live units only: a farm that retired
		// "arroba" and starts using arrobas again must be able to say so, and
		// the old records keep their old row with its own factor -- which is
		// honest, because an arroba that changed size IS a different unit.
		id := create("arroba", "Arroba", 12.5)
		h.mustDo(t, http.MethodDelete, "/v1/catalogs/work-units/"+id, f.OwnerToken, nil, http.StatusOK)
		create("arroba", "Arroba nueva", 11)
	})
}

func containsCode(raw, code string) bool {
	return len(raw) > 0 && len(code) > 0 && indexOf(raw, code) >= 0
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}
