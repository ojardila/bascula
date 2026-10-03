// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// c2saArgsTx is a cmrTx that also remembers the arguments of every Query, so
// a test can see what a function actually asked the database for.
type c2saArgsTx struct {
	*cmrTx
	queryArgs [][]any
	execArgs  [][]any
}

func (t *c2saArgsTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	t.queryArgs = append(t.queryArgs, args)
	return t.cmrTx.Query(ctx, sql, args...)
}

func (t *c2saArgsTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	t.execArgs = append(t.execArgs, args)
	return t.cmrTx.Exec(ctx, sql, args...)
}

func TestC2saWorkRecordsPassFailuresThrough(t *testing.T) {
	ctx := context.Background()
	const list = "ORDER BY l.local_day DESC, l.created_at DESC"
	for _, rows := range []*cmrRows{cmrFailing(), cmrEndsBadly()} {
		out, err := ListWorkRecords(ctx, &cmrTx{query: map[string]*cmrRows{list: rows}}, WorkRecordFilter{})
		cmrWantErr(t, "ListWorkRecords", err)
		if out != nil {
			t.Errorf("ListWorkRecords returned rows with its error: %v", out)
		}
	}

	// The links: a plot link that fails to scan, a plot result that ends in
	// an error, a crop link that fails to scan. A settled record needs no
	// pricing query, so these are the only queries made.
	paid := int64(500)
	records := func() []WorkRecord { return []WorkRecord{{ID: "w1", settledAmount: &paid}} }
	const plots, crops = "FROM work_record_plots WHERE", "FROM work_record_plot_crops WHERE"
	for name, q := range map[string]map[string]*cmrRows{
		"plot scan":      {plots: cmrFailing()},
		"plot iteration": {plots: cmrEndsBadly()},
		"crop scan":      {plots: {}, crops: cmrFailing()},
	} {
		out, err := attachWorkRecordLinks(ctx, &cmrTx{query: q}, records(), []string{"w1"})
		cmrWantErr(t, name, err)
		if out != nil {
			t.Errorf("%s: records came back with the error", name)
		}
	}

	tx := &cmrTx{exec: map[string]error{"UPDATE work_records SET deleted_at = NULL": nil}}
	if err := RestoreWorkRecord(ctx, tx, "w1"); !errors.Is(err, NoRows) {
		t.Errorf("RestoreWorkRecord of a live record: %v, want NoRows", err)
	}
}

func TestC2saWorkRecordPricingWithoutAPrice(t *testing.T) {
	ctx := context.Background()
	owner := map[string]cmrRow{"current_role_name()": {vals: []any{"owner"}}}
	const kilo = "CROSS JOIN LATERAL kilo_price("

	// A weekly-priced weighing with no kilo price anywhere is an estimate of
	// zero; a record with no frozen amount and no way to derive one is zero
	// too, and also an estimate.
	records := []WorkRecord{
		{ID: "w1", RateSource: domain.RateWeeklyPrice, Quantity: "12.5", EffectiveMinor: 99},
		{ID: "w2", RateSource: domain.RateExplicit, Quantity: "3", EffectiveMinor: 99},
	}
	tx := &cmrTx{row: owner, query: map[string]*cmrRows{kilo: {}}}
	if err := priceWorkRecords(ctx, tx, records); err != nil {
		t.Fatalf("priceWorkRecords: %v", err)
	}
	for _, r := range records {
		if r.EffectiveMinor != 0 || !r.AmountIsEstimate || r.PriceWithheld {
			t.Errorf("%s priced %d estimate=%v withheld=%v, want 0, an estimate, not withheld",
				r.ID, r.EffectiveMinor, r.AmountIsEstimate, r.PriceWithheld)
		}
	}

	// A quantity that is not a number is an error naming the record.
	bad := []WorkRecord{{ID: "w9", RateSource: domain.RateWeeklyPrice, Quantity: json.Number("doce")}}
	tx = &cmrTx{row: owner, query: map[string]*cmrRows{kilo: {data: [][]any{{"w9", int64(900), "finca"}}}}}
	err := priceWorkRecords(ctx, tx, bad)
	if err == nil || !strings.Contains(err.Error(), "w9") || !strings.Contains(err.Error(), "unreadable quantity") {
		t.Errorf("unreadable quantity: %v", err)
	}
}

