// SPDX-License-Identifier: MIT

package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

// The write tools read through the server's own routes. These tests swap the
// router for a table of canned answers, so a refusal can arrive at exactly the
// read a preview or a confirmation makes second — which no database-backed test
// can arrange, because the first read would be refused for the same reason.

type cmrReply struct {
	status int
	body   string
}

// cmrCaller is an mcpCaller whose inner requests are answered from routes:
// "METHOD /path" → reply. Anything else is a 404 envelope.
func cmrCaller(t *testing.T, routes map[string]cmrReply) (*mcpCaller, *[]string) {
	t.Helper()
	signer := auth.NewSigner([]byte("test-signing-key"), "bascula")
	s := &Server{signer: signer}
	var seen []string
	r := chi.NewRouter()
	r.HandleFunc("/*", func(w http.ResponseWriter, req *http.Request) {
		k := req.Method + " " + req.URL.Path
		seen = append(seen, k)
		rep, ok := routes[k]
		if !ok {
			rep = cmrReply{http.StatusNotFound, `{"error":{"code":"NOT_FOUND","message":"not found"}}`}
		}
		w.WriteHeader(rep.status)
		_, _ = w.Write([]byte(rep.body))
	})
	s.router = r
	tok, err := signer.Issue("u-1", "f-1", domain.RoleOwner, "", false)
	if err != nil {
		t.Fatal(err)
	}
	h := http.Header{}
	h.Set("Authorization", "Bearer "+tok)
	req := &mcp.CallToolRequest{Extra: &mcp.RequestExtra{Header: h}}
	return &mcpCaller{s: s, ctx: context.Background(), req: req}, &seen
}

const cmrWorker = `{"id":"w-1","name":"Ana","kind":"persona"}`

func TestCMRLedgerPreviewRefusals(t *testing.T) {
	a := mcpArgs{"workerId": "w-1", "amountCents": json.Number("500")}

	// A malformed amount is refused before anything is read.
	c, seen0 := cmrCaller(t, nil)
	_, err := previewLedger("PAGO")(c, mcpArgs{"workerId": "w-1", "amountCents": "mucho"})
	wantErr(t, err, `"amountCents" debe ser un entero`)
	if len(*seen0) != 0 {
		t.Errorf("a malformed amount still read %v", *seen0)
	}

	// The worker is not there: the route's own 404 envelope, not a preview.
	_, err = previewLedger("PAGO")(c, a)
	wantErr(t, err, "NOT_FOUND")

	// The worker reads, the balance does not: still no preview with a
	// made-up balance of zero.
	c, seen := cmrCaller(t, map[string]cmrReply{"GET /v1/workers/w-1": {200, cmrWorker}})
	_, err = previewLedger("ANTICIPO")(c, a)
	wantErr(t, err, "NOT_FOUND")
	if len(*seen) != 2 || (*seen)[1] != "GET /v1/workers/w-1/balance" {
		t.Errorf("the second read should be the balance, got %v", *seen)
	}

	// A receiver named on a worker whose body lists no members reads as the
	// id given.
	if got := previewLedgerReceiver(map[string]any{"name": "Ana"}, "m-9"); got != "m-9" {
		t.Errorf("previewLedgerReceiver without members = %q", got)
	}
}

