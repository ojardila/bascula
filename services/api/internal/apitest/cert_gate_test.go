package apitest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// TestNotReadyUntilCloudflareCertificateIsActive: the farm's address can
// answer /health (the platform's wildcard route, or Cloudflare's cache) while
// its own certificate is still pending, and a browser then gets a TLS error.
// The waiting screen must not call that ready: the certificate step is done
// only when Cloudflare says ssl.status is active, a failed Cloudflare call is
// retried and surfaced, and a failed certificate is asked for again.
func TestNotReadyUntilCloudflareCertificateIsActive(t *testing.T) {
	h := requireDB(t)
	slug := "gate-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")

	var mu sync.Mutex
	sslStatus := "pending_validation"
	failCalls := 2 // the first Cloudflare calls fail outright
	creates, patches := 0, 0
	const id = "host-1"
	cf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if failCalls > 0 {
			failCalls--
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "errors": []any{map[string]any{"code": 1000, "message": "cloudflare down"}}})
			return
		}
		view := map[string]any{"id": id, "hostname": "x", "status": "active", "ssl": map[string]any{"status": sslStatus, "method": "http"}}
		reply := func(result any) {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "errors": []any{}, "result": result})
		}
		const base = "/zones/zone-test/custom_hostnames"
		switch {
		case r.Method == http.MethodGet && r.URL.Path == base:
			if creates == 0 {
				reply([]any{})
				return
			}
			reply([]any{view})
		case r.Method == http.MethodPost && r.URL.Path == base:
			creates++
			reply(view)
		case r.Method == http.MethodPatch:
			patches++
			sslStatus = "pending_validation"
			reply(view)
		default:
			reply(view)
		}
	}))
	defer cf.Close()

	var probes []string
	// The address answers from the first second, as the wildcard route does.
	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		probes = append(probes, r.URL.RawQuery)
		mu.Unlock()
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer public.Close()

	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = t.TempDir()
	cfg.MaxFarmsPerEmail = 3
	cfg.SignupsPerIPPerHour = 1000
	cfg.SignupsPerEmailPerHour = 1000
	cfg.TenantPublicURL = public.URL
	cfg.ProvisionPollEvery = 20 * time.Millisecond
	cfg.ProvisionWatchFor = 20 * time.Second
	cfg.CloudflareSaaSToken = "cf-test"
	cfg.CloudflareZoneID = "zone-test"
	cfg.CloudflareAPIURL = cf.URL
	platform := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)

	signupWithSlug(t, platform, "Candado", slug)

	stepDone := func(st response, key string) bool {
		steps, _ := st.Body["steps"].([]any)
		for _, s := range steps {
			m, _ := s.(map[string]any)
			if m["key"] == key {
				return m["done"] == true
			}
		}
		t.Fatalf("no %s step: %s", key, st.Raw)
		return false
	}
	get := func() response {
		time.Sleep(4100 * time.Millisecond) // past the per-slug status cache
		return call(t, platform, http.MethodGet, "/v1/farms/"+slug+"/provision-status", "", nil)
	}

	// Cloudflare errors and a pending certificate: never ready, although
	// the address answers 200.
	waitFor(t, 5*time.Second, "custom hostname created after errors", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return creates == 1
	})
	st := get()
	if st.Body["ready"] == true || stepDone(st, "certificate") || !stepDone(st, "web") {
		t.Fatalf("pending certificate reported as done/ready: %s", st.Raw)
	}

	// A failed certificate is asked for again rather than abandoned.
	mu.Lock()
	sslStatus = "validation_timed_out"
	mu.Unlock()
	waitFor(t, 10*time.Second, "revalidate after failure", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return patches >= 1
	})
	st = get()
	if st.Body["ready"] == true || stepDone(st, "certificate") {
		t.Fatalf("failed certificate reported as done/ready: %s", st.Raw)
	}

	// Active at Cloudflare: now, and only now, ready.
	mu.Lock()
	sslStatus = "active"
	mu.Unlock()
	waitFor(t, 15*time.Second, "ready once the certificate is active", func() bool {
		st = get()
		return st.Body["ready"] == true
	})
	if !stepDone(st, "certificate") {
		t.Fatalf("ready without certificate step: %s", st.Raw)
	}

	// The probe goes past Cloudflare's cache.
	mu.Lock()
	defer mu.Unlock()
	if len(probes) == 0 || !strings.HasPrefix(probes[len(probes)-1], "probe=") {
		t.Fatalf("probe queries = %v, want a cache-busting probe=", probes)
	}
}
