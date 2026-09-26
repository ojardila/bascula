package apitest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// TestNewFarmGetsACloudflareCertificate: with Cloudflare for SaaS configured,
// creating a farm with a slug asks Cloudflare for ONE custom hostname for the
// farm's address (HTTP validation), watches it until the hostname and its
// certificate are active, and the waiting screen shows that as its own step
// between "app" and "web".
func TestNewFarmGetsACloudflareCertificate(t *testing.T) {
	h := requireDB(t)
	owner := h.signupFarm(t, "Finca con certificado", 90000)
	slug := "cert-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")

	var mu sync.Mutex
	type hostRec struct {
		ID, Hostname, Status, SSL string
		gets                      int
	}
	hosts := map[string]*hostRec{}
	var creates []map[string]any
	certActive := false
	cf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer cf-test" {
			http.Error(w, `{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}`, http.StatusForbidden)
			return
		}
		reply := func(status int, result any) {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "errors": []any{}, "result": result})
		}
		view := func(x *hostRec) map[string]any {
			return map[string]any{"id": x.ID, "hostname": x.Hostname, "status": x.Status, "ssl": map[string]any{"status": x.SSL, "method": "http"}}
		}
		const base = "/zones/zone-test/custom_hostnames"
		switch {
		case r.Method == http.MethodGet && r.URL.Path == base:
			out := []any{}
			for _, x := range hosts {
				if x.Hostname == r.URL.Query().Get("hostname") {
					out = append(out, view(x))
				}
			}
			reply(200, out)
		case r.Method == http.MethodPost && r.URL.Path == base:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			creates = append(creates, body)
			x := &hostRec{ID: uuid.NewString(), Hostname: body["hostname"].(string), Status: "pending", SSL: "pending_validation"}
			hosts[x.ID] = x
			reply(201, view(x))
		case strings.HasPrefix(r.URL.Path, base+"/"):
			x := hosts[strings.TrimPrefix(r.URL.Path, base+"/")]
			if x == nil {
				http.NotFound(w, r)
				return
			}
			x.gets++
			if x.gets >= 2 {
				x.Status, x.SSL = "active", "active"
				certActive = true
			}
			reply(200, view(x))
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer cf.Close()

	// The farm's public address answers only once its certificate exists.
	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		ok := certActive
		mu.Unlock()
		if r.URL.Path == "/health" && ok {
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		}
		http.Error(w, "no certificate yet", http.StatusServiceUnavailable)
	}))
	defer public.Close()

	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = t.TempDir()
	cfg.MaxFarmsPerEmail = 3
	cfg.TenantPublicURL = public.URL
	cfg.ProvisionPollEvery = 50 * time.Millisecond
	cfg.ProvisionWatchFor = 20 * time.Second
	cfg.CloudflareSaaSToken = "cf-test"
	cfg.CloudflareZoneID = "zone-test"
	cfg.CloudflareAPIURL = cf.URL
	platform := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)

	created := call(t, platform, http.MethodPost, "/v1/farms", owner.OwnerToken, map[string]any{
		"name": "Con certificado", "slug": slug, "priceCents": 90000,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("create farm: %d %s", created.Status, created.Raw)
	}

	var status response
	waitFor(t, 10*time.Second, "provision status ready", func() bool {
		status = call(t, platform, http.MethodGet, "/v1/farms/"+slug+"/provision-status", "", nil)
		return status.Status == http.StatusOK && status.Body["ready"] == true
	})
	steps, _ := status.Body["steps"].([]any)
	var keys []string
	for _, s := range steps {
		m, _ := s.(map[string]any)
		keys = append(keys, m["key"].(string))
		if m["done"] != true {
			t.Fatalf("step not done: %s", status.Raw)
		}
	}
	if strings.Join(keys, ",") != "database,app,certificate,web" {
		t.Fatalf("steps = %v", keys)
	}

	mu.Lock()
	defer mu.Unlock()
	u, _ := url.Parse(public.URL)
	if len(creates) != 1 || creates[0]["hostname"] != u.Hostname() {
		t.Fatalf("custom hostname requests = %v, want one for %s", creates, u.Hostname())
	}
	ssl, _ := creates[0]["ssl"].(map[string]any)
	if ssl["method"] != "http" || ssl["type"] != "dv" {
		t.Fatalf("ssl = %v", ssl)
	}
}
