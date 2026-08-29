package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// Sales — RSP-026 … RSP-029.

func (s *Server) handleListSales(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.SaleFilter{
		Filter:     listFilter(r),
		ProductID:  q.Get("productId"),
		CustomerID: q.Get("customerId"),
	}
	var err error
	if f.From, err = optionalDate(q.Get("from")); err != nil {
		writeError(w, r, err)
		return
	}
	if f.To, err = optionalDate(q.Get("to")); err != nil {
		writeError(w, r, err)
		return
	}
	// A filter by a product of another farm would list nothing and total zero,
	// which reads as "we have sold none of that" rather than "that is not
	// ours". Confirm before adding up.
	if err := confirmOurs(r, map[string]string{
		"product": f.ProductID, "customer": f.CustomerID,
	}); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	list, err := store.ListSales(r.Context(), tx, f)
	if err != nil {
		writeError(w, r, err)
		return
	}
	var total int64
	var qty float64
	for _, sale := range list {
		if sale.VoidedAt == nil {
			total += sale.AmountMinor
			qty += sale.Qty
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": list, "totalCents": total, "totalQty": qty,
	})
}

func (s *Server) handleGetSale(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	sale, err := store.GetSale(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, sale)
}

// handleCreateSale writes the sale and its outgoing stock movement in ONE
// transaction, which is the whole point of the endpoint.
//
// Two endpoints would mean two chances to write half of it, and the first time
// anybody voided anything the sales list and the warehouse would disagree with
// no third record to say which was right. The database backs it up:
// stock_venta_has_sale makes a 'venta' movement without a sale impossible.
func (s *Server) handleCreateSale(w http.ResponseWriter, r *http.Request) {
	var body store.NewSale
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.ProductID == "" {
		writeError(w, r, domain.BadRequest("productId is required"))
		return
	}
	if body.WarehouseID == "" {
		writeError(w, r, domain.BadRequest(
			"warehouseId is required: a sale takes the product out of somewhere"))
		return
	}
	if body.Qty <= 0 {
		writeError(w, r, domain.BadRequest("qty must be positive"))
		return
	}
	if body.AmountMinor <= 0 {
		writeError(w, r, domain.BadRequest("amountCents must be positive"))
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

	// The customer picker resolves a name into a row, so the sales screen can
	// offer "add it if it is not there" like every other picker here.
	if (body.CustomerID == nil || *body.CustomerID == "") && body.Customer != "" {
		c, err := store.EnsureCustomer(r.Context(), tx, farmID, store.Customer{
			ID: newID(), Name: body.Customer,
		})
		if err != nil {
			writeError(w, r, err)
			return
		}
		body.CustomerID = &c.ID
	}

	if err := confirmOurs(r, map[string]string{
		"product": body.ProductID, "warehouse": body.WarehouseID,
		"customer": deref(body.CustomerID), "attachment": deref(body.ReceiptID),
	}); err != nil {
		writeError(w, r, err)
		return
	}
	if existing, err := store.GetSale(r.Context(), tx, body.ID); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	}
	if !body.AllowNegativeStock {
		if err := guardStock(r, body.ProductID, body.WarehouseID, -body.Qty); err != nil {
			writeError(w, r, err)
			return
		}
	}

	body.CreatedBy = principalID(r)
	sale, err := store.CreateSale(r.Context(), tx, farmID, body, newID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, sale)
}

type salePatchRequest struct {
	store.SalePatch
	// Qty is accepted only to be refused with an explanation. Silently
	// ignoring a field the caller sent is the worst of both answers: the
	// request succeeds and the number on the screen is not the number stored.
	Qty      *float64 `json:"qty"`
	Customer string   `json:"customer"`
	Status   string   `json:"status"`
}

// handleUpdateSale is RSP-028, minus the quantity. The quantity is one half of
// a stock movement that is already written and append-only, so moving it here
// would leave the warehouse claiming one number and the sales list another.
func (s *Server) handleUpdateSale(w http.ResponseWriter, r *http.Request) {
	var body salePatchRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.Qty != nil {
		writeError(w, r, domain.BadRequest(
			"the quantity of a sale is fixed by its stock movement: void the sale and record it again"))
		return
	}
	if body.Status == "inactive" {
		writeError(w, r, domain.BadRequest(
			"use DELETE to void a sale; voiding returns the stock as well as flagging the row"))
		return
	}
	if body.Status == "active" {
		writeError(w, r, domain.BadRequest(
			"a voided sale is not restored: record a new one"))
		return
	}
	if body.AmountMinor != nil && *body.AmountMinor <= 0 {
		writeError(w, r, domain.BadRequest("amountCents must be positive"))
		return
	}
	id := chi.URLParam(r, "id")
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
	if _, err := store.GetSale(r.Context(), tx, id); err != nil {
		writeError(w, r, err)
		return
	}
	if (body.CustomerID == nil || *body.CustomerID == "") && body.Customer != "" {
		c, err := store.EnsureCustomer(r.Context(), tx, farmID, store.Customer{
			ID: newID(), Name: body.Customer,
		})
		if err != nil {
			writeError(w, r, err)
			return
		}
		body.CustomerID = &c.ID
	}
	if err := confirmOurs(r, map[string]string{
		"customer": deref(body.CustomerID), "attachment": deref(body.ReceiptID),
	}); err != nil {
		writeError(w, r, err)
		return
	}
	updated, err := store.UpdateSale(r.Context(), tx, id, body.SalePatch)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleVoidSale is RSP-029's "eliminar deja la venta inactiva", done
// honestly: the row is flagged AND the coffee comes back into the warehouse,
// as a reversing movement in the same transaction. Flagging alone would leave
// the product sold in one list and gone from the other forever.
func (s *Server) handleVoidSale(w http.ResponseWriter, r *http.Request) {
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
	sale, err := store.VoidSale(r.Context(), tx, farmID, chi.URLParam(r, "id"), newID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, sale)
}
