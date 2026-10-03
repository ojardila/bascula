// SPDX-License-Identifier: MIT

package apitest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// signupBody is a valid public signup with the four dispatched fields chosen.
func signupBody(farmName, ownerName, email, phone string) map[string]any {
	return map[string]any{
		"farm": map[string]any{
			"name": farmName, "slug": "campos-" + strings.ReplaceAll(uuid.NewString()[:8], "-", ""),
			"priceCents": 90000,
		},
		"owner": map[string]any{"email": email, "name": ownerName, "phone": phone, "password": "una-clave-larga-1"},
	}
}

func freshEmail() string { return "campos-" + uuid.NewString()[:8] + "@example.com" }

// TestSignupRefusesFieldsThatCannotTravelToTheWorkflow: the farm name, the
// owner's name, the address and the phone are sent to the provision-tenant
// workflow, so signup refuses line breaks, control characters and absurd
// lengths in them — and nothing else: accents and ñ are ordinary names.
func TestSignupRefusesFieldsThatCannotTravelToTheWorkflow(t *testing.T) {
	h := requireDB(t)
	long := strings.Repeat("ñ", 81)
	cases := []struct {
		name                      string
		farm, owner, email, phone string
		field                     string
	}{
		{"newline in farm name", "Finca\nmode: shared", "Ana", freshEmail(), "", "farm.name"},
		{"carriage return in farm name", "Finca\r", "Ana", freshEmail(), "", "farm.name"},
		{"tab in farm name", "Finca\tLa Palma", "Ana", freshEmail(), "", "farm.name"},
		{"C1 control in farm name", "Finca\u0085La Palma", "Ana", freshEmail(), "", "farm.name"},
		{"line separator in farm name", "Finca\u2028La Palma", "Ana", freshEmail(), "", "farm.name"},
		{"paragraph separator in owner name", "La Palma", "Ana\u2029María", freshEmail(), "", "owner.name"},
		{"newline in owner name", "La Palma", "Ana\nMaría", freshEmail(), "", "owner.name"},
		{"farm name too long", long, "Ana", freshEmail(), "", "farm.name"},
		{"owner name too long", "La Palma", long, freshEmail(), "", "owner.name"},
		{"letters in phone", "La Palma", "Ana", freshEmail(), "310 555 abcd", "owner.phone"},
		{"newline in phone", "La Palma", "Ana", freshEmail(), "310\n555", "owner.phone"},
		{"phone too long", "La Palma", "Ana", freshEmail(), strings.Repeat("1", 26), "owner.phone"},
		{"display name in email", "La Palma", "Ana", "Ana <" + freshEmail() + ">", "", "owner.email"},
		{"email too long", "La Palma", "Ana", strings.Repeat("a", 250) + "@example.com", "", "owner.email"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := h.do(t, http.MethodPost, "/v1/signup", "", signupBody(c.farm, c.owner, c.email, c.phone))
			if res.Status != http.StatusBadRequest {
				t.Fatalf("status %d, want 400: %s", res.Status, res.Raw)
			}
			errBody, _ := res.Body["error"].(map[string]any)
			details, _ := errBody["details"].(map[string]any)
			fields, _ := details["fields"].(map[string]any)
			if _, ok := fields[c.field]; !ok {
				t.Fatalf("the refusal does not name %s: %s", c.field, res.Raw)
			}
		})
	}

	t.Run("accents, ñ, a dash and a phone with punctuation are fine", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/signup", "",
			signupBody("Finca La Ñapa Ñuñoa – José María", "José María Núñez", freshEmail(), "+57 (310) 555-1234"))
		if res.Status != http.StatusCreated {
			t.Fatalf("status %d, want 201: %s", res.Status, res.Raw)
		}
	})
	t.Run("exactly 80 runes is fine", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/signup", "",
			signupBody(strings.Repeat("ñ", 80), strings.Repeat("é", 80), freshEmail(), ""))
		if res.Status != http.StatusCreated {
			t.Fatalf("status %d, want 201: %s", res.Status, res.Raw)
		}
	})
}

