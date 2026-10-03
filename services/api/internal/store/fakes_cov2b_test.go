// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// Error branches of the store that a live database will not take on demand,
// driven through the scripted transaction of cmr_fake_test.go: a row that
// fails to scan, a result set that ends in an error, an UPDATE that touched
// nothing (the scripted Exec reports zero rows affected).

func c2sbWantErr(t *testing.T, what string, err error) {
	t.Helper()
	if !errors.Is(err, errCMR) {
		t.Errorf("%s: got %v, want the scripted failure passed through", what, err)
	}
}

func c2sbWantNoRows(t *testing.T, what string, err error) {
	t.Helper()
	if !errors.Is(err, NoRows) {
		t.Errorf("%s: got %v, want NoRows", what, err)
	}
}

func c2sbWantCode(t *testing.T, what string, err error, status int, code domain.Code) {
	t.Helper()
	var de *domain.Error
	if !errors.As(err, &de) || de.Status != status || (code != "" && de.Code != code) {
		t.Fatalf("%s: got %v, want a %d %s", what, err, status, code)
	}
}

func c2sbQ(frag string, rows *cmrRows) *cmrTx {
	return &cmrTx{query: map[string]*cmrRows{frag: rows}}
}

func c2sbStr(s string) *string { return &s }

// Every list in the store reads the whole result or fails: a row that does
// not scan is the error and never a shorter list.
func TestC2SBListsPassScanErrorsThrough(t *testing.T) {
	ctx := context.Background()
	t0 := time.Now()

	_, err := ListWorkUnits(ctx, c2sbQ("FROM work_units u", cmrFailing()))
	c2sbWantErr(t, "ListWorkUnits", err)

	for _, rows := range []*cmrRows{cmrFailing(), cmrEndsBadly()} {
		out, err := ListActivities(ctx, c2sbQ("FROM activities a JOIN", rows), true, t0, Filter{}, "")
		c2sbWantErr(t, "ListActivities", err)
		if out != nil {
			t.Errorf("ListActivities returned rows with its error: %v", out)
		}
	}

	_, err = ListActivityRates(ctx, c2sbQ("ORDER BY valid_from DESC", cmrFailing()), "a1")
	c2sbWantErr(t, "ListActivityRates", err)

	_, err = ListNotes(ctx, c2sbQ("FROM employee_notes", cmrFailing()), "e1", 10)
	c2sbWantErr(t, "ListNotes", err)

	_, err = ListProducts(ctx, c2sbQ("FROM products", cmrFailing()), Filter{}, "")
	c2sbWantErr(t, "ListProducts", err)

	_, err = ListCustomers(ctx, c2sbQ("FROM customers", cmrFailing()), Filter{})
	c2sbWantErr(t, "ListCustomers", err)

	_, err = ListEmployees(ctx, c2sbQ("FROM employees", cmrFailing()), Filter{})
	c2sbWantErr(t, "ListEmployees", err)

	_, err = ListReactivations(ctx, c2sbQ("FROM employee_reactivations", cmrFailing()), "", 10)
	c2sbWantErr(t, "ListReactivations", err)

	_, err = FarmOwnerEmails(ctx, c2sbQ("FROM memberships m", cmrFailing()), "u1")
	c2sbWantErr(t, "FarmOwnerEmails scan", err)
	_, err = FarmOwnerEmails(ctx, c2sbQ("FROM memberships m", &cmrRows{queryErr: errCMR}), "u1")
	c2sbWantErr(t, "FarmOwnerEmails query", err)

	_, err = ListMCPAudit(ctx, c2sbQ("FROM mcp_audit a", cmrFailing()), 10)
	c2sbWantErr(t, "ListMCPAudit", err)

	_, err = ListPasskeys(ctx, c2sbQ("FROM passkeys", cmrFailing()), "u1", "rp")
	c2sbWantErr(t, "ListPasskeys", err)

	_, err = ListTours(ctx, c2sbQ("FROM user_tours", cmrFailing()))
	c2sbWantErr(t, "ListTours", err)

	tx := &cmrTx{
		row:   map[string]cmrRow{"fc.price_confirmed_at IS NOT NULL": {}},
		query: map[string]*cmrRows{"FROM farm_prices": cmrFailing()},
	}
	_, err = GetBasePrice(ctx, tx)
	c2sbWantErr(t, "GetBasePrice history", err)

	_, err = loadReaders(ctx, c2sbQ("FROM sync_readers", cmrFailing()), "u1", false)
	c2sbWantErr(t, "loadReaders", err)
}

