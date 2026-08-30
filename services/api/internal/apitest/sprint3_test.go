package apitest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// ---------------------------------------------------------------------------
// Fixtures for the inventory module
// ---------------------------------------------------------------------------

type inventoryFixture struct {
	ProductID   string
	WarehouseID string
}

func (h *harness) seedInventory(t *testing.T, f *farmFixture, product, warehouse string) inventoryFixture {
	t.Helper()
	wh := h.mustDo(t, http.MethodPost, "/v1/warehouses", f.OwnerToken,
		map[string]any{"name": warehouse}, http.StatusOK)
	p := h.mustDo(t, http.MethodPost, "/v1/products", f.OwnerToken, map[string]any{
		"name": product, "category": "Materia prima", "storageUnit": "Bulto",
	}, http.StatusCreated)
	return inventoryFixture{
		ProductID:   mustString(t, p.Body, "id"),
		WarehouseID: mustString(t, wh.Body, "id"),
	}
}

func (h *harness) stockOf(t *testing.T, f *farmFixture, productID string) float64 {
	t.Helper()
	res := h.mustDo(t, http.MethodGet, "/v1/products/"+productID+"/stock",
		f.OwnerToken, nil, http.StatusOK)
	total, ok := res.Body["total"].(float64)
	if !ok {
		t.Fatalf("no total in %s", res.Raw)
	}
	return total
}

func (h *harness) move(t *testing.T, f *farmFixture, inv inventoryFixture,
	reason string, qty float64, extra map[string]any) map[string]any {
	t.Helper()
	body := map[string]any{
		"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
		"reason": reason, "qty": qty,
	}
	for k, v := range extra {
		body[k] = v
	}
	res := h.mustDo(t, http.MethodPost, "/v1/stock/moves", f.OwnerToken, body, http.StatusCreated)
	m, _ := res.Body["move"].(map[string]any)
	if m == nil {
		t.Fatalf("no move in %s", res.Raw)
	}
	return res.Body
}

// ---------------------------------------------------------------------------
// RSP-018 … RSP-025
// ---------------------------------------------------------------------------

// TestStockOnHandIsDerivedFromMovements is the inventory equivalent of
// TestBalanceIsDerivedAndReversalsAreOnce, and it exists for the same reason.
//
// There is no `stock` column. Every quantity this API reports is a SUM over
// stock_moves, and stock_moves is append-only — the database has a trigger and
// a REVOKE that make editing or deleting one impossible. A mistake is
// corrected with its opposite. If any of that stops being true, a total will
// one day disagree with the movements underneath it, and nothing in the system
// will be able to say which of the two is lying.
func TestStockOnHandIsDerivedFromMovements(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de bodega", 80000)
	inv := h.seedInventory(t, f, "Cafe pergamino", "Bodega principal")

	t.Run("a harvest comes in and a merma goes out", func(t *testing.T) {
		h.move(t, f, inv, "cosecha", 100, nil)
		if got := h.stockOf(t, f, inv.ProductID); got != 100 {
			t.Fatalf("stock is %v after a harvest of 100, want 100", got)
		}
		// Sent unsigned; the sign follows from the reason, and the database
		// refuses the pair if the two disagree.
		h.move(t, f, inv, "merma", 12, nil)
		if got := h.stockOf(t, f, inv.ProductID); got != 88 {
			t.Fatalf("stock is %v after a merma of 12, want 88", got)
		}
	})

	t.Run("the product list carries the same derived number", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/products", f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("want 1 product, got %d: %s", len(items), res.Raw)
		}
		row := items[0].(map[string]any)
		if row["stock"] != 88.0 {
			t.Fatalf("the list says %v, the per-product read says 88: %s", row["stock"], res.Raw)
		}
	})

	t.Run("a harvest that increases nothing is refused by the database", func(t *testing.T) {
		// The sign belongs to the reason. A client that insists otherwise is
		// refused by stock_sign, not by a validation somebody remembered.
		h.withTenant(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
			func(ctx context.Context, tx pgx.Tx) {
				_, err := tx.Exec(ctx, `
					INSERT INTO stock_moves (id, farm_id, product_id, warehouse_id, qty, reason, local_day)
					VALUES ($1, $2, $3, $4, -5, 'cosecha', current_date)`,
					uuid.NewString(), f.FarmID, inv.ProductID, inv.WarehouseID)
				if err == nil {
					t.Error("a 'cosecha' of -5 was accepted; stock_sign is not doing its job")
				}
			})
	})

	t.Run("movements cannot be edited or deleted at all", func(t *testing.T) {
		h.withTenant(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
			func(ctx context.Context, tx pgx.Tx) {
				_, err := tx.Exec(ctx, `UPDATE stock_moves SET qty = 1 WHERE farm_id = $1`, f.FarmID)
				if err == nil {
					t.Error("the API role was allowed to UPDATE a stock movement")
				}
			})
		h.withTenant(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
			func(ctx context.Context, tx pgx.Tx) {
				_, err := tx.Exec(ctx, `DELETE FROM stock_moves WHERE farm_id = $1`, f.FarmID)
				if err == nil {
					t.Error("the API role was allowed to DELETE a stock movement")
				}
			})
	})

	t.Run("a mistake is corrected with its opposite, once", func(t *testing.T) {
		body := h.move(t, f, inv, "compra", 30, nil)
		moveID := body["move"].(map[string]any)["id"].(string)
		if got := h.stockOf(t, f, inv.ProductID); got != 118 {
			t.Fatalf("stock is %v, want 118", got)
		}

		h.mustDo(t, http.MethodPost, "/v1/stock/moves/"+moveID+"/reverse",
			f.OwnerToken, map[string]any{"note": "mal contado"}, http.StatusCreated)
		if got := h.stockOf(t, f, inv.ProductID); got != 88 {
			t.Fatalf("stock is %v after the reversal, want 88 again", got)
		}

		second := h.do(t, http.MethodPost, "/v1/stock/moves/"+moveID+"/reverse", f.OwnerToken, nil)
		if second.code() != string(domain.CodeAlreadyReversed) {
			t.Fatalf("second reversal: got %d %s, want ALREADY_REVERSED", second.Status, second.Raw)
		}
		if got := h.stockOf(t, f, inv.ProductID); got != 88 {
			t.Fatalf("the refused reversal still moved the stock: %v", got)
		}
	})

	t.Run("taking out more than there is needs saying so", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/stock/moves", f.OwnerToken, map[string]any{
			"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
			"reason": "consumo", "qty": 1000,
		})
		if res.code() != string(domain.CodeInsufficientStock) {
			t.Fatalf("consuming 1000 of 88: got %d %s, want INSUFFICIENT_STOCK", res.Status, res.Raw)
		}
		// And the override, which exists because a warehouse whose opening
		// balance was never entered is ordinary.
		h.mustDo(t, http.MethodPost, "/v1/stock/moves", f.OwnerToken, map[string]any{
			"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
			"reason": "consumo", "qty": 1000, "allowNegative": true,
		}, http.StatusCreated)
		if got := h.stockOf(t, f, inv.ProductID); got != -912 {
			t.Fatalf("stock is %v, want -912: the override did not take", got)
		}
	})
}

