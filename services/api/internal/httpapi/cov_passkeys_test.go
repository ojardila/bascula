package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// TestCpkPasskeyUserHandle: the WebAuthn user handle is the account UUID as
// 16 bytes; an id that is not a UUID (none exists today) falls back to its
// own bytes rather than to an empty handle, which go-webauthn would refuse.
func TestCpkPasskeyUserHandle(t *testing.T) {
	u := passkeyUser{user: &store.User{ID: "0192f3a0-0000-7000-8000-0000000000aa", Email: "a@b.co", Name: "Ana"}}
	if got := u.WebAuthnID(); len(got) != 16 || got[0] != 0x01 || got[15] != 0xaa {
		t.Fatalf("UUID handle: %x", got)
	}
	if u.WebAuthnName() != "a@b.co" || u.WebAuthnDisplayName() != "Ana" || u.WebAuthnCredentials() != nil {
		t.Fatalf("user adapter: %q %q %v", u.WebAuthnName(), u.WebAuthnDisplayName(), u.WebAuthnCredentials())
	}
	legacy := passkeyUser{user: &store.User{ID: "cuenta-antigua"}}
	if got := string(legacy.WebAuthnID()); got != "cuenta-antigua" {
		t.Fatalf("non-UUID handle: %q", got)
	}
}

// TestCpkPasskeyHandlersNeedATransaction: every passkey handler that gets
// past its request checks and finds no request transaction answers
// TENANT_NOT_SET instead of going on. The route-wide fault sweep sends bodies
// that stop earlier (no Origin, no password, no seal), so it never gets here.
func TestCpkPasskeyHandlersNeedATransaction(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	s := New(nil, auth.NewSigner([]byte("cpk-key"), "bascula"), Config{UploadDir: t.TempDir()})
	const userID = "0192f3a0-0000-7000-8000-0000000000aa"
	const origin = "http://localhost:5173"

	sd := &webauthn.SessionData{
		Challenge: "Y2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2U", RelyingPartyID: "localhost",
		Origin: origin, Expires: time.Now().Add(time.Minute),
		UserID: passkeyUser{user: &store.User{ID: userID}}.WebAuthnID(),
	}
	sealed, err := s.sealPasskeySession(sealPasskeyRegister, sd)
	if err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		name, method, body string
		handler            http.HandlerFunc
	}{
		{"list", http.MethodGet, "", s.handleListPasskeys},
		{"register options", http.MethodPost, `{"currentPassword":"una-clave"}`, s.handlePasskeyRegisterOptions},
		{"register", http.MethodPost, `{"challenge":"` + sealed + `","credential":{}}`, s.handlePasskeyRegister},
		{"sign-in", http.MethodPost, `{"challenge":"x","credential":{}}`, s.handlePasskeyLogin},
	} {
		req := httptest.NewRequest(c.method, "/v1/me/passkeys", strings.NewReader(c.body))
		req.Host = "localhost:5173"
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(auth.WithPrincipal(req.Context(), &auth.Principal{
			UserID: userID, FarmID: userID, Role: domain.RoleOwner,
		}))
		rec := httptest.NewRecorder()
		c.handler(rec, req)
		if rec.Code < 500 || !strings.Contains(rec.Body.String(), "TENANT_NOT_SET") {
			t.Fatalf("%s with no transaction: %d %s", c.name, rec.Code, rec.Body.String())
		}
	}
}
