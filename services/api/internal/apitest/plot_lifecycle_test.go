// SPDX-License-Identifier: MIT

package apitest

import (
	"net/http"
	"testing"
)

// A plot from the first form to taken out of service: the same id twice is
// one plot, the name is unique, the shape drawn in the form is stored with it,
// and nothing planted can be orphaned by deleting or deactivating it.
func TestPlotLifecycle(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de los lotes", 80000)
	square := map[string]any{"type": "Polygon", "coordinates": [][][]float64{{
		{-75.6, 5.07}, {-75.599, 5.07}, {-75.599, 5.071}, {-75.6, 5.071}, {-75.6, 5.07},
	}}}

	t.Run("the form's shape is stored with the plot", func(t *testing.T) {
		plotLifecycleShapeStored(t, h, f, square)
	})

	t.Run("sending the same plot twice is one plot", func(t *testing.T) {
		plotLifecycleSameTwiceIsOne(t, h, f)
	})

	t.Run("two plots cannot share a name", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken,
			map[string]any{"name": "Único"}, http.StatusCreated)
		res := h.do(t, http.MethodPost, "/v1/plots", f.OwnerToken, map[string]any{"name": "Único"})
		if res.Status != http.StatusConflict {
			t.Fatalf("a duplicate name was accepted: %d %s", res.Status, res.Raw)
		}
	})

	t.Run("a crop needs a type, in the form and on its own", func(t *testing.T) {
		plotLifecycleCropNeedsType(t, h, f)
	})

	t.Run("a planted plot cannot be deleted or deactivated until its crops go", func(t *testing.T) {
		plotLifecyclePlantedCannotGo(t, h, f)
	})

	t.Run("a status the API does not know is refused", func(t *testing.T) {
		plotLifecycleUnknownStatus(t, h, f)
	})
}

func plotLifecycleShapeStored(t *testing.T, h *harness, f *farmFixture, square map[string]any) {
	res := h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken,
		map[string]any{"name": "Con forma", "boundary": square}, http.StatusCreated)
	if res.Body["boundary"] == nil || res.Body["computedAreaHa"] == nil {
		t.Fatalf("the boundary sent with the form was dropped: %s", res.Raw)
	}
	id := plotLifecycleIDOf(t, res)
	res = h.mustDo(t, http.MethodPatch, "/v1/plots/"+id, f.OwnerToken,
		map[string]any{"name": "Con forma nueva", "boundary": square}, http.StatusOK)
	if res.Body["boundary"] == nil {
		t.Fatalf("the boundary sent with the edit was dropped: %s", res.Raw)
	}
}

func plotLifecycleSameTwiceIsOne(t *testing.T, h *harness, f *farmFixture) {
	first := h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken,
		map[string]any{"name": "Repetido"}, http.StatusCreated)
	id := plotLifecycleIDOf(t, first)
	h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken,
		map[string]any{"id": id, "name": "Repetido"}, http.StatusOK)
}

func plotLifecycleCropNeedsType(t *testing.T, h *harness, f *farmFixture) {
	res := h.do(t, http.MethodPost, "/v1/plots", f.OwnerToken,
		map[string]any{"name": "Sin tipo", "crops": []map[string]any{{"areaHa": 1}}})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("a crop without a type was accepted: %d %s", res.Status, res.Raw)
	}
	res = h.do(t, http.MethodPost, "/v1/plots", f.OwnerToken,
		map[string]any{"name": "Área rara", "crops": []map[string]any{{"cropType": "Café", "areaHa": 1.23456}}})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("a crop area finer than the column was accepted: %d %s", res.Status, res.Raw)
	}
	plot := plotLifecycleIDOf(t, h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken,
		map[string]any{"name": "Para cultivos"}, http.StatusCreated))
	res = h.do(t, http.MethodPost, "/v1/plots/"+plot+"/crops", f.OwnerToken, map[string]any{"areaHa": 1})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("a crop without a type was accepted on its own: %d %s", res.Status, res.Raw)
	}
	res = h.do(t, http.MethodPost, "/v1/plots/"+plot+"/crops", f.OwnerToken,
		map[string]any{"cropType": "Café", "areaHa": 1.23456})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("a crop area finer than the column was accepted on its own: %d %s", res.Status, res.Raw)
	}
}

func plotLifecyclePlantedCannotGo(t *testing.T, h *harness, f *farmFixture) {
	plot := plotLifecycleIDOf(t, h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken,
		map[string]any{"name": "Sembrado"}, http.StatusCreated))
	crop := plotLifecycleIDOf(t, h.mustDo(t, http.MethodPost, "/v1/plots/"+plot+"/crops", f.OwnerToken,
		map[string]any{"cropType": "Café", "areaHa": 1.5}, http.StatusCreated))

	if res := h.do(t, http.MethodDelete, "/v1/plots/"+plot, f.OwnerToken, nil); res.Status != http.StatusConflict {
		t.Fatalf("a planted plot was deleted: %d %s", res.Status, res.Raw)
	}
	if res := h.do(t, http.MethodPatch, "/v1/plots/"+plot, f.OwnerToken,
		map[string]any{"status": "inactive"}); res.Status != http.StatusConflict {
		t.Fatalf("a planted plot was deactivated: %d %s", res.Status, res.Raw)
	}

	h.mustDo(t, http.MethodDelete, "/v1/plots/"+plot+"/crops/"+crop, f.OwnerToken, nil, http.StatusNoContent)
	h.mustDo(t, http.MethodPatch, "/v1/plots/"+plot, f.OwnerToken,
		map[string]any{"status": "inactive"}, http.StatusOK)
	h.mustDo(t, http.MethodPatch, "/v1/plots/"+plot, f.OwnerToken,
		map[string]any{"status": "active"}, http.StatusOK)
	h.mustDo(t, http.MethodDelete, "/v1/plots/"+plot, f.OwnerToken, nil, http.StatusNoContent)
}

func plotLifecycleUnknownStatus(t *testing.T, h *harness, f *farmFixture) {
	plot := plotLifecycleIDOf(t, h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken,
		map[string]any{"name": "Estado raro"}, http.StatusCreated))
	if res := h.do(t, http.MethodPatch, "/v1/plots/"+plot, f.OwnerToken,
		map[string]any{"status": "borrado"}); res.Status != http.StatusBadRequest {
		t.Fatalf("an unknown status was accepted: %d %s", res.Status, res.Raw)
	}
	if res := h.do(t, http.MethodPatch, "/v1/plots/"+plot, f.OwnerToken,
		map[string]any{"areaHa": 1.23456}); res.Status != http.StatusBadRequest {
		t.Fatalf("an area finer than the column was accepted: %d %s", res.Status, res.Raw)
	}
}

// plotLifecycleIDOf is the id a plot or crop answer carries; an answer
// without one fails the subtest that asked for it.
func plotLifecycleIDOf(t *testing.T, res response) string {
	id, _ := res.Body["id"].(string)
	if id == "" {
		t.Fatalf("no id in %s", res.Raw)
	}
	return id
}