// TestStickersAreGeneratedNotPrinted is RSP-025's last line, read the way a
// server has to read it: it generates the batch and returns its id. A request
// that blocked on a printer would fail a harvest because the paper ran out.
func TestStickersAreGeneratedNotPrinted(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de stickers", 80000)
	inv := h.seedInventory(t, f, "Aguacate", "Bodega norte")
	plot := h.createPlot(t, f, "Lote de aguacate")

	res := h.mustDo(t, http.MethodPost, "/v1/stock/moves", f.OwnerToken, map[string]any{
		"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
		"reason": "cosecha", "qty": 11, "plotId": plot, "labels": 4,
	}, http.StatusCreated)

	batch, _ := res.Body["labelBatch"].(map[string]any)
	if batch == nil {
		t.Fatalf("no labelBatch in the response: %s", res.Raw)
	}
	batchID := mustString(t, batch, "id")

	got := h.mustDo(t, http.MethodGet, "/v1/label-batches/"+batchID, f.OwnerToken, nil, http.StatusOK)
	labels, _ := got.Body["labels"].([]any)
	if len(labels) != 4 {
		t.Fatalf("%d labels, want 4: %s", len(labels), got.Raw)
	}

	// Eleven over four is 2.75 each, and the paper still adds up to eleven.
	var total float64
	for _, raw := range labels {
		l := raw.(map[string]any)
		total += l["qty"].(float64)
		if l["product"] != "Aguacate" {
			t.Errorf("a label names %v, want Aguacate", l["product"])
		}
		if l["plot"] != "Lote de aguacate" {
			t.Errorf("a label names plot %v", l["plot"])
		}
	}
	if total != 11 {
		t.Fatalf("the labels add up to %v, want the movement's 11", total)
	}

	// Eleven over four divides cleanly, which is why it never caught anything.
	// Forty over three does not: the share is 13.333… and the label column
	// stores three decimals. Rounding each share AND then rounding a remainder
	// taken from the unrounded share printed 13.333 three times, so the paper
	// said 39.999 for a movement of forty. A sack count that does not add up to
	// what came out of the field is the one thing a sticker must never do.
	res = h.mustDo(t, http.MethodPost, "/v1/stock/moves", f.OwnerToken, map[string]any{
		"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
		"reason": "cosecha", "qty": 40, "plotId": plot, "labels": 3,
	}, http.StatusCreated)
	batch, _ = res.Body["labelBatch"].(map[string]any)
	got = h.mustDo(t, http.MethodGet, "/v1/label-batches/"+mustString(t, batch, "id"),
		f.OwnerToken, nil, http.StatusOK)

	labels, _ = got.Body["labels"].([]any)
	total = 0
	for _, raw := range labels {
		total += raw.(map[string]any)["qty"].(float64)
	}
	if total != 40 {
		t.Fatalf("forty over three labels adds up to %v on the paper, want 40: %s",
			total, got.Raw)
	}
}

// ---------------------------------------------------------------------------
// RSP-026 … RSP-029
// ---------------------------------------------------------------------------

