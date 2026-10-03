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

// oauthPostOrigin is oauthPost as a browser posts the sign-in form: with the
// page's Origin, from a named address.
func (h *harness) oauthPostOrigin(t *testing.T, ip, origin, path string, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	req.RemoteAddr = ip + ":12345"
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	return rec
}

// TestOAuthSignInWithPasskey: the page ChatGPT or Claude opens to connect
// can be passed with a passkey instead of the password, checked exactly like
// the app's passkey sign-in.
func TestOAuthSignInWithPasskey(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca OAuth con Llave", 120000)
	key := newSoftPasskey(t)
	h.registerPasskey(t, f.OwnerToken, key)

	redirect := "https://chatgpt.com/connector_platform_oauth_redirect"
	reg := h.mustDo(t, http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name": "ChatGPT", "redirect_uris": []string{redirect},
	}, http.StatusCreated)
	clientID := reg.Body["client_id"].(string)
	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	base := url.Values{
		"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(sum[:])},
		"code_challenge_method": {"S256"}, "access": {"read"}, "state": {"s1"},
	}
	answer := func(ip string) url.Values { return h.passkeyAnswer(t, key, base, ip) }

	t.Run("the page offers the passkey under a nonce-only script policy", func(t *testing.T) {
		h.checkPasskeyPageNonce(t, base)
	})

	t.Run("a passkey answer from another site's page is refused", func(t *testing.T) {
		rec := h.oauthPostOrigin(t, "10.31.0.1", "https://evil.example", "/oauth/authorize", answer("10.31.0.1"))
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "No reconocimos esa llave de acceso") {
			t.Fatalf("foreign origin: %d %s", rec.Code, rec.Body.String())
		}
	})

	form := answer("10.31.0.2")
	t.Run("a passkey signs in and the code becomes a read-only connection", func(t *testing.T) {
		code := h.passkeyAuthorizeCode(t, "10.31.0.2", form)
		tok := h.oauthPost(t, "/oauth/token", url.Values{
			"grant_type": {"authorization_code"}, "code": {code},
			"redirect_uri": {redirect}, "client_id": {clientID}, "code_verifier": {verifier},
		})
		if tok.Code != http.StatusOK || !strings.Contains(tok.Body.String(), "mcp:read") {
			t.Fatalf("token: %d %s", tok.Code, tok.Body.String())
		}
	})

	t.Run("the same answer is not accepted twice", func(t *testing.T) {
		rec := h.oauthPostOrigin(t, "10.31.0.3", passkeyOrigin, "/oauth/authorize", form)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "No reconocimos esa llave de acceso") {
			t.Fatalf("replay: %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("refusals count against the address and then stop it", func(t *testing.T) {
		bad := answer("10.31.0.4")
		bad.Set("passkey_challenge", "forged")
		h.expectOAuthRateLimited(t, "10.31.0.4", bad)
	})
}

// passkeyAnswer is the sign-in form with a fresh passkey assertion for ip.
func (h *harness) passkeyAnswer(t *testing.T, key *softPasskey, base url.Values, ip string) url.Values {
	t.Helper()
	opts := h.passkeyOptions(t, ip)
	cred, err := json.Marshal(key.get(t, opts, passkeyOrigin))
	if err != nil {
		t.Fatal(err)
	}
	form := url.Values{}
	for k, v := range base {
		form[k] = v
	}
	form.Set("passkey_challenge", opts["challenge"].(string))
	form.Set("passkey_credential", string(cred))
	return form
}

// checkPasskeyPageNonce: the authorize page carries the passkey button inside
// the one script its nonce-only CSP allows.
func (h *harness) checkPasskeyPageNonce(t *testing.T, base url.Values) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/oauth/authorize?"+base.Encode(), nil)
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	csp := rec.Header().Get("Content-Security-Policy")
	body := rec.Body.String()
	if !strings.Contains(csp, "script-src 'nonce-") || !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("csp: %s", csp)
	}
	nonce := csp[strings.Index(csp, "'nonce-")+7:]
	nonce = nonce[:strings.Index(nonce, "'")]
	if !strings.Contains(body, `<script nonce="`+nonce+`">`) || !strings.Contains(body, "Entrar con llave de acceso") {
		t.Fatalf("page has no passkey button under the nonce")
	}
}

// passkeyAuthorizeCode posts the passkey form and returns the code from the
// redirect, checking that the state came back.
func (h *harness) passkeyAuthorizeCode(t *testing.T, ip string, form url.Values) string {
	t.Helper()
	rec := h.oauthPostOrigin(t, ip, passkeyOrigin, "/oauth/authorize", form)
	if rec.Code != http.StatusFound {
		t.Fatalf("authorize with passkey: %d %s", rec.Code, rec.Body.String())
	}
	loc, _ := rec.Result().Location()
	if loc.Query().Get("state") != "s1" || loc.Query().Get("code") == "" {
		t.Fatalf("redirect: %s", loc)
	}
	return loc.Query().Get("code")
}

// expectOAuthRateLimited repeats a refused sign-in from ip until the address
// is told to wait, and fails if that never happens.
func (h *harness) expectOAuthRateLimited(t *testing.T, ip string, form url.Values) {
	t.Helper()
	var last *httptest.ResponseRecorder
	for i := 0; i < 40; i++ {
		last = h.oauthPostOrigin(t, ip, passkeyOrigin, "/oauth/authorize", form)
		if strings.Contains(last.Body.String(), "Demasiados intentos") {
			return
		}
	}
	t.Fatalf("never limited: %s", last.Body.String())
}
