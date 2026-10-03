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

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// The money handlers with a request that is valid as far as the body goes but
// reaches them without a tenant: no transaction at all, or a transaction with
// no farm pinned. Every one must refuse with TENANT_NOT_SET before touching
// the database, never answer as if the farm had nothing in it. The sweep in
// fault_sweep_test.go sends bodies too thin to get that far.

type cmoMoneyCase struct {
	name    string
	handler func(*Server) http.HandlerFunc
	method  string
	query   string
	params  map[string]string
	body    string
	mode    string // "none": no tenant; "nofarm": a transaction, no farm
	status  int
	code    domain.Code
}

func cmoServeMoney(t *testing.T, c cmoMoneyCase) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	s := New(nil, nil, Config{UploadDir: t.TempDir()})
	const id = "0192f3a0-0000-7000-8000-0000000000aa"
	req := httptest.NewRequest(c.method, "/v1/x"+c.query, strings.NewReader(c.body))
	req.Header.Set("Content-Type", "application/json")
	ctx := auth.WithPrincipal(req.Context(), &auth.Principal{
		UserID: id, FarmID: id, Role: domain.RoleOwner, Email: "dueno@example.com",
	})
	if c.mode == "nofarm" {
		ctx = tenant.WithTestTx(ctx, brokenTx{}, "")
	}
	rctx := chi.NewRouteContext()
	for k, v := range c.params {
		rctx.URLParams.Add(k, v)
	}
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	rec := httptest.NewRecorder()
	c.handler(s).ServeHTTP(rec, req.WithContext(ctx))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func TestCmoMoneyHandlersRefuseWithoutTenant(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	const w = "0192f3a0-0000-7000-8000-0000000000bb"
	settle := `{"workerId":"` + w + `","from":"2026-08-24","to":"2026-08-30","expectedGrossCents":100}`
	pay := `{"workerId":"` + w + `","amountCents":100}`
	monday := map[string]string{"monday": "2026-01-05"}
	sid := map[string]string{"id": w}
	tns, tnsCode := http.StatusInternalServerError, domain.CodeTenantNotSet
	bad := http.StatusBadRequest

	cases := []cmoMoneyCase{
		{"pending/no tenant", func(s *Server) http.HandlerFunc { return s.handlePending }, "GET",
			"?workerId=" + w + "&from=2026-08-24&to=2026-08-30", nil, "", "none", tns, tnsCode},
		{"preview/no tenant", func(s *Server) http.HandlerFunc { return s.handleSettlementPreview }, "POST",
			"", nil, settle, "none", tns, tnsCode},
		{"settle/zero expectation", func(s *Server) http.HandlerFunc { return s.handleCreateSettlement }, "POST",
			"", nil, `{"workerId":"` + w + `","from":"2026-08-24","to":"2026-08-30","expectedGrossCents":0}`,
			"none", bad, domain.CodeBadRequest},
		{"settle/negative expectation", func(s *Server) http.HandlerFunc { return s.handleCreateSettlement }, "POST",
			"", nil, `{"workerId":"` + w + `","from":"2026-08-24","to":"2026-08-30","expectedGrossCents":-1}`,
			"none", bad, domain.CodeBadRequest},
		{"settle/inverted range", func(s *Server) http.HandlerFunc { return s.handleCreateSettlement }, "POST",
			"", nil, `{"workerId":"` + w + `","from":"2026-08-30","to":"2026-08-24","expectedGrossCents":1}`,
			"none", bad, domain.CodeBadRequest},
		{"settle/no tenant", func(s *Server) http.HandlerFunc { return s.handleCreateSettlement }, "POST",
			"", nil, settle, "none", tns, tnsCode},
		{"settle/no farm", func(s *Server) http.HandlerFunc { return s.handleCreateSettlement }, "POST",
			"", nil, settle, "nofarm", tns, tnsCode},
		{"void/no farm", func(s *Server) http.HandlerFunc { return s.handleVoidSettlement }, "POST",
			"", sid, "", "nofarm", tns, tnsCode},
		{"release/no tenant", func(s *Server) http.HandlerFunc { return s.handleReleaseSettlement }, "POST",
			"", sid, `{"reason":"x"}`, "none", tns, tnsCode},
		{"release/no farm", func(s *Server) http.HandlerFunc { return s.handleReleaseSettlement }, "POST",
			"", sid, `{"reason":"x"}`, "nofarm", tns, tnsCode},
		{"payment/no tenant", func(s *Server) http.HandlerFunc { return s.handlePayment }, "POST",
			"", nil, pay, "none", tns, tnsCode},
		{"payment/no farm", func(s *Server) http.HandlerFunc { return s.handlePayment }, "POST",
			"", nil, pay, "nofarm", tns, tnsCode},
		{"reverse/no farm", func(s *Server) http.HandlerFunc { return s.handleReverseLedger }, "POST",
			"", sid, "", "nofarm", tns, tnsCode},
		{"week price get/no tenant", func(s *Server) http.HandlerFunc { return s.handleGetWeekPrice }, "GET",
			"", monday, "", "none", tns, tnsCode},
		{"week price set/bad json", func(s *Server) http.HandlerFunc { return s.handleSetWeekPrice }, "PUT",
			"", monday, `{"priceCents":`, "none", bad, domain.CodeBadRequest},
		{"week price set/no tenant", func(s *Server) http.HandlerFunc { return s.handleSetWeekPrice }, "PUT",
			"", monday, `{"priceCents":5}`, "none", tns, tnsCode},
		{"week price set/no farm", func(s *Server) http.HandlerFunc { return s.handleSetWeekPrice }, "PUT",
			"", monday, `{"priceCents":5}`, "nofarm", tns, tnsCode},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec, out := cmoServeMoney(t, c)
			if rec.Code != c.status {
				t.Fatalf("status %d, want %d: %s", rec.Code, c.status, rec.Body.String())
			}
			e, _ := out["error"].(map[string]any)
			if got, _ := e["code"].(string); got != string(c.code) {
				t.Errorf("code %q, want %q: %s", got, c.code, rec.Body.String())
			}
		})
	}
}