// The performance sheet's three readers each fail as a whole.
func TestC2SBPerformanceLoadersPassErrorsThrough(t *testing.T) {
	ctx := context.Background()
	week := time.Date(2026, 9, 28, 0, 0, 0, 0, time.UTC)
	out := &EmployeePerformance{}

	err := perfLoadWeeks(ctx, c2sbQ(perfWeeksSQL, cmrFailing()), out, "e1", perfWindow{from: week, to: week}, week)
	c2sbWantErr(t, "perfLoadWeeks", err)

	for _, rows := range []*cmrRows{cmrFailing(), cmrEndsBadly()} {
		err = perfLoadDays(ctx, c2sbQ(perfDaysSQL, rows), out, "e1", perfWindow{from: week, to: week}, week, week)
		c2sbWantErr(t, "perfLoadDays", err)
	}
	if out.Days != nil {
		t.Errorf("perfLoadDays filled days before failing: %v", out.Days)
	}

	err = perfLoadPlots(ctx, c2sbQ(perfPlotsSQL, cmrFailing()), out, "e1", perfWindow{from: week, to: week})
	c2sbWantErr(t, "perfLoadPlots", err)
}

// An UPDATE that matched nothing is NoRows, not a silent success.
func TestC2SBUpdatesThatTouchNothingAreNoRows(t *testing.T) {
	ctx := context.Background()
	tx := &cmrTx{exec: map[string]error{
		"UPDATE activities":              nil,
		"UPDATE products":                nil,
		"UPDATE employees":               nil,
		"UPDATE farm_owner_credentials":  nil,
		"UPDATE users SET password_hash": nil,
	}}
	c2sbWantNoRows(t, "RestoreActivity", RestoreActivity(ctx, tx, "a1"))
	c2sbWantNoRows(t, "ArchiveActivity", ArchiveActivity(ctx, tx, "a1"))
	c2sbWantNoRows(t, "SoftDeleteProduct", SoftDeleteProduct(ctx, tx, "p1"))
	c2sbWantNoRows(t, "RestoreProduct", RestoreProduct(ctx, tx, "p1"))
	c2sbWantNoRows(t, "SoftDeleteEmployee", SoftDeleteEmployee(ctx, tx, "e1", ""))
	c2sbWantNoRows(t, "SetFarmOwnerCredentialHash", SetFarmOwnerCredentialHash(ctx, tx, "f1", "u1", "h"))
	c2sbWantNoRows(t, "SetUserPasswordHash", SetUserPasswordHash(ctx, tx, "u1", "h"))

	// UpdateProduct with both ids given resolves nothing in the catalogue and
	// goes straight to the UPDATE.
	p, err := UpdateProduct(ctx, tx, "f1", "p1", NewProduct{
		CategoryID: c2sbStr("c1"), StorageUnitID: c2sbStr("u1")}, func() string { return "x" })
	c2sbWantNoRows(t, "UpdateProduct", err)
	if p != nil {
		t.Errorf("UpdateProduct returned %v with NoRows", p)
	}
	if last := tx.seen[len(tx.seen)-1]; last != "E:UPDATE products" {
		t.Errorf("UpdateProduct with ids ran %v, want only the UPDATE", last)
	}

	lock := &cmrTx{row: map[string]cmrRow{"FOR UPDATE": {err: pgx.ErrNoRows}}}
	c2sbWantNoRows(t, "LockEmployeeForMoney", LockEmployeeForMoney(ctx, lock, "e1"))
}

func TestC2SBActivityRules(t *testing.T) {
	ctx := context.Background()

	tx := &cmrTx{row: map[string]cmrRow{"pay_scheme = 'unidad_trabajo'": {err: pgx.ErrNoRows}}}
	id, err := HarvestActivityID(ctx, tx)
	c2sbWantCode(t, "HarvestActivityID", err, 409, domain.CodeNoRateInForce)
	if id != "" {
		t.Errorf("HarvestActivityID = %q with no activity", id)
	}

	// No category id and no name: refused before anything is written.
	_, err = CreateActivity(ctx, &cmrTx{}, "f1", NewActivity{ID: "a1", Name: "x"}, func() string { return "c" })
	c2sbWantCode(t, "CreateActivity", err, 400, "")

	// An unknown scheme writes nothing (the empty fake would panic on Exec).
	err = SetActivityRate(ctx, &cmrTx{}, "a1", domain.PayScheme("nope"), ActivityRate{})
	c2sbWantCode(t, "SetActivityRate", err, 400, "")
}