// TestASaleMovesStockInTheSameTransaction is the invariant that made sales one
// endpoint instead of two.
//
// Two endpoints would mean two chances to write half of it, and the first time
// anybody voided anything the sales list and the warehouse would disagree with
// no third record to say which was right.
func TestASaleMovesStockInTheSameTransaction(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de ventas", 80000)
	inv := h.seedInventory(t, f, "Cafe seco", "Bodega venta")
	h.move(t, f, inv, "cosecha", 500, nil)

	var saleID string
	t.Run("selling takes the coffee out of the warehouse", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/sales", f.OwnerToken, map[string]any{
			"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
			"qty": 120, "amountCents": 96_000_00, "customer": "Cooperativa del Sur",
		}, http.StatusCreated)
		saleID = mustString(t, res.Body, "id")

		if res.Body["stockMoveId"] == nil {
			t.Fatalf("the sale wrote no stock movement: %s", res.Raw)
		}
		if got := h.stockOf(t, f, inv.ProductID); got != 380 {
			t.Fatalf("stock is %v after selling 120 of 500, want 380", got)
		}
		// The customer picker created the row rather than refusing the name.
		cs := h.mustDo(t, http.MethodGet, "/v1/customers", f.OwnerToken, nil, http.StatusOK)
		items, _ := cs.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("want 1 customer, got %d: %s", len(items), cs.Raw)
		}
	})

	t.Run("a 'venta' movement cannot be written by hand", func(t *testing.T) {
		// The one way to get the two lists to disagree, closed at the door and
		// again in the database by stock_venta_has_sale.
		res := h.do(t, http.MethodPost, "/v1/stock/moves", f.OwnerToken, map[string]any{
			"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
			"reason": "venta", "qty": 10,
		})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("a hand-written venta movement: got %d %s, want 400", res.Status, res.Raw)
		}
		h.withTenant(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
			func(ctx context.Context, tx pgx.Tx) {
				_, err := tx.Exec(ctx, `
					INSERT INTO stock_moves (id, farm_id, product_id, warehouse_id, qty, reason, local_day)
					VALUES ($1, $2, $3, $4, -10, 'venta', current_date)`,
					uuid.NewString(), f.FarmID, inv.ProductID, inv.WarehouseID)
				if err == nil {
					t.Error("a venta movement without a sale was accepted")
				}
			})
	})

	t.Run("the quantity of a sale cannot be edited", func(t *testing.T) {
		res := h.do(t, http.MethodPatch, "/v1/sales/"+saleID, f.OwnerToken,
			map[string]any{"qty": 5})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("editing qty: got %d %s, want 400 telling us to void and re-record",
				res.Status, res.Raw)
		}
		if got := h.stockOf(t, f, inv.ProductID); got != 380 {
			t.Fatalf("the refused patch moved the stock: %v", got)
		}
		// What CAN move, moves.
		h.mustDo(t, http.MethodPatch, "/v1/sales/"+saleID, f.OwnerToken,
			map[string]any{"amountCents": 97_000_00}, http.StatusOK)
	})

	t.Run("voiding a sale puts the coffee back", func(t *testing.T) {
		res := h.mustDo(t, http.MethodDelete, "/v1/sales/"+saleID, f.OwnerToken, nil, http.StatusOK)
		if res.Body["voidedAt"] == nil {
			t.Fatalf("the sale is not marked void: %s", res.Raw)
		}
		if res.Body["reversalMoveId"] == nil {
			t.Fatalf("voiding wrote no reversing movement: %s", res.Raw)
		}
		if got := h.stockOf(t, f, inv.ProductID); got != 500 {
			t.Fatalf("stock is %v after voiding, want 500. A void that only flags "+
				"the row leaves the coffee sold in one list and gone from the other.", got)
		}

		second := h.do(t, http.MethodDelete, "/v1/sales/"+saleID, f.OwnerToken, nil)
		if second.code() != string(domain.CodeSaleAlreadyVoid) {
			t.Fatalf("second void: got %d %s, want SALE_ALREADY_VOID", second.Status, second.Raw)
		}
		if got := h.stockOf(t, f, inv.ProductID); got != 500 {
			t.Fatalf("the refused void moved the stock again: %v", got)
		}
	})

	t.Run("a voided sale is not restored", func(t *testing.T) {
		res := h.do(t, http.MethodPatch, "/v1/sales/"+saleID, f.OwnerToken,
			map[string]any{"status": "active"})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("un-voiding: got %d %s, want 400", res.Status, res.Raw)
		}
	})

	t.Run("the totals count the live sales only", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/sales", f.OwnerToken, map[string]any{
			"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
			"qty": 10, "amountCents": 8_000_00,
		}, http.StatusCreated)

		res := h.mustDo(t, http.MethodGet, "/v1/sales?status=all", f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, res.Body, "totalCents"); got != 8_000_00 {
			t.Fatalf("totalCents is %d, want only the live sale's 800000: %s", got, res.Raw)
		}
	})
}

// ---------------------------------------------------------------------------
// RSP-030 … RSP-033 — and the confusion in the document
// ---------------------------------------------------------------------------

