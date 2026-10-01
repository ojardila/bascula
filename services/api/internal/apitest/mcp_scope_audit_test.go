package apitest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// Read-only grants and the MCP audit trail (migration 00038,
// docs/mcp/security.md).

func toolNames(t *testing.T, rec *httptest.ResponseRecorder) map[string]bool {
	t.Helper()
	var out struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("tools/list: %d %s", rec.Code, rec.Body.String())
	}
	names := map[string]bool{}
	for _, tl := range out.Result.Tools {
		names[tl.Name] = true
	}
	return names
}

const toolsListBody = `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`

// TestMCPReadOnlyGrant: a person can connect an assistant for consultation
// only. Its token lists no write tool and cannot run one, rotation keeps the
// restriction, and a grant from before scopes existed (NULL scope, like the
// live ChatGPT connection) keeps full access.
func TestMCPReadOnlyGrant(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca solo consulta", 250000)
	const host = "mcp-ro.example.org"
	signer := auth.NewSigner([]byte("test-signing-key"), "bascula")

	ro := h.oauthGrantAt(t, h.server, f, host, "ChatGPT", url.Values{"access": {"read"}})
	if ro["scope"] != auth.ScopeMCPRead {
		t.Fatalf("granted scope: %v", ro["scope"])
	}
	access := ro["access_token"].(string)
	if c, err := signer.Parse(access); err != nil || !c.ReadOnly() {
		t.Fatalf("read-only token claims: %+v %v", c, err)
	}
	names := toolNames(t, mcpRaw(h.server, host, access, toolsListBody))
	if !names["list_workers"] || names["create_worker"] || names["register_payment"] {
		t.Fatalf("read-only tool list: %v", names)
	}
	out := mcpRaw(h.server, host, access, toolCallBody("create_worker", map[string]any{"name": "No Debe", "tag": "ND-1"})).Body.String()
	if !strings.Contains(out, `"isError":true`) && !strings.Contains(out, `"error"`) {
		t.Fatalf("a read-only token ran a write: %s", out)
	}
	if strings.Contains(h.mustDo(t, http.MethodGet, "/v1/workers?q=No%20Debe", f.OwnerToken, nil, http.StatusOK).Raw, "No Debe") {
		t.Fatal("a read-only token created a worker")
	}

	// Rotation keeps it read-only.
	rec := formAt(h.server, host, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {ro["refresh_token"].(string)}, "client_id": {ro["client_id"].(string)},
	})
	var next map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &next)
	if c, err := signer.Parse(next["access_token"].(string)); err != nil || !c.ReadOnly() {
		t.Fatalf("the refreshed token lost the read-only scope: %s", rec.Body.String())
	}

	// A full grant, then made legacy (NULL scope): still full access.
	full := h.oauthGrantAt(t, h.server, f, host, "ChatGPT", nil)
	if names := toolNames(t, mcpRaw(h.server, host, full["access_token"].(string), toolsListBody)); !names["create_worker"] {
		t.Fatalf("a full grant misses write tools: %v", names)
	}
	if _, err := h.admin.Exec(context.Background(),
		`UPDATE refresh_tokens SET scope = NULL WHERE family_id IN (SELECT family_id FROM refresh_tokens WHERE oauth_client_id = $1)`,
		full["client_id"]); err != nil {
		t.Fatal(err)
	}
	rec = formAt(h.server, host, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {full["refresh_token"].(string)}, "client_id": {full["client_id"].(string)},
	})
	next = nil
	_ = json.Unmarshal(rec.Body.Bytes(), &next)
	tok, _ := next["access_token"].(string)
	if tok == "" {
		t.Fatalf("legacy refresh: %d %s", rec.Code, rec.Body.String())
	}
	out = mcpRaw(h.server, host, tok, toolCallBody("create_worker", map[string]any{"name": "Legado Sigue", "tag": "LS-1"})).Body.String()
	if strings.Contains(out, `"isError":true`) {
		t.Fatalf("a legacy grant lost write access: %s", out)
	}
}

