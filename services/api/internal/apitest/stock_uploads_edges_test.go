package apitest

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

// TestStockMoveRefusals covers the stock move checks and filters the main
// inventory flows never trip.
func TestStockMoveRefusals(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca bodega bordes", 250000)
	inv := h.seedInventory(t, f, "Abono bordes", "Bodega bordes")

	base := func(extra map[string]any) map[string]any {
		b := map[string]any{"productId": inv.ProductID, "warehouseId": inv.WarehouseID, "reason": "compra", "qty": 5}
		for k, v := range extra {
			b[k] = v
		}
		return b
	}
	for name, extra := range map[string]map[string]any{
		"zero qty":   {"qty": 0},
		"bad reason": {"reason": "regalo"},
		"labels":     {"labels": 501},
	} {
		t.Run(name, func(t *testing.T) {
			h.mustDo(t, http.MethodPost, "/v1/stock/moves", f.OwnerToken, base(extra), http.StatusBadRequest)
		})
	}

	// A purchase sent with a minus sign still comes in, and a resent id
	// answers with the move it already wrote.
	key := uuid.NewString()
	body := base(map[string]any{"id": key, "qty": -5})
	h.mustDo(t, http.MethodPost, "/v1/stock/moves", f.OwnerToken, body, http.StatusCreated)
	h.mustDo(t, http.MethodPost, "/v1/stock/moves", f.OwnerToken, body, http.StatusOK)
	if got := h.stockOf(t, f, inv.ProductID); got != 5 {
		t.Errorf("a purchase of -5 should add 5, stock is %v", got)
	}

	for _, q := range []string{"reason=regalo", "from=ayer", "to=hoy"} {
		h.mustDo(t, http.MethodGet, "/v1/stock/moves?"+q, f.OwnerToken, nil, http.StatusBadRequest)
	}
	h.mustDo(t, http.MethodGet, "/v1/stock/moves?reason=compra&from=2020-01-01&to=2099-12-31", f.OwnerToken, nil, http.StatusOK)
	h.mustDo(t, http.MethodGet, "/v1/stock", f.OwnerToken, nil, http.StatusOK)
}

// TestUploadEdges covers the upload ticket's declared-size refusal, id
// replay, resending bytes to a ready upload, a text file and reading the
// bytes of an upload that has none yet.
func TestUploadEdges(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca fotos bordes", 250000)

	h.mustDo(t, http.MethodPost, "/v1/uploads", f.OwnerToken,
		map[string]any{"filename": "grande.png", "bytes": 50 << 20}, http.StatusRequestEntityTooLarge)

	key := uuid.NewString()
	ticket := map[string]any{"id": key, "purpose": "worker-photo", "filename": "foto.png"}
	first := h.mustDo(t, http.MethodPost, "/v1/uploads", f.OwnerToken, ticket, http.StatusCreated)
	h.mustDo(t, http.MethodPost, "/v1/uploads", f.OwnerToken, ticket, http.StatusOK)
	url := mustString(t, first.Body, "uploadUrl")

	req := httptest.NewRequest(http.MethodGet, "/v1/uploads/"+key+"/content", nil)
	req.Header.Set("Authorization", "Bearer "+f.OwnerToken)
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Errorf("bytes of a pending upload: got %d %s, want 409", rec.Code, rec.Body.String())
	}

	if res := h.putBytes(t, url, f.OwnerToken, []byte("solo texto, no una foto")); res.Status != http.StatusUnsupportedMediaType {
		t.Errorf("a text file: got %d %s, want 415", res.Status, res.Raw)
	}
	if res := h.putBytes(t, url, f.OwnerToken, pngOf(512)); res.Status != http.StatusOK {
		t.Fatalf("upload: got %d %s", res.Status, res.Raw)
	}
	again := h.putBytes(t, url, f.OwnerToken, pngOf(512))
	if again.Status != http.StatusOK || again.Body["status"] != "ready" {
		t.Errorf("resending bytes to a ready upload: got %d %s", again.Status, again.Raw)
	}
}
