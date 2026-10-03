package apitest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// ---------------------------------------------------------------------------
// Helpers extracted so each Test* stays under SonarQube's cognitive-complexity
// budget (go:S3776). Behavior is unchanged: same setup, same assertions.
// ---------------------------------------------------------------------------

type stockOnHandFixture struct {
	h   *harness
	f   *farmFixture
	inv inventoryFixture
}

func stockOnHandHarvestAndMerma(t *testing.T, s stockOnHandFixture) {
	t.Helper()
	h, f, inv := s.h, s.f, s.inv
	h.move(t, f, inv, "cosecha", 100, nil)
	if got := h.stockOf(t, f, inv.ProductID); got != 100 {
		t.Fatalf("stock is %v after a harvest of 100, want 100", got)
	}
	h.move(t, f, inv, "merma", 12, nil)
	if got := h.stockOf(t, f, inv.ProductID); got != 88 {
		t.Fatalf("stock is %v after a merma of 12, want 88", got)
	}
}

func stockOnHandProductListMatches(t *testing.T, s stockOnHandFixture) {
	t.Helper()
	h, f := s.h, s.f
	res := h.mustDo(t, http.MethodGet, "/v1/products", f.OwnerToken, nil, http.StatusOK)
	items, _ := res.Body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("want 1 product, got %d: %s", len(items), res.Raw)
	}
	row := items[0].(map[string]any)
	if row["stock"] != 88.0 {
		t.Fatalf("the list says %v, the per-product read says 88: %s", row["stock"], res.Raw)
	}
}

func stockOnHandNegativeHarvestRefused(t *testing.T, s stockOnHandFixture) {
	t.Helper()
	h, f, inv := s.h, s.f, s.inv
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
}

func stockOnHandMovesImmutable(t *testing.T, s stockOnHandFixture) {
	t.Helper()
	h, f := s.h, s.f
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
}

func stockOnHandReversalOnce(t *testing.T, s stockOnHandFixture) {
	t.Helper()
	h, f, inv := s.h, s.f, s.inv
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
}

func stockOnHandInsufficientNeedsOverride(t *testing.T, s stockOnHandFixture) {
	t.Helper()
	h, f, inv := s.h, s.f, s.inv
	res := h.do(t, http.MethodPost, "/v1/stock/moves", f.OwnerToken, map[string]any{
		"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
		"reason": "consumo", "qty": 1000,
	})
	if res.code() != string(domain.CodeInsufficientStock) {
		t.Fatalf("consuming 1000 of 88: got %d %s, want INSUFFICIENT_STOCK", res.Status, res.Raw)
	}
	h.mustDo(t, http.MethodPost, "/v1/stock/moves", f.OwnerToken, map[string]any{
		"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
		"reason": "consumo", "qty": 1000, "allowNegative": true,
	}, http.StatusCreated)
	if got := h.stockOf(t, f, inv.ProductID); got != -912 {
		t.Fatalf("stock is %v, want -912: the override did not take", got)
	}
}

type saleStockFixture struct {
	h      *harness
	f      *farmFixture
	inv    inventoryFixture
	saleID *string
}

func saleStockSellingTakesCoffeeOut(t *testing.T, s saleStockFixture) {
	t.Helper()
	h, f, inv := s.h, s.f, s.inv
	res := h.mustDo(t, http.MethodPost, "/v1/sales", f.OwnerToken, map[string]any{
		"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
		"qty": 120, "amountCents": 96_000_00, "customer": "Cooperativa del Sur",
	}, http.StatusCreated)
	*s.saleID = mustString(t, res.Body, "id")

	if res.Body["stockMoveId"] == nil {
		t.Fatalf("the sale wrote no stock movement: %s", res.Raw)
	}
	if got := h.stockOf(t, f, inv.ProductID); got != 380 {
		t.Fatalf("stock is %v after selling 120 of 500, want 380", got)
	}
	cs := h.mustDo(t, http.MethodGet, "/v1/customers", f.OwnerToken, nil, http.StatusOK)
	items, _ := cs.Body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("want 1 customer, got %d: %s", len(items), cs.Raw)
	}
}

func saleStockHandWrittenVentaRefused(t *testing.T, s saleStockFixture) {
	t.Helper()
	h, f, inv := s.h, s.f, s.inv
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
}

