// SPDX-License-Identifier: MIT

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

// oauthCode runs the sign-in step of the connector flow and returns the code.
func (h *harness) oauthCode(t *testing.T, f *farmFixture, clientID, redirect, challenge string) string {
	t.Helper()
	rec := oauthFrom(t, h.server, "10.31.0.1", http.MethodPost, "/oauth/authorize", url.Values{
		"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"},
		"email": {f.OwnerEmail}, "password": {"una-clave-larga-1"},
	})
	if rec.Code != http.StatusFound {
		t.Fatalf("authorize: got %d: %s", rec.Code, rec.Body.String())
	}
	loc, err := rec.Result().Location()
	if err != nil || loc.Query().Get("code") == "" {
		t.Fatalf("authorize redirect without a code: %v %v", loc, err)
	}
	return loc.Query().Get("code")
}

func oauthErrorOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	e, _ := body["error"].(string)
	return e
}

// TestOAuthRegistrationEdges covers the metadata a registration may carry.
func TestOAuthRegistrationEdges(t *testing.T) {
	h := requireDB(t)
	reg := func(body map[string]any) response {
		return h.do(t, http.MethodPost, "/oauth/register", "", body)
	}
	for name, body := range map[string]map[string]any{
		"implicit flow": {"redirect_uris": []string{"https://a.example/cb"}, "response_types": []string{"token"}},
		"plain http":    {"redirect_uris": []string{"http://a.example/cb"}},
		"not a uri":     {"redirect_uris": []string{"cb"}},
		"odd scheme":    {"redirect_uris": []string{"ftp://a.example/cb"}},
	} {
		if res := reg(body); res.Status != http.StatusBadRequest {
			t.Errorf("%s: got %d %s, want 400", name, res.Status, res.Raw)
		}
	}

	// No name, a loopback redirect named as a single string, an unsupported
	// auth method and a large echo field: all registered, kept small.
	res := reg(map[string]any{
		"redirect_uris":              "http://127.0.0.1:8765/callback",
		"token_endpoint_auth_method": "private_key_jwt",
		"logo_uri":                   "https://a.example/" + strings.Repeat("x", 9000),
		"client_secret":              "ignored",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("loopback registration: got %d %s", res.Status, res.Raw)
	}
	if res.Body["client_name"] != "mcp-client" || res.Body["token_endpoint_auth_method"] != "none" {
		t.Errorf("defaults: %s", res.Raw)
	}
	if _, echoed := res.Body["client_secret"]; echoed {
		t.Errorf("a client_secret was echoed back: %s", res.Raw)
	}

	long := reg(map[string]any{"client_name": strings.Repeat("Asistente ", 20), "redirect_uris": []string{"https://a.example/cb"}})
	if n := len([]rune(long.Body["client_name"].(string))); long.Status != http.StatusCreated || n > 80 {
		t.Errorf("a long client name: got %d, %d runes", long.Status, n)
	}
}

// TestOAuthTokenAndAuthorizeEdges covers the token endpoint's refusals and
// the sign-in page variants.
func TestOAuthTokenAndAuthorizeEdges(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca OAuth bordes", 250000)
	redirect := "https://claude.ai/api/mcp/auth_callback"
	clientID := h.registerOAuthClient(t, "Claude", redirect)
	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	token := func(form url.Values) *httptest.ResponseRecorder {
		return oauthFrom(t, h.server, "10.31.0.2", http.MethodPost, "/oauth/token", form)
	}
	if rec := token(url.Values{"grant_type": {"authorization_code"}}); oauthErrorOf(t, rec) != "invalid_request" {
		t.Errorf("a code grant without its fields: %d %s", rec.Code, rec.Body.String())
	}
	if rec := token(url.Values{"grant_type": {"refresh_token"}}); oauthErrorOf(t, rec) != "invalid_request" {
		t.Errorf("a refresh grant without a token: %d %s", rec.Code, rec.Body.String())
	}

	other := h.registerOAuthClient(t, "Otro", redirect)
	code := h.oauthCode(t, f, clientID, redirect, challenge)
	if rec := token(url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect},
		"client_id": {other}, "code_verifier": {verifier}}); oauthErrorOf(t, rec) != "invalid_grant" {
		t.Errorf("a code for another client: %d %s", rec.Code, rec.Body.String())
	}
	code = h.oauthCode(t, f, clientID, redirect, challenge)
	if rec := token(url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect},
		"client_id": {clientID}, "code_verifier": {pkceVerifier(t)}}); oauthErrorOf(t, rec) != "invalid_grant" {
		t.Errorf("the wrong PKCE verifier: %d %s", rec.Code, rec.Body.String())
	}

	// The sign-in page: read-only access preselected, a farm's own host
	// names the farm, and a submit without credentials is answered on the
	// page.
	q := url.Values{"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}, "scope": {"mcp:read"}}
	slug := h.farmSlug(t, f.FarmID)
	req := httptest.NewRequest(http.MethodGet, "/oauth/authorize?"+q.Encode(), nil)
	req.Host = slug + ".bascula.engp.io"
	req.Header.Set("X-Forwarded-Proto", "https")
	req.RemoteAddr = "10.31.0.3:12345"
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Finca OAuth bordes") {
		t.Errorf("sign-in page on the farm host: %d %s", rec.Code, rec.Body.String())
	}

	q.Set("email", f.OwnerEmail)
	rec = oauthFrom(t, h.server, "10.31.0.4", http.MethodPost, "/oauth/authorize", q)
	if rec.Code == http.StatusFound || !strings.Contains(rec.Body.String(), "obligatorios") {
		t.Errorf("a sign-in without a password: %d %s", rec.Code, rec.Body.String())
	}
}