func TestC2saStock(t *testing.T) {
	ctx := context.Background()
	const moves = "AND ($3::text IS NULL OR m.reason::text = $3)"

	// The limit: absent or out of range is 200, otherwise what was asked.
	for _, c := range []struct{ asked, sent int }{{0, 200}, {-3, 200}, {501, 200}, {7, 7}, {500, 500}} {
		tx := &c2saArgsTx{cmrTx: &cmrTx{query: map[string]*cmrRows{moves: {}}}}
		out, err := ListStockMoves(ctx, tx, StockMoveFilter{Limit: c.asked})
		if err != nil || len(out) != 0 {
			t.Fatalf("ListStockMoves: %v %v", out, err)
		}
		args := tx.queryArgs[0]
		if got := args[len(args)-1]; got != c.sent {
			t.Errorf("limit %d was sent as %v, want %d", c.asked, got, c.sent)
		}
	}

	_, err := ListStockMoves(ctx, &cmrTx{query: map[string]*cmrRows{moves: cmrFailing()}}, StockMoveFilter{})
	cmrWantErr(t, "ListStockMoves", err)
	_, err = StockLevels(ctx, &cmrTx{query: map[string]*cmrRows{"FROM stock_levels l": cmrFailing()}}, "", "")
	cmrWantErr(t, "StockLevels", err)

	lock := "FROM products WHERE id = $1 FOR UPDATE"
	if err := LockProductForStock(ctx, &cmrTx{row: map[string]cmrRow{lock: {err: pgx.ErrNoRows}}}, "p"); !errors.Is(err, NoRows) {
		t.Errorf("locking a missing product: %v, want NoRows", err)
	}
	if err := LockProductForStock(ctx, &cmrTx{row: map[string]cmrRow{lock: {err: errCMR}}}, "p"); !errors.Is(err, errCMR) {
		t.Errorf("locking with a failing database: %v", err)
	}

	// Each constraint of stock_moves comes back as the contract's error.
	for _, c := range []struct {
		pg     *pgconn.PgError
		status int
		code   domain.Code
	}{
		{&pgconn.PgError{Code: "23514", ConstraintName: "stock_sign"}, 400, domain.CodeBadRequest},
		{&pgconn.PgError{Code: "23514", ConstraintName: "stock_venta_has_sale"}, 400, domain.CodeBadRequest},
		{&pgconn.PgError{Code: "23514", ConstraintName: "stock_crop_needs_plot"}, 400, domain.CodeBadRequest},
		{&pgconn.PgError{Code: "23505", ConstraintName: "ux_moves_reverses"}, 409, domain.CodeAlreadyReversed},
	} {
		tx := &cmrTx{row: map[string]cmrRow{"INSERT INTO stock_moves": {err: c.pg}}}
		_, err := InsertStockMove(ctx, tx, "f", NewStockMove{Reason: "compra"})
		c2saWantCode(t, c.pg.ConstraintName, err, c.status, c.code)
	}
	if err := translateStockError(errCMR); !errors.Is(err, errCMR) {
		t.Errorf("an unrelated error was translated: %v", err)
	}

	// A reversal is not reversed in turn.
	vals := make([]any, 14)
	vals[0], vals[13] = "m2", c2saS("m1")
	tx := &cmrTx{row: map[string]cmrRow{"WHERE m.id = $1": {vals: vals}}}
	_, err = ReverseStockMove(ctx, tx, "f", "m2", nil, func() string { return "m3" })
	de := c2saWantCode(t, "reversing a reversal", err, 409, domain.CodeAlreadyReversed)
	if !strings.Contains(de.Message, "a reversal cannot be reversed") {
		t.Errorf("reversing a reversal: %q", de.Message)
	}
}

