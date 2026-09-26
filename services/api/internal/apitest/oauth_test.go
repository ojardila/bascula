package apitest

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestOAuthMetadataIsPublic(t *testing.T) {
	h := requireDB(t)
	res := h.mustDo(t, http.MethodGet, "/.well-known/oauth-authorization-server", "", nil, http.StatusOK)
	if res.Body["authorization_endpoint"] == nil || res.Body["token_endpoint"] == nil {
		t.Fatalf("metadata missing endpoints: %s", res.Raw)
	}
	if methods, _ := res.Body["token_endpoint_auth_methods_supported"].([]any); len(methods) == 0 || methods[0] != "none" {
		t.Fatalf("ChatGPT needs token_endpoint_auth_methods_supported=none, got %s", res.Raw)
	}
	pr := h.mustDo(t, http.MethodGet, "/.well-known/oauth-protected-resource", "", nil, http.StatusOK)
	if pr.Body["resource"] == nil {
		t.Fatalf("protected resource missing resource: %s", pr.Raw)
	}
}

func TestOAuthIssuesTheSameJWTLoginWould(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca OAuth MCP", 250000)

	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	redirect := "https://chatgpt.com/connector_platform_oauth_redirect"

	reg := h.mustDo(t, http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name":   "ChatGPT",
		"redirect_uris": []string{redirect},
	}, http.StatusCreated)
	clientID, _ := reg.Body["client_id"].(string)
	if clientID == "" {
		t.Fatalf("no client_id: %s", reg.Raw)
	}

	form := url.Values{
		"client_id":             {clientID},
		"redirect_uri":          {redirect},
		"response_type":         {"code"},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"state":                 {"st-1"},
		"email":                 {f.OwnerEmail},
		"password":              {"una-clave-larga-1"},
	}
	req := httptest.NewRequest(http.MethodPost, "/oauth/authorize", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = "10.0.0.1:12345"
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("authorize: got %d want 302: %s", rec.Code, rec.Body.String())
	}
	loc, err := rec.Result().Location()
	if err != nil {
		t.Fatalf("location: %v", err)
	}
	code := loc.Query().Get("code")
	if code == "" || loc.Query().Get("state") != "st-1" {
		t.Fatalf("redirect missing code/state: %s", loc)
	}

	tokForm := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirect},
		"client_id":     {clientID},
		"code_verifier": {verifier},
	}
	tokReq := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(tokForm.Encode()))
	tokReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokReq.RemoteAddr = "10.0.0.1:12345"
	tokRec := httptest.NewRecorder()
	h.server.ServeHTTP(tokRec, tokReq)
	if tokRec.Code != http.StatusOK {
		t.Fatalf("token: got %d: %s", tokRec.Code, tokRec.Body.String())
	}
	var tok map[string]any
	if err := json.Unmarshal(tokRec.Body.Bytes(), &tok); err != nil {
		t.Fatalf("token json: %v", err)
	}
	access, _ := tok["access_token"].(string)
	if access == "" {
		t.Fatalf("no access_token: %s", tokRec.Body.String())
	}

	me := h.mustDo(t, http.MethodGet, "/v1/me", access, nil, http.StatusOK)
	if mustString(t, me.Body, "id") == "" {
		t.Fatalf("token did not open a session: %s", me.Raw)
	}

	sess := h.mcpClient(t, access)
	res := callTool(t, sess, "me", nil)
	if res.IsError {
		t.Fatalf("mcp me with oauth token: %s", toolText(res))
	}
}

func TestMCPUnauthorizedAdvertisesOAuth(t *testing.T) {
	h := requireDB(t)
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "10.0.0.1:12345"
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401", rec.Code)
	}
	wa := rec.Header().Get("WWW-Authenticate")
	if !strings.Contains(wa, "oauth-protected-resource") {
		t.Fatalf("WWW-Authenticate missing resource_metadata: %q", wa)
	}
}

func pkceVerifier(t *testing.T) string {
	t.Helper()
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// oauthPost sends a form to the OAuth endpoints the way a connector does.
func (h *harness) oauthPost(t *testing.T, path string, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = "10.0.0.1:12345"
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	return rec
}

// TestOAuthRefreshKeepsTheConnectorAlive: the access token lives fifteen
// minutes, so a connector without a refresh token stopped working a quarter of
// an hour after it was made. The token endpoint now issues one, rotates it on
// the refresh_token grant, and refuses it the second time.
func TestOAuthRefreshKeepsTheConnectorAlive(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca OAuth refresh", 250000)
	redirect := "https://claude.ai/api/mcp/auth_callback"
	reg := h.mustDo(t, http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name": "Claude", "redirect_uris": []string{redirect},
	}, http.StatusCreated)
	clientID := reg.Body["client_id"].(string)
	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))

	rec := h.oauthPost(t, "/oauth/authorize", url.Values{
		"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"email": {f.OwnerEmail}, "password": {"una-clave-larga-1"},
	})
	if rec.Code != http.StatusFound {
		t.Fatalf("authorize: %d %s", rec.Code, rec.Body.String())
	}
	loc, _ := rec.Result().Location()
	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"authorization_code"}, "code": {loc.Query().Get("code")},
		"redirect_uri": {redirect}, "client_id": {clientID}, "code_verifier": {verifier},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("token: %d %s", rec.Code, rec.Body.String())
	}
	var tok map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &tok)
	refresh, _ := tok["refresh_token"].(string)
	if refresh == "" || tok["access_token"] == nil {
		t.Fatalf("the token endpoint issued no refresh token: %s", rec.Body.String())
	}

	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {clientID},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh grant: %d %s", rec.Code, rec.Body.String())
	}
	var next map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &next)
	access, _ := next["access_token"].(string)
	if access == "" || next["refresh_token"] == refresh {
		t.Fatalf("refresh did not rotate: %s", rec.Body.String())
	}
	sess := h.mcpClient(t, access)
	if res := callTool(t, sess, "me", nil); res.IsError {
		t.Fatalf("the refreshed token does not open the tunnel: %s", toolText(res))
	}

	// Spent: the same refresh token again is refused.
	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {clientID},
	})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_grant") {
		t.Fatalf("a spent refresh token was accepted: %d %s", rec.Code, rec.Body.String())
	}
}

// TestMCPExpiredTokenAdvertisesOAuth: a token that no longer verifies gets the
// challenge too, so the client knows to refresh or sign in again instead of
// showing the connector as broken.
func TestMCPExpiredTokenAdvertisesOAuth(t *testing.T) {
	h := requireDB(t)
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.e30.not-valid")
	req.RemoteAddr = "10.0.0.1:12345"
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401", rec.Code)
	}
	wa := rec.Header().Get("WWW-Authenticate")
	if !strings.Contains(wa, "resource_metadata") || !strings.Contains(wa, "invalid_token") {
		t.Fatalf("WWW-Authenticate on a bad token: %q", wa)
	}
}
