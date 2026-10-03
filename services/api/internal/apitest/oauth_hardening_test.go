package apitest

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// oauthFrom sends a form from a client address of its own, so a test about a
// per-IP limit keeps its own bucket.
func oauthFrom(t *testing.T, srv http.Handler, ip, method, path string, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if method == http.MethodGet {
		req = httptest.NewRequest(method, path+"?"+form.Encode(), nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	req.RemoteAddr = ip + ":12345"
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec
}

func (h *harness) registerOAuthClient(t *testing.T, name, redirect string) string {
	t.Helper()
	reg := h.mustDo(t, http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name": name, "redirect_uris": []string{redirect},
	}, http.StatusCreated)
	id, _ := reg.Body["client_id"].(string)
	if id == "" {
		t.Fatalf("no client_id: %s", reg.Raw)
	}
	return id
}

// TestOAuthAuthorizeIsNotAnOpenRedirect: the PKCE check used to run before the
// client was looked up, and its error was sent to whatever redirect_uri the
// query named. A link on the farm's own domain bounced anyone to any site.
func TestOAuthAuthorizeIsNotAnOpenRedirect(t *testing.T) {
	h := requireDB(t)
	for _, q := range []url.Values{
		{"client_id": {"nobody"}, "redirect_uri": {"https://evil.example/"}},
		{"client_id": {h.registerOAuthClient(t, "Claude", "https://claude.ai/api/mcp/auth_callback")},
			"redirect_uri": {"https://evil.example/"}},
	} {
		rec := oauthFrom(t, h.server, "10.9.0.1", http.MethodGet, "/oauth/authorize", q)
		if rec.Code == http.StatusFound || strings.Contains(rec.Header().Get("Location"), "evil.example") {
			t.Fatalf("redirected to an unregistered redirect_uri: %d %s", rec.Code, rec.Header().Get("Location"))
		}
	}

	// A registered client and redirect without PKCE still gets its error at
	// the redirect, which is where the client expects it.
	redirect := "https://claude.ai/api/mcp/auth_callback"
	id := h.registerOAuthClient(t, "Claude", redirect)
	rec := oauthFrom(t, h.server, "10.9.0.1", http.MethodGet, "/oauth/authorize",
		url.Values{"client_id": {id}, "redirect_uri": {redirect}})
	if rec.Code != http.StatusFound || !strings.HasPrefix(rec.Header().Get("Location"), redirect) {
		t.Fatalf("PKCE error should go to the registered redirect: %d %s", rec.Code, rec.Header().Get("Location"))
	}
}

// TestOAuthSignInPageNamesTheClientAndCannotBeFramed: registration is open, so
// a stranger can register a client of their own and send its link to an
// owner. The page has to say who is asking and where the code goes, and it
// must not be framed.
func TestOAuthSignInPageNamesTheClientAndCannotBeFramed(t *testing.T) {
	h := requireDB(t)
	redirect := "https://attacker.example/cb"
	id := h.registerOAuthClient(t, "Totally <b>ChatGPT</b>", redirect)
	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	rec := oauthFrom(t, h.server, "10.9.0.2", http.MethodGet, "/oauth/authorize", url.Values{
		"client_id": {id}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("sign-in page: %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "attacker.example") || !strings.Contains(body, "Totally &lt;b&gt;ChatGPT&lt;/b&gt;") {
		t.Fatalf("the page does not name the client and the destination (escaped): %s", body)
	}
	if rec.Header().Get("X-Frame-Options") != "DENY" ||
		!strings.Contains(rec.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatalf("the password form can be framed: %v", rec.Header())
	}
}

// TestOAuthSignInIsRateLimited: the sign-in page checks the same password as
// /v1/auth/login, and it used to do so without the login limiter.
func TestOAuthSignInIsRateLimited(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca OAuth limite", 250000)
	redirect := "https://claude.ai/api/mcp/auth_callback"
	id := h.registerOAuthClient(t, "Claude", redirect)
	sum := sha256.Sum256([]byte(pkceVerifier(t)))
	form := func(password string) url.Values {
		return url.Values{
			"client_id": {id}, "redirect_uri": {redirect}, "response_type": {"code"},
			"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
			"email": {f.OwnerEmail}, "password": {password},
		}
	}
	const ip = "10.9.0.3"
	// Wrong passwords until the door shuts; it must shut well before an
	// attacker gets anywhere.
	limited := false
	for i := 0; i < 20 && !limited; i++ {
		rec := oauthFrom(t, h.server, ip, http.MethodPost, "/oauth/authorize", form(fmt.Sprintf("wrong-%d", i)))
		body := rec.Body.String()
		switch {
		case strings.Contains(body, "Demasiados intentos"):
			limited = true
		case rec.Code != http.StatusOK || !strings.Contains(body, "incorrectos"):
			t.Fatalf("attempt %d: %d %s", i, rec.Code, body)
		}
	}
	if !limited {
		t.Fatal("twenty wrong passwords and the sign-in page never refused")
	}
	// The right password, from the same place, is now refused too: the limit
	// is a property of the door, as on /v1/auth/login.
	rec := oauthFrom(t, h.server, ip, http.MethodPost, "/oauth/authorize", form("una-clave-larga-1"))
	if rec.Code == http.StatusFound || !strings.Contains(rec.Body.String(), "Demasiados intentos") {
		t.Fatalf("the sign-in page is not rate limited: %d %s", rec.Code, rec.Body.String())
	}
	// The owner at their own office is not locked out by it.
	rec = oauthFrom(t, h.server, "10.9.0.4", http.MethodPost, "/oauth/authorize", form("una-clave-larga-1"))
	if rec.Code != http.StatusFound {
		t.Fatalf("another address was locked out: %d %s", rec.Code, rec.Body.String())
	}
}

// TestOAuthRegisterIsBounded: registration is anonymous, and every one is a
// row nothing prunes.
func TestOAuthRegisterIsBounded(t *testing.T) {
	h := requireDB(t)
	many := make([]string, 11)
	for i := range many {
		many[i] = fmt.Sprintf("https://claude.ai/cb/%d", i)
	}
	res := h.doFrom(t, "10.9.0.5", http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name": "x", "redirect_uris": many,
	})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("eleven redirect_uris accepted: %d %s", res.Status, res.Raw)
	}
	res = h.doFrom(t, "10.9.0.5", http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name": "x", "redirect_uris": []string{"https://claude.ai/" + strings.Repeat("a", 3000)},
	})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("a 3 KB redirect_uri accepted: %d", res.Status)
	}
	res = h.doFrom(t, "10.9.0.5", http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name": "x", "redirect_uris": []string{"https://claude.ai/cb"},
		"padding": strings.Repeat("a", 100<<10),
	})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("a 100 KB registration accepted: %d", res.Status)
	}

	srv := h.serverWithConfig(t, func(cfg *httpapi.Config) { cfg.OAuthRegistrationsPerIPPerHour = 2 })
	reg := func(ip string) int {
		raw, _ := json.Marshal(map[string]any{"client_name": "x", "redirect_uris": []string{"https://claude.ai/cb"}})
		req := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = ip + ":1"
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		return rec.Code
	}
	// Two calls on purpose: each one is a registration.
	first, second := reg("10.9.0.6"), reg("10.9.0.6")
	if first != http.StatusCreated || second != http.StatusCreated {
		t.Fatal("the first two registrations must pass")
	}
	if got := reg("10.9.0.6"); got != http.StatusTooManyRequests {
		t.Fatalf("third registration from one address: %d, want 429", got)
	}
	if reg("10.9.0.7") != http.StatusCreated {
		t.Fatal("another address has its own count")
	}
}

