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
