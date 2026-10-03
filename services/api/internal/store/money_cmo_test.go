package store

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// The money ledger against a scripted transaction. The database-backed suite
// in internal/apitest walks every statement with real rows and fails each
// call once (the fault replay), but a failure there is always the CALL
// failing. What it cannot produce is a row that fails to scan, a cursor that
// breaks after the last row, a race lost between a read and a write, or a row
// the schema's constraints would never let through. Those are scripted here,
// one statement at a time, matched by a fragment of its SQL.

var errCmo = errors.New("cmo: scripted failure")

// cmoStep answers the first not-yet-used statement whose SQL contains match.
type cmoStep struct {
	match   string
	rows    [][]any // the rows a Query or QueryRow returns
	err     error   // Query/Exec fails, or QueryRow's Scan does
	scanErr error   // a Query row fails to scan
	rowsErr error   // the cursor fails after its last row
	used    bool
}

type cmoTx struct {
	pgx.Tx // nil: any statement this test did not script panics
	t      *testing.T
	steps  []*cmoStep
}

func cmoScript(t *testing.T, steps ...*cmoStep) *cmoTx {
	return &cmoTx{t: t, steps: steps}
}

func (c *cmoTx) step(sql string) *cmoStep {
	for _, s := range c.steps {
		if !s.used && strings.Contains(sql, s.match) {
			s.used = true
			return s
		}
	}
	c.t.Fatalf("unscripted statement: %s", sql)
	return nil
}

func (c *cmoTx) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	s := c.step(sql)
	if s.err != nil {
		return nil, s.err
	}
	return &cmoRows{step: s}, nil
}

func (c *cmoTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	return cmoRow{step: c.step(sql)}
}

func (c *cmoTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, c.step(sql).err
}

func cmoAssign(vals []any, dest []any) error {
	if len(vals) != len(dest) {
		return errors.New("cmo: scripted row has the wrong width")
	}
	for i, d := range dest {
		dv := reflect.ValueOf(d).Elem()
		if vals[i] == nil {
			dv.Set(reflect.Zero(dv.Type()))
			continue
		}
		dv.Set(reflect.ValueOf(vals[i]).Convert(dv.Type()))
	}
	return nil
}

type cmoRow struct{ step *cmoStep }

func (r cmoRow) Scan(dest ...any) error {
	if r.step.err != nil {
		return r.step.err
	}
	if len(r.step.rows) == 0 {
		return pgx.ErrNoRows
	}
	return cmoAssign(r.step.rows[0], dest)
}

type cmoRows struct {
	step *cmoStep
	i    int
}

func (r *cmoRows) Close()                                       {}
func (r *cmoRows) Err() error                                   { return r.step.rowsErr }
func (r *cmoRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *cmoRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *cmoRows) Values() ([]any, error)                       { return nil, nil }
func (r *cmoRows) RawValues() [][]byte                          { return nil }
func (r *cmoRows) Conn() *pgx.Conn                              { return nil }
func (r *cmoRows) TypeMap() *pgtype.Map                         { return nil }
func (r *cmoRows) Next() bool {
	if r.i < len(r.step.rows) {
		r.i++
		return true
	}
	return false
}
func (r *cmoRows) Scan(dest ...any) error {
	if r.step.scanErr != nil {
		return r.step.scanErr
	}
	return cmoAssign(r.step.rows[r.i-1], dest)
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

var (
	cmoMon = time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)
	cmoTue = time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
)

func cmoI64(v int64) *int64 { return &v }

// cmoPendingRow is one row of pendingSQL.
func cmoPendingRow(id string, src domain.RateSource, qty string, price, amount *int64, plots []string) []any {
	var p, a any
	if price != nil {
		p = price
	}
	if amount != nil {
		a = amount
	}
	var pl any
	if plots != nil {
		pl = plots
	}
	return []any{id, "act-1", "Recoleccion", domain.PaySchemeWorkUnit, src, qty, nil,
		p, a, cmoTue, cmoMon, pl}
}

// cmoSettlementRow is the header row GetSettlement reads.
func cmoSettlementRow(id, worker string, gross int64) []any {
	return []any{id, worker, cmoMon, cmoMon.AddDate(0, 0, 6), gross, "open", nil, cmoTue, nil}
}

