package apitest

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
)

// oauthSignIn is the connector sign-in form, posted as a browser would.
type oauthSignIn struct {
	h    *harness
	base url.Values
}

func (h *harness) newOAuthSignIn(t *testing.T) *oauthSignIn {
	t.Helper()
	redirect := "https://chatgpt.com/connector_platform_oauth_redirect"
	reg := h.mustDo(t, http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name": "ChatGPT", "redirect_uris": []string{redirect},
	}, http.StatusCreated)
	sum := sha256.Sum256([]byte(pkceVerifier(t)))
	return &oauthSignIn{h: h, base: url.Values{
		"client_id": {reg.Body["client_id"].(string)}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"state": {"s1"}, "scope": {"mcp"},
	}}
}

func (o *oauthSignIn) post(host string, kv ...string) *httptest.ResponseRecorder {
	form := url.Values{}
	for k, vs := range o.base {
		form[k] = vs
	}
	for i := 0; i+1 < len(kv); i += 2 {
		form.Set(kv[i], kv[i+1])
	}
	req := httptest.NewRequest(http.MethodPost, "/oauth/authorize", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = "10.0.7.1:12345"
	if host != "" {
		req.Host = host
	}
	rec := httptest.NewRecorder()
	o.h.server.ServeHTTP(rec, req)
	return rec
}

// refused asserts the form came back (no redirect, no code) saying want.
func refused(t *testing.T, what string, rec *httptest.ResponseRecorder, want string) {
	t.Helper()
	if rec.Code == http.StatusFound {
		t.Fatalf("%s: signed in, redirected to %s", what, rec.Header().Get("Location"))
	}
	if !strings.Contains(rec.Body.String(), want) {
		t.Fatalf("%s: page should say %q, got %d %s", what, want, rec.Code, rec.Body.String())
	}
}

func signedIn(t *testing.T, what string, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusFound {
		t.Fatalf("%s: got %d %s, want a redirect with a code", what, rec.Code, rec.Body.String())
	}
	loc, _ := rec.Result().Location()
	if loc.Query().Get("code") == "" {
		t.Fatalf("%s: no code in %s", what, loc)
	}
}

func (h *harness) slugOf(t *testing.T, farmID string) string {
	t.Helper()
	var slug string
	if err := h.admin.QueryRow(context.Background(), `SELECT slug FROM farms WHERE id = $1`, farmID).Scan(&slug); err != nil {
		t.Fatal(err)
	}
	return slug
}

// TestOAuthSignInRefusals covers what the connector sign-in says to a correct
// password that still cannot connect an assistant.
func TestOAuthSignInRefusals(t *testing.T) {
	h := requireDB(t)
	ctx := context.Background()
	o := h.newOAuthSignIn(t)

	t.Run("an account that belongs to no farm", func(t *testing.T) {
		email := "oauth-sin-finca-" + uuid.NewString()[:8] + "@example.com"
		hash, err := auth.HashPassword("una-clave-larga-1")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := h.admin.Exec(ctx, `INSERT INTO users (id, email, name, password_hash, email_verified_at)
			VALUES ($1, $2, 'Nadie', $3, now())`, uuid.NewString(), email, hash); err != nil {
			t.Fatal(err)
		}
		refused(t, "no farm", o.post("", "email", email, "password", "una-clave-larga-1"), "no pertenece a ninguna finca")
	})

	t.Run("an unverified address", func(t *testing.T) {
		f := h.signupFarm(t, "Finca OAuth sin verificar", 250000)
		if _, err := h.admin.Exec(ctx, `UPDATE users SET email_verified_at = NULL WHERE id = $1`, f.OwnerUserID); err != nil {
			t.Fatal(err)
		}
		refused(t, "unverified", o.post("", "email", f.OwnerEmail, "password", f.loginSecret()), "Verifique el correo")
	})

	t.Run("an account whose only farm is suspended", func(t *testing.T) {
		f := h.signupFarm(t, "Finca OAuth suspendida", 250000)
		if _, err := h.admin.Exec(ctx, `UPDATE farms SET suspended_at = now() WHERE id = $1`, f.FarmID); err != nil {
			t.Fatal(err)
		}
		refused(t, "suspended", o.post("", "email", f.OwnerEmail, "password", f.loginSecret()), "suspendida")
	})

	t.Run("a farm host", func(t *testing.T) {
		f := h.signupFarm(t, "Finca OAuth anfitriona", 250000)
		g := h.signupFarm(t, "Finca OAuth vecina", 250000)
		stranger := h.signupFarm(t, "Finca OAuth extraña", 250000)
		strangerHost := h.slugOf(t, stranger.FarmID) + ".bascula.engp.io"

		// One farm, someone else's host: a dedicated stack holds only its own
		// farm, so the one active membership is the one opened.
		signedIn(t, "single farm on a foreign host", o.post(strangerHost, "email", f.OwnerEmail, "password", f.loginSecret()))

		// Two farms and a host that is neither: no guessing.
		h.addOwner(t, g.FarmID, f.OwnerUserID)
		refused(t, "two farms on a foreign host",
			o.post(strangerHost, "email", f.OwnerEmail, "password", f.loginSecret()), "no pertenece a esta finca")

		// The host names one of them, and that one is suspended: the other
		// farm is not opened in its place.
		if _, err := h.admin.Exec(ctx, `UPDATE farms SET suspended_at = now() WHERE id = $1`, g.FarmID); err != nil {
			t.Fatal(err)
		}
		refused(t, "suspended host farm",
			o.post(h.slugOf(t, g.FarmID)+".bascula.engp.io", "email", f.OwnerEmail, "password", f.loginSecret()), "suspendida")
	})

	t.Run("a farm-pick ticket for an account deleted since", func(t *testing.T) {
		f := h.signupFarm(t, "Finca OAuth ticket uno", 250000)
		g := h.signupFarm(t, "Finca OAuth ticket dos", 250000)
		h.addOwner(t, g.FarmID, f.OwnerUserID)
		rec := o.post("", "email", f.OwnerEmail, "password", f.loginSecret())
		m := regexp.MustCompile(`name="ticket" value="([^"]+)"`).FindStringSubmatch(rec.Body.String())
		if m == nil {
			t.Fatalf("two farms should get a pick step with a ticket: %d %s", rec.Code, rec.Body.String())
		}
		if _, err := h.admin.Exec(ctx, `DELETE FROM users WHERE id = $1`, f.OwnerUserID); err != nil {
			t.Fatal(err)
		}
		refused(t, "deleted account", o.post("", "ticket", m[1], "farm_id", g.FarmID), "Entre de nuevo")
	})
}