func saleStockQtyCannotBeEdited(t *testing.T, s saleStockFixture) {
	t.Helper()
	h, f := s.h, s.f
	saleID := *s.saleID
	res := h.do(t, http.MethodPatch, "/v1/sales/"+saleID, f.OwnerToken,
		map[string]any{"qty": 5})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("editing qty: got %d %s, want 400 telling us to void and re-record",
			res.Status, res.Raw)
	}
	if got := h.stockOf(t, f, s.inv.ProductID); got != 380 {
		t.Fatalf("the refused patch moved the stock: %v", got)
	}
	h.mustDo(t, http.MethodPatch, "/v1/sales/"+saleID, f.OwnerToken,
		map[string]any{"amountCents": 97_000_00}, http.StatusOK)
}

func saleStockVoidPutsCoffeeBack(t *testing.T, s saleStockFixture) {
	t.Helper()
	h, f := s.h, s.f
	saleID := *s.saleID
	res := h.mustDo(t, http.MethodDelete, "/v1/sales/"+saleID, f.OwnerToken, nil, http.StatusOK)
	if res.Body["voidedAt"] == nil {
		t.Fatalf("the sale is not marked void: %s", res.Raw)
	}
	if res.Body["reversalMoveId"] == nil {
		t.Fatalf("voiding wrote no reversing movement: %s", res.Raw)
	}
	if got := h.stockOf(t, f, s.inv.ProductID); got != 500 {
		t.Fatalf("stock is %v after voiding, want 500. A void that only flags "+
			"the row leaves the coffee sold in one list and gone from the other.", got)
	}

	second := h.do(t, http.MethodDelete, "/v1/sales/"+saleID, f.OwnerToken, nil)
	if second.code() != string(domain.CodeSaleAlreadyVoid) {
		t.Fatalf("second void: got %d %s, want SALE_ALREADY_VOID", second.Status, second.Raw)
	}
	if got := h.stockOf(t, f, s.inv.ProductID); got != 500 {
		t.Fatalf("the refused void moved the stock again: %v", got)
	}
}

func saleStockVoidedNotRestored(t *testing.T, s saleStockFixture) {
	t.Helper()
	h, f := s.h, s.f
	res := h.do(t, http.MethodPatch, "/v1/sales/"+*s.saleID, f.OwnerToken,
		map[string]any{"status": "active"})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("un-voiding: got %d %s, want 400", res.Status, res.Raw)
	}
}

func saleStockTotalsCountLiveOnly(t *testing.T, s saleStockFixture) {
	t.Helper()
	h, f, inv := s.h, s.f, s.inv
	h.mustDo(t, http.MethodPost, "/v1/sales", f.OwnerToken, map[string]any{
		"productId": inv.ProductID, "warehouseId": inv.WarehouseID,
		"qty": 10, "amountCents": 8_000_00,
	}, http.StatusCreated)

	res := h.mustDo(t, http.MethodGet, "/v1/sales?status=all", f.OwnerToken, nil, http.StatusOK)
	if got := mustInt(t, res.Body, "totalCents"); got != 8_000_00 {
		t.Fatalf("totalCents is %d, want only the live sale's 800000: %s", got, res.Raw)
	}
}

type expenseTargetFixture struct {
	h        *harness
	f        *farmFixture
	plot     string
	activity string
}

func expenseTargetNeitherRefused(t *testing.T, e expenseTargetFixture) {
	t.Helper()
	h, f := e.h, e.f
	res := h.do(t, http.MethodPost, "/v1/expenses", f.OwnerToken, map[string]any{
		"concept": "Sin imputar", "amountCents": 1000,
	})
	if res.code() != string(domain.CodeExpenseTargetInvalid) {
		t.Fatalf("got %d %s, want EXPENSE_TARGET_INVALID.\n"+
			"An expense charged to nothing appears in the total and in no "+
			"breakdown, and the gap is what nobody can explain in March.",
			res.Status, res.Raw)
	}
}

func expenseTargetBothRefused(t *testing.T, e expenseTargetFixture) {
	t.Helper()
	h, f := e.h, e.f
	res := h.do(t, http.MethodPost, "/v1/expenses", f.OwnerToken, map[string]any{
		"concept": "Doble", "amountCents": 1000,
		"plotId": e.plot, "activityId": e.activity,
	})
	if res.code() != string(domain.CodeExpenseTargetInvalid) {
		t.Fatalf("got %d %s, want EXPENSE_TARGET_INVALID", res.Status, res.Raw)
	}
}

func expenseTargetDBRefusesToo(t *testing.T, e expenseTargetFixture) {
	t.Helper()
	h, f := e.h, e.f
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
}

