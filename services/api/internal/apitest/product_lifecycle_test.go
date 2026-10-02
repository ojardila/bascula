package apitest

import (
	"net/http"
	"testing"
)

// A product from the inventory form to out of service, and the customer picker
// that must never produce two rows for one name.
func TestProductLifecycle(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del inventario", 80000)

	t.Run("a product needs a name and a unit", func(t *testing.T) {
		if res := h.do(t, http.MethodPost, "/v1/products", f.OwnerToken,
			map[string]any{"storageUnit": "Bulto"}); res.Status != http.StatusBadRequest {
			t.Fatalf("a product without a name was accepted: %d %s", res.Status, res.Raw)
		}
		if res := h.do(t, http.MethodPost, "/v1/products", f.OwnerToken,
			map[string]any{"name": "Urea"}); res.Status != http.StatusBadRequest {
			t.Fatalf("a product without a unit was accepted: %d %s", res.Status, res.Raw)
		}
	})

	res := h.mustDo(t, http.MethodPost, "/v1/products", f.OwnerToken,
		map[string]any{"name": "Urea", "category": "Fertilizante", "storageUnit": "Bulto"}, http.StatusCreated)
	id, _ := res.Body["id"].(string)
	if id == "" {
		t.Fatalf("no id in %s", res.Raw)
	}

	t.Run("sending it again is the same product, and the name is unique", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/products", f.OwnerToken,
			map[string]any{"id": id, "name": "Urea", "storageUnit": "Bulto"}, http.StatusOK)
		if res := h.do(t, http.MethodPost, "/v1/products", f.OwnerToken,
			map[string]any{"name": "Urea", "storageUnit": "Bulto"}); res.Status != http.StatusConflict {
			t.Fatalf("a second product with the same name was accepted: %d %s", res.Status, res.Raw)
		}
	})

	t.Run("it can be renamed, taken out of service and brought back", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPatch, "/v1/products/"+id, f.OwnerToken,
			map[string]any{"name": "Urea 46%", "storageUnit": "Bulto"}, http.StatusOK)
		if res.Body["name"] != "Urea 46%" {
			t.Fatalf("the rename did not stick: %s", res.Raw)
		}
		h.mustDo(t, http.MethodPatch, "/v1/products/"+id, f.OwnerToken,
			map[string]any{"name": "Urea 46%", "storageUnit": "Bulto", "status": "inactive"}, http.StatusOK)
		h.mustDo(t, http.MethodPatch, "/v1/products/"+id, f.OwnerToken,
			map[string]any{"name": "Urea 46%", "storageUnit": "Bulto", "status": "active"}, http.StatusOK)
		if res := h.do(t, http.MethodPatch, "/v1/products/"+id, f.OwnerToken,
			map[string]any{"name": "Urea", "status": "borrado"}); res.Status != http.StatusBadRequest {
			t.Fatalf("an unknown status was accepted: %d %s", res.Status, res.Raw)
		}
	})

	t.Run("it can be deleted", func(t *testing.T) {
		h.mustDo(t, http.MethodDelete, "/v1/products/"+id, f.OwnerToken, nil, http.StatusNoContent)
	})

	t.Run("a customer is one row per name", func(t *testing.T) {
		if res := h.do(t, http.MethodPost, "/v1/customers", f.OwnerToken, map[string]any{}); res.Status != http.StatusBadRequest {
			t.Fatalf("a customer without a name was accepted: %d %s", res.Status, res.Raw)
		}
		a := h.mustDo(t, http.MethodPost, "/v1/customers", f.OwnerToken,
			map[string]any{"name": "Cooperativa"}, http.StatusOK)
		b := h.mustDo(t, http.MethodPost, "/v1/customers", f.OwnerToken,
			map[string]any{"name": "cooperativa"}, http.StatusOK)
		if a.Body["id"] != b.Body["id"] {
			t.Fatalf("one name made two customers: %s / %s", a.Raw, b.Raw)
		}
	})
}