// TestAnExpenseIsNotADebt is the test the whole expenses module was shaped
// around, and the one worth reading first.
//
// The use case document uses one word, "gasto", for two different things.
// RSP-030 means the cost of a spraying; RSP-007 means what an employee owes
// the farm. On a form they look identical — a value, a date, a description.
// They are not the same thing at all: an expense is the farm's own accounting,
// a debt is one line in one person's balance.
//
// If they were wired together, recording the cost of the spraying would take
// money out of somebody's wages. Quietly, correctly according to the code, and
// wrongly according to the person who does not get paid on Friday. So: no
// worker on an expense, no employee_id column at all, and this test standing
// between the two from now on.
func TestAnExpenseIsNotADebt(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de gastos", 80000)
	worker := h.createWorker(t, f, "Fumigador", "7000000001")
	plot := h.createPlot(t, f, "Lote fumigado")
	activity := h.harvestActivityID(t, f)

	// The worker earns something, so a balance moving would be visible.
	h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 50)
	h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated)

	balanceBefore := func(t *testing.T) int64 {
		t.Helper()
		res := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/balance",
			f.OwnerToken, nil, http.StatusOK)
		return mustInt(t, res.Body, "balanceCents")
	}
	ledgerRows := func(t *testing.T) int {
		t.Helper()
		res := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/ledger",
			f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		return len(items)
	}

	before := balanceBefore(t)
	rows := ledgerRows(t)
	if before <= 0 {
		t.Fatalf("the worker is owed %d; the fixture is not exercising anything", before)
	}

	t.Run("the cost of a spraying does not touch anybody's wages", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/expenses", f.OwnerToken, map[string]any{
			"concept": "Fumigacion del lote", "amountCents": 450_000_00, "plotId": plot,
		}, http.StatusCreated)

		if got := balanceBefore(t); got != before {
			t.Fatalf("recording an expense moved a worker's balance from %d to %d.\n"+
				"An expense is the farm's accounting; a debt is POST /v1/deductions. "+
				"Wire them together and the spraying comes out of somebody's pay.",
				before, got)
		}
		if got := ledgerRows(t); got != rows {
			t.Fatalf("recording an expense wrote %d ledger rows", got-rows)
		}
	})

	t.Run("a debt does move the balance, through its own endpoint", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/deductions", f.OwnerToken, map[string]any{
			"workerId": worker, "amountCents": 100_00,
		}, http.StatusCreated)
		if got := balanceBefore(t); got != before-100_00 {
			t.Fatalf("a deduction did not move the balance: %d, want %d", got, before-100_00)
		}
	})

	t.Run("an expense cannot name a worker at all", func(t *testing.T) {
		// Not "the handler ignores it": the field does not exist, and decode
		// rejects unknown fields, so this is a 400 rather than a silent drop.
		res := h.do(t, http.MethodPost, "/v1/expenses", f.OwnerToken, map[string]any{
			"concept": "Deuda disfrazada", "amountCents": 1000,
			"plotId": plot, "workerId": worker,
		})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("an expense naming a worker: got %d %s, want 400", res.Status, res.Raw)
		}
	})

	t.Run("and the table has no column for one", func(t *testing.T) {
		h.withTenant(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
			func(ctx context.Context, tx pgx.Tx) {
				var n int
				err := tx.QueryRow(ctx, `
					SELECT count(*) FROM information_schema.columns
					 WHERE table_name = 'expenses'
					   AND column_name IN ('employee_id', 'worker_id', 'person_id')`).Scan(&n)
				if err != nil {
					t.Fatalf("query: %v", err)
				}
				if n != 0 {
					t.Fatalf("expenses has %d column(s) pointing at a person. "+
						"That is the door this whole design closes.", n)
				}
			})
	})
}

// TestAnExpenseIsChargedToExactlyOneThing is RSP-031's select as a rule.
func TestAnExpenseIsChargedToExactlyOneThing(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de imputacion", 80000)
	plot := h.createPlot(t, f, "Lote imputado")
	activity := h.harvestActivityID(t, f)

	t.Run("to neither is refused", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/expenses", f.OwnerToken, map[string]any{
			"concept": "Sin imputar", "amountCents": 1000,
		})
		if res.code() != string(domain.CodeExpenseTargetInvalid) {
			t.Fatalf("got %d %s, want EXPENSE_TARGET_INVALID.\n"+
				"An expense charged to nothing appears in the total and in no "+
				"breakdown, and the gap is what nobody can explain in March.",
				res.Status, res.Raw)
		}
	})

	t.Run("to both is refused", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/expenses", f.OwnerToken, map[string]any{
			"concept": "Doble", "amountCents": 1000,
			"plotId": plot, "activityId": activity,
		})
		if res.code() != string(domain.CodeExpenseTargetInvalid) {
			t.Fatalf("got %d %s, want EXPENSE_TARGET_INVALID", res.Status, res.Raw)
		}
	})

	t.Run("the database refuses it too, not only the handler", func(t *testing.T) {
		h.withTenant(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
			func(ctx context.Context, tx pgx.Tx) {
				_, err := tx.Exec(ctx, `
					INSERT INTO expenses (id, farm_id, concept, amount_minor, local_day)
					VALUES ($1, $2, 'sin imputar', 1000, current_date)`,
					uuid.NewString(), f.FarmID)
				if err == nil {
					t.Error("an expense charged to nothing went straight into the table")
				}
			})
	})

	t.Run("the imputation can move from an activity to a plot", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/expenses", f.OwnerToken, map[string]any{
			"concept": "Jornales extra", "amountCents": 50_000, "activityId": activity,
		}, http.StatusCreated)
		id := mustString(t, res.Body, "id")
		if res.Body["target"] != "activity" {
			t.Fatalf("target is %v, want activity", res.Body["target"])
		}

		// Field by field this would be impossible: the old activityId would
		// survive the patch and expense_target would refuse the result.
		moved := h.mustDo(t, http.MethodPatch, "/v1/expenses/"+id, f.OwnerToken,
			map[string]any{"plotId": plot}, http.StatusOK)
		if moved.Body["target"] != "plot" {
			t.Fatalf("target is %v after retargeting, want plot: %s",
				moved.Body["target"], moved.Raw)
		}
		if moved.Body["activityId"] != nil {
			t.Fatalf("the old activity survived the retarget: %s", moved.Raw)
		}
	})

	t.Run("deleting leaves the expense inactive, and it comes back", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/expenses", f.OwnerToken, map[string]any{
			"concept": "Borrable", "amountCents": 7000, "plotId": plot,
		}, http.StatusCreated)
		id := mustString(t, res.Body, "id")

		h.mustDo(t, http.MethodDelete, "/v1/expenses/"+id, f.OwnerToken, nil, http.StatusNoContent)
		live := h.mustDo(t, http.MethodGet, "/v1/expenses", f.OwnerToken, nil, http.StatusOK)
		if strings.Contains(live.Raw, id) {
			t.Fatalf("a deleted expense is still in the live list: %s", live.Raw)
		}
		all := h.mustDo(t, http.MethodGet, "/v1/expenses?status=all", f.OwnerToken, nil, http.StatusOK)
		if !strings.Contains(all.Raw, id) {
			t.Fatalf("the row was really deleted; it should only be inactive: %s", all.Raw)
		}
		h.mustDo(t, http.MethodPatch, "/v1/expenses/"+id, f.OwnerToken,
			map[string]any{"status": "active"}, http.StatusOK)
	})
}

