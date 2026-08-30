package apitest

import (
	"net/http"
	"testing"
)

// A plot's location is one point, captured by standing in it.
//
// It exists because the boundary editor asked an owner to trace a polygon over
// a grey rectangle -- the drawing surface has no basemap, deliberately, since
// no tile source is same-origin and none of them work on a farm with no signal.
// In this database, across every real farm, 2 plots out of 138 have a boundary
// and the rest never drew one. A point costs one tap, needs no basemap of ours
// to be worth having, and answers the question an owner asks a map: where is
// it, how do I get back.
func TestPlotLocationIsAPointThatCanBeSetAndErased(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del punto", 80000)

	// A point on the farm, in GeoJSON: longitude first, as the format says.
	point := map[string]any{"type": "Point", "coordinates": []float64{-75.6, 5.07}}

	t.Run("it is stored when the plot is created", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken,
			map[string]any{"name": "Lote alto", "location": point}, http.StatusCreated)
		got, _ := res.Body["location"].(map[string]any)
		if got == nil || got["type"] != "Point" {
			t.Fatalf("the location did not come back as a GeoJSON Point: %s", res.Raw)
		}
	})

	t.Run("a plot created without one has none", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken,
			map[string]any{"name": "Lote bajo"}, http.StatusCreated)
		if res.Body["location"] != nil {
			t.Fatalf("a plot nobody stood in reported a location: %s", res.Raw)
		}
	})

	t.Run("editing the name does not drop the point", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken,
			map[string]any{"name": "Lote medio", "location": point}, http.StatusCreated)
		id, _ := res.Body["id"].(string)

		// The whole reason `location` distinguishes absent from null. A PATCH
		// that renames a plot must leave its point alone; if absent erased,
		// every rename would silently lose it.
		res = h.mustDo(t, http.MethodPatch, "/v1/plots/"+id, f.OwnerToken,
			map[string]any{"name": "Lote del medio"}, http.StatusOK)
		if res.Body["location"] == nil {
			t.Fatalf("renaming the plot erased its location: %s", res.Raw)
		}
	})

	t.Run("null erases it, because a point can be captured at the wrong gate", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken,
			map[string]any{"name": "Lote equivocado", "location": point}, http.StatusCreated)
		id, _ := res.Body["id"].(string)

		res = h.mustDo(t, http.MethodPatch, "/v1/plots/"+id, f.OwnerToken,
			map[string]any{"location": nil}, http.StatusOK)
		if res.Body["location"] != nil {
			t.Fatalf("the location survived being set to null: %s", res.Raw)
		}
	})

	t.Run("a polygon is refused, since this field is not the boundary", func(t *testing.T) {
		square := map[string]any{"type": "Polygon", "coordinates": [][][]float64{{
			{-75.6, 5.07}, {-75.59, 5.07}, {-75.59, 5.08}, {-75.6, 5.08}, {-75.6, 5.07},
		}}}
		res := h.do(t, http.MethodPost, "/v1/plots", f.OwnerToken,
			map[string]any{"name": "Lote con forma", "location": square})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("a Polygon was accepted as a location: %d %s", res.Status, res.Raw)
		}
	})

	t.Run("the boundary is untouched by any of this", func(t *testing.T) {
		// The point does not replace the polygon and is not derived from it.
		// The two farms in this database that drew one keep it.
		res := h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken,
			map[string]any{"name": "Lote con ambos", "location": point}, http.StatusCreated)
		id, _ := res.Body["id"].(string)

		square := map[string]any{"type": "Polygon", "coordinates": [][][]float64{{
			{-75.6, 5.07}, {-75.59, 5.07}, {-75.59, 5.08}, {-75.6, 5.08}, {-75.6, 5.07},
		}}}
		// This route answers with the plot nested under "plot", alongside the
		// overlap warning -- unlike POST and PATCH, which answer with the plot
		// itself.
		res = h.mustDo(t, http.MethodPut, "/v1/plots/"+id+"/boundary", f.OwnerToken,
			map[string]any{"boundary": square}, http.StatusOK)
		plot, _ := res.Body["plot"].(map[string]any)
		if plot == nil {
			t.Fatalf("no plot in the boundary response: %s", res.Raw)
		}
		if plot["boundary"] == nil {
			t.Fatalf("the boundary did not survive: %s", res.Raw)
		}
		if plot["location"] == nil {
			t.Fatalf("drawing a boundary erased the location: %s", res.Raw)
		}
	})
}
