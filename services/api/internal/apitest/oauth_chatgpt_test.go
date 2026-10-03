package apitest

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// TestOAuthDiscoveryAnswersEveryWellKnownPath: ChatGPT fetched
// /.well-known/openid-configuration after the RFC 8414 document and got a
// 404. Every discovery path an MCP client tries now answers the same
// metadata, with the fields ChatGPT's auth guide asks for.
func TestOAuthDiscoveryAnswersEveryWellKnownPath(t *testing.T) {
	h := requireDB(t)
	for _, p := range []string{
		"/.well-known/oauth-authorization-server",
		"/.well-known/oauth-authorization-server/mcp",
		"/.well-known/openid-configuration",
		"/.well-known/openid-configuration/mcp",
	} {
		res := h.mustDo(t, http.MethodGet, p, "", nil, http.StatusOK)
		a3CheckDiscoveryDoc(t, p, res)
	}
	h.mustDo(t, http.MethodGet, "/.well-known/jwks.json", "", nil, http.StatusOK)
}

// a3CheckDiscoveryDoc asserts one discovery path answers the full metadata.
func a3CheckDiscoveryDoc(t *testing.T, p string, res response) {
	t.Helper()
	for _, k := range []string{"issuer", "authorization_endpoint", "token_endpoint",
		"registration_endpoint", "revocation_endpoint", "service_documentation", "jwks_uri"} {
		if s, _ := res.Body[k].(string); s == "" {
			t.Errorf("%s: %s missing: %s", p, k, res.Raw)
		}
	}
	if res.Body["authorization_response_iss_parameter_supported"] != true {
		t.Errorf("%s: iss parameter not advertised: %s", p, res.Raw)
	}
	for k, want := range map[string][]string{
		"scopes_supported":                      {"mcp", "offline_access"},
		"token_endpoint_auth_methods_supported": {"none", "client_secret_post", "client_secret_basic"},
		"code_challenge_methods_supported":      {"S256"},
	} {
		got, _ := res.Body[k].([]any)
		for _, w := range want {
			if !a3HasValue(got, w) {
				t.Errorf("%s: %s lacks %s: %s", p, k, w, res.Raw)
			}
		}
	}
}

func a3HasValue(got []any, w string) bool {
	found := false
	for _, g := range got {
		found = found || g == w
	}
	return found
}

// TestOAuthRegisterIsRFC7591Complete: the registration response carries
// client_id_issued_at, the scope and every registered field; a client that
// asks to be confidential gets a secret that never expires and must use it.
func TestOAuthRegisterIsRFC7591Complete(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca OAuth confidencial", 250000)
	redirect := "https://chatgpt.com/connector_platform_oauth_redirect"

	pub := h.mustDo(t, http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name": "ChatGPT", "redirect_uris": []string{redirect},
		"grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"},
		"token_endpoint_auth_method": "none", "scope": "mcp offline_access",
		"logo_uri": "https://chatgpt.com/favicon.ico",
	}, http.StatusCreated)
	if pub.Body["client_id_issued_at"] == nil || pub.Body["scope"] != "mcp offline_access" ||
		pub.Body["token_endpoint_auth_method"] != "none" || pub.Body["logo_uri"] == nil {
		t.Fatalf("public registration incomplete: %s", pub.Raw)
	}
	if _, has := pub.Body["client_secret"]; has {
		t.Fatalf("a public client got a secret: %s", pub.Raw)
	}

	for _, method := range []string{"client_secret_basic", "client_secret_post"} {
		a3ConfidentialClientFlow(t, h, f, redirect, method)
	}
}

// a3ConfidentialClientFlow registers a confidential client with the given
// auth method and walks it through authorize, token and revocation.
func a3ConfidentialClientFlow(t *testing.T, h *harness, f *farmFixture, redirect, method string) {
	t.Helper()
	reg := h.mustDo(t, http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name": "ChatGPT", "redirect_uris": []string{redirect},
		"token_endpoint_auth_method": method,
	}, http.StatusCreated)
	clientID, _ := reg.Body["client_id"].(string)
	secret, _ := reg.Body["client_secret"].(string)
	if secret == "" || reg.Body["client_secret_expires_at"] != float64(0) ||
		reg.Body["token_endpoint_auth_method"] != method || reg.Body["scope"] == nil {
		t.Fatalf("%s registration incomplete: %s", method, reg.Raw)
	}

	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	rec := h.oauthPost(t, "/oauth/authorize", url.Values{
		"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"scope": {"mcp offline_access"}, "state": {"s1"},
		"email": {f.OwnerEmail}, "password": {"una-clave-larga-1"},
	})
	if rec.Code != http.StatusFound {
		t.Fatalf("authorize: %d %s", rec.Code, rec.Body.String())
	}
	loc, _ := rec.Result().Location()
	if loc.Query().Get("iss") == "" {
		t.Fatalf("authorization response lacks iss: %s", loc)
	}
	code := loc.Query().Get("code")

	tokenReq := func(withSecret bool) *httptest.ResponseRecorder {
		return a3TokenRequest(h, method, clientID, secret, code, redirect, verifier, withSecret)
	}
	if rr := tokenReq(false); rr.Code != http.StatusUnauthorized || !strings.Contains(rr.Body.String(), "invalid_client") {
		t.Fatalf("%s without the secret: %d %s", method, rr.Code, rr.Body.String())
	}
	rr := tokenReq(true)
	if rr.Code != http.StatusOK {
		t.Fatalf("%s token: %d %s", method, rr.Code, rr.Body.String())
	}
	var tok map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &tok)
	if tok["access_token"] == nil || tok["scope"] != "mcp offline_access" {
		t.Fatalf("%s token response: %s", method, rr.Body.String())
	}

	// Revocation closes the refresh token.
	refresh, _ := tok["refresh_token"].(string)
	rv := h.oauthPost(t, "/oauth/revoke", url.Values{"token": {refresh},
		"client_id": {clientID}, "client_secret": {secret}})
	if rv.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", rv.Code, rv.Body.String())
	}
	again := h.oauthPost(t, "/oauth/token", url.Values{"grant_type": {"refresh_token"},
		"refresh_token": {refresh}, "client_id": {clientID}, "client_secret": {secret}})
	if again.Code == http.StatusOK {
		t.Fatalf("a revoked refresh token still works: %s", again.Body.String())
	}
}

// a3TokenRequest exchanges code at /oauth/token, authenticating the client
// the way method says, with or without the real secret.
func a3TokenRequest(h *harness, method, clientID, secret, code, redirect, verifier string, withSecret bool) *httptest.ResponseRecorder {
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code},
		"redirect_uri": {redirect}, "code_verifier": {verifier}}
	if method == "client_secret_post" {
		form.Set("client_id", clientID)
		if withSecret {
			form.Set("client_secret", secret)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if method == "client_secret_basic" {
		pw := "wrong"
		if withSecret {
			pw = secret
		}
		req.SetBasicAuth(url.QueryEscape(clientID), url.QueryEscape(pw))
	}
	req.RemoteAddr = "10.0.0.1:12345"
	rr := httptest.NewRecorder()
	h.server.ServeHTTP(rr, req)
	return rr
}
