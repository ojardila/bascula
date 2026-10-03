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
	slug := "cert-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")

	fake := &fcFakeCloudflare{hosts: map[string]*fcHostRec{}}
	cf := httptest.NewServer(fake)
	defer cf.Close()

	// The farm's public address answers only once its certificate exists.
	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" && fake.isCertActive() {
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		}
		http.Error(w, "no certificate yet", http.StatusServiceUnavailable)
	}))
	defer public.Close()

	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = t.TempDir()
	cfg.MaxFarmsPerEmail = 3
	cfg.SignupsPerIPPerHour = 1000
	cfg.SignupsPerEmailPerHour = 1000
	cfg.TenantPublicURL = public.URL
	cfg.ProvisionPollEvery = 50 * time.Millisecond
	cfg.ProvisionWatchFor = 20 * time.Second
	cfg.CloudflareSaaSToken = "cf-test"
	cfg.CloudflareZoneID = "zone-test"
	cfg.CloudflareAPIURL = cf.URL
	platform := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)

	signupWithSlug(t, platform, "Con certificado", slug)

	var status response
	waitFor(t, 10*time.Second, "provision status ready", func() bool {
		status = call(t, platform, http.MethodGet, provisionStatusPath(slug), "", nil)
		return status.Status == http.StatusOK && status.Body["ready"] == true
	})
	fcAssertStepsDone(t, status)

	fake.mu.Lock()
	defer fake.mu.Unlock()
	creates := fake.creates
	u, _ := url.Parse(public.URL)
	if len(creates) != 1 || creates[0]["hostname"] != u.Hostname() {
		t.Fatalf("custom hostname requests = %v, want one for %s", creates, u.Hostname())
	}
	ssl, _ := creates[0]["ssl"].(map[string]any)
	if ssl["method"] != "http" || ssl["type"] != "dv" {
		t.Fatalf("ssl = %v", ssl)
	}
}

// fcAssertStepsDone checks every provisioning step is done and the steps are,
// in order, database, app, certificate and web.
func fcAssertStepsDone(t *testing.T, status response) {
	t.Helper()
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
}

type fcHostRec struct {
	ID, Hostname, Status, SSL string
	gets                      int
}

// fcFakeCloudflare stands in for the Cloudflare for SaaS custom hostnames API:
// a hostname and its certificate turn active on the second time it is read.
type fcFakeCloudflare struct {
	mu         sync.Mutex
	hosts      map[string]*fcHostRec
	creates    []map[string]any
	certActive bool
}

const fcCustomHostnamesBase = "/zones/zone-test/custom_hostnames"

func (c *fcFakeCloudflare) isCertActive() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.certActive
}

func (c *fcFakeCloudflare) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer cf-test" {
		http.Error(w, `{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}`, http.StatusForbidden)
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == fcCustomHostnamesBase:
		c.list(w, r)
	case r.Method == http.MethodPost && r.URL.Path == fcCustomHostnamesBase:
		c.create(w, r)
	case strings.HasPrefix(r.URL.Path, fcCustomHostnamesBase+"/"):
		c.get(w, r)
	default:
		http.Error(w, "unexpected", http.StatusBadRequest)
	}
}

func (c *fcFakeCloudflare) list(w http.ResponseWriter, r *http.Request) {
	out := []any{}
	for _, x := range c.hosts {
		if x.Hostname == r.URL.Query().Get("hostname") {
			out = append(out, fcView(x))
		}
	}
	fcReply(w, 200, out)
}

func (c *fcFakeCloudflare) create(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	c.creates = append(c.creates, body)
	x := &fcHostRec{ID: uuid.NewString(), Hostname: body["hostname"].(string), Status: "pending", SSL: "pending_validation"}
	c.hosts[x.ID] = x
	fcReply(w, 201, fcView(x))
}

func (c *fcFakeCloudflare) get(w http.ResponseWriter, r *http.Request) {
	x := c.hosts[strings.TrimPrefix(r.URL.Path, fcCustomHostnamesBase+"/")]
	if x == nil {
		http.NotFound(w, r)
		return
	}
	x.gets++
	if x.gets >= 2 {
		x.Status, x.SSL = "active", "active"
		c.certActive = true
	}
	fcReply(w, 200, fcView(x))
}

func fcReply(w http.ResponseWriter, status int, result any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "errors": []any{}, "result": result})
}

func fcView(x *fcHostRec) map[string]any {
	return map[string]any{"id": x.ID, "hostname": x.Hostname, "status": x.Status, "ssl": map[string]any{"status": x.SSL, "method": "http"}}
}
