// SPDX-License-Identifier: MIT

package apitest

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// TestSignupFirstCannotOpenTheRealOwnersFarm: signup marks an address as
// verified without a mail link, so an account's global password belongs to
// whoever registered the address first. When the address's real owner later
// registers their own farm, it is attached to that account; the first
// registrant's password must not open it.
func TestSignupFirstCannotOpenTheRealOwnersFarm(t *testing.T) {
	h := requireDB(t)
	victim := "victima-" + uuid.NewString()[:8] + "@example.com"
	const attackerPass = "clave-del-atacante-1"
	const victimPass = "clave-de-la-duena-2"
	signup := func(name, slug, pass string) {
		t.Helper()
		h.mustDo(t, http.MethodPost, "/v1/signup", "", map[string]any{
			"farm": map[string]any{"name": name, "slug": slug, "timezone": "America/Bogota",
				"currency": "COP", "priceCents": 100000},
			"owner": map[string]any{"email": victim, "name": "X", "password": pass},
		}, http.StatusCreated)
	}
	bait := "cebo-" + uuid.NewString()[:8]
	real := "real-" + uuid.NewString()[:8]
	signup("Finca cebo", bait, attackerPass) // the attacker, first
	signup("Finca real", real, victimPass)   // the real owner, later

	// The attacker, with the only password they know, cannot open the farm.
	for _, body := range []map[string]any{
		{"email": victim, "password": attackerPass, "farmSlug": real},
		{"email": victim, "password": attackerPass},
	} {
		res := h.doFrom(t, "10.9.1.1", http.MethodPost, "/v1/auth/login", "", body)
		if res.Status == http.StatusOK && res.Body["slug"] == real {
			t.Fatalf("the first registrant opened the real owner's farm: %s", res.Raw)
		}
		if res.Status == http.StatusBadRequest {
			t.Fatalf("the real owner's farm was offered to the first registrant: %s", res.Raw)
		}
	}
	// The real owner signs in to their farm with what they typed.
	res := h.doFrom(t, "10.9.1.2", http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": victim, "password": victimPass,
	})
	if res.Status != http.StatusOK || res.Body["slug"] != real {
		t.Fatalf("the real owner could not sign in to their farm: %d %s", res.Status, res.Raw)
	}
}