func TestCMRPricePreviewAndExecuteRefusals(t *testing.T) {
	week := mcpArgs{"scope": "week", "monday": "2026-08-24", "priceCents": json.Number("90000")}
	base := mcpArgs{"scope": "base", "monday": "2026-08-24", "priceCents": json.Number("90000")}

	c, _ := cmrCaller(t, nil)
	_, err := previewPrice(c, mcpArgs{"scope": "week", "monday": "2026-08-24", "priceCents": json.Number("9.5")})
	wantErr(t, err, "sin decimales")
	_, err = previewPrice(c, week)
	wantErr(t, err, "NOT_FOUND")
	_, err = previewPrice(c, base)
	wantErr(t, err, "NOT_FOUND")
	if _, err := currentPriceAt(c, week); err == nil {
		t.Error("currentPriceAt(week) with the week unreadable should fail")
	}
	if _, err := currentPriceAt(c, base); err == nil {
		t.Error("currentPriceAt(base) with the base unreadable should fail")
	}
	// executePrice refuses when it cannot read the price it promised to change.
	if res := executePrice(c, base, "k", "80000"); !res.IsError || !strings.Contains(toolResultText(res), "NOT_FOUND") {
		t.Errorf("executePrice with the price unreadable: %v", toolResultText(res))
	}

	// History that starts after the Monday: the current price stands.
	c, _ = cmrCaller(t, map[string]cmrReply{"GET /v1/prices/base": {200,
		`{"currentCents":70000,"history":[{"validFrom":"2026-09-07","priceCents":95000},{"priceCents":1}]}`}})
	if cur, err := currentPriceAt(c, base); err != nil || cur != 70000 {
		t.Errorf("currentPriceAt with no history row in force = %d, %v; want the current 70000", cur, err)
	}

	// The bind still matches, but the amount itself is malformed: refused by
	// the builder, after the read, before any write.
	bad := mcpArgs{"scope": "base", "monday": "2026-08-24", "priceCents": json.Number("1.5")}
	c, seen := cmrCaller(t, map[string]cmrReply{"GET /v1/prices/base": {200, `{"currentCents":70000}`}})
	res := executePrice(c, bad, "k", "70000")
	if !res.IsError || !strings.Contains(toolResultText(res), "sin decimales") {
		t.Errorf("executePrice with a decimal price: %s", toolResultText(res))
	}
	for _, k := range *seen {
		if strings.HasPrefix(k, "PUT ") {
			t.Errorf("a malformed price reached the write: %v", *seen)
		}
	}
}

