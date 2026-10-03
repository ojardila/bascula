// SPDX-License-Identifier: MIT

package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// The handlers below check their input and their tenant before they reach the
// database. These tests mount the real routes behind an owner and a
// transaction of the test's choosing (none, one that fails, one with no farm),
// and assert the refusal each check gives.

const cmrFarm = "0192f3a0-0000-7000-8000-000000000001"
const cmrID = "0192f3a0-0000-7000-8000-0000000000aa"

// cmrCountTx answers every "SELECT count(*)" ownership check with 1 and fails
// everything else, so a request gets past confirmOurs and no further.
type cmrCountTx struct{ brokenTx }

type cmrCountRow struct{}

func (cmrCountRow) Scan(dest ...any) error {
	if n, ok := dest[0].(*int); ok && len(dest) == 1 {
		*n = 1
		return nil
	}
	return errDBDown
}

func (cmrCountTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if strings.Contains(sql, "SELECT count(*)") {
		return cmrCountRow{}
	}
	return brokenRow{}
}

// cmrTagTx is a database whose every call reports that the basket number's
// unique index fired: what a save racing another save for the same number
// sees, after the pre-check had found the number free.
type cmrTagTx struct{ brokenTx }

var cmrTagCollision = &pgconn.PgError{Code: "23505", ConstraintName: "ux_employees_tag"}

type cmrTagRow struct{}

func (cmrTagRow) Scan(...any) error { return cmrTagCollision }

func (cmrTagTx) QueryRow(context.Context, string, ...any) pgx.Row { return cmrTagRow{} }
func (cmrTagTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, cmrTagCollision
}
func (cmrTagTx) Query(context.Context, string, ...any) (pgx.Rows, error) { return nil, cmrTagCollision }

