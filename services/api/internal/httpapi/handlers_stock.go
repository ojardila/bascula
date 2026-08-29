package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// confirmOurs checks that every id the caller named belongs to this farm,
// BEFORE anything is added up.
//
// This is the trap that has bitten this project twice. RLS narrows rows rather
// than raising, so a SUM over a product of another farm returns 0 and a list
// returns []. "There are no sacks in that warehouse" is a completely credible
// answer, and it is the same answer a warehouse that is genuinely empty gives.
// A wrong answer that looks right is the expensive kind, so an id that is not
// ours is 404 before a single row is counted.
func confirmOurs(r *http.Request, checks map[string]string) error {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		return err
	}
	for kind, id := range checks {
		if id == "" {
			continue
		}
		var n int
		var q string
		switch kind {
		case "product":
			q = `SELECT count(*) FROM products WHERE id = $1`
		case "warehouse":
			q = `SELECT count(*) FROM warehouses WHERE id = $1`
		case "plot":
			q = `SELECT count(*) FROM plots WHERE id = $1`
		case "plotCrop":
			q = `SELECT count(*) FROM plot_crops WHERE id = $1`
		case "customer":
			q = `SELECT count(*) FROM customers WHERE id = $1`
		case "activity":
			q = `SELECT count(*) FROM activities WHERE id = $1`
		case "workRecord":
			q = `SELECT count(*) FROM work_records WHERE id = $1`
		case "attachment":
			q = `SELECT count(*) FROM attachments WHERE id = $1`
		default:
			return domain.Internal("unknown ownership check " + kind)
		}
		if err := tx.QueryRow(r.Context(), q, id).Scan(&n); err != nil {
			// A malformed uuid lands here as 22P02, which writeError already
			// turns into the 404 it deserves.
			return err
		}
		if n == 0 {
			return domain.NotFound("no " + kind + " with that id on this farm")
		}
	}
	return nil
}