const (
	cmoSQLPending        = "AND l.id NOT IN (SELECT si.payable_id"
	cmoSQLGetSettlement  = "FROM settlements WHERE id = $1"
	cmoSQLSettlementItem = "JOIN work_records l ON l.id = si.payable_id"
	cmoSQLInsertSettle   = "INSERT INTO settlements"
	cmoSQLInsertItem     = "INSERT INTO settlement_items"
	cmoSQLWinner         = "WHERE si.payable_id = $1 AND si.voided_at IS NULL"
	cmoSQLDevengos       = "WHERE settlement_id = $1 AND kind = 'devengo'"
)

func cmoCode(t *testing.T, err error) *domain.Error {
	t.Helper()
	de, _ := domain.AsError(err)
	if de == nil {
		t.Fatalf("want a domain error, got %v", err)
	}
	return de
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

func TestCmoPricePending(t *testing.T) {
	kilo := map[string]KiloPrice{"k": {PriceMinor: 3, Source: "lote"}, "half": {PriceMinor: 1, Source: "finca"}}
	row := func(id string, src domain.RateSource, qty string, price, amount *int64) pendingRow {
		return pendingRow{
			Payable:      Payable{PayableID: id, RateSource: src, Quantity: json.Number(qty)},
			frozenPrice:  price,
			frozenAmount: amount,
		}
	}

	t.Run("a frozen price is read back, never recomputed", func(t *testing.T) {
		// 3 x 7 is 21, but the frozen amount is what was agreed.
		p, err := pricePending(row("f", domain.RateExplicit, "3", cmoI64(7), cmoI64(20)), kilo)
		if err != nil || p.PriceMinor != 7 || p.AmountMinor != 20 || p.PriceSource != "" {
			t.Fatalf("got %+v %v", p, err)
		}
	})
	for name, r := range map[string]pendingRow{
		"no frozen price":     row("f", domain.RateActivityDated, "1", nil, cmoI64(1)),
		"no frozen amount":    row("f", domain.RateExplicit, "1", cmoI64(1), nil),
		"no kilo price":       row("missing", domain.RateWeeklyPrice, "1", nil, nil),
		"unparsable quantity": row("k", domain.RateWeeklyPrice, "uno", nil, nil),
	} {
		t.Run("refused: "+name, func(t *testing.T) {
			if _, err := pricePending(r, kilo); cmoCode(t, err).Status != 500 {
				t.Fatalf("want an internal error, got %v", err)
			}
		})
	}
	// Fixed-scale rounding, half away from zero, like Postgres round(numeric).
	for _, c := range []struct {
		id, qty string
		want    int64
	}{
		{"half", "0.5", 1},    // exactly half rounds up
		{"half", "0.499", 0},  // just under half rounds down
		{"half", "0.0001", 0}, // dust is not money
		{"k", "2.5", 8},       // 7.5 -> 8
		{"k", "12.345", 37},   // 37.035 -> 37
		{"k", "0.1666", 0},    // 0.4998 -> 0
		{"k", "0.16667", 1},   // 0.50001 -> 1
		{"k", "1000000", 3000000},
	} {
		p, err := pricePending(row(c.id, domain.RateWeeklyPrice, c.qty, nil, nil), kilo)
		if err != nil {
			t.Fatalf("%s x %s: %v", c.qty, c.id, err)
		}
		if p.AmountMinor != c.want || p.PriceMinor != kilo[c.id].PriceMinor || p.PriceSource != kilo[c.id].Source {
			t.Errorf("%s at %d: got %d (%s), want %d", c.qty, kilo[c.id].PriceMinor, p.AmountMinor, p.PriceSource, c.want)
		}
		q, _ := new(big.Rat).SetString(c.qty)
		if domain.AmountMinor(q, kilo[c.id].PriceMinor) != p.AmountMinor {
			t.Errorf("pending and domain.AmountMinor disagree on %s", c.qty)
		}
	}
}

func TestCmoPendingFaults(t *testing.T) {
	ctx := context.Background()

	t.Run("a row that does not scan", func(t *testing.T) {
		tx := cmoScript(t, &cmoStep{match: cmoSQLPending, rows: [][]any{{}}, scanErr: errCmo})
		if _, err := Pending(ctx, tx, "w", cmoMon, cmoTue); !errors.Is(err, errCmo) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("a cursor that breaks", func(t *testing.T) {
		tx := cmoScript(t, &cmoStep{match: cmoSQLPending, rowsErr: errCmo})
		if _, err := Pending(ctx, tx, "w", cmoMon, cmoTue); !errors.Is(err, errCmo) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("a non-kilo record with no frozen price is an internal error, not a free line", func(t *testing.T) {
		tx := cmoScript(t, &cmoStep{match: cmoSQLPending, rows: [][]any{
			cmoPendingRow("r1", domain.RateExplicit, "2", nil, nil, []string{"Lote 1"}),
		}})
		out, err := Pending(ctx, tx, "w", cmoMon, cmoTue)
		if out != nil || cmoCode(t, err).Status != 500 {
			t.Fatalf("got %v %v", out, err)
		}
	})
	t.Run("no plots is an empty list on the wire, never null", func(t *testing.T) {
		tx := cmoScript(t, &cmoStep{match: cmoSQLPending, rows: [][]any{
			cmoPendingRow("r1", domain.RateExplicit, "2", cmoI64(5), cmoI64(10), nil),
		}})
		out, err := Pending(ctx, tx, "w", cmoMon, cmoTue)
		if err != nil || len(out) != 1 || out[0].PlotNames == nil || len(out[0].PlotNames) != 0 ||
			out[0].AmountMinor != 10 {
			t.Fatalf("got %+v %v", out, err)
		}
	})
}

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

func cmoSettleParams() SettleParams {
	return SettleParams{FarmID: "farm", EmployeeID: "w", SettlementID: "s1",
		From: cmoMon, To: cmoMon.AddDate(0, 0, 6), CreatedBy: "u", On: &cmoTue}
}

func TestCmoSettleAddingUpToNothingIsRefused(t *testing.T) {
	tx := cmoScript(t,
		&cmoStep{match: cmoSQLGetSettlement},
		&cmoStep{match: cmoSQLPending, rows: [][]any{
			cmoPendingRow("r1", domain.RateExplicit, "0", cmoI64(5), cmoI64(0), nil),
		}},
	)
	s, created, err := Settle(context.Background(), tx, cmoSettleParams())
	if s != nil || created || cmoCode(t, err).Code != domain.CodeNothingToSettle {
		t.Fatalf("a zero settlement: %v %v %v", s, created, err)
	}
}

// Two identical requests that both pass the idempotency check: the INSERT's
// ON CONFLICT DO NOTHING is what decides, and the loser must read back.
func TestCmoSettleLosesTheInsertRace(t *testing.T) {
	ctx := context.Background()
	script := func(t *testing.T, readBack ...*cmoStep) *cmoTx {
		steps := []*cmoStep{
			{match: cmoSQLGetSettlement},
			{match: cmoSQLPending, rows: [][]any{
				cmoPendingRow("r1", domain.RateExplicit, "2", cmoI64(50), cmoI64(100), nil),
			}},
			{match: cmoSQLInsertSettle}, // DO NOTHING: no row returned
		}
		return cmoScript(t, append(steps, readBack...)...)
	}

	t.Run("the winner is read back, and nothing more is written", func(t *testing.T) {
		tx := script(t,
			&cmoStep{match: cmoSQLGetSettlement, rows: [][]any{cmoSettlementRow("s1", "w", 100)}},
			&cmoStep{match: cmoSQLSettlementItem},
		)
		s, created, err := Settle(ctx, tx, cmoSettleParams())
		if err != nil || created || s == nil || s.ID != "s1" || s.GrossMinor != 100 {
			t.Fatalf("got %+v %v %v", s, created, err)
		}
	})
	t.Run("the id is taken by something this farm cannot see", func(t *testing.T) {
		tx := script(t, &cmoStep{match: cmoSQLGetSettlement})
		_, created, err := Settle(ctx, tx, cmoSettleParams())
		if created || cmoCode(t, err).Code != domain.CodeIdempotencyKeyReused {
			t.Fatalf("got %v %v", created, err)
		}
	})
	t.Run("the read-back fails", func(t *testing.T) {
		tx := script(t, &cmoStep{match: cmoSQLGetSettlement, err: errCmo})
		if _, _, err := Settle(ctx, tx, cmoSettleParams()); !errors.Is(err, errCmo) {
			t.Fatalf("got %v", err)
		}
	})
}

// A payable claimed between Pending and the INSERT of its line: the partial
// unique index fires, and the answer names the settlement that won it.
func TestCmoSettlePayableClaimedMidway(t *testing.T) {
	ctx := context.Background()
	claimed := &pgconn.PgError{Code: "23505", ConstraintName: "ux_items_payable_live"}
	script := func(t *testing.T, winner *cmoStep) *cmoTx {
		return cmoScript(t,
			&cmoStep{match: cmoSQLGetSettlement},
			&cmoStep{match: cmoSQLPending, rows: [][]any{
				cmoPendingRow("r1", domain.RateExplicit, "2", cmoI64(50), cmoI64(100), nil),
			}},
			&cmoStep{match: cmoSQLInsertSettle, rows: [][]any{{cmoTue}}},
			&cmoStep{match: cmoSQLInsertItem, err: claimed},
			winner,
		)
	}

	t.Run("the winner is in the details", func(t *testing.T) {
		tx := script(t, &cmoStep{match: cmoSQLWinner, rows: [][]any{{"s0", int64(100), cmoTue}}})
		_, created, err := Settle(ctx, tx, cmoSettleParams())
		de := cmoCode(t, err)
		if created || de.Code != domain.CodePayableAlreadyClaimed || de.Details["payableId"] != "r1" {
			t.Fatalf("got %v %v", created, err)
		}
		w, _ := de.Details["winningSettlement"].(map[string]any)
		if w["id"] != "s0" || w["grossCents"] != int64(100) || w["createdAt"] != cmoTue {
			t.Errorf("winningSettlement: %v", de.Details["winningSettlement"])
		}
		if !errors.Is(err, claimed) {
			t.Errorf("the unique violation is not kept as the cause")
		}
	})
	t.Run("a winner that cannot be read is still a conflict", func(t *testing.T) {
		tx := script(t, &cmoStep{match: cmoSQLWinner, err: errCmo})
		_, _, err := Settle(ctx, tx, cmoSettleParams())
		de := cmoCode(t, err)
		if de.Code != domain.CodePayableAlreadyClaimed {
			t.Fatalf("got %v", err)
		}
		if w, _ := de.Details["winningSettlement"].(map[string]any); w != nil {
			t.Errorf("an unread winner was invented: %v", w)
		}
	})
	t.Run("any other failure of the line is passed through", func(t *testing.T) {
		tx := cmoScript(t,
			&cmoStep{match: cmoSQLGetSettlement},
			&cmoStep{match: cmoSQLPending, rows: [][]any{
				cmoPendingRow("r1", domain.RateExplicit, "2", cmoI64(50), cmoI64(100), nil),
			}},
			&cmoStep{match: cmoSQLInsertSettle, rows: [][]any{{cmoTue}}},
			&cmoStep{match: cmoSQLInsertItem, err: &pgconn.PgError{Code: "23505", ConstraintName: "other"}},
		)
		_, _, err := Settle(ctx, tx, cmoSettleParams())
		if _, isDomain := domain.AsError(err); isDomain || !IsUniqueViolation(err, "other") {
			t.Fatalf("got %v", err)
		}
	})
}

// ---------------------------------------------------------------------------
// Readers that fail mid-cursor
// ---------------------------------------------------------------------------

func TestCmoReadersFailMidCursor(t *testing.T) {
	ctx := context.Background()
	one := [][]any{{}}

	t.Run("debts", func(t *testing.T) {
		tx := cmoScript(t, &cmoStep{match: "l.kind IN ('deduccion', 'anticipo')", rows: one, scanErr: errCmo})
		if _, err := Debts(ctx, tx, "w"); !errors.Is(err, errCmo) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("settlement list, scan", func(t *testing.T) {
		tx := cmoScript(t, &cmoStep{match: "count(*) OVER ()", rows: one, scanErr: errCmo})
		if _, _, err := ListSettlements(ctx, tx, SettlementFilter{}); !errors.Is(err, errCmo) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("settlement list, cursor", func(t *testing.T) {
		tx := cmoScript(t, &cmoStep{match: "count(*) OVER ()", rowsErr: errCmo})
		if _, _, err := ListSettlements(ctx, tx, SettlementFilter{}); !errors.Is(err, errCmo) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("ledger", func(t *testing.T) {
		tx := cmoScript(t, &cmoStep{match: "LIMIT $2", rows: one, scanErr: errCmo})
		if _, err := ListLedger(ctx, tx, "w", 0); !errors.Is(err, errCmo) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("balances", func(t *testing.T) {
		tx := cmoScript(t, &cmoStep{match: "FROM employees e LEFT JOIN ledger", rows: one, scanErr: errCmo})
		if _, err := ListBalances(ctx, tx); !errors.Is(err, errCmo) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("settlement lines, scan", func(t *testing.T) {
		tx := cmoScript(t,
			&cmoStep{match: cmoSQLGetSettlement, rows: [][]any{cmoSettlementRow("s1", "w", 100)}},
			&cmoStep{match: cmoSQLSettlementItem, rows: one, scanErr: errCmo})
		if _, err := GetSettlement(ctx, tx, "s1"); !errors.Is(err, errCmo) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("settlement lines without plots carry an empty list", func(t *testing.T) {
		tx := cmoScript(t,
			&cmoStep{match: cmoSQLGetSettlement, rows: [][]any{cmoSettlementRow("s1", "w", 100)}},
			&cmoStep{match: cmoSQLSettlementItem, rows: [][]any{{"r1", "act", "Recoleccion",
				domain.PaySchemeWorkUnit, domain.RateWeeklyPrice, "2.5", nil, cmoTue, cmoMon,
				int64(40), int64(100), false, nil}}})
		s, err := GetSettlement(ctx, tx, "s1")
		if err != nil || len(s.Items) != 1 || s.Items[0].PlotNames == nil || s.Items[0].AmountMinor != 100 ||
			s.Items[0].Quantity != "2.5" {
			t.Fatalf("got %+v %v", s, err)
		}
	})
}

// ---------------------------------------------------------------------------
// Void and release
// ---------------------------------------------------------------------------

func TestCmoVoidFailsReadingTheEarnings(t *testing.T) {
	for name, devengos := range map[string]*cmoStep{
		"scan":   {match: cmoSQLDevengos, rows: [][]any{{}}, scanErr: errCmo},
		"cursor": {match: cmoSQLDevengos, rowsErr: errCmo},
	} {
		t.Run(name, func(t *testing.T) {
			tx := cmoScript(t,
				&cmoStep{match: "FROM settlements WHERE id = $1 FOR UPDATE", rows: [][]any{{"open"}}},
				&cmoStep{match: "UPDATE settlement_items SET voided_at"},
				&cmoStep{match: "UPDATE settlements SET status = 'void'"},
				devengos,
			)
			s, created, err := VoidSettlement(context.Background(), tx, "farm", "s1", "", "u", &cmoTue)
			if s != nil || created || !errors.Is(err, errCmo) {
				t.Fatalf("got %v %v %v", s, created, err)
			}
		})
	}
}

func TestCmoReleaseFailsMidCursor(t *testing.T) {
	head := func() []*cmoStep {
		return []*cmoStep{
			{match: "status::text, employee_id::text FROM settlements", rows: [][]any{{"void", "w"}}},
			{match: "FROM employees WHERE id = $1 FOR UPDATE", rows: [][]any{{1}}},
		}
	}
	freed := "RETURNING payable_id::text"
	for name, tail := range map[string][]*cmoStep{
		"freed lines, scan":   {{match: freed, rows: [][]any{{}}, scanErr: errCmo}},
		"freed lines, cursor": {{match: freed, rowsErr: errCmo}},
		"earnings, scan": {{match: freed},
			{match: cmoSQLDevengos, rows: [][]any{{}}, scanErr: errCmo}},
		"earnings, cursor": {{match: freed}, {match: cmoSQLDevengos, rowsErr: errCmo}},
	} {
		t.Run(name, func(t *testing.T) {
			tx := cmoScript(t, append(head(), tail...)...)
			r, created, err := ReleaseSettlement(context.Background(), tx, ReleaseParams{
				FarmID: "farm", SettlementID: "s1", Reason: "x", ReleasedBy: "u", On: &cmoTue,
			})
			if r != nil || created || !errors.Is(err, errCmo) {
				t.Fatalf("got %v %v %v", r, created, err)
			}
		})
	}
}
