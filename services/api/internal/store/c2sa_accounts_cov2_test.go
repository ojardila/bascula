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

// A list half-read is never an answer: a row that fails to scan is the error.
func TestC2saAccountListsPassScanErrorsThrough(t *testing.T) {
	ctx := context.Background()
	q := func(key string) *cmrTx { return &cmrTx{query: map[string]*cmrRows{key: cmrFailing()}} }

	_, err := OwnerCredentialHashes(ctx, q("FROM farm_owner_credentials WHERE user_id = $1"), "u")
	cmrWantErr(t, "OwnerCredentialHashes", err)
	_, err = ListMemberships(ctx, q("ORDER BY f.created_at"), "u")
	cmrWantErr(t, "ListMemberships", err)
	_, err = ListFarmUsers(ctx, q("ORDER BY m.role, lower(u.email)"))
	cmrWantErr(t, "ListFarmUsers", err)
	_, err = ListAdminFarms(ctx, q("($2 = 'suspended' AND suspended_at IS NOT NULL)"), "", "")
	cmrWantErr(t, "ListAdminFarms", err)
	_, err = ListMCPConnections(ctx, q("coalesce(l.scope = 'mcp:read', false)"), "u", "f")
	cmrWantErr(t, "ListMCPConnections", err)
	_, err = ListUserSessions(ctx, q("coalesce(l.sign_in_method, '')"), "u", "f")
	cmrWantErr(t, "ListUserSessions", err)
	_, err = ListSpecialPrices(ctx, q("AS current_minor"))
	cmrWantErr(t, "ListSpecialPrices", err)
	_, err = KiloPrices(ctx, q("CROSS JOIN LATERAL kilo_price("), []string{"w1"})
	cmrWantErr(t, "KiloPrices", err)
}

// A write that touched no row says so instead of reporting success.
func TestC2saWritesThatTouchNothing(t *testing.T) {
	ctx := context.Background()
	e := func(key string) *cmrTx { return &cmrTx{exec: map[string]error{key: nil}} }

	if err := SetMembershipRole(ctx, e("UPDATE memberships SET role"), "u", domain.RoleAdmin); !errors.Is(err, NoRows) {
		t.Errorf("SetMembershipRole of a non-member: %v", err)
	}
	if err := DeleteMembership(ctx, e("DELETE FROM memberships"), "u"); !errors.Is(err, NoRows) {
		t.Errorf("DeleteMembership of a non-member: %v", err)
	}
	tx := e("UPDATE users SET password_hash")
	if err := ReplaceUnverifiedClaim(ctx, tx, "u", "n", "p", "h"); !errors.Is(err, pgx.ErrNoRows) {
		t.Errorf("ReplaceUnverifiedClaim of a verified account: %v", err)
	}
	if len(tx.seen) != 1 {
		t.Errorf("the refused claim still spent the pending links: %v", tx.seen)
	}
	err := SetSpecialPrice(ctx, e("INSERT INTO plot_prices"), "f", "u",
		SpecialPriceChange{Kind: SpecialPlot, TargetID: "p", ValidFrom: time.Now()})
	c2saWantCode(t, "SetSpecialPrice that wrote nothing", err, 404, domain.CodeNotFound)
}

func TestC2saOAuthClientDefaults(t *testing.T) {
	ctx := context.Background()
	tx := &c2saArgsTx{cmrTx: &cmrTx{exec: map[string]error{"INSERT INTO oauth_clients": nil}}}
	if err := InsertOAuthClientFrom(ctx, tx, OAuthClient{ID: "c1", Name: "ChatGPT"}, "1.2.3.4"); err != nil {
		t.Fatal(err)
	}
	args := tx.execArgs[0]
	if args[4] != "none" {
		t.Errorf("auth method %v, want none for a client that named none", args[4])
	}
	if m, _ := args[6].([]byte); string(m) != "{}" {
		t.Errorf("metadata %q, want {}", m)
	}

	tx = &c2saArgsTx{cmrTx: &cmrTx{exec: map[string]error{"INSERT INTO oauth_clients": nil}}}
	_ = InsertOAuthClientFrom(ctx, tx, OAuthClient{AuthMethod: "client_secret_post", Metadata: []byte(`{"a":1}`)}, "x")
	if args = tx.execArgs[0]; args[4] != "client_secret_post" || string(args[6].([]byte)) != `{"a":1}` {
		t.Errorf("given values were replaced: %v", args)
	}
}

const (
	c2saFarmUpdateSQL = "UPDATE farms f SET"
	c2saFarmPriceSQL  = "INSERT INTO farm_prices"
	c2saFarmSyncSQL   = "UPDATE farm_config fc SET"
	c2saFarmConfigSQL = "SELECT price_minor, harvest_mode FROM farm_config"
)

func c2saFarmTx(priceErr, syncErr error) *cmrTx {
	return &cmrTx{
		row: map[string]cmrRow{
			c2saFarmUpdateSQL: {vals: []any{"f1", "Finca"}},
			c2saFarmConfigSQL: {vals: []any{int64(90000), true}},
		},
		exec: map[string]error{c2saFarmPriceSQL: priceErr, c2saFarmSyncSQL: syncErr},
	}
}