// ---------------------------------------------------------------------------
// The credible zero, in this sprint's modules
// ---------------------------------------------------------------------------

// TestInventoryEndpointsThatAddUpConfirmTheResourceFirst is
// TestEveryEndpointThatAddsUpConfirmsTheWorkerFirst for the new modules.
//
// Every endpoint below ends in a SUM or a list. Over an id of another farm, a
// SUM returns 0 and a list returns [] — because RLS narrows rows rather than
// raising, which is exactly the silence it is designed to give. "There are no
// sacks in that warehouse" and "we have sold none of that" are entirely
// credible answers, and both are false. Two ids that must behave identically:
// a real product of another farm, and one that never existed anywhere.
func TestInventoryEndpointsThatAddUpConfirmTheResourceFirst(t *testing.T) {
	h := requireDB(t)
	mine := h.signupFarm(t, "Finca propia inv", 80000)
	theirs := h.signupFarm(t, "Finca vecina inv", 80000)

	myInv := h.seedInventory(t, mine, "Mi cafe", "Mi bodega")
	theirInv := h.seedInventory(t, theirs, "Su cafe", "Su bodega")
	ghost := uuid.NewString()

	// Their warehouse really does have coffee in it, so a zero here would be a
	// lie about a real stock and not merely about an empty row.
	h.move(t, theirs, theirInv, "cosecha", 900, nil)
	h.mustDo(t, http.MethodPost, "/v1/sales", theirs.OwnerToken, map[string]any{
		"productId": theirInv.ProductID, "warehouseId": theirInv.WarehouseID,
		"qty": 5, "amountCents": 100000,
	}, http.StatusCreated)
	theirPlot := h.createPlot(t, theirs, "Su lote")
	h.mustDo(t, http.MethodPost, "/v1/expenses", theirs.OwnerToken, map[string]any{
		"concept": "Su gasto", "amountCents": 999_999, "plotId": theirPlot,
	}, http.StatusCreated)

	reads := []struct {
		name string
		path func(string) string
	}{
		{"product stock", func(id string) string { return "/v1/products/" + id + "/stock" }},
		{"product", func(id string) string { return "/v1/products/" + id }},
		{"stock by product", func(id string) string { return "/v1/stock?productId=" + id }},
		{"movements by product", func(id string) string { return "/v1/stock/moves?productId=" + id }},
		{"sales by product", func(id string) string { return "/v1/sales?productId=" + id }},
	}
	for _, r := range reads {
		for _, subject := range []struct{ label, id string }{
			{"another farm's product", theirInv.ProductID},
			{"a product that never existed", ghost},
		} {
			t.Run(r.name+" of "+subject.label, func(t *testing.T) {
				res := h.do(t, http.MethodGet, r.path(subject.id), mine.OwnerToken, nil)
				if res.Status != http.StatusNotFound {
					t.Fatalf("got %d, want 404. A zero or an empty list here is a "+
						"credible answer and a false one: %s", res.Status, res.Raw)
				}
			})
		}
	}

	t.Run("warehouse of another farm", func(t *testing.T) {
		res := h.do(t, http.MethodGet, "/v1/stock?warehouseId="+theirInv.WarehouseID,
			mine.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Fatalf("got %d %s, want 404", res.Status, res.Raw)
		}
	})

	t.Run("expenses filtered by another farm's plot", func(t *testing.T) {
		res := h.do(t, http.MethodGet, "/v1/expenses?plotId="+theirPlot, mine.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Fatalf("got %d %s, want 404 rather than an empty list totalling zero",
				res.Status, res.Raw)
		}
	})

	t.Run("a sale of another farm's product", func(t *testing.T) {
		// The write has the same shape: it confirms before it derives. Without
		// the guard this answers INSUFFICIENT_STOCK, which looks like a
		// business rule and is really a tenant leak wearing a hat.
		res := h.do(t, http.MethodPost, "/v1/sales", mine.OwnerToken, map[string]any{
			"productId": theirInv.ProductID, "warehouseId": theirInv.WarehouseID,
			"qty": 1, "amountCents": 1000,
		})
		if res.Status != http.StatusNotFound {
			t.Fatalf("got %d %s, want 404", res.Status, res.Raw)
		}
	})

	t.Run("a movement into another farm's warehouse", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/stock/moves", mine.OwnerToken, map[string]any{
			"productId": myInv.ProductID, "warehouseId": theirInv.WarehouseID,
			"reason": "cosecha", "qty": 1,
		})
		if res.Status != http.StatusNotFound {
			t.Fatalf("got %d %s, want 404", res.Status, res.Raw)
		}
	})

	t.Run("an expense charged to another farm's plot", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/expenses", mine.OwnerToken, map[string]any{
			"concept": "Ajeno", "amountCents": 1000, "plotId": theirPlot,
		})
		if res.Status != http.StatusNotFound {
			t.Fatalf("got %d %s, want 404", res.Status, res.Raw)
		}
	})

	t.Run("our own still answers", func(t *testing.T) {
		for _, r := range reads {
			h.mustDo(t, http.MethodGet, r.path(myInv.ProductID), mine.OwnerToken, nil, http.StatusOK)
		}
	})

	t.Run("the database refuses across the border too", func(t *testing.T) {
		h.withTenant(t, mine.FarmID, mine.OwnerUserID, domain.RoleOwner,
			func(ctx context.Context, tx pgx.Tx) {
				for _, table := range []string{"products", "stock_moves", "sales", "expenses"} {
					var n int
					if err := tx.QueryRow(ctx,
						`SELECT count(*) FROM `+table+` WHERE farm_id = $1`, theirs.FarmID).Scan(&n); err != nil {
						t.Fatalf("count %s: %v", table, err)
					}
					if n != 0 {
						t.Errorf("RLS let our farm count %d rows of theirs in %s", n, table)
					}
				}
			})
	})
}