// TestOAuthRefreshTokenIsBoundToItsClient: RFC 6749 §6. Another client's
// refresh token is refused.
func TestOAuthRefreshTokenIsBoundToItsClient(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca OAuth binding", 250000)
	redirect := "https://claude.ai/api/mcp/auth_callback"
	id := h.registerOAuthClient(t, "Claude", redirect)
	other := h.registerOAuthClient(t, "Otro", redirect)
	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	rec := h.oauthPost(t, "/oauth/authorize", url.Values{
		"client_id": {id}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"email": {f.OwnerEmail}, "password": {"una-clave-larga-1"},
	})
	if rec.Code != http.StatusFound {
		t.Fatalf("authorize: %d %s", rec.Code, rec.Body.String())
	}
	loc, _ := rec.Result().Location()
	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"authorization_code"}, "code": {loc.Query().Get("code")},
		"redirect_uri": {redirect}, "client_id": {id}, "code_verifier": {verifier},
	})
	var tok map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &tok)
	refresh, _ := tok["refresh_token"].(string)
	if refresh == "" {
		t.Fatalf("no refresh token: %s", rec.Body.String())
	}
	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {other},
	})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_grant") {
		t.Fatalf("another client refreshed the token: %d %s", rec.Code, rec.Body.String())
	}
	// The owner's own client still can: the refusal spent nothing.
	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {id},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("the right client could not refresh: %d %s", rec.Code, rec.Body.String())
	}
}