func expenseTargetRetargetActivityToPlot(t *testing.T, e expenseTargetFixture) {
	t.Helper()
	h, f := e.h, e.f
	res := h.mustDo(t, http.MethodPost, "/v1/expenses", f.OwnerToken, map[string]any{
		"concept": "Jornales extra", "amountCents": 50_000, "activityId": e.activity,
	}, http.StatusCreated)
	id := mustString(t, res.Body, "id")
	if res.Body["target"] != "activity" {
		t.Fatalf("target is %v, want activity", res.Body["target"])
	}

	moved := h.mustDo(t, http.MethodPatch, "/v1/expenses/"+id, f.OwnerToken,
		map[string]any{"plotId": e.plot}, http.StatusOK)
	if moved.Body["target"] != "plot" {
		t.Fatalf("target is %v after retargeting, want plot: %s",
			moved.Body["target"], moved.Raw)
	}
	if moved.Body["activityId"] != nil {
		t.Fatalf("the old activity survived the retarget: %s", moved.Raw)
	}
}

func expenseTargetDeleteLeavesInactive(t *testing.T, e expenseTargetFixture) {
	t.Helper()
	h, f := e.h, e.f
	res := h.mustDo(t, http.MethodPost, "/v1/expenses", f.OwnerToken, map[string]any{
		"concept": "Borrable", "amountCents": 7000, "plotId": e.plot,
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
}

type invConfirmFixture struct {
	h         *harness
	mine      *farmFixture
	theirs    *farmFixture
	myInv     inventoryFixture
	theirInv  inventoryFixture
	ghost     string
	theirPlot string
	reads     []struct {
		name string
		path func(string) string
	}
}

func invConfirmCrossFarmReads404(t *testing.T, fx invConfirmFixture) {
	t.Helper()
	h, mine := fx.h, fx.mine
	for _, r := range fx.reads {
		for _, subject := range []struct{ label, id string }{
			{"another farm's product", fx.theirInv.ProductID},
			{"a product that never existed", fx.ghost},
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
}

func invConfirmWarehouseOfOtherFarm(t *testing.T, fx invConfirmFixture) {
	t.Helper()
	res := fx.h.do(t, http.MethodGet, "/v1/stock?warehouseId="+fx.theirInv.WarehouseID,
		fx.mine.OwnerToken, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("got %d %s, want 404", res.Status, res.Raw)
	}
}

func invConfirmExpensesOtherPlot(t *testing.T, fx invConfirmFixture) {
	t.Helper()
	res := fx.h.do(t, http.MethodGet, "/v1/expenses?plotId="+fx.theirPlot, fx.mine.OwnerToken, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("got %d %s, want 404 rather than an empty list totalling zero",
			res.Status, res.Raw)
	}
}

func invConfirmSaleOtherProduct(t *testing.T, fx invConfirmFixture) {
	t.Helper()
	res := fx.h.do(t, http.MethodPost, "/v1/sales", fx.mine.OwnerToken, map[string]any{
		"productId": fx.theirInv.ProductID, "warehouseId": fx.theirInv.WarehouseID,
		"qty": 1, "amountCents": 1000,
	})
	if res.Status != http.StatusNotFound {
		t.Fatalf("got %d %s, want 404", res.Status, res.Raw)
	}
}

func invConfirmMoveOtherWarehouse(t *testing.T, fx invConfirmFixture) {
	t.Helper()
	res := fx.h.do(t, http.MethodPost, "/v1/stock/moves", fx.mine.OwnerToken, map[string]any{
		"productId": fx.myInv.ProductID, "warehouseId": fx.theirInv.WarehouseID,
		"reason": "cosecha", "qty": 1,
	})
	if res.Status != http.StatusNotFound {
		t.Fatalf("got %d %s, want 404", res.Status, res.Raw)
	}
}

func invConfirmExpenseOtherPlot(t *testing.T, fx invConfirmFixture) {
	t.Helper()
	res := fx.h.do(t, http.MethodPost, "/v1/expenses", fx.mine.OwnerToken, map[string]any{
		"concept": "Ajeno", "amountCents": 1000, "plotId": fx.theirPlot,
	})
	if res.Status != http.StatusNotFound {
		t.Fatalf("got %d %s, want 404", res.Status, res.Raw)
	}
}

func invConfirmOwnStillAnswers(t *testing.T, fx invConfirmFixture) {
	t.Helper()
	for _, r := range fx.reads {
		fx.h.mustDo(t, http.MethodGet, r.path(fx.myInv.ProductID), fx.mine.OwnerToken, nil, http.StatusOK)
	}
}

func invConfirmDBRefusesAcrossBorder(t *testing.T, fx invConfirmFixture) {
	t.Helper()
	h, mine, theirs := fx.h, fx.mine, fx.theirs
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
}

type weigherMoneyFixture struct {
	h *harness
	f *farmFixture
}

func weigherMoneyRoutesRefuse(t *testing.T, w weigherMoneyFixture) {
	t.Helper()
	h, f := w.h, w.f
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
}

func weigherMoneyDBRefuses(t *testing.T, w weigherMoneyFixture) {
	t.Helper()
	h, f := w.h, w.f
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
}

type uploadLimitFixture struct {
	h *harness
	f *farmFixture
}

func (u uploadLimitFixture) newTicket(t *testing.T, declared int64) (string, string) {
	t.Helper()
	res := u.h.mustDo(t, http.MethodPost, "/v1/uploads", u.f.OwnerToken, map[string]any{
		"purpose": "sale-receipt", "filename": "recibo.png",
		"contentType": "image/png", "bytes": declared,
	}, http.StatusCreated)
	a, _ := res.Body["attachment"].(map[string]any)
	return mustString(t, a, "id"), mustString(t, res.Body, "uploadUrl")
}

func uploadLimitSmallHonest(t *testing.T, u uploadLimitFixture) {
	t.Helper()
	id, url := u.newTicket(t, 2048)
	res := u.h.putBytes(t, url, u.f.OwnerToken, pngOf(2048))
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
	got := u.h.mustDo(t, http.MethodGet, "/v1/uploads/"+id, u.f.OwnerToken, nil, http.StatusOK)
	if got.Body["status"] != "ready" {
		t.Fatalf("the stored row is %v: %s", got.Body["status"], got.Raw)
	}
}

func uploadLimitLieAboutSize(t *testing.T, u uploadLimitFixture) {
	t.Helper()
	_, url := u.newTicket(t, 1024)
	res := u.h.putBytes(t, url, u.f.OwnerToken, pngOf(6*1024*1024))
	if res.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("6 MB after declaring 1 KB: got %d %s, want 413.\n"+
			"The limit that counts is the one applied to the bytes that arrived.",
			res.Status, res.Raw)
	}
	if res.code() != string(domain.CodeUploadTooLarge) {
		t.Fatalf("got code %q, want UPLOAD_TOO_LARGE: %s", res.code(), res.Raw)
	}
}

func uploadLimitExactBoundary(t *testing.T, u uploadLimitFixture) {
	t.Helper()
	_, url := u.newTicket(t, 0)
	if res := u.h.putBytes(t, url, u.f.OwnerToken, pngOf(5*1024*1024)); res.Status != http.StatusOK {
		t.Fatalf("exactly 5 MB: got %d %s, want 200", res.Status, res.Raw)
	}
	_, url2 := u.newTicket(t, 0)
	res := u.h.putBytes(t, url2, u.f.OwnerToken, pngOf(5*1024*1024+1))
	if res.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("5 MB plus one byte: got %d %s, want 413.\n"+
			"Reading exactly the limit and stopping would store a truncated file "+
			"with no error anywhere.", res.Status, res.Raw)
	}
}

func uploadLimitMediaTypeFromBytes(t *testing.T, u uploadLimitFixture) {
	t.Helper()
	_, url := u.newTicket(t, 16)
	res := u.h.putBytes(t, url, u.f.OwnerToken, []byte("MZ\x90\x00 not a photograph at all"))
	if res.Status != http.StatusUnsupportedMediaType {
		t.Fatalf("an executable declared as image/png: got %d %s, want 415",
			res.Status, res.Raw)
	}
}

func uploadLimitPendingCannotHangOnSale(t *testing.T, u uploadLimitFixture) {
	t.Helper()
	h, f := u.h, u.f
	id, _ := u.newTicket(t, 1024)
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
}

func uploadLimitReadyHangsAndComesBack(t *testing.T, u uploadLimitFixture) {
	t.Helper()
	h, f := u.h, u.f
	id, url := u.newTicket(t, 1024)
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
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "sandbox") {
		t.Fatalf("an upload is served without a sandbox: %q", csp)
	}
}

func uploadLimitOtherFarm404(t *testing.T, u uploadLimitFixture) {
	t.Helper()
	h, f := u.h, u.f
	other := h.signupFarm(t, "Finca ajena fotos", 80000)
	id, url := u.newTicket(t, 1024)
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
}