// TestWeigherSeesNoSalesExpensesOrStock is the sprint's half of the rule that
// docs/modelo-datos.md §9 states: ventas, gastos and stock_moves are outside
// the weigher's reach with the same shape as the ledger.
//
// The contract test already asserts 403 on every route marked Money. This one
// checks the layer underneath — the RLS policies — so that the guarantee does
// not rest on a flag in a Go table.
func TestWeigherSeesNoSalesExpensesOrStock(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca sin pesador", 80000)
	inv := h.seedInventory(t, f, "Cafe vedado", "Bodega vedada")
	h.move(t, f, inv, "cosecha", 100, nil)
	plot := h.createPlot(t, f, "Lote vedado")
	h.mustDo(t, http.MethodPost, "/v1/expenses", f.OwnerToken, map[string]any{
		"concept": "Gasto vedado", "amountCents": 1000, "plotId": plot,
	}, http.StatusCreated)
	h.mustDo(t, http.MethodPost, "/v1/sales", f.OwnerToken, map[string]any{
		"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
		"qty": 1, "amountCents": 1000,
	}, http.StatusCreated)

	t.Run("the routes refuse him", func(t *testing.T) {
		for _, path := range []string{
			"/v1/products", "/v1/stock", "/v1/stock/moves", "/v1/sales",
			"/v1/expenses", "/v1/warehouses", "/v1/customers",
			"/v1/catalogs/product-categories", "/v1/catalogs/storage-units",
		} {
			res := h.do(t, http.MethodGet, path, f.WeigherToken, nil)
			if res.Status != http.StatusForbidden {
				t.Errorf("weigher on GET %s: got %d, want 403: %s", path, res.Status, res.Raw)
			}
		}
	})

	t.Run("and so does the database, one layer down", func(t *testing.T) {
		h.withTenant(t, f.FarmID, f.WeigherID, domain.RoleWeigher,
			func(ctx context.Context, tx pgx.Tx) {
				for _, table := range []string{"products", "stock_moves", "sales", "expenses", "customers"} {
					var n int
					if err := tx.QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&n); err != nil {
						t.Fatalf("count %s as the weigher: %v", table, err)
					}
					if n != 0 {
						t.Errorf("the weigher's own transaction can read %d rows of %s. "+
							"The middleware says no; the RLS policy has to say it too.", n, table)
					}
				}
			})
	})
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

// putBytes sends a raw body, which the JSON helper cannot do.
func (h *harness) putBytes(t *testing.T, path, token string, body []byte) response {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, path, bytes.NewReader(body))
	req.RemoteAddr = "10.0.0.1:12345"
	req.Header.Set("Content-Type", "application/octet-stream")
	req.ContentLength = int64(len(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	out := response{Status: rec.Code, Raw: rec.Body.String()}
	if out.Raw != "" {
		_ = json.Unmarshal([]byte(out.Raw), &out.Body)
	}
	return out
}

// pngOf builds a body that begins with a real PNG signature, so the server's
// sniffing has something honest to find, padded to the size the test wants.
func pngOf(size int) []byte {
	head := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}
	out := make([]byte, size)
	copy(out, head)
	return out
}