func TestC2SBProductCatalogueRules(t *testing.T) {
	ctx := context.Background()

	// Neither a storage unit id nor a name: refused, nothing written.
	_, err := CreateProduct(ctx, &cmrTx{}, "f1", NewProduct{ID: "p1", Name: "x"}, func() string { return "n" })
	c2sbWantCode(t, "CreateProduct", err, 400, "")

	// A catalogue name that cannot be ensured fails the write.
	tx := &cmrTx{row: map[string]cmrRow{"INSERT INTO product_categories": {err: errCMR}}}
	_, err = CreateProduct(ctx, tx, "f1", NewProduct{ID: "p1", Name: "x", Category: "Abonos"}, func() string { return "n" })
	c2sbWantErr(t, "CreateProduct category", err)
	_, err = UpdateProduct(ctx, tx, "f1", "p1", NewProduct{Category: "Abonos"}, func() string { return "n" })
	c2sbWantErr(t, "UpdateProduct category", err)
}

func TestC2SBNotes(t *testing.T) {
	ctx := context.Background()
	day := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	existing := cmrRow{vals: []any{"n1", "e1", day, "first text", c2sbStr("u1"), day}}

	// A resent note answers with the one already there.
	tx := &cmrTx{row: map[string]cmrRow{
		"INSERT INTO employee_notes":      {err: pgx.ErrNoRows},
		"FROM employee_notes WHERE id = ": existing,
	}}
	n, err := CreateNote(ctx, tx, "f1", NewNote{ID: "n1", EmployeeID: "e1", Body: "resent", NotedOn: &day})
	if err != nil || n == nil || n.Body != "first text" || n.ID != "n1" {
		t.Fatalf("CreateNote retry = %+v, %v; want the stored note", n, err)
	}

	tx = &cmrTx{row: map[string]cmrRow{"FROM employee_notes WHERE id = ": {err: errCMR}}}
	_, err = GetNote(ctx, tx, "n1")
	c2sbWantErr(t, "GetNote", err)

	// Out-of-range limits fall back to the default rather than failing.
	for _, limit := range []int{0, -1, 501} {
		out, err := ListNotes(ctx, c2sbQ("FROM employee_notes", &cmrRows{}), "e1", limit)
		if err != nil || out == nil || len(out) != 0 {
			t.Errorf("ListNotes(limit %d) = %v, %v", limit, out, err)
		}
	}
}

// c2sbExecArgs records the arguments of every Exec.
type c2sbExecArgs struct {
	cmrTx
	args [][]any
}

func (t *c2sbExecArgs) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	t.args = append(t.args, args)
	return t.cmrTx.Exec(ctx, sql, args...)
}

func TestC2SBMCPAuditEmptyArgsIsAnEmptyObject(t *testing.T) {
	tx := &c2sbExecArgs{cmrTx: cmrTx{exec: map[string]error{"INSERT INTO mcp_audit": nil}}}
	if err := InsertMCPAudit(context.Background(), tx, "f1", MCPAuditEntry{ID: "m1", Tool: "t"}); err != nil {
		t.Fatal(err)
	}
	got := tx.args[0][7].([]byte)
	if string(got) != "{}" {
		t.Errorf("args stored as %q, want {}", got)
	}
}

func TestC2SBSyncReaderPicks(t *testing.T) {
	if got := SyncReaderDevice("named", "tok"); got != "named" {
		t.Errorf("named device lost: %q", got)
	}
	if got := SyncReaderDevice("", "tok"); got != "tok" {
		t.Errorf("token device lost: %q", got)
	}
	if got := SyncReaderDevice("", ""); got != NilDevice {
		t.Errorf("fallback = %q", got)
	}

	ctx := context.Background()
	// An unnamed client of an account never seen on this farm, presenting a
	// cursor: the device lookup is skipped (the empty fake would panic) and
	// the replay is owed; only a role that sees no money drops it.
	for _, c := range []struct {
		role  domain.Role
		purge bool
	}{{domain.RoleWeigher, true}, {domain.RoleOwner, false}} {
		order, err := decideReplay(ctx, &cmrTx{}, nil, "u1", NilDevice, c.role, 42)
		if err != nil {
			t.Fatal(err)
		}
		if order.Reason != ReplayDeviceUnknown || order.PurgeMoney != c.purge ||
			!order.Required || order.FromCursor == nil || *order.FromCursor != 0 {
			t.Errorf("%s: order = %+v", c.role, order)
		}
	}
	if known, err := deviceKnownToSomebodyElse(ctx, &cmrTx{}, "u1", NilDevice); known || err != nil {
		t.Errorf("unnamed device known to somebody else: %v %v", known, err)
	}

	// A sibling's standing order wins over a role change seen on another.
	pending := "reason_x"
	order := siblingReplay([]readerRow{
		{DeviceID: "d1", Role: domain.RoleOwner, Pending: &pending, Purge: true},
		{DeviceID: "d2", Role: domain.RoleOwner},
	}, domain.RoleWeigher)
	if order.Reason != pending || !order.PurgeMoney || order.PreviousRole != domain.RoleOwner {
		t.Errorf("pending sibling: %+v", order)
	}
	// A sibling under another role is a role change; losing money sight purges.
	order = siblingReplay([]readerRow{{DeviceID: "d1", Role: domain.RoleOwner}}, domain.RoleWeigher)
	if order.Reason != ReplayRoleChanged || !order.PurgeMoney {
		t.Errorf("role change down: %+v", order)
	}
	order = siblingReplay([]readerRow{{DeviceID: "d1", Role: domain.RoleWeigher}}, domain.RoleAdmin)
	if order.Reason != ReplayRoleChanged || order.PurgeMoney {
		t.Errorf("role change up: %+v", order)
	}
}

