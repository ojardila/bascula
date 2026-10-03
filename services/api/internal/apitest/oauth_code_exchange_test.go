package apitest

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// oauthExchange is one connector: a registered client, a PKCE pair, and the
// code exchange it performs against /oauth/token.
type oauthExchange struct {
	h                  *harness
	f                  *farmFixture
	clientID, redirect string
	verifier           string
	challenge          string
}

func (h *harness) newOAuthExchange(t *testing.T, f *farmFixture) *oauthExchange {
	redirect := "https://claude.ai/api/mcp/auth_callback"
	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	return &oauthExchange{h: h, f: f, redirect: redirect, verifier: verifier,
		clientID:  h.registerOAuthClient(t, "Claude", redirect),
		challenge: base64.RawURLEncoding.EncodeToString(sum[:])}
}

// code signs in and leaves one pending code for this client, then lets the
// test change what that code row says before it is exchanged.
func (o *oauthExchange) code(t *testing.T, tamper string) string {
	t.Helper()
	code := o.h.oauthCode(t, o.f, o.clientID, o.redirect, o.challenge)
	if tamper != "" {
		adminExec(t, o.h, `UPDATE oauth_codes SET `+tamper+` WHERE client_id = $1`, o.clientID)
	}
	return code
}

func (o *oauthExchange) exchange(t *testing.T, code string) (status int, oauthErr, body string) {
	t.Helper()
	rec := oauthFrom(t, o.h.server, "10.32.0.1", http.MethodPost, "/oauth/token", url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {o.redirect},
		"client_id": {o.clientID}, "code_verifier": {o.verifier},
	})
	return rec.Code, oauthErrorOf(t, rec), rec.Body.String()
}

func (o *oauthExchange) refused(t *testing.T, code, wantErr, wantDesc string) {
	t.Helper()
	status, got, body := o.exchange(t, code)
	if status != http.StatusBadRequest || got != wantErr || !strings.Contains(body, wantDesc) {
		t.Fatalf("got %d %s, want 400 %s mentioning %q", status, body, wantErr, wantDesc)
	}
}

// TestOAuthCodeExchangeChecksTheSealedProof: a code is only as good as the
// sign-in sealed inside it and the membership it names when it is spent.
func TestOAuthCodeExchangeChecksTheSealedProof(t *testing.T) {
	h := requireDB(t)

	t.Run("a proof that does not verify reads as expired", func(t *testing.T) {
		o := h.newOAuthExchange(t, h.signupFarm(t, "Finca código roto", 250000))
		o.refused(t, o.code(t, `access_token = 'not-a-ticket'`), "invalid_grant", "code expired")
	})

	t.Run("a code issued for another server's resource", func(t *testing.T) {
		o := h.newOAuthExchange(t, h.signupFarm(t, "Finca otro recurso", 250000))
		o.refused(t, o.code(t, `resource = 'https://otro.example/mcp'`), "invalid_target", "another resource")
	})

	for name, change := range map[string]string{
		"a farm suspended between sign-in and exchange":     `UPDATE farms SET suspended_at = now() WHERE id = $1`,
		"a membership removed between sign-in and exchange": `DELETE FROM memberships WHERE farm_id = $1`,
	} {
		t.Run(name, func(t *testing.T) {
			f := h.signupFarm(t, "Finca "+name[:12], 250000)
			o := h.newOAuthExchange(t, f)
			code := o.code(t, "")
			adminExec(t, h, change, f.FarmID)
			o.refused(t, code, "invalid_grant", "no longer has access")
		})
	}

	t.Run("an account deleted between sign-in and exchange", func(t *testing.T) {
		f := h.signupFarm(t, "Finca cuenta borrada", 250000)
		o := h.newOAuthExchange(t, f)
		code := o.code(t, "")
		adminExec(t, h, `DELETE FROM users WHERE id = $1`, f.OwnerUserID)
		o.refused(t, code, "invalid_grant", "no longer exists")
	})

	t.Run("a code with no scope gets the full connector scope", func(t *testing.T) {
		o := h.newOAuthExchange(t, h.signupFarm(t, "Finca sin alcance", 250000))
		status, oauthErr, body := o.exchange(t, o.code(t, `scope = ''`))
		if status != http.StatusOK || oauthErr != "" || !strings.Contains(body, `"scope":"mcp"`) {
			t.Fatalf("got %d %s, want 200 with scope mcp", status, body)
		}
	})
}