func TestC2saSales(t *testing.T) {
	ctx := context.Background()
	_, err := ListSales(ctx, &cmrTx{query: map[string]*cmrRows{
		"AND ($5::uuid IS NULL OR s.customer_id = $5)": cmrFailing()}}, SaleFilter{})
	cmrWantErr(t, "ListSales", err)

	// A receipt still uploading.
	tx := &cmrTx{row: map[string]cmrRow{"INSERT INTO sales": {err: &pgconn.PgError{
		Code: "23514", ConstraintName: "attachments_ready_shape"}}}}
	_, err = CreateSale(ctx, tx, "f", NewSale{}, func() string { return "x" })
	c2saWantCode(t, "sale with an unready receipt", err, 409, domain.CodeUploadNotReady)

	tx = &cmrTx{exec: map[string]error{"UPDATE sales SET": nil}}
	if _, err := UpdateSale(ctx, tx, "s1", SalePatch{}); !errors.Is(err, NoRows) {
		t.Errorf("UpdateSale of a void or missing sale: %v, want NoRows", err)
	}

	// A live sale with no movement behind it cannot be voided: there is
	// nothing to put back, and pretending would leave the warehouse wrong.
	tx = &cmrTx{row: map[string]cmrRow{"WHERE s.id = $1": {vals: []any{"s1"}}}}
	_, err = VoidSale(ctx, tx, "f", "s1", func() string { return "x" })
	c2saWantCode(t, "void without a movement", err, 500, domain.CodeInternal)
	for _, s := range tx.seen {
		if strings.HasPrefix(s, "E:") {
			t.Errorf("the refused void still wrote: %v", tx.seen)
		}
	}
}

func TestC2saExpenses(t *testing.T) {
	ctx := context.Background()
	_, _, err := ListExpenses(ctx, &cmrTx{query: map[string]*cmrRows{
		"AND ($3::text IS NULL OR e.concept ILIKE": cmrFailing()}}, ExpenseFilter{})
	cmrWantErr(t, "ListExpenses", err)

	for _, name := range []string{"expense_target", "expense_crop_needs_plot"} {
		tx := &cmrTx{row: map[string]cmrRow{"INSERT INTO expenses": {err: &pgconn.PgError{
			Code: "23514", ConstraintName: name}}}}
		_, err := CreateExpense(ctx, tx, "f", NewExpense{})
		c2saWantCode(t, name, err, 400, domain.CodeExpenseTargetInvalid)
	}

	// The amount travels as given, and a zero amount as "leave it".
	tx := &c2saArgsTx{cmrTx: &cmrTx{exec: map[string]error{"concept      = coalesce($2, concept)": nil}}}
	if _, err := UpdateExpense(ctx, tx, "e1", NewExpense{AmountMinor: 4500}, false); !errors.Is(err, NoRows) {
		t.Errorf("UpdateExpense of a missing expense: %v, want NoRows", err)
	}
	if got, ok := tx.execArgs[0][2].(*int64); !ok || got == nil || *got != 4500 {
		t.Errorf("amount sent as %v, want 4500", tx.execArgs[0][2])
	}
	if nilIfZero(0) != nil {
		t.Error("a zero amount was sent as a value")
	}

	tx2 := &cmrTx{exec: map[string]error{"UPDATE expenses SET deleted_at = now()": nil}}
	if err := SoftDeleteExpense(ctx, tx2, "e1"); !errors.Is(err, NoRows) {
		t.Errorf("SoftDeleteExpense of nothing: %v, want NoRows", err)
	}
	tx2 = &cmrTx{exec: map[string]error{"UPDATE expenses SET deleted_at = NULL": nil}}
	if err := RestoreExpense(ctx, tx2, "e1"); !errors.Is(err, NoRows) {
		t.Errorf("RestoreExpense of nothing: %v, want NoRows", err)
	}
}
