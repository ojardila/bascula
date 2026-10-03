// SPDX-License-Identifier: MIT

package apitest

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

const coaRedirect = "https://chatgpt.com/connector_platform_oauth_redirect"

// coaAuthorize is a connector sign-in form for a fresh public client.
type coaAuthorize struct {
	h        *harness
	clientID string
	verifier string
	base     url.Values
}

func (h *harness) coaNewAuthorize(t *testing.T) *coaAuthorize {
	t.Helper()
	id := h.registerOAuthClient(t, "ChatGPT", coaRedirect)
	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	return &coaAuthorize{h: h, clientID: id, verifier: verifier, base: url.Values{
		"client_id": {id}, "redirect_uri": {coaRedirect}, "response_type": {"code"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"state": {"s1"}, "scope": {"mcp offline_access"},
	}}
}

func (a *coaAuthorize) form(kv ...string) url.Values {
	form := url.Values{}
	for k, vs := range a.base {
		form[k] = vs
	}
	for i := 0; i+1 < len(kv); i += 2 {
		form.Set(kv[i], kv[i+1])
	}
	return form
}

// coaRequest is the sign-in POST as a browser sends it.
func coaRequest(ip, host, origin string, form url.Values) (*http.Request, string) {
	raw := form.Encode()
	req := httptest.NewRequest(http.MethodPost, "/oauth/authorize", strings.NewReader(raw))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = ip + ":12345"
	if host != "" {
		req.Host = host
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	return req, raw
}

// coaReplayThenSend runs the request once per database call with that call
// failing (the fault replay, which skips /oauth on its own), then sends it for
// real. Every failed run must answer without a code: an error, or the page.
func (h *harness) coaReplayThenSend(t *testing.T, ip, host, origin string, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req, raw := coaRequest(ip, host, origin, form)
	for n := 1; n <= 60; n++ {
		plan := &faultPlan{failAt: n}
		twin := req.Clone(context.WithValue(req.Context(), faultKey{}, plan))
		twin.Body = httpBody(raw)
		twin.RemoteAddr = "10.250.0.1:12345"
		rec := httptest.NewRecorder()
		h.server.ServeHTTP(rec, twin)
		if !plan.hit {
			break
		}
		if loc := rec.Header().Get("Location"); strings.Contains(loc, "code=") {
			t.Fatalf("fault at call %d still issued a code: %s", n, loc)
		}
	}
	req, _ = coaRequest(ip, host, origin, form)
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	return rec
}

// coaCodeFrom checks a sign-in redirect went to the registered URI with a
// code, the state and the issuer, and returns the code.
func coaCodeFrom(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	if rec.Code != http.StatusFound {
		t.Fatalf("want a redirect with a code, got %d %s", rec.Code, rec.Body.String())
	}
	loc, err := rec.Result().Location()
	if err != nil || !strings.HasPrefix(loc.String(), coaRedirect+"?") {
		t.Fatalf("redirect to an unregistered place: %v %v", loc, err)
	}
	if loc.Query().Get("code") == "" || loc.Query().Get("state") != "s1" || loc.Query().Get("iss") == "" {
		t.Fatalf("redirect without code, state or iss: %s", loc)
	}
	return loc.Query().Get("code")
}

func coaPage(t *testing.T, what string, rec *httptest.ResponseRecorder, want string) {
	t.Helper()
	if rec.Code != http.StatusOK || rec.Header().Get("Location") != "" || !strings.Contains(rec.Body.String(), want) {
		t.Fatalf("%s: want the page saying %q, got %d %s", what, want, rec.Code, rec.Body.String())
	}
}

// TestCoaOAuthSignInSurvivesDatabaseFaults walks the database errors of the
// password sign-in: recording a failed attempt, the unverified-address check
// and the farm-host lookup. None of them hands out a code, and the request
// that follows sees an untouched database.
func TestCoaOAuthSignInSurvivesDatabaseFaults(t *testing.T) {
	h := requireDB(t)
	ctx := context.Background()
	a := h.coaNewAuthorize(t)

	t.Run("a wrong password is counted, and its fault is a 5xx", func(t *testing.T) {
		f := h.signupFarm(t, "Finca coa clave mala", 250000)
		rec := h.coaReplayThenSend(t, "10.77.0.1", "", "", a.form("email", f.OwnerEmail, "password", "no-es-la-clave"))
		coaPage(t, "wrong password", rec, "Correo o contraseña incorrectos")
		var n int
		if err := h.admin.QueryRow(ctx, `SELECT count(*) FROM login_failures WHERE ip = '10.77.0.1'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("failed sign-ins recorded: %d, want exactly the real one", n)
		}
	})

	t.Run("an unknown address costs a wrong password", func(t *testing.T) {
		rec := h.coaReplayThenSend(t, "10.77.0.2", "", "",
			a.form("email", "coa-nadie-"+uuid.NewString()[:8]+"@example.com", "password", "una-clave-larga-1"))
		coaPage(t, "unknown address", rec, "Correo o contraseña incorrectos")
	})

	t.Run("an unverified address", func(t *testing.T) {
		f := h.signupFarm(t, "Finca coa sin verificar", 250000)
		if _, err := h.admin.Exec(ctx, `UPDATE users SET email_verified_at = NULL WHERE id = $1`, f.OwnerUserID); err != nil {
			t.Fatal(err)
		}
		rec := h.coaReplayThenSend(t, "10.77.0.3", "", "", a.form("email", f.OwnerEmail, "password", f.loginSecret()))
		coaPage(t, "unverified", rec, "Verifique el correo")
	})

	t.Run("a farm host that is none of the account's farms", func(t *testing.T) {
		f := h.signupFarm(t, "Finca coa anfitriona", 250000)
		stranger := h.signupFarm(t, "Finca coa extraña", 250000)
		host := h.farmSlug(t, stranger.FarmID) + ".bascula.engp.io"
		rec := h.coaReplayThenSend(t, "10.77.0.4", host, "", a.form("email", f.OwnerEmail, "password", f.loginSecret()))
		code := coaCodeFrom(t, rec)
		// The code opens the account's own farm, never the host's.
		tok := h.oauthPost(t, "/oauth/token", url.Values{
			"grant_type": {"authorization_code"}, "code": {code},
			"redirect_uri": {coaRedirect}, "client_id": {a.clientID}, "code_verifier": {a.verifier},
		})
		if tok.Code != http.StatusOK {
			t.Fatalf("token: %d %s", tok.Code, tok.Body.String())
		}
	})
}

// TestCoaOAuthPasskeySignInSurvivesDatabaseFaults: the connect page's passkey
// door, with each of its database calls failing in turn (the challenge spend,
// the passkey touch, the farm-password lookup), and then for real.
func TestCoaOAuthPasskeySignInSurvivesDatabaseFaults(t *testing.T) {
	h := requireDB(t)
	ctx := context.Background()
	f := h.signupFarm(t, "Finca coa llave", 120000)
	key := newSoftPasskey(t)
	h.registerPasskey(t, f.OwnerToken, key)
	a := h.coaNewAuthorize(t)

	form := h.passkeyAnswer(t, key, a.base, "10.77.1.1")
	rec := h.coaReplayThenSend(t, "10.77.1.1", "", passkeyOrigin, form)
	coaCodeFrom(t, rec)

	// The farm the passkey would open is now guarded by its own password:
	// the passkey opens nothing, and the page says so instead of a code.
	if _, err := h.admin.Exec(ctx, `
		INSERT INTO farm_owner_credentials (farm_id, user_id, name, phone, password_hash)
		VALUES ($1, $2, 'Owner', '', 'x')`, f.FarmID, f.OwnerUserID); err != nil {
		t.Fatal(err)
	}
	rec = h.oauthPostOrigin(t, "10.77.1.2", passkeyOrigin, "/oauth/authorize", h.passkeyAnswer(t, key, a.base, "10.77.1.2"))
	coaPage(t, "passkey with no farm", rec, "no abre ninguna finca")
}

// TestCoaOAuthRevokeEdges: RFC 7009 answers 200 for a token it never issued
// unless the asking client fails to authenticate, and a public client's
// refresh token can be revoked by the token alone, after which it is dead.
func TestCoaOAuthRevokeEdges(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca coa revocar", 250000)
	a := h.coaNewAuthorize(t)

	unknown := "coa-" + uuid.NewString()
	if rec := h.oauthPost(t, "/oauth/revoke", url.Values{"token": {unknown}}); rec.Code != http.StatusOK {
		t.Fatalf("unknown token, no client: %d %s", rec.Code, rec.Body.String())
	}
	rec := h.oauthPost(t, "/oauth/revoke", url.Values{"token": {unknown}, "client_id": {"coa-no-such-client"}})
	if rec.Code != http.StatusUnauthorized || oauthErrorOf(t, rec) != "invalid_client" {
		t.Fatalf("unknown token, unknown client: %d %s", rec.Code, rec.Body.String())
	}
	if rec := h.oauthPost(t, "/oauth/revoke", url.Values{"token": {unknown}, "client_id": {a.clientID}}); rec.Code != http.StatusOK {
		t.Fatalf("unknown token, known public client: %d %s", rec.Code, rec.Body.String())
	}

	code := coaCodeFrom(t, oauthFrom(t, h.server, "10.77.2.1", http.MethodPost, "/oauth/authorize",
		a.form("email", f.OwnerEmail, "password", f.loginSecret())))
	tok := h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"authorization_code"}, "code": {code},
		"redirect_uri": {coaRedirect}, "client_id": {a.clientID}, "code_verifier": {a.verifier},
	})
	var body map[string]any
	_ = json.Unmarshal(tok.Body.Bytes(), &body)
	refresh, _ := body["refresh_token"].(string)
	if tok.Code != http.StatusOK || refresh == "" {
		t.Fatalf("token: %d %s", tok.Code, tok.Body.String())
	}
	if rec := h.oauthPost(t, "/oauth/revoke", url.Values{"token": {refresh}}); rec.Code != http.StatusOK {
		t.Fatalf("revoke by token alone: %d %s", rec.Code, rec.Body.String())
	}
	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {a.clientID},
	})
	if rec.Code != http.StatusBadRequest || oauthErrorOf(t, rec) != "invalid_grant" {
		t.Fatalf("a revoked refresh token still works: %d %s", rec.Code, rec.Body.String())
	}
}

// TestCoaOAuthRegisterWithoutAPerAddressCap: a stack that turns the
// database-counted per-address cap off still registers clients (the
// platform-wide cap alone applies).
func TestCoaOAuthRegisterWithoutAPerAddressCap(t *testing.T) {
	h := requireDB(t)
	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = t.TempDir()
	cfg.OAuthRegistrationsPerHour = 1 << 20
	cfg.OAuthRegistrationsPerIPPerHour = 0
	srv := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)
	req := httptest.NewRequest(http.MethodPost, "/oauth/register",
		strings.NewReader(`{"client_name":"Claude","redirect_uris":["https://claude.ai/api/mcp/auth_callback"]}`))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "10.77.3.1:12345"
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated || !strings.Contains(rec.Body.String(), "client_id") {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
}

// TestCoaOAuthPageOnAnUnknownFarmHost: a farm address that names no farm
// shows its slug on the page instead of a display name.
func TestCoaOAuthPageOnAnUnknownFarmHost(t *testing.T) {
	h := requireDB(t)
	a := h.coaNewAuthorize(t)
	slug := "coa-nadie-" + uuid.NewString()[:6]
	req := httptest.NewRequest(http.MethodGet, "/oauth/authorize?"+a.base.Encode(), nil)
	req.Host = slug + ".bascula.engp.io"
	req.RemoteAddr = "10.77.4.1:12345"
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	coaPage(t, "unknown farm host", rec, slug)
}