// TestTheConsoleRefusesTheSameFields: the operator door creates a farm and
// dispatches it exactly like signup, so it validates the same way.
func TestTheConsoleRefusesTheSameFields(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del operador", 80000)
	admin := h.superadminToken(t, f.FarmID)
	for name, body := range map[string]map[string]any{
		"newline in name": {"name": "Finca\nx", "priceCents": 90000,
			"owner": map[string]any{"email": freshEmail(), "name": "Ana"}},
		"name too long": {"name": strings.Repeat("a", 81), "priceCents": 90000,
			"owner": map[string]any{"email": freshEmail(), "name": "Ana"}},
		"newline in owner name": {"name": "La Palma", "priceCents": 90000,
			"owner": map[string]any{"email": freshEmail(), "name": "Ana\r\nx"}},
		"display name in email": {"name": "La Palma", "priceCents": 90000,
			"owner": map[string]any{"email": "x <" + freshEmail() + ">", "name": "Ana"}},
	} {
		t.Run(name, func(t *testing.T) {
			res := h.do(t, http.MethodPost, "/v1/admin/farms", admin, body)
			if res.Status != http.StatusBadRequest {
				t.Fatalf("status %d, want 400: %s", res.Status, res.Raw)
			}
		})
	}
}

// TestTheProvisionDispatchCarriesCleanText: what reaches GitHub's
// repository_dispatch is the name as typed, accents and all, and no control
// character anywhere in client_payload.
func TestTheProvisionDispatchCarriesCleanText(t *testing.T) {
	h := requireDB(t)

	var mu sync.Mutex
	var raw []string
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		b, _ := json.Marshal(body["client_payload"])
		mu.Lock()
		raw = append(raw, string(b))
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer gh.Close()
	dead := httptest.NewServer(http.NotFoundHandler())
	defer dead.Close()

	uploads, _ := os.MkdirTemp("", "bascula-dispatch-uploads-")
	defer os.RemoveAll(uploads)
	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = uploads
	cfg.SignupsPerIPPerHour = 1000
	cfg.SignupsPerEmailPerHour = 1000
	cfg.GitHubDispatchToken = "gh-test"
	cfg.GitHubDispatchRepo = "ojardila/gitops"
	cfg.GitHubAPIURL = gh.URL
	cfg.TenantInternalURL = dead.URL
	cfg.TenantPublicURL = dead.URL
	cfg.ProvisionPollEvery = 50 * time.Millisecond
	cfg.ProvisionWatchFor = time.Second
	platform := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)

	const farmName = "Finca La Ñapa Ñuñoa – José María"
	res := call(t, platform, http.MethodPost, "/v1/signup", "",
		signupBody(farmName, "José María Núñez", freshEmail(), "+57 (310) 555-1234"))
	if res.Status != http.StatusCreated {
		t.Fatalf("signup: %d %s", res.Status, res.Raw)
	}
	waitFor(t, 5*time.Second, "provision-tenant dispatch", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(raw) > 0
	})
	mu.Lock()
	got := raw[0]
	mu.Unlock()

	var payload map[string]string
	if err := json.Unmarshal([]byte(got), &payload); err != nil {
		t.Fatalf("client_payload is not a flat object of strings: %s", got)
	}
	if payload["farmName"] != farmName || payload["ownerName"] != "José María Núñez" ||
		payload["phone"] != "+57 (310) 555-1234" {
		t.Fatalf("payload changed what was typed: %s", got)
	}
	for k, v := range payload {
		for _, r := range v {
			if r < 0x20 || (r >= 0x7f && r <= 0x9f) || r == '\u2028' || r == '\u2029' {
				t.Fatalf("client_payload[%s] carries control character %U: %q", k, r, v)
			}
		}
	}
}