func c2sbEntry(id string, kind domain.LedgerKind, amount int64, at time.Time, settlement, reverses *string) []any {
	return []any{id, "w1", kind, amount, at, settlement, nil, nil, reverses, at, nil}
}

// The receipt of a payment is the ledger as it stood that day: a discount
// cancelled before the payment is not on it, the week starts after the
// previous live payment, and a settlement that is gone is skipped.
func TestC2SBPaymentReceiptFromAScriptedLedger(t *testing.T) {
	ctx := context.Background()
	t0 := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	ledger := [][]any{
		c2sbEntry("e1", domain.KindEarning, 1000, at(1), nil, nil),
		c2sbEntry("p0", domain.KindPayment, -500, at(2), nil, nil),
		c2sbEntry("d1", domain.KindDeduction, -100, at(3), nil, nil),
		c2sbEntry("r1", domain.KindReversal, 100, at(4), nil, c2sbStr("d1")),
		c2sbEntry("e2", domain.KindEarning, 2000, at(5), c2sbStr("s-gone"), nil),
		c2sbEntry("p1", domain.KindPayment, -1500, at(6), nil, nil),
	}
	tx := &cmrTx{
		row: map[string]cmrRow{
			"FROM ledger WHERE id":      {vals: ledger[5]},
			"FROM settlements WHERE id": {err: pgx.ErrNoRows},
		},
		query: map[string]*cmrRows{"FROM ledger WHERE employee_id": {data: ledger}},
	}
	r, err := PaymentReceiptOf(ctx, tx, "p1")
	if err != nil {
		t.Fatal(err)
	}
	if r.CurrentWeekCents != 2000 || r.DeductionsCents != 0 || len(r.Deductions) != 0 ||
		r.PaidCents != 1500 || r.RemainingCents != 1000 || r.PreviousBalanceCents != 500 ||
		r.CurrentWeekFrom != nil || r.CurrentWeekTo != nil || r.Reversed {
		t.Errorf("receipt = %+v", r)
	}
	if len(r.SettlementIDs) != 1 || r.SettlementIDs[0] != "s-gone" {
		t.Errorf("settlements = %v", r.SettlementIDs)
	}

	// The cancelled discount's own receipt says it was reversed.
	tx.row["FROM ledger WHERE id"] = cmrRow{vals: ledger[2]}
	r, err = PaymentReceiptOf(ctx, tx, "d1")
	if err != nil || !r.Reversed || r.PaidCents != 100 {
		t.Errorf("deduction receipt = %+v, %v", r, err)
	}

	// Unknown id, and an id the worker's ledger does not list.
	tx.row["FROM ledger WHERE id"] = cmrRow{err: pgx.ErrNoRows}
	if _, err := PaymentReceiptOf(ctx, tx, "nope"); !errors.Is(err, pgx.ErrNoRows) {
		t.Errorf("unknown payment: %v", err)
	}
	tx.row["FROM ledger WHERE id"] = cmrRow{vals: ledger[5]}
	tx.query["FROM ledger WHERE employee_id"] = &cmrRows{}
	if _, err := PaymentReceiptOf(ctx, tx, "p1"); !errors.Is(err, pgx.ErrNoRows) {
		t.Errorf("payment missing from its own ledger: %v", err)
	}

	for _, rows := range []*cmrRows{cmrFailing(), cmrEndsBadly()} {
		tx.query["FROM ledger WHERE employee_id"] = rows
		_, err := PaymentReceiptOf(ctx, tx, "p1")
		c2sbWantErr(t, "PaymentReceiptOf ledger", err)
	}

	if absMinor(7) != 7 || absMinor(-7) != 7 {
		t.Error("absMinor")
	}
}
