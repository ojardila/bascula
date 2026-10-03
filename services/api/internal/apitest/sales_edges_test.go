// SPDX-License-Identifier: MIT

package apitest

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// The refusals around a sale that the screens never send, a create that is
// replayed with the same id, and a reading of one sale by id.
func TestSaleEdges(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de ventas raras", 80000)
	inv := h.seedInventory(t, f, "Cafe pergamino", "Bodega rara")
	h.move(t, f, inv, "cosecha", 100, nil)
	sale := func(extra map[string]any) map[string]any {
		body := map[string]any{"productId": inv.ProductID, "warehouseId": inv.WarehouseID, "qty": 10, "amountCents": 50_000_00}
		for k, v := range extra {
			body[k] = v
		}
		return body
	}
	post := func(body map[string]any) response { return h.do(t, http.MethodPost, "/v1/sales", f.OwnerToken, body) }

	expectStatus(t, "no warehouse", post(sale(map[string]any{"warehouseId": ""})), http.StatusBadRequest)
	expectStatus(t, "zero qty", post(sale(map[string]any{"qty": 0})), http.StatusBadRequest)
	expectStatus(t, "qty too precise", post(sale(map[string]any{"qty": 1.123456789})), http.StatusBadRequest)
	expectStatus(t, "zero amount", post(sale(map[string]any{"amountCents": 0})), http.StatusBadRequest)
	for _, q := range []string{"?from=ayer", "?to=mañana"} {
		expectStatus(t, q, h.do(t, http.MethodGet, "/v1/sales"+q, f.OwnerToken, nil), http.StatusBadRequest)
	}

	id := uuid.NewString()
	first := post(sale(map[string]any{"id": id}))
	expectStatus(t, "first create", first, http.StatusCreated)
	again := post(sale(map[string]any{"id": id}))
	expectStatus(t, "the same id again", again, http.StatusOK)
	if again.Body["id"] != id {
		t.Fatalf("the replay is not the first sale: %s", again.Raw)
	}
	if got := h.stockOf(t, f, inv.ProductID); got != 90 {
		t.Fatalf("a replayed sale moved stock twice: %v", got)
	}
	expectStatus(t, "read by id", h.do(t, http.MethodGet, "/v1/sales/"+id, f.OwnerToken, nil), http.StatusOK)

	patch := func(body map[string]any) response {
		return h.do(t, http.MethodPatch, "/v1/sales/"+id, f.OwnerToken, body)
	}
	expectStatus(t, "voiding by patch", patch(map[string]any{"status": "inactive"}), http.StatusBadRequest)
	expectStatus(t, "zero amount on edit", patch(map[string]any{"amountCents": 0}), http.StatusBadRequest)
	res := patch(map[string]any{"customer": "Tostadora La Montaña"})
	expectStatus(t, "a new customer by name", res, http.StatusOK)
	if res.Body["customerId"] == nil {
		t.Fatalf("the customer name made no row: %s", res.Raw)
	}
	expectStatus(t, "list by date", h.do(t, http.MethodGet, "/v1/sales?from=2020-01-01&to=2099-12-31", f.OwnerToken, nil),
		http.StatusOK)
}