// The legacy standing price lands in the price history and the current base
// price follows it; a failure at either step is the request's failure.
func TestC2saUpdateFarmStandingPrice(t *testing.T) {
	ctx := context.Background()
	price := int64(90000)

	tx := c2saFarmTx(nil, nil)
	out, err := UpdateFarm(ctx, tx, Farm{PriceMinor: &price}, nil)
	if err != nil {
		t.Fatalf("UpdateFarm: %v", err)
	}
	if out.ID != "f1" || out.PriceMinor == nil || *out.PriceMinor != 90000 || out.HarvestMode == nil || !*out.HarvestMode {
		t.Errorf("UpdateFarm = %+v", out)
	}
	want := []string{"R:" + c2saFarmUpdateSQL, "E:" + c2saFarmPriceSQL, "E:" + c2saFarmSyncSQL, "R:" + c2saFarmConfigSQL}
	if !c2saSameOrder(tx.seen, want) {
		t.Errorf("calls %v, want %v", tx.seen, want)
	}

	for name, tx := range map[string]*cmrTx{"history": c2saFarmTx(errCMR, nil), "sync": c2saFarmTx(nil, errCMR)} {
		out, err := UpdateFarm(ctx, tx, Farm{PriceMinor: &price}, nil)
		cmrWantErr(t, name, err)
		if out != nil {
			t.Errorf("%s: a farm came back with the error", name)
		}
	}
}

func c2saImporter(tx pgx.Tx) *seasonImporter {
	return &seasonImporter{ctx: context.Background(), tx: tx, farmID: "f", newID: func() string { return "x" },
		rep: &ImportReport{}}
}

const c2saUUID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b"

func TestC2saImportChecks(t *testing.T) {
	ctx := context.Background()

	// The same payable claimed twice by live settlements in one file.
	tx := &cmrTx{
		row:  map[string]cmrRow{"WHERE settlement_id = $1 AND payable_id = $2": {err: pgx.ErrNoRows}},
		exec: map[string]error{"INSERT INTO settlement_items": &pgconn.PgError{Code: "23505", ConstraintName: "ux_items_payable_live"}},
	}
	err := c2saImporter(tx).settlementItem(ImportSettlement{ID: "s1"}, "settlement s1",
		ImportSettlementItem{PayableID: c2saUUID, WeekStart: "2026-09-28", Quantity: "1"})
	de := c2saWantCode(t, "double claim", err, 409, domain.CodePayableAlreadyClaimed)
	if de.Details["settlementId"] != "s1" || de.Details["payableId"] != c2saUUID {
		t.Errorf("double claim details %v", de.Details)
	}

	// A balance for a worker id that is not even a uuid is an unknown worker,
	// not a query.
	rep := &ImportReport{}
	err = checkImportBalances(ctx, &cmrTx{}, SeasonImport{Balances: []ImportBalance{{WorkerID: "w-1"}}}, rep)
	de = c2saWantCode(t, "non-uuid worker", err, 409, domain.CodeImportMismatch)
	if u, _ := de.Details["unknownWorkers"].([]string); len(u) != 1 || u[0] != "w-1" || rep.BalancesChecked != 1 {
		t.Errorf("non-uuid worker: details %v, checked %d", de.Details, rep.BalancesChecked)
	}

	// A settlement that is not there after the import.
	tx = &cmrTx{row: map[string]cmrRow{"FROM settlements s WHERE s.id = $1": {err: pgx.ErrNoRows}}}
	err = checkImportSettlements(ctx, tx, SeasonImport{Settlements: []ImportSettlement{{ID: "s9"}}})
	c2saWantCode(t, "missing settlement", err, 409, domain.CodeImportMismatch)

	// A stray line that fails to scan.
	strays, err := appendSettlementStrays(ctx, &cmrTx{query: map[string]*cmrRows{"w.employee_id <> $2": cmrFailing()}},
		nil, "s1", "e1")
	cmrWantErr(t, "appendSettlementStrays", err)
	if len(strays) != 0 {
		t.Errorf("strays %v came back with the error", strays)
	}

	// Fewer live lines than the handset sent.
	tx = &cmrTx{row: map[string]cmrRow{"WHERE voided_at IS NULL": {vals: []any{1}}}}
	rep = &ImportReport{}
	in := SeasonImport{Settlements: []ImportSettlement{{Items: []ImportSettlementItem{{}, {}, {VoidedAt: &time.Time{}}}}}}
	err = checkImportLiveLines(ctx, tx, in, rep)
	de = c2saWantCode(t, "lost live lines", err, 409, domain.CodeImportMismatch)
	if de.Details["expectedLiveItems"] != 2 || de.Details["liveItems"] != 1 || rep.LiveItems != 1 {
		t.Errorf("lost live lines: details %v, report %d", de.Details, rep.LiveItems)
	}
}

func TestC2saImportFailure(t *testing.T) {
	// A domain error is passed through untouched.
	own := domain.Conflict(domain.CodeAlreadyReversed, "mine")
	if got := importFailure("row 3", own); got != own {
		t.Errorf("importFailure rewrote a domain error: %v", got)
	}
	// Any unique violation is a mismatch naming the row.
	de := c2saWantCode(t, "unique", importFailure("row 3", &pgconn.PgError{Code: "23505", ConstraintName: "anything"}),
		409, domain.CodeImportMismatch)
	if de.Message != "the import was refused at row 3" {
		t.Errorf("unique violation message %q", de.Message)
	}
	// Anything else is a 400 naming the row and the cause.
	de = c2saWantCode(t, "other", importFailure("row 3", errCMR), 400, domain.CodeBadRequest)
	if !errors.Is(de, errCMR) {
		t.Errorf("the cause was dropped: %v", de)
	}
}