// TestUploadLimitIsEnforcedOnTheBytesThatArrive is the point of the whole
// upload design.
//
// RSP-004 says "hasta 5 MB". A limit checked when the URL is handed out is a
// limit checked against a number the client typed, and a client that lies gets
// to store whatever it likes. So the size that ends up on the row is the one
// the SERVER counted, and the media type is the one the SERVER sniffed.
func TestUploadLimitIsEnforcedOnTheBytesThatArrive(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de fotos", 80000)

	newTicket := func(t *testing.T, declared int64) (string, string) {
		t.Helper()
		res := h.mustDo(t, http.MethodPost, "/v1/uploads", f.OwnerToken, map[string]any{
			"purpose": "sale-receipt", "filename": "recibo.png",
			"contentType": "image/png", "bytes": declared,
		}, http.StatusCreated)
		a, _ := res.Body["attachment"].(map[string]any)
		return mustString(t, a, "id"), mustString(t, res.Body, "uploadUrl")
	}

	t.Run("a small honest file goes through", func(t *testing.T) {
		id, url := newTicket(t, 2048)
		res := h.putBytes(t, url, f.OwnerToken, pngOf(2048))
		if res.Status != http.StatusOK {
			t.Fatalf("upload: got %d %s, want 200", res.Status, res.Raw)
		}
		if res.Body["status"] != "ready" {
			t.Fatalf("status is %v, want ready: %s", res.Body["status"], res.Raw)
		}
		if res.Body["bytes"] != 2048.0 {
			t.Fatalf("bytes is %v, want the 2048 the server counted", res.Body["bytes"])
		}
		if res.Body["contentType"] != "image/png" {
			t.Fatalf("contentType is %v, want the sniffed image/png", res.Body["contentType"])
		}
		got := h.mustDo(t, http.MethodGet, "/v1/uploads/"+id, f.OwnerToken, nil, http.StatusOK)
		if got.Body["status"] != "ready" {
			t.Fatalf("the stored row is %v: %s", got.Body["status"], got.Raw)
		}
	})

	t.Run("a file that LIES about its size is refused when it arrives", func(t *testing.T) {
		// This is the case the whole design exists for: the ticket was asked
		// for with an honest-looking 1 KB, and six megabytes turn up.
		_, url := newTicket(t, 1024)
		res := h.putBytes(t, url, f.OwnerToken, pngOf(6*1024*1024))
		if res.Status != http.StatusRequestEntityTooLarge {
			t.Fatalf("6 MB after declaring 1 KB: got %d %s, want 413.\n"+
				"The limit that counts is the one applied to the bytes that arrived.",
				res.Status, res.Raw)
		}
		if res.code() != string(domain.CodeUploadTooLarge) {
			t.Fatalf("got code %q, want UPLOAD_TOO_LARGE: %s", res.code(), res.Raw)
		}
	})

	t.Run("exactly at the limit is accepted, one byte over is not", func(t *testing.T) {
		_, url := newTicket(t, 0)
		if res := h.putBytes(t, url, f.OwnerToken, pngOf(5*1024*1024)); res.Status != http.StatusOK {
			t.Fatalf("exactly 5 MB: got %d %s, want 200", res.Status, res.Raw)
		}
		_, url2 := newTicket(t, 0)
		res := h.putBytes(t, url2, f.OwnerToken, pngOf(5*1024*1024+1))
		if res.Status != http.StatusRequestEntityTooLarge {
			t.Fatalf("5 MB plus one byte: got %d %s, want 413.\n"+
				"Reading exactly the limit and stopping would store a truncated file "+
				"with no error anywhere.", res.Status, res.Raw)
		}
	})

	t.Run("the media type is what the bytes say, not what the header claimed", func(t *testing.T) {
		_, url := newTicket(t, 16)
		res := h.putBytes(t, url, f.OwnerToken, []byte("MZ\x90\x00 not a photograph at all"))
		if res.Status != http.StatusUnsupportedMediaType {
			t.Fatalf("an executable declared as image/png: got %d %s, want 415",
				res.Status, res.Raw)
		}
	})

	t.Run("a pending attachment cannot be hung on a sale", func(t *testing.T) {
		id, _ := newTicket(t, 1024) // no bytes ever sent
		inv := h.seedInventory(t, f, "Cafe con recibo", "Bodega recibo")
		h.move(t, f, inv, "cosecha", 10, nil)

		res := h.do(t, http.MethodPost, "/v1/sales", f.OwnerToken, map[string]any{
			"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
			"qty": 1, "amountCents": 1000, "receiptId": id,
		})
		if res.code() != string(domain.CodeUploadNotReady) {
			t.Fatalf("a sale pointing at an empty upload: got %d %s, want UPLOAD_NOT_READY.\n"+
				"Otherwise the screen shows a broken image and nobody can tell "+
				"whether the photo was lost or never taken.", res.Status, res.Raw)
		}
	})

	t.Run("a ready one can, and comes back", func(t *testing.T) {
		id, url := newTicket(t, 1024)
		h.putBytes(t, url, f.OwnerToken, pngOf(1024))

		inv := h.seedInventory(t, f, "Cafe con foto", "Bodega foto")
		h.move(t, f, inv, "cosecha", 10, nil)
		sale := h.mustDo(t, http.MethodPost, "/v1/sales", f.OwnerToken, map[string]any{
			"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
			"qty": 1, "amountCents": 1000, "receiptId": id,
		}, http.StatusCreated)
		if mustString(t, sale.Body, "receiptId") != id {
			t.Fatalf("the receipt did not stick: %s", sale.Raw)
		}

		req := httptest.NewRequest(http.MethodGet, "/v1/uploads/"+id+"/content", nil)
		req.Header.Set("Authorization", "Bearer "+f.OwnerToken)
		rec := httptest.NewRecorder()
		h.server.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("fetching the bytes: got %d %s", rec.Code, rec.Body.String())
		}
		if rec.Body.Len() != 1024 {
			t.Fatalf("got %d bytes back, want 1024", rec.Body.Len())
		}
		if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
			t.Fatalf("Content-Type is %q, want image/png", ct)
		}
	})

	t.Run("another farm's attachment is 404 before the disk is touched", func(t *testing.T) {
		other := h.signupFarm(t, "Finca ajena fotos", 80000)
		id, url := newTicket(t, 1024)
		h.putBytes(t, url, f.OwnerToken, pngOf(1024))

		for _, path := range []string{"/v1/uploads/" + id, "/v1/uploads/" + id + "/content"} {
			res := h.do(t, http.MethodGet, path, other.OwnerToken, nil)
			if res.Status != http.StatusNotFound {
				t.Fatalf("another farm reading %s: got %d %s, want 404", path, res.Status, res.Raw)
			}
		}
		res := h.putBytes(t, url, other.OwnerToken, pngOf(16))
		if res.Status != http.StatusNotFound {
			t.Fatalf("another farm writing the bytes: got %d %s, want 404", res.Status, res.Raw)
		}
	})
}