func TestCMRSettlementRefusals(t *testing.T) {
	a := mcpArgs{"workerId": "w-1", "from": "2026-08-24", "to": "2026-08-30"}

	// The worker reads, the preview is refused: the refusal, not "nothing to
	// settle".
	c, _ := cmrCaller(t, map[string]cmrReply{"GET /v1/workers/w-1": {200, cmrWorker},
		"POST /v1/settlements/preview": {http.StatusConflict, `{"error":{"code":"WORKER_IN_TEAM","message":"x"}}`}})
	_, err := previewSettlement(c, a)
	wantErr(t, err, "WORKER_IN_TEAM")

	// Confirming: no settlement under the key yet, and the re-preview fails.
	res := executeSettlement(c, a, "key-1", "100:x")
	if !res.IsError || !strings.Contains(toolResultText(res), "WORKER_IN_TEAM") {
		t.Errorf("executeSettlement with the preview refused: %s", toolResultText(res))
	}

	// Voiding a settlement whose period comes back short: shown as given.
	c, _ = cmrCaller(t, map[string]cmrReply{"GET /v1/settlements/s-1": {200,
		`{"id":"s-1","status":"active","workerId":"w-1","periodStart":"ayer","periodEnd":"2026-08-30T00:00:00Z","grossCents":1500,"items":[{}]}`},
		"GET /v1/workers/w-1": {200, cmrWorker}})
	pv, err := previewVoidSettlement(c, mcpArgs{"id": "s-1"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(pv.Summary, "periodo ayer a 2026-08-30") || !strings.Contains(pv.Summary, "de Ana") {
		t.Errorf("void preview summary: %q", pv.Summary)
	}
}

func TestCMRWriteBuildersRefuseMalformedNumbersAndLists(t *testing.T) {
	cases := []struct {
		tool string
		args mcpArgs
		want string
	}{
		{"create_team", mcpArgs{"name": "E", "tag": "1", "memberIds": "a,b"}, `"memberIds" debe ser una lista`},
		{"set_team_members", mcpArgs{"teamId": "t", "memberIds": []any{1.0}}, "memberIds[0] debe ser un UUID"},
		{"create_plot", mcpArgs{"name": "L", "areaHa": "mucha"}, `"areaHa" debe ser un número`},
		{"register_weighing", mcpArgs{"workerId": "w", "kg": "diez", "date": "2026-08-24"}, `"kg" debe ser un número`},
		{"correct_weighing", mcpArgs{"id": "x", "kg": true}, `"kg" debe ser un número`},
	}
	for _, c := range cases {
		t.Run(c.tool, func(t *testing.T) {
			_, err := writeTool(t, c.tool).Build(c.args, "")
			wantErr(t, err, c.want)
		})
	}
}

func TestCMRPrincipalFromTheToolRequest(t *testing.T) {
	signer := auth.NewSigner([]byte("test-signing-key"), "bascula")
	s := &Server{signer: signer}
	header := func(v string) *mcp.CallToolRequest {
		h := http.Header{}
		if v != "" {
			h.Set("Authorization", v)
		}
		return &mcp.CallToolRequest{Extra: &mcp.RequestExtra{Header: h}}
	}
	if _, err := s.mcpPrincipal(&mcp.CallToolRequest{}); err == nil || err.Error() != "no headers" {
		t.Errorf("no extra: %v", err)
	}
	if _, err := s.mcpPrincipal(&mcp.CallToolRequest{Extra: &mcp.RequestExtra{}}); err == nil || err.Error() != "no headers" {
		t.Errorf("no header map: %v", err)
	}
	if _, err := s.mcpPrincipal(header("")); err == nil || err.Error() != "no bearer" {
		t.Errorf("no bearer: %v", err)
	}
	if _, err := s.mcpPrincipal(header("Bearer not-a-token")); err == nil {
		t.Error("a garbage bearer must not yield a principal")
	}

	ro, err := signer.IssueMCP("", "client-1", auth.ScopeMCPRead, auth.TokenSubject{UserID: "u-1", FarmID: "f-1", Role: domain.RoleOwner})
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.mcpPrincipal(header("Bearer " + ro))
	if err != nil || !p.ReadOnly || !p.MCPOnly || p.ClientID != "client-1" {
		t.Fatalf("read-only principal: %+v, %v", p, err)
	}
}

// TestCMRWriteHandlerRefusesBeforeRunning drives the tool handler itself: a
// request that carries no principal, and a read-only grant that calls a
// write tool anyway (the tool list hides them; the handler is the second
// lock). Neither may reach the route.
func TestCMRWriteHandlerRefusesBeforeRunning(t *testing.T) {
	signer := auth.NewSigner([]byte("test-signing-key"), "bascula")
	s := New(nil, signer, Config{UploadDir: t.TempDir()})
	reached := false
	r := chi.NewRouter()
	r.HandleFunc("/*", func(w http.ResponseWriter, _ *http.Request) { reached = true })
	s.router = r

	handler := s.mcpWriteHandler(writeTool(t, "create_worker"))
	args := json.RawMessage(`{"name":"No Debe","tag":"ND-1"}`)

	res, err := handler(context.Background(), &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Arguments: args}})
	if err != nil || !res.IsError || !strings.Contains(toolResultText(res), "UNAUTHORIZED") {
		t.Errorf("no principal: %v %s", err, toolResultText(res))
	}

	ro, _ := signer.IssueMCP("", "client-1", auth.ScopeMCPRead, auth.TokenSubject{UserID: "u-ro", FarmID: "f-1", Role: domain.RoleOwner})
	h := http.Header{}
	h.Set("Authorization", "Bearer "+ro)
	res, err = handler(context.Background(), &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{Arguments: args}, Extra: &mcp.RequestExtra{Header: h}})
	if err != nil || !res.IsError || !strings.Contains(toolResultText(res), "read-only access") ||
		!strings.Contains(toolResultText(res), "Consultar y registrar") {
		t.Errorf("read-only grant calling a write: %v %s", err, toolResultText(res))
	}
	if reached {
		t.Error("a refused write reached the route")
	}
}

// TestCMRPreviewWithoutFacts: a preview that states no facts still hands the
// assistant an object, never a null it has to special-case.
func TestCMRPreviewWithoutFacts(t *testing.T) {
	c, _ := cmrCaller(t, nil)
	tool := mcpWriteTool{Name: "cmr_tool", Preview: func(*mcpCaller, mcpArgs) (*mcpPreview, error) {
		return &mcpPreview{Summary: "nada"}, nil
	}}
	res := c.s.mcpIssuePreview(c, tool, &auth.Principal{UserID: "u-1", FarmID: "f-1"}, mcpArgs{})
	sc, _ := res.StructuredContent.(map[string]any)
	if facts, ok := sc["preview"].(map[string]any); !ok || facts == nil || len(facts) != 0 {
		t.Errorf("preview facts = %#v, want an empty object", sc["preview"])
	}
	if sc["status"] != "confirmation_required" || sc["confirmationToken"] == "" {
		t.Errorf("preview envelope: %v", sc)
	}
}
