package apitest

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// The security review of the MCP server and its OAuth (docs/mcp/security.md).
// One test per finding, each named for what an attacker could do before.

// oauthGrantAt runs the connector's OAuth dance at a given host and returns
// the token response plus the client id.
func (h *harness) oauthGrantAt(t *testing.T, srv http.Handler, f *farmFixture, host, clientName string, extra url.Values) map[string]any {
	t.Helper()
	redirect := "https://chatgpt.com/connector_platform_oauth_redirect"
	raw, _ := json.Marshal(map[string]any{"client_name": clientName, "redirect_uris": []string{redirect}})
	req := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	req.Host = host
	req.RemoteAddr = "10.44.0.1:1"
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	var reg map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &reg)
	clientID := reg["client_id"].(string)
	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	form := url.Values{
		"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"email": {f.OwnerEmail}, "password": {"una-clave-larga-1"},
	}
	for k, v := range extra {
		form[k] = v
	}
	rec = formAt(srv, host, "/oauth/authorize", form)
	if rec.Code != http.StatusFound {
		t.Fatalf("authorize: %d %s", rec.Code, rec.Body.String())
	}
	loc, _ := rec.Result().Location()
	if e := loc.Query().Get("error"); e != "" {
		t.Fatalf("authorize error: %s", loc)
	}
	rec = formAt(srv, host, "/oauth/token", url.Values{
		"grant_type": {"authorization_code"}, "code": {loc.Query().Get("code")},
		"redirect_uri": {redirect}, "client_id": {clientID}, "code_verifier": {verifier},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("token: %d %s", rec.Code, rec.Body.String())
	}
	var tok map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &tok)
	tok["client_id"] = clientID
	tok["code"] = loc.Query().Get("code")
	return tok
}

func formAt(srv http.Handler, host, path string, form url.Values) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Host = host
	req.RemoteAddr = "10.44.0.1:1"
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

// mcpRaw posts one JSON-RPC body to /mcp at host with a bearer.
func mcpRaw(srv http.Handler, host, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-06-18")
	if host != "" {
		req.Host = host
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "10.44.0.2:1"
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

func toolCallBody(name string, args map[string]any) string {
	raw, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args},
	})
	return string(raw)
}

