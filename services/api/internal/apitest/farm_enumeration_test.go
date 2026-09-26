package apitest

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// TestProvisionStatusIsNotAFarmDirectory: the waiting screen's status answers
// the person who created the farm (the provision ticket signup handed back)
// and a super-admin. Anybody else gets, for a farm that exists, exactly the
// answer a slug nobody registered gets: same status, same body.
func TestProvisionStatusIsNotAFarmDirectory(t *testing.T) {
	h := requireDB(t)
	slug := "directorio-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")

	email := fmt.Sprintf("dueno-%s@example.com", uuid.NewString()[:8])
	res := call(t, h.server, http.MethodPost, "/v1/signup", "", map[string]any{
		"farm":  map[string]any{"name": "Directorio", "slug": slug, "priceCents": 90000},
		"owner": map[string]any{"email": email, "name": "Owner", "password": "una-clave-larga-1"},
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("signup: %d %s", res.Status, res.Raw)
	}
	ticket, _ := res.Body["provisionTicket"].(string)
	if ticket == "" {
		t.Fatalf("signup must hand back a provision ticket: %s", res.Raw)
	}

	existing := call(t, h.server, http.MethodGet, "/v1/farms/"+slug+"/provision-status", "", nil)
	missing := call(t, h.server, http.MethodGet, "/v1/farms/no-existe-"+uuid.NewString()[:6]+"/provision-status", "", nil)
	if existing.Status != http.StatusNotFound || existing.Raw != missing.Raw {
		t.Fatalf("status without a ticket must look like an unknown slug: %d %s vs %d %s",
			existing.Status, existing.Raw, missing.Status, missing.Raw)
	}
	for _, leak := range []string{"elapsedSeconds", "createdAt", "stages", "certificate"} {
		if strings.Contains(existing.Raw, leak) {
			t.Fatalf("status without a ticket leaked %q: %s", leak, existing.Raw)
		}
	}

	// A ticket for another slug opens nothing.
	other := call(t, h.server, http.MethodGet,
		"/v1/farms/"+slug+"/provision-status?ticket="+provisionTicketFor("otra-finca"), "", nil)
	if other.Status != http.StatusNotFound || other.Raw != missing.Raw {
		t.Fatalf("status with another farm's ticket: %d %s", other.Status, other.Raw)
	}
	// Nor does a forged or expired one.
	expired := testSigner.SignTicket("provision-status", slug, -time.Minute)
	for _, bad := range []string{"x.y.z", expired, ticket + "x"} {
		got := call(t, h.server, http.MethodGet, "/v1/farms/"+slug+"/provision-status?ticket="+bad, "", nil)
		if got.Status != http.StatusNotFound {
			t.Fatalf("status with a bad ticket %q: %d %s", bad, got.Status, got.Raw)
		}
	}

	// The ticket from signup, in the header the web sends.
	req := httptest.NewRequest(http.MethodGet, "/v1/farms/"+slug+"/provision-status", nil)
	req.RemoteAddr = "10.0.0.9:12345"
	req.Header.Set("X-Provision-Ticket", ticket)
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"slug":"`+slug+`"`) {
		t.Fatalf("status with the signup ticket: %d %s", rec.Code, rec.Body.String())
	}

	// A super-admin watches any farm from the console.
	var farmID string
	if err := h.admin.QueryRow(context.Background(), `SELECT id::text FROM farms WHERE slug = $1`, slug).Scan(&farmID); err != nil {
		t.Fatal(err)
	}
	admin := call(t, h.server, http.MethodGet, "/v1/farms/"+slug+"/provision-status", h.superadminToken(t, farmID), nil)
	if admin.Status != http.StatusOK {
		t.Fatalf("status for a super-admin: %d %s", admin.Status, admin.Raw)
	}
}

// TestFarmLookupsAreMetered: the availability check is an oracle for one exact
// slug by nature, so it is metered per address; so is the farm name on the
// shared platform. A dedicated stack only knows its own farm and does not
// meter its front door.
func TestFarmLookupsAreMetered(t *testing.T) {
	h := requireDB(t)
	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = t.TempDir()
	cfg.FarmLookupsPerIPPerHour = 3
	srv := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)

	lookup := func(path, ip string) int {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = ip + ":4000"
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		return rec.Code
	}
	for i := 0; i < 2; i++ {
		if code := lookup("/v1/farm-slugs?slug=alguna-"+uuid.NewString()[:6], "10.9.8.7"); code != http.StatusOK {
			t.Fatalf("lookup %d: %d", i, code)
		}
	}
	if code := lookup("/v1/farm-name?slug=alguna", "10.9.8.7"); code != http.StatusNotFound {
		t.Fatalf("farm name within the budget: %d", code)
	}
	if code := lookup("/v1/farm-slugs?slug=otra-mas", "10.9.8.7"); code != http.StatusTooManyRequests {
		t.Fatalf("lookup past the budget: %d, want 429", code)
	}
	if code := lookup("/v1/farm-name?slug=alguna", "10.9.8.7"); code != http.StatusTooManyRequests {
		t.Fatalf("farm name past the budget: %d, want 429", code)
	}
	// Another address has its own budget.
	if code := lookup("/v1/farm-slugs?slug=otra-mas", "10.9.8.6"); code != http.StatusOK {
		t.Fatalf("another address: %d", code)
	}

	// A dedicated stack's farm name is not metered.
	dcfg := cfg
	dcfg.TenantSlug = "la-propia"
	dedicated := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), dcfg)
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/v1/farm-name", nil)
		req.RemoteAddr = "10.9.8.5:4000"
		rec := httptest.NewRecorder()
		dedicated.ServeHTTP(rec, req)
		if rec.Code == http.StatusTooManyRequests {
			t.Fatalf("dedicated farm name metered on call %d", i)
		}
	}
}