// TestMCPWritesAreAudited: every write an assistant runs, or is refused, is
// recorded with who and which client; previews are not; the confirmation
// token is never stored; only the owner and the administrator read it.
func TestMCPWritesAreAudited(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca auditoría MCP", 250000)
	const host = "mcp-audit.example.org"
	g := h.oauthGrantAt(t, h.server, f, host, "ChatGPT", nil)
	access := g["access_token"].(string)

	out := mcpRaw(h.server, host, access, toolCallBody("create_worker", map[string]any{"name": "Auditado Uno", "tag": "AU-1"})).Body.String()
	if strings.Contains(out, `"isError":true`) {
		t.Fatalf("create_worker: %s", out)
	}
	sess := h.mcpClient(t, f.OwnerToken)
	priceArgs := map[string]any{"scope": "week", "monday": "2026-08-24", "priceCents": 300000}
	tok, _ := previewToken(t, sess, "set_kilo_price", priceArgs)
	mustTool(t, sess, "set_kilo_price", withToken(priceArgs, tok))
	// A weigher trying a write their role does not allow.
	wsess := h.mcpClient(t, f.WeigherToken)
	if res := callTool(t, wsess, "set_kilo_price", priceArgs); !res.IsError {
		t.Fatal("a weigher set the price")
	}

	got := h.mustDo(t, http.MethodGet, "/v1/mcp/activity", f.OwnerToken, nil, http.StatusOK)
	var body struct {
		Items []struct {
			Tool, Outcome, ClientName, UserID string
			ClientID                          *string
			Args                              map[string]any
		} `json:"items"`
	}
	_ = json.Unmarshal([]byte(got.Raw), &body)
	count := map[string]int{}
	for _, it := range body.Items {
		count[it.Tool+"/"+it.Outcome]++
		if _, leaked := it.Args["confirmationToken"]; leaked {
			t.Fatalf("a confirmation token was stored: %v", it.Args)
		}
		if it.Tool == "create_worker" && (it.ClientID == nil || *it.ClientID != g["client_id"] || it.ClientName != "ChatGPT") {
			t.Fatalf("the write does not name its client: %+v", it)
		}
	}
	if count["create_worker/done"] != 1 || count["set_kilo_price/done"] != 1 || count["set_kilo_price/refused"] != 1 || len(body.Items) != 3 {
		t.Fatalf("audit rows: %v (%s)", count, got.Raw)
	}
	h.mustDo(t, http.MethodGet, "/v1/mcp/activity", f.AdminToken, nil, http.StatusOK)
	h.mustDo(t, http.MethodGet, "/v1/mcp/activity", f.WeigherToken, nil, http.StatusForbidden)

	// Another farm sees none of it.
	other := h.signupFarm(t, "Finca ajena auditoría", 250000)
	if raw := h.mustDo(t, http.MethodGet, "/v1/mcp/activity", other.OwnerToken, nil, http.StatusOK).Raw; strings.Contains(raw, "create_worker") {
		t.Fatalf("audit leaked across farms: %s", raw)
	}
}

// TestOAuthRegistrationLimitSurvivesRestart: the per-address registration
// cap is counted in the database, so another replica (or a restart) does not
// hand out a fresh budget.
func TestOAuthRegistrationLimitSurvivesRestart(t *testing.T) {
	h := requireDB(t)
	reg := func(srv http.Handler) int {
		raw, _ := json.Marshal(map[string]any{"client_name": "x", "redirect_uris": []string{"https://claude.ai/cb"}})
		req := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = "10.9.3.3:1"
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		return rec.Code
	}
	mk := func() *httpapi.Server {
		return h.serverWithSigner(t, func(cfg *httpapi.Config) { cfg.OAuthRegistrationsPerIPPerHour = 2 })
	}
	a := mk()
	if reg(a) != http.StatusCreated || reg(a) != http.StatusCreated {
		t.Fatal("the first two registrations must pass")
	}
	if got := reg(mk()); got != http.StatusTooManyRequests {
		t.Fatalf("a fresh replica gave the address a new budget: %d", got)
	}
}
