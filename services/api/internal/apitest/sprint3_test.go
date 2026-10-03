// SPDX-License-Identifier: MIT

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
	s := stockOnHandFixture{h: h, f: f, inv: inv}

	t.Run("a harvest comes in and a merma goes out", func(t *testing.T) {
		stockOnHandHarvestAndMerma(t, s)
	})
	t.Run("the product list carries the same derived number", func(t *testing.T) {
		stockOnHandProductListMatches(t, s)
	})
	t.Run("a harvest that increases nothing is refused by the database", func(t *testing.T) {
		stockOnHandNegativeHarvestRefused(t, s)
	})
	t.Run("movements cannot be edited or deleted at all", func(t *testing.T) {
		stockOnHandMovesImmutable(t, s)
	})
	t.Run("a mistake is corrected with its opposite, once", func(t *testing.T) {
		stockOnHandReversalOnce(t, s)
	})
	t.Run("taking out more than there is needs saying so", func(t *testing.T) {
		stockOnHandInsufficientNeedsOverride(t, s)
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
	s := saleStockFixture{h: h, f: f, inv: inv, saleID: &saleID}

	t.Run("selling takes the coffee out of the warehouse", func(t *testing.T) {
		saleStockSellingTakesCoffeeOut(t, s)
	})
	t.Run("a 'venta' movement cannot be written by hand", func(t *testing.T) {
		saleStockHandWrittenVentaRefused(t, s)
	})
	t.Run("the quantity of a sale cannot be edited", func(t *testing.T) {
		saleStockQtyCannotBeEdited(t, s)
	})
	t.Run("voiding a sale puts the coffee back", func(t *testing.T) {
		saleStockVoidPutsCoffeeBack(t, s)
	})
	t.Run("a voided sale is not restored", func(t *testing.T) {
		saleStockVoidedNotRestored(t, s)
	})
	t.Run("the totals count the live sales only", func(t *testing.T) {
		saleStockTotalsCountLiveOnly(t, s)
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
	e := expenseTargetFixture{h: h, f: f, plot: plot, activity: activity}

	t.Run("to neither is refused", func(t *testing.T) { expenseTargetNeitherRefused(t, e) })
	t.Run("to both is refused", func(t *testing.T) { expenseTargetBothRefused(t, e) })
	t.Run("the database refuses it too, not only the handler", func(t *testing.T) {
		expenseTargetDBRefusesToo(t, e)
	})
	t.Run("the imputation can move from an activity to a plot", func(t *testing.T) {
		expenseTargetRetargetActivityToPlot(t, e)
	})
	t.Run("deleting leaves the expense inactive, and it comes back", func(t *testing.T) {
		expenseTargetDeleteLeavesInactive(t, e)
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
	fx := invConfirmFixture{
		h: h, mine: mine, theirs: theirs, myInv: myInv, theirInv: theirInv,
		ghost: ghost, theirPlot: theirPlot, reads: reads,
	}

	invConfirmCrossFarmReads404(t, fx)
	t.Run("warehouse of another farm", func(t *testing.T) { invConfirmWarehouseOfOtherFarm(t, fx) })
	t.Run("expenses filtered by another farm's plot", func(t *testing.T) { invConfirmExpensesOtherPlot(t, fx) })
	t.Run("a sale of another farm's product", func(t *testing.T) { invConfirmSaleOtherProduct(t, fx) })
	t.Run("a movement into another farm's warehouse", func(t *testing.T) { invConfirmMoveOtherWarehouse(t, fx) })
	t.Run("an expense charged to another farm's plot", func(t *testing.T) { invConfirmExpenseOtherPlot(t, fx) })
	t.Run("our own still answers", func(t *testing.T) { invConfirmOwnStillAnswers(t, fx) })
	t.Run("the database refuses across the border too", func(t *testing.T) { invConfirmDBRefusesAcrossBorder(t, fx) })
}

// TestWeigherSeesNoSalesExpensesOrStock is the sprint's half of the rule that
// docs/data-model.md §9 states: ventas, gastos and stock_moves are outside
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
	w := weigherMoneyFixture{h: h, f: f}

	t.Run("the routes refuse him", func(t *testing.T) { weigherMoneyRoutesRefuse(t, w) })
	t.Run("and so does the database, one layer down", func(t *testing.T) { weigherMoneyDBRefuses(t, w) })
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
	u := uploadLimitFixture{h: h, f: f}

	t.Run("a small honest file goes through", func(t *testing.T) { uploadLimitSmallHonest(t, u) })
	t.Run("a file that LIES about its size is refused when it arrives", func(t *testing.T) {
		uploadLimitLieAboutSize(t, u)
	})
	t.Run("exactly at the limit is accepted, one byte over is not", func(t *testing.T) {
		uploadLimitExactBoundary(t, u)
	})
	t.Run("the media type is what the bytes say, not what the header claimed", func(t *testing.T) {
		uploadLimitMediaTypeFromBytes(t, u)
	})
	t.Run("a pending attachment cannot be hung on a sale", func(t *testing.T) {
		uploadLimitPendingCannotHangOnSale(t, u)
	})
	t.Run("a ready one can, and comes back", func(t *testing.T) {
		uploadLimitReadyHangsAndComesBack(t, u)
	})
	t.Run("another farm's attachment is 404 before the disk is touched", func(t *testing.T) {
		uploadLimitOtherFarm404(t, u)
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
