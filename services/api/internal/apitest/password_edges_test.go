package apitest

import (
	"net/http"
	"strings"
	"testing"
)

// The refusals around a password: what is too long to hash, an address that
// is not one, a new password too short to set, and the per-address limit on
// reset mails.
func TestPasswordEdges(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la clave larga", 90000)
	long := strings.Repeat("x", 129)

	t.Run("change refuses a current or new password over the limit", func(t *testing.T) {
		for _, body := range []map[string]any{
			{"currentPassword": long, "newPassword": newSecret},
			{"currentPassword": f.loginSecret(), "newPassword": long},
		} {
			if res := h.do(t, http.MethodPost, "/v1/me/password", f.OwnerToken, body); res.Status != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d %s", res.Status, res.Raw)
			}
		}
	})

	srv, _ := mailServer(t, h)

	t.Run("a reset request needs something that looks like an address", func(t *testing.T) {
		for _, email := range []string{"", "   ", "sin-arroba", strings.Repeat("a", 320) + "@x.co"} {
			res := call(t, srv, http.MethodPost, "/v1/auth/password-reset/request", "", map[string]any{"email": email})
			if res.Status != http.StatusBadRequest {
				t.Fatalf("%q: expected 400, got %d %s", email, res.Status, res.Raw)
			}
		}
	})

	t.Run("a reset with a short password is refused before the link is spent", func(t *testing.T) {
		res := call(t, srv, http.MethodPost, "/v1/auth/password-reset", "",
			map[string]any{"token": "lo-que-sea", "password": "corta"})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d %s", res.Status, res.Raw)
		}
	})

	t.Run("one address gets a few reset mails an hour, then a 429", func(t *testing.T) {
		email := "limite-" + f.FarmID[:8] + "@example.com"
		var last response
		for i := 0; i < 6; i++ {
			last = call(t, srv, http.MethodPost, "/v1/auth/password-reset/request", "", map[string]any{"email": email})
			if last.Status == http.StatusTooManyRequests {
				return
			}
		}
		t.Fatalf("six requests for one address were all accepted: %d %s", last.Status, last.Raw)
	})
}