// cmrServe sends one request through the real route table. tx nil means no
// tenant at all; farm "" means a transaction with no farm on it.
func cmrServe(t *testing.T, tx pgx.Tx, farm, method, path, body string) (int, map[string]any) {
	t.Helper()
	s := New(nil, nil, Config{UploadDir: t.TempDir()})
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := auth.WithPrincipal(req.Context(), &auth.Principal{
				UserID: cmrID, FarmID: cmrFarm, Role: domain.RoleOwner})
			if tx != nil {
				ctx = tenant.WithTestTx(ctx, tx, farm)
			}
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	for _, rt := range s.Routes() {
		r.MethodFunc(rt.Method, rt.Pattern, rt.Handler)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	out := map[string]any{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func cmrErrCode(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}

func cmrExpect(t *testing.T, name string, status int, out map[string]any, wantStatus int, wantCode, wantMsg string) {
	t.Helper()
	if status != wantStatus || cmrErrCode(out) != wantCode {
		t.Errorf("%s: got %d %v, want %d %s", name, status, out, wantStatus, wantCode)
		return
	}
	if wantMsg != "" {
		msg, _ := out["error"].(map[string]any)["message"].(string)
		if !strings.Contains(msg, wantMsg) {
			t.Errorf("%s: message %q should mention %q", name, msg, wantMsg)
		}
	}
}

func TestCMRReportParameterRefusals(t *testing.T) {
	tx := brokenTx{}
	cases := []struct{ name, path, msg string }{
		{"from", "/v1/reports/weeks?from=2026-13-01", "from must be YYYY-MM-DD"},
		{"to", "/v1/reports/weeks?to=ayer", "to must be YYYY-MM-DD"},
		{"to before from", "/v1/reports/weeks?from=2026-08-24&to=2026-08-23", "to cannot be before from"},
		{"maxKg zero", "/v1/reports/anomalies?maxKg=0", "maxKg must be a positive"},
		{"maxKg text", "/v1/reports/anomalies?maxKg=mucho", "maxKg must be a positive"},
	}
	for _, c := range cases {
		st, out := cmrServe(t, tx, cmrFarm, http.MethodGet, c.path, "")
		cmrExpect(t, c.name, st, out, http.StatusBadRequest, string(domain.CodeBadRequest), c.msg)
	}

	// A valid Monday with no tenant: TENANT_NOT_SET, never an empty week.
	st, out := cmrServe(t, nil, "", http.MethodGet, "/v1/reports/weeks/2026-08-24", "")
	if st < 500 || cmrErrCode(out) == "" {
		t.Errorf("week detail without a tenant: %d %v", st, out)
	}
}

func TestCMRBoundedParam(t *testing.T) {
	get := func(q string) int {
		return boundedParam(httptest.NewRequest(http.MethodGet, "/x?"+q, nil), "weeks", 12, 52)
	}
	for q, want := range map[string]int{"": 12, "weeks=abc": 12, "weeks=0": 12, "weeks=-3": 12,
		"weeks=52": 52, "weeks=53": 52, "weeks=100000": 52, "weeks=7": 7} {
		if got := get(q); got != want {
			t.Errorf("boundedParam(%q) = %d, want %d", q, got, want)
		}
	}
}

func TestCMRListParams(t *testing.T) {
	req := func(q string) *http.Request { return httptest.NewRequest(http.MethodGet, "/x?"+q, nil) }
	for q, want := range map[string]int{"limit=x": 50, "limit=0": 50, "limit=-1": 50, "limit=501": maxListLimit, "limit=20": 20} {
		if got := limitParam(req(q), 50); got != want {
			t.Errorf("limitParam(%q) = %d, want %d", q, got, want)
		}
	}
	for q, want := range map[string]int{"offset=x": 0, "offset=-5": 0, "offset=40": 40} {
		if got := offsetParam(req(q)); got != want {
			t.Errorf("offsetParam(%q) = %d, want %d", q, got, want)
		}
	}
}

func TestCMRWorkerRefusalsBeforeTheDatabase(t *testing.T) {
	worker := `{"name":"Ana","tag":"77"}`

	// Create: no tenant, then a transaction with no farm on it.
	st, out := cmrServe(t, nil, "", http.MethodPost, "/v1/workers", worker)
	cmrExpect(t, "create without tenant", st, out, http.StatusInternalServerError, string(domain.CodeTenantNotSet), "")
	st, out = cmrServe(t, brokenTx{}, "", http.MethodPost, "/v1/workers", worker)
	cmrExpect(t, "create without farm", st, out, http.StatusInternalServerError, string(domain.CodeTenantNotSet), "")

	// A note: same two.
	note := `{"text":"llegó tarde"}`
	st, out = cmrServe(t, nil, "", http.MethodPost, "/v1/workers/"+cmrID+"/notes", note)
	cmrExpect(t, "note without tenant", st, out, http.StatusInternalServerError, string(domain.CodeTenantNotSet), "")
	st, out = cmrServe(t, brokenTx{}, "", http.MethodPost, "/v1/workers/"+cmrID+"/notes", note)
	cmrExpect(t, "note without farm", st, out, http.StatusInternalServerError, string(domain.CodeTenantNotSet), "")

	// The tag index fired on the update after the pre-check: DUPLICATE_TAG,
	// not a 500.
	st, out = cmrServe(t, cmrTagTx{}, cmrFarm, http.MethodPatch, "/v1/workers/"+cmrID, `{"name":"Ana María"}`)
	cmrExpect(t, "update racing tag", st, out, http.StatusConflict, string(domain.CodeDuplicateTag), "basket number")
}

func TestCMRWorkerHelpers(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	if _, err := parseMembersFrom(req, ""); err == nil {
		t.Error("membersFrom defaulting to today needs a tenant to know today")
	}
	if err := closeMembershipsToday(req, cmrID); err == nil {
		t.Error("closing memberships needs a tenant")
	}
	members := []string{}
	noFarm := httptest.NewRequest(http.MethodPatch, "/x", nil)
	noFarm = noFarm.WithContext(tenant.WithTestTx(noFarm.Context(), brokenTx{}, ""))
	err := setUpdatedWorkerMembers(noFarm, brokenTx{}, cmrID,
		&updateWorkerRequest{MemberIDs: &members, MembersFrom: "2026-08-24"}, nil)
	var tn *domain.Error
	if !asDomain(err, &tn) || tn.Code != domain.CodeTenantNotSet {
		t.Errorf("members set on a transaction with no farm: %v", err)
	}
	if principalUserID(nil) != "" {
		t.Error("no principal names nobody")
	}
	var de *domain.Error
	if err := createEmployeeError(cmrTagCollision); !asDomain(err, &de) || de.Code != domain.CodeDuplicateTag {
		t.Errorf("a tag collision on create: %v", err)
	}
	if err := createEmployeeError(errDBDown); err != errDBDown {
		t.Errorf("any other error passes through: %v", err)
	}
}

func asDomain(err error, out **domain.Error) bool {
	d, ok := err.(*domain.Error)
	if ok {
		*out = d
	}
	return ok
}

func TestCMRStockRefusals(t *testing.T) {
	// A harvest move tied to a weighing gets past the ownership checks, then
	// finds no farm on the transaction.
	move := `{"productId":"` + cmrID + `","warehouseId":"` + cmrID + `","qty":5,"reason":"cosecha","workRecordId":"` + cmrID + `"}`
	st, out := cmrServe(t, cmrCountTx{}, "", http.MethodPost, "/v1/stock/moves", move)
	cmrExpect(t, "move without farm", st, out, http.StatusInternalServerError, string(domain.CodeTenantNotSet), "")

	// With a farm it goes on to the write, which this database refuses.
	st, _ = cmrServe(t, cmrCountTx{}, cmrFarm, http.MethodPost, "/v1/stock/moves", move)
	if st != http.StatusInternalServerError {
		t.Errorf("move with the write failing: %d", st)
	}

	st, out = cmrServe(t, brokenTx{}, "", http.MethodPost, "/v1/stock/moves/"+cmrID+"/reverse", `{}`)
	cmrExpect(t, "reverse without farm", st, out, http.StatusInternalServerError, string(domain.CodeTenantNotSet), "")

	// More decimals than the column keeps: refused, not rounded.
	body := stockMoveRequest{}
	body.ProductID, body.WarehouseID, body.Reason, body.Qty = "p", "w", "cosecha", 1.23456
	if err := body.prepare(); err == nil || !strings.Contains(err.Error(), "qty") {
		t.Errorf("qty with four decimals: %v", err)
	}

	req := tenantReq(brokenTx{})
	if err := confirmOurs(req, map[string]string{"bogus": cmrID}); err == nil ||
		!strings.Contains(err.Error(), "unknown ownership check bogus") {
		t.Errorf("an unknown ownership kind must fail closed: %v", err)
	}
	if err := guardStock(httptest.NewRequest(http.MethodPost, "/x", nil), cmrID, cmrID, -5); err == nil {
		t.Error("the stock guard needs a tenant")
	}
}

func tenantReq(tx pgx.Tx) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	return req.WithContext(tenant.WithTestTx(req.Context(), tx, cmrFarm))
}