var _ = fmt.Sprintf

// TestAPlainDateIsAcceptedWhereTheContractPromisesOne pins the shape of a
// business date. openapi.yaml declares localDay as `format: date`, and until
// this test the handlers decoded into time.Time, which only reads RFC 3339: a
// client that sent the `2026-08-25` the contract asked for got a 400 that named
// no field, and had to guess. Sending an instant for a day is also wrong on its
// own terms — a day in Pitalito is not a moment, and which moment you pick is
// what decides the week a picker gets paid in.
func TestAPlainDateIsAcceptedWhereTheContractPromisesOne(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de fechas", 80000)
	inv := h.seedInventory(t, f, "Cafe pergamino", "Bodega")
	plot := h.createPlot(t, f, "Lote de fechas")

	for _, day := range []any{"2026-08-25", "2026-08-25T14:30:00-05:00"} {
		res := h.mustDo(t, http.MethodPost, "/v1/stock/moves", f.OwnerToken, map[string]any{
			"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
			"reason": "cosecha", "qty": 5, "plotId": plot, "localDay": day,
		}, http.StatusCreated)
		move, _ := res.Body["move"].(map[string]any)
		if move == nil {
			t.Fatalf("no move in the response: %s", res.Raw)
		}
		// Both land on the 25th. The second matters on its own: 14:30 in
		// Colombia is 19:30 UTC, and a naive read would file it on the 26th —
		// the timezone slip that cost a picker a week's price once already.
		if got := move["localDay"]; got != "2026-08-25T00:00:00Z" && got != "2026-08-25" {
			t.Fatalf("sent %v, the movement came back on %v", day, got)
		}
	}

	// And a date that is not one still fails saying which field.
	res := h.do(t, http.MethodPost, "/v1/expenses", f.OwnerToken, map[string]any{
		"concept": "Fumigacion", "amountCents": 100000,
		"plotId": plot, "localDay": "el martes",
	})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("a nonsense date got %d, want 400: %s", res.Status, res.Raw)
	}
	if !strings.Contains(res.Raw, "localDay") {
		t.Fatalf("the 400 does not name the field: %s", res.Raw)
	}
}

// TestAWorkRecordAlwaysKnowsWhatItIsWorth covers what made the console show $0
// against every harvest record it listed, settled ones included.
//
// A record paid at the week's price has no amount of its own until the week is
// settled — that is correct, and it is why `amountCents` is nullable. But a
// list that renders that null as a figure says the farm owes nothing when it
// owes a week of picking, and it says it with the same confidence as the truth.
func TestAWorkRecordAlwaysKnowsWhatItIsWorth(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del cero visible", 80000)
	w := h.createWorker(t, f, "Rosa", "1099000777")
	p := h.createPlot(t, f, "Lote del cero")
	act := h.harvestActivityID(t, f)

	h.mustDo(t, http.MethodPost, "/v1/work-records", f.OwnerToken, map[string]any{
		"activityId": act, "workerId": w, "quantity": 100,
		"dateFrom": "2026-08-25", "dateTo": "2026-08-25", "plotIds": []string{p},
	}, http.StatusCreated)

	read := func() map[string]any {
		res := h.mustDo(t, http.MethodGet, "/v1/work-records", f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("%d records, want 1: %s", len(items), res.Raw)
		}
		return items[0].(map[string]any)
	}

	// Unsettled: no frozen amount, but 100 kg at 800 pesos is not unknowable.
	r := read()
	if r["amountCents"] != nil {
		t.Fatalf("an unsettled weekly-price record froze an amount: %v", r["amountCents"])
	}
	if got := r["estimatedAmountCents"]; got != float64(8_000_000) {
		t.Fatalf("100kg at 800 is worth %v, want 8000000", got)
	}
	if r["amountIsEstimate"] != true {
		t.Fatal("an unsettled amount is an estimate and has to say so")
	}

	// Settled: the same number, now final rather than an estimate.
	h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": w, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated)

	r = read()
	if got := r["estimatedAmountCents"]; got != float64(8_000_000) {
		t.Fatalf("settling changed what the record is worth: %v", got)
	}
	if r["amountIsEstimate"] != false {
		t.Fatal("a settled amount is not an estimate any more")
	}
}