// handleListStock is the existencias screen: a derived level per product and
// warehouse, never a stored total.
func (s *Server) handleListStock(w http.ResponseWriter, r *http.Request) {
	productID := r.URL.Query().Get("productId")
	warehouseID := r.URL.Query().Get("warehouseId")
	if err := confirmOurs(r, map[string]string{
		"product": productID, "warehouse": warehouseID,
	}); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	levels, err := store.StockLevels(r.Context(), tx, productID, warehouseID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	var total float64
	for _, l := range levels {
		total += l.Qty
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": levels, "total": total})
}

// handleProductStock is the per-product breakdown. It is the sharpest form of
// the zero trap in this module — one product, one number — so the product is
// confirmed to be ours before the sum runs.
func (s *Server) handleProductStock(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := confirmOurs(r, map[string]string{"product": id}); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	levels, err := store.StockLevels(r.Context(), tx, id, "")
	if err != nil {
		writeError(w, r, err)
		return
	}
	var total float64
	for _, l := range levels {
		total += l.Qty
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"productId": id, "byWarehouse": levels, "total": total,
	})
}

func (s *Server) handleListStockMoves(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.StockMoveFilter{
		ProductID:   q.Get("productId"),
		WarehouseID: q.Get("warehouseId"),
		Reason:      q.Get("reason"),
		Limit:       limitParam(r, 200),
	}
	if f.Reason != "" && !store.IsStockReason(f.Reason) {
		writeError(w, r, domain.BadRequest(
			"reason must be one of "+strings.Join(store.StockReasons, ", ")))
		return
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
	if err := confirmOurs(r, map[string]string{
		"product": f.ProductID, "warehouse": f.WarehouseID,
	}); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	list, err := store.ListStockMoves(r.Context(), tx, f)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

type stockMoveRequest struct {
	store.NewStockMove
	// Labels is RSP-025's stickers. The server generates the batch and returns
	// its id; it does not print. A request that blocked on a printer would
	// make recording a harvest fail because the paper ran out.
	Labels int `json:"labels"`
	// AllowNegative is the escape hatch for the stock guard, spelled the way
	// `allowOverpayment` is on a payment: the guard exists because a keyboard
	// makes typos, and the override exists because the warehouse is not always
	// in the database before the truck arrives.
	AllowNegative bool `json:"allowNegative"`
}

// handleCreateStockMove is RSP-025, and the one write that puts anything into
// or out of a warehouse other than a sale.
func (s *Server) handleCreateStockMove(w http.ResponseWriter, r *http.Request) {
	var body stockMoveRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.ProductID == "" || body.WarehouseID == "" {
		writeError(w, r, domain.BadRequest("productId and warehouseId are required"))
		return
	}
	if body.Qty == 0 {
		writeError(w, r, domain.BadRequest("qty cannot be zero"))
		return
	}
	if !store.IsStockReason(body.Reason) {
		writeError(w, r, domain.BadRequest(
			"reason must be one of "+strings.Join(store.StockReasons, ", ")))
		return
	}
	// A 'venta' movement is the shadow of a sale and is written by the sales
	// handler, in the same transaction as the sale itself. Letting one in
	// here would be the one way to get stock and sales to disagree.
	if body.Reason == "venta" {
		writeError(w, r, domain.BadRequest(
			"record the sale at POST /v1/sales; it writes its own stock movement"))
		return
	}
	if body.Labels < 0 || body.Labels > 500 {
		writeError(w, r, domain.BadRequest("labels must be between 0 and 500"))
		return
	}
	// The sign follows from the reason rather than from the caller, so a
	// client that sends 40 for a merma gets a merma of 40 out and not a
	// refusal it has to guess its way out of. The database checks the pair
	// anyway; this is the courtesy, not the guarantee.
	if store.OutgoingReasons[body.Reason] && body.Qty > 0 {
		body.Qty = -body.Qty
	}
	if (body.Reason == "cosecha" || body.Reason == "compra") && body.Qty < 0 {
		body.Qty = -body.Qty
	}
	if body.ID == "" {
		body.ID = newID()
	}

	if err := confirmOurs(r, map[string]string{
		"product": body.ProductID, "warehouse": body.WarehouseID,
		"plot": deref(body.PlotID), "plotCrop": deref(body.PlotCropID),
		"workRecord": deref(body.WorkRecordID),
	}); err != nil {
		writeError(w, r, err)
		return
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
	if existing, err := store.GetStockMove(r.Context(), tx, body.ID); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	}

	if body.Qty < 0 && !body.AllowNegative {
		if err := guardStock(r, body.ProductID, body.WarehouseID, body.Qty); err != nil {
			writeError(w, r, err)
			return
		}
	}

	body.CreatedBy = principalID(r)
	move, err := store.InsertStockMove(r.Context(), tx, farmID, body.NewStockMove)
	if err != nil {
		writeError(w, r, err)
		return
	}

	out := map[string]any{"move": move}
	if body.Labels > 0 {
		batch, err := store.CreateLabelBatch(r.Context(), tx, farmID, move.ID,
			body.Labels, principalID(r), newID)
		if err != nil {
			writeError(w, r, err)
			return
		}
		out["labelBatch"] = batch
	}
	writeJSON(w, http.StatusCreated, out)
}

// guardStock refuses to take out more than is there, unless the caller says to
// go ahead. It runs on the derived level, never on a stored one, and it is
// only ever a 409 the caller can override: a warehouse whose opening balance
// was never recorded is common, and a server that made it impossible to record
// what actually left would be a server nobody could use.
func guardStock(r *http.Request, productID, warehouseID string, qty float64) error {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		return err
	}
	onHand, err := store.StockOnHand(r.Context(), tx, productID, warehouseID)
	if err != nil {
		return err
	}
	if onHand+qty < 0 {
		return domain.Conflict(domain.CodeInsufficientStock,
			"there is not that much in the warehouse").
			WithDetails(map[string]any{
				"onHand":    onHand,
				"requested": -qty,
			})
	}
	return nil
}

// handleReverseStockMove is the only way back through an append-only table:
// its exact opposite, once. Nothing is edited and nothing is deleted, which is
// what keeps the derived level and the facts it is derived from in step.
func (s *Server) handleReverseStockMove(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Note *string `json:"note"`
	}
	if err := decodeOptional(r, &body); err != nil {
		writeError(w, r, err)
		return
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
	move, err := store.ReverseStockMove(r.Context(), tx, farmID, chi.URLParam(r, "id"),
		body.Note, newID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, move)
}

// handleGetLabelBatch hands over the stickers RSP-025 asks the system to
// print. The server does not print: it produces the batch and whatever holds
// the paper asks for it here. A request that blocked on a printer would fail a
// harvest because the printer was out of paper, which is the wrong thing to
// couple to the wrong thing.
func (s *Server) handleGetLabelBatch(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	batch, err := store.GetLabelBatch(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, batch)
}

func optionalDate(raw string) (*time.Time, error) {
	if raw == "" {
		return nil, nil
	}
	d, err := time.Parse("2006-01-02", raw)
	if err != nil {
		return nil, domain.BadRequest("dates must be YYYY-MM-DD")
	}
	return &d, nil
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