const initializeBody = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`

// TestMCPTokenIsAudienceBound: RFC 8707. An assistant's token names the MCP
// resource it was issued for and is refused at another; a resource indicator
// that is not this server is refused at authorize and at the token endpoint;
// and a token minted before the binding (audience "mcp" alone, like the live
// ChatGPT grant's) keeps working until it lapses.
func TestMCPTokenIsAudienceBound(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca audiencia MCP", 250000)
	const hostA, hostB = "mcp-a.example.org", "mcp-b.example.org"
	tok := h.oauthGrantAt(t, h.server, f, hostA, "ChatGPT",
		url.Values{"resource": {"http://" + hostA + "/mcp"}})
	access := tok["access_token"].(string)

	claims, err := auth.NewSigner([]byte("test-signing-key"), "bascula").Parse(access)
	if err != nil {
		t.Fatal(err)
	}
	if claims.MCPResource() != "http://"+hostA+"/mcp" || claims.ClientID != tok["client_id"] {
		t.Fatalf("token not bound to its resource and client: aud=%v cid=%q", claims.Audience, claims.ClientID)
	}
	if rec := mcpRaw(h.server, hostA, access, initializeBody); rec.Code != http.StatusOK {
		t.Fatalf("token refused at its own resource: %d %s", rec.Code, rec.Body.String())
	}
	rec := mcpRaw(h.server, hostB, access, initializeBody)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Header().Get("WWW-Authenticate"), "invalid_token") {
		t.Fatalf("token for %s opened %s: %d %s", hostA, hostB, rec.Code, rec.Body.String())
	}

	// The refreshed token is bound the same way.
	rec = formAt(h.server, hostA, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)},
		"client_id": {tok["client_id"].(string)},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh: %d %s", rec.Code, rec.Body.String())
	}
	var next map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &next)
	if rec := mcpRaw(h.server, hostB, next["access_token"].(string), initializeBody); rec.Code != http.StatusUnauthorized {
		t.Fatalf("refreshed token opened another resource: %d", rec.Code)
	}

	// A legacy assistant token (audience "mcp" only) still opens /mcp.
	legacy, err := auth.NewSigner([]byte("test-signing-key"), "bascula").IssueFor(auth.AudienceMCP,
		f.OwnerUserID, f.FarmID, "owner", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if rec := mcpRaw(h.server, hostB, legacy, initializeBody); rec.Code != http.StatusOK {
		t.Fatalf("a pre-binding assistant token stopped working: %d %s", rec.Code, rec.Body.String())
	}

	// A resource indicator for somewhere else is refused before sign-in ...
	redirect := "https://chatgpt.com/connector_platform_oauth_redirect"
	id := h.registerOAuthClient(t, "ChatGPT", redirect)
	sum := sha256.Sum256([]byte(pkceVerifier(t)))
	rec = oauthFrom(t, h.server, "10.44.0.3", http.MethodGet, "/oauth/authorize", url.Values{
		"client_id": {id}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"resource": {"https://otra-finca.bascula.engp.io/mcp"},
	})
	if loc := rec.Header().Get("Location"); rec.Code != http.StatusFound || !strings.Contains(loc, "error=invalid_target") {
		t.Fatalf("authorize accepted a foreign resource: %d %s", rec.Code, loc)
	}
	// ... and at the token endpoint.
	rec = formAt(h.server, hostA, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {next["refresh_token"].(string)},
		"client_id": {tok["client_id"].(string)}, "resource": {"https://evil.example/mcp"},
	})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_target") {
		t.Fatalf("token endpoint accepted a foreign resource: %d %s", rec.Code, rec.Body.String())
	}
}

// TestOAuthRevokeIsScopedToTheClient: /oauth/revoke used to close whatever
// session family the presented refresh token belonged to — a browser's or a
// phone's included — whoever asked.
func TestOAuthRevokeIsScopedToTheClient(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca revocar MCP", 250000)

	// A web session's refresh token presented at /oauth/revoke: left alone.
	login := h.loginOwner(t, f, "", nil)
	webRefresh := login.Body["refreshToken"].(string)
	rec := h.oauthPost(t, "/oauth/revoke", url.Values{"token": {webRefresh}})
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke: %d", rec.Code)
	}
	res := h.do(t, http.MethodPost, "/v1/auth/refresh", "", map[string]any{"refreshToken": webRefresh})
	if res.Status != http.StatusOK {
		t.Fatalf("/oauth/revoke closed a web session: %d %s", res.Status, res.Raw)
	}

	// Another client's refresh token: refused, and still alive.
	a := h.oauthGrant(t, f, "ChatGPT")
	b := h.oauthGrant(t, f, "Otro")
	rec = h.oauthPost(t, "/oauth/revoke", url.Values{
		"token": {a["refresh_token"].(string)}, "client_id": {b["client_id"].(string)},
	})
	if rec.Code == http.StatusOK {
		t.Fatalf("client B revoked client A's grant: %d", rec.Code)
	}
	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {a["refresh_token"].(string)},
		"client_id": {a["client_id"].(string)},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("A's grant died from B's revoke: %d %s", rec.Code, rec.Body.String())
	}
	var next map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &next)

	// Its own client: revoked.
	rec = h.oauthPost(t, "/oauth/revoke", url.Values{
		"token": {next["refresh_token"].(string)}, "client_id": {a["client_id"].(string)},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("own revoke: %d %s", rec.Code, rec.Body.String())
	}
	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {next["refresh_token"].(string)},
		"client_id": {a["client_id"].(string)},
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a revoked grant still refreshes: %d", rec.Code)
	}
	// B was never touched.
	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {b["refresh_token"].(string)},
		"client_id": {b["client_id"].(string)},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("B's grant died: %d %s", rec.Code, rec.Body.String())
	}
}

// TestRefreshTokensStayInTheirLane: the OAuth token endpoint only rotates the
// families it issued, and /v1/auth/refresh does not rotate an assistant's.
func TestRefreshTokensStayInTheirLane(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca carriles refresh", 250000)
	login := h.loginOwner(t, f, "", nil)
	webRefresh := login.Body["refreshToken"].(string)
	rec := h.oauthPost(t, "/oauth/token", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {webRefresh}})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_grant") {
		t.Fatalf("the OAuth endpoint rotated a web session: %d %s", rec.Code, rec.Body.String())
	}
	tok := h.oauthGrant(t, f, "ChatGPT")
	res := h.do(t, http.MethodPost, "/v1/auth/refresh", "", map[string]any{"refreshToken": tok["refresh_token"]})
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("/v1/auth/refresh rotated an assistant's token: %d %s", res.Status, res.Raw)
	}
	// And that attempt did not burn the grant.
	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)},
		"client_id": {tok["client_id"].(string)},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("grant broken: %d %s", rec.Code, rec.Body.String())
	}
}

// TestRefreshRaceYieldsOneSession: two refreshes of the same token at once
// used to both succeed, forking the family into two live branches (a stolen
// copy used in parallel with the real one went unnoticed).
func TestRefreshRaceYieldsOneSession(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca carrera refresh", 250000)
	tok := h.oauthGrant(t, f, "ChatGPT")
	const n = 10
	var wg sync.WaitGroup
	codes := make([]int, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			codes[i] = formAt(h.server, "", "/oauth/token", url.Values{
				"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)},
				"client_id": {tok["client_id"].(string)},
			}).Code
		}(i)
	}
	close(start)
	wg.Wait()
	ok := 0
	for _, c := range codes {
		if c == http.StatusOK {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("%d concurrent refreshes of one token succeeded (codes %v), want exactly 1", ok, codes)
	}
}

// TestOAuthCodesAreNotStoredUsable: the code table held the code itself and a
// signed session JWT beside it, so a read of oauth_codes was a session.
func TestOAuthCodesAreNotStoredUsable(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca códigos OAuth", 250000)
	redirect := "https://chatgpt.com/connector_platform_oauth_redirect"
	id := h.registerOAuthClient(t, "ChatGPT", redirect)
	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	rec := h.oauthPost(t, "/oauth/authorize", url.Values{
		"client_id": {id}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"email": {f.OwnerEmail}, "password": {"una-clave-larga-1"},
	})
	loc, _ := rec.Result().Location()
	code := loc.Query().Get("code")
	var stored, proof string
	if err := h.admin.QueryRow(context.Background(),
		`SELECT code, access_token FROM oauth_codes WHERE client_id = $1`, id).Scan(&stored, &proof); err != nil {
		t.Fatal(err)
	}
	if stored == code || strings.Contains(stored, code) {
		t.Fatal("the authorization code is stored in the clear")
	}
	if strings.HasPrefix(proof, "eyJ") {
		t.Fatal("a JWT is stored beside the code")
	}
	if res := h.do(t, http.MethodGet, "/v1/me", proof, nil); res.Status != http.StatusUnauthorized {
		t.Fatalf("the stored proof works as a bearer: %d", res.Status)
	}
	// And the code still works, once.
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {code},
		"redirect_uri": {redirect}, "client_id": {id}, "code_verifier": {verifier},
	}
	if rec := h.oauthPost(t, "/oauth/token", form); rec.Code != http.StatusOK {
		t.Fatalf("exchange: %d %s", rec.Code, rec.Body.String())
	}
	if rec := h.oauthPost(t, "/oauth/token", form); rec.Code != http.StatusBadRequest {
		t.Fatalf("a code was exchanged twice: %d", rec.Code)
	}
}

// TestMCPToolCallsDoNotStarveThePool: each tool call used to hold the /mcp
// request's transaction while its inner request asked for a second
// connection. A burst of concurrent calls took every connection and every
// farm on the stack stopped answering.
func TestMCPToolCallsDoNotStarveThePool(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca pool MCP", 250000)
	srv := h.serverWithSigner(t, func(cfg *httpapi.Config) { cfg.MCPCallsPerUserPerMinute = 0 })
	const n = 40
	// wg.Add and wg.Wait run in the same goroutine, Add before each spawn, so Wait counts every call.
	// nosemgrep: trailofbits.go.waitgroup-add-called-inside-goroutine.waitgroup-add-called-inside-goroutine
	var wg sync.WaitGroup
	errs := make(chan string, n)
	done := make(chan struct{})
	go func() {
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				rec := mcpRaw(srv, "", f.OwnerToken, toolCallBody("list_workers", nil))
				if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), `"isError":true`) {
					errs <- fmt.Sprintf("%d %s", rec.Code, rec.Body.String())
				}
			}()
		}
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("concurrent MCP tool calls deadlocked the pool")
	}
	close(errs)
	for e := range errs {
		t.Fatalf("a concurrent tool call failed: %s", e)
	}
}

// TestMCPRateLimitsPerUser: one account's assistant cannot hammer the
// database, and writes have a tighter budget than reads.
func TestMCPRateLimitsPerUser(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca límite MCP", 250000)
	srv := h.serverWithSigner(t, func(cfg *httpapi.Config) {
		cfg.MCPCallsPerUserPerMinute = 5
		cfg.MCPWritesPerUserPerMinute = 2
	})
	call := func(token, name string, args map[string]any) string {
		return mcpRaw(srv, "", token, toolCallBody(name, args)).Body.String()
	}
	for i := 0; i < 2; i++ {
		if out := call(f.OwnerToken, "create_worker", map[string]any{"name": fmt.Sprintf("W%d", i), "tag": fmt.Sprintf("W%d", i)}); strings.Contains(out, "RATE_LIMITED") {
			t.Fatalf("write %d limited too early: %s", i, out)
		}
	}
	if out := call(f.OwnerToken, "create_worker", map[string]any{"name": "W3", "tag": "W3"}); !strings.Contains(out, "RATE_LIMITED") {
		t.Fatalf("third write in a minute was not limited: %s", out)
	}
	for i := 0; i < 2; i++ {
		if out := call(f.OwnerToken, "me", nil); strings.Contains(out, "RATE_LIMITED") {
			t.Fatalf("read %d limited too early: %s", i, out)
		}
	}
	if out := call(f.OwnerToken, "me", nil); !strings.Contains(out, "RATE_LIMITED") {
		t.Fatalf("sixth call in a minute was not limited: %s", out)
	}
	// Another person has a budget of their own.
	if out := call(f.AdminToken, "me", nil); strings.Contains(out, "RATE_LIMITED") {
		t.Fatalf("the limit leaked across users: %s", out)
	}
}

// TestMCPRejectsBatchesAndHugeBodies: a JSON-RPC batch is N tool calls behind
// one request, and the body had no cap below the SDK's 4 MiB.
func TestMCPRejectsBatchesAndHugeBodies(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca lotes JSON-RPC", 250000)
	batch := "[" + toolCallBody("me", nil) + "," + toolCallBody("me", nil) + "]"
	if rec := mcpRaw(h.server, "", f.OwnerToken, batch); rec.Code != http.StatusBadRequest {
		t.Fatalf("a batch was accepted: %d %s", rec.Code, rec.Body.String())
	}
	huge := toolCallBody("list_workers", map[string]any{"q": strings.Repeat("a", 2<<20)})
	if rec := mcpRaw(h.server, "", f.OwnerToken, huge); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("a 2 MiB request was accepted: %d", rec.Code)
	}
}

// TestMCPToolsCannotReachAnotherFarm: every id a tool takes is looked up as
// the caller, inside the caller's farm. Another farm's ids are not found —
// for reads, for previews, and for writes.
func TestMCPToolsCannotReachAnotherFarm(t *testing.T) {
	h := requireDB(t)
	a := h.signupFarm(t, "Finca IDOR A", 250000)
	b := h.signupFarm(t, "Finca IDOR B", 250000)
	workerB := h.createWorker(t, b, "Ajena", "900111222")
	plotB := h.createPlot(t, b, "Lote ajeno")
	act := h.harvestActivityID(t, b)
	recB := h.createWorkRecord(t, b, b.OwnerToken, workerB, act, "2026-08-25", 10)
	settlementB := h.settleSomething(t, b, workerB, plotB)
	sess := h.mcpClient(t, a.OwnerToken)

	for _, c := range []struct {
		tool string
		args map[string]any
	}{
		{"get_worker", map[string]any{"id": workerB}},
		{"worker_balance", map[string]any{"id": workerB}},
		{"worker_ledger", map[string]any{"id": workerB}},
		{"worker_payables", map[string]any{"id": workerB}},
		{"worker_performance", map[string]any{"id": workerB}},
		{"get_settlement", map[string]any{"id": settlementB}},
		{"update_worker", map[string]any{"id": workerB, "name": "Robada"}},
		{"correct_weighing", map[string]any{"id": recB, "kg": 99}},
		{"void_weighing", map[string]any{"id": recB}},
		{"register_payment", map[string]any{"workerId": workerB, "amountCents": 100}},
		{"register_advance", map[string]any{"workerId": workerB, "amountCents": 100}},
		{"void_settlement", map[string]any{"id": settlementB}},
		{"create_settlement", map[string]any{"workerId": workerB, "from": "2026-08-24", "to": "2026-08-30"}},
		{"register_weighing", map[string]any{"workerId": workerB, "kg": 5, "date": "2026-08-26"}},
	} {
		res := callTool(t, sess, c.tool, c.args)
		if !res.IsError {
			t.Errorf("%s reached farm B's %v: %s", c.tool, c.args, toolText(res))
		}
		if strings.Contains(toolText(res), "Ajena") {
			t.Errorf("%s leaked farm B's data: %s", c.tool, toolText(res))
		}
	}
	// Nothing in farm B changed.
	w := h.mustDo(t, http.MethodGet, "/v1/workers/"+workerB, b.OwnerToken, nil, http.StatusOK)
	if w.Body["name"] != "Ajena" {
		t.Fatalf("farm B's worker was changed: %s", w.Raw)
	}
	if n := ledgerLen(t, h, b, workerB); n != 1 {
		t.Fatalf("farm B's ledger changed: %d entries", n)
	}
	// A confirmation token minted in farm A is no good to farm B's owner.
	workerA := h.createWorker(t, a, "Propia", "900111333")
	tok, _ := previewToken(t, sess, "register_advance", map[string]any{"workerId": workerA, "amountCents": 100})
	other := h.mcpClient(t, b.OwnerToken)
	res := callTool(t, other, "register_advance", withToken(map[string]any{"workerId": workerA, "amountCents": 100}, tok))
	if !res.IsError {
		t.Fatalf("farm A's confirmation executed for farm B: %s", toolText(res))
	}
}

// TestOAuthRegistrationHardening: a platform-wide cap every replica shares,
// names that cannot smuggle invisible characters onto the sign-in page, and
// redirect URIs without fragments or credentials.
func TestOAuthRegistrationHardening(t *testing.T) {
	h := requireDB(t)
	var existing int
	if err := h.admin.QueryRow(context.Background(),
		`SELECT count(*) FROM oauth_clients WHERE created_at > now() - interval '1 hour'`).Scan(&existing); err != nil {
		t.Fatal(err)
	}
	srv := h.serverWithSigner(t, func(cfg *httpapi.Config) {
		cfg.OAuthRegistrationsPerHour = existing + 2
		cfg.OAuthRegistrationsPerIPPerHour = 1000
	})
	reg := func(ip string, body map[string]any) (int, map[string]any) {
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = ip + ":1"
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	ok := map[string]any{"client_name": "Chat\u202eTPG\u200b\x07  bot", "redirect_uris": []string{"https://chatgpt.com/cb"}}
	code, out := reg("10.45.0.1", ok)
	if code != http.StatusCreated {
		t.Fatalf("register: %d %v", code, out)
	}
	if out["client_name"] != "ChatTPG bot" {
		t.Fatalf("client_name not sanitized: %q", out["client_name"])
	}
	for _, bad := range []string{"https://chatgpt.com/cb#frag", "https://chatgpt.com@evil.example/cb"} {
		if code, _ := reg("10.45.0.2", map[string]any{"redirect_uris": []string{bad}}); code != http.StatusBadRequest {
			t.Fatalf("redirect %q accepted: %d", bad, code)
		}
	}
	if code, _ := reg("10.45.0.3", ok); code != http.StatusCreated {
		t.Fatalf("second registration: %d", code)
	}
	if code, _ := reg("10.45.0.4", ok); code != http.StatusTooManyRequests {
		t.Fatalf("registration past the platform-wide cap: %d, want 429", code)
	}
}

// TestOAuthMetadataPointsAtTheDocs: service_documentation and
// resource_documentation name the reference page, not the endpoint.
func TestOAuthMetadataPointsAtTheDocs(t *testing.T) {
	h := requireDB(t)
	as := h.mustDo(t, http.MethodGet, "/.well-known/oauth-authorization-server", "", nil, http.StatusOK)
	pr := h.mustDo(t, http.MethodGet, "/.well-known/oauth-protected-resource", "", nil, http.StatusOK)
	if s, _ := as.Body["service_documentation"].(string); !strings.HasSuffix(s, "/mcp/docs") {
		t.Fatalf("service_documentation: %q", s)
	}
	if s, _ := pr.Body["resource_documentation"].(string); !strings.HasSuffix(s, "/mcp/docs") {
		t.Fatalf("resource_documentation: %q", s)
	}
}

// TestListLimitsAreCapped: ?limit= is bounded, so an assistant asking for ten
// million ledger rows gets a page.
func TestListLimitsAreCapped(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca límites de lista", 250000)
	w := h.createWorker(t, f, "Con Límite", "900222333")
	h.mustDo(t, http.MethodGet, "/v1/workers/"+w+"/ledger?limit=10000000", f.OwnerToken, nil, http.StatusOK)
}

// serverWithSigner is serverWithConfig with the suite's signing key, so the
// fixtures' tokens verify on it.
func (h *harness) serverWithSigner(t *testing.T, mutate func(cfg *httpapi.Config)) *httpapi.Server {
	t.Helper()
	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = t.TempDir()
	cfg.OAuthRegistrationsPerHour = 1 << 20
	cfg.OAuthRegistrationsPerIPPerHour = 1 << 20
	mutate(&cfg)
	return httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)
}
