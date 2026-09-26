package apitest

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// call is h.do against a server other than the shared one.
func call(t *testing.T, srv http.Handler, method, path, token string, body any) response {
	t.Helper()
	var reader io.Reader = strings.NewReader("")
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = strings.NewReader(string(raw))
	}
	req := httptest.NewRequest(method, path, reader)
	req.RemoteAddr = "10.0.0.9:12345"
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	out := response{Status: rec.Code, Raw: rec.Body.String()}
	if out.Raw != "" {
		_ = json.Unmarshal([]byte(out.Raw), &out.Body)
	}
	return out
}

// scratchTenantDB is a second, empty, migrated database: what a dedicated
// stack's Postgres looks like the moment Argo brings it up.
func scratchTenantDB(t *testing.T, h *harness) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	name := "bascula_tenant_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	boot, err := pgxpool.New(ctx, h.adminDSN)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if _, err := boot.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		boot.Close()
		t.Fatalf("create tenant db: %v", err)
	}
	boot.Close()
	adminDSN := replaceDBName(h.adminDSN, name)
	t.Cleanup(func() {
		drop, err := pgxpool.New(context.Background(), h.adminDSN)
		if err != nil {
			return
		}
		defer drop.Close()
		_, _ = drop.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
	})
	if err := store.Migrate(ctx, adminDSN); err != nil {
		t.Fatalf("migrate tenant db: %v", err)
	}
	pool, err := store.Open(ctx, appDSNFor(adminDSN))
	if err != nil {
		t.Fatalf("open tenant pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// TestCreatingAFarmFromTheAppLaunchesAndSeedsItsOwnStack walks the whole
// dedicated flow with stand-ins for GitHub and for the public address:
// POST /v1/farms with a slug dispatches provision-tenant, the watcher copies
// the farm into an empty stack, the owner logs in THERE with the password
// they already had, and the status the waiting screen polls says ready.
func TestCreatingAFarmFromTheAppLaunchesAndSeedsItsOwnStack(t *testing.T) {
	h := requireDB(t)
	slug := "prueba-url-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")

	// GitHub: records the repository_dispatch it receives.
	var mu sync.Mutex
	var dispatched []map[string]any
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/ojardila/bascula/dispatches" || r.Header.Get("Authorization") != "Bearer gh-test" {
			http.Error(w, "unexpected", http.StatusBadRequest)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		dispatched = append(dispatched, body)
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer gh.Close()

	// The farm's public address, once DNS and TLS are in place.
	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer public.Close()

	// The dedicated stack: its own empty database, its own signing key.
	uploads, _ := os.MkdirTemp("", "bascula-tenant-uploads-")
	defer os.RemoveAll(uploads)
	tcfg := httpapi.DefaultConfig()
	tcfg.UploadDir = uploads
	tcfg.TenantSlug = slug
	tenantAPI := httpapi.New(scratchTenantDB(t, h), auth.NewSigner([]byte("tenant-signing-key-0123456789abcdef"), "bascula"), tcfg)
	internal := httptest.NewServer(tenantAPI.InternalHandler())
	defer internal.Close()

	// The platform, with dedicated provisioning switched on.
	pcfg := httpapi.DefaultConfig()
	pcfg.UploadDir = uploads
	pcfg.MaxFarmsPerEmail = 3
	pcfg.SignupsPerIPPerHour = 1000
	pcfg.SignupsPerEmailPerHour = 1000
	pcfg.GitHubDispatchToken = "gh-test"
	pcfg.GitHubDispatchRepo = "ojardila/bascula"
	pcfg.GitHubAPIURL = gh.URL
	pcfg.TenantInternalURL = internal.URL
	pcfg.TenantPublicURL = public.URL
	pcfg.ProvisionPollEvery = 50 * time.Millisecond
	pcfg.ProvisionWatchFor = 20 * time.Second
	platform := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), pcfg)

	// Before: the address is free.
	free := call(t, platform, http.MethodGet, "/v1/farm-slugs?slug="+slug, "", nil)
	if free.Status != http.StatusOK || free.Body["available"] != true {
		t.Fatalf("slug should be available: %d %s", free.Status, free.Raw)
	}

	ownerEmail := signupWithSlug(t, platform, "La Palma de prueba", slug)

	// The dispatch names the slug, the owner and dedicated mode.
	waitFor(t, 5*time.Second, "provision-tenant dispatch", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(dispatched) > 0
	})
	mu.Lock()
	payload, _ := dispatched[0]["client_payload"].(map[string]any)
	eventType := dispatched[0]["event_type"]
	mu.Unlock()
	if eventType != "provision-tenant" || payload["slug"] != slug || payload["mode"] != "dedicated" ||
		payload["email"] != ownerEmail || payload["farmName"] != "La Palma de prueba" {
		t.Fatalf("dispatch payload = %v %v", eventType, payload)
	}

	// The watcher seeds the empty stack.
	waitFor(t, 15*time.Second, "tenant seeded", func() bool {
		res, err := http.Get(internal.URL + "/internal/tenant")
		if err != nil {
			return false
		}
		defer res.Body.Close()
		var info map[string]any
		_ = json.NewDecoder(res.Body).Decode(&info)
		return info["seeded"] == true
	})

	// The owner logs in on the new stack with the password they already had,
	// pinned to the farm by its slug.
	login := call(t, tenantAPI, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": ownerEmail, "password": "una-clave-larga-1", "farmSlug": slug,
	})
	if login.Status != http.StatusOK || login.Body["slug"] != slug {
		t.Fatalf("login on the dedicated stack: %d %s", login.Status, login.Raw)
	}
	farm := call(t, tenantAPI, http.MethodGet, "/v1/farm", mustString(t, login.Body, "accessToken"), nil)
	if farm.Status != http.StatusOK || farm.Body["name"] != "La Palma de prueba" {
		t.Fatalf("farm on the dedicated stack: %d %s", farm.Status, farm.Raw)
	}

	// First login on the dedicated stack: no tour row yet, so the web app
	// starts the owner tour; the price chosen on the platform arrives
	// confirmed, and progress saves on the database of the stack itself.
	tenantToken := mustString(t, login.Body, "accessToken")
	tours := call(t, tenantAPI, http.MethodGet, "/v1/me/tours", tenantToken, nil)
	if items, _ := tours.Body["items"].([]any); tours.Status != http.StatusOK || len(items) != 0 {
		t.Fatalf("tours on a fresh dedicated stack: %d %s", tours.Status, tours.Raw)
	}
	base := call(t, tenantAPI, http.MethodGet, "/v1/prices/base", tenantToken, nil)
	if base.Status != http.StatusOK || base.Body["confirmed"] != true || base.Body["currentCents"] != float64(90000) {
		t.Fatalf("base price on the dedicated stack: %d %s", base.Status, base.Raw)
	}
	saved := call(t, tenantAPI, http.MethodPut, "/v1/me/tours/owner", tenantToken, map[string]any{"step": 3, "status": "active"})
	if saved.Status != http.StatusOK {
		t.Fatalf("save tour on the dedicated stack: %d %s", saved.Status, saved.Raw)
	}

	// The waiting screen sees every step done.
	var status response
	waitFor(t, 10*time.Second, "provision status ready", func() bool {
		status = call(t, platform, http.MethodGet, "/v1/farms/"+slug+"/provision-status", "", nil)
		return status.Status == http.StatusOK && status.Body["ready"] == true
	})
	if status.Body["dedicated"] != true || status.Body["url"] != public.URL {
		t.Fatalf("status = %s", status.Raw)
	}

	// Now the address is taken, and a second seed is a no-op.
	taken := call(t, platform, http.MethodGet, "/v1/farm-slugs?slug="+slug, "", nil)
	if taken.Body["available"] != false || taken.Body["reason"] != "taken" {
		t.Fatalf("slug should be taken: %s", taken.Raw)
	}
	again, err := http.Post(internal.URL+"/internal/tenant/seed", "application/json",
		strings.NewReader(fmt.Sprintf(`{"farm":{"id":"%s","slug":"%s","name":"x"},"members":[{"id":"%s","email":"x@example.com","role":"owner","passwordHash":"x"}]}`,
			uuid.NewString(), slug, uuid.NewString())))
	if err != nil {
		t.Fatal(err)
	}
	again.Body.Close()
	if again.StatusCode != http.StatusOK {
		t.Fatalf("second seed: status %d, want 200 no-op", again.StatusCode)
	}

	// A stack refuses a farm that is not its own.
	other, err := http.Post(internal.URL+"/internal/tenant/seed", "application/json",
		strings.NewReader(`{"farm":{"id":"`+uuid.NewString()+`","slug":"otra-finca"},"members":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	other.Body.Close()
	if other.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign seed: status %d, want 403", other.StatusCode)
	}
}

// TestProvisionStatusAndSlugChecksWithoutDedicatedStacks: the shared server
// has no dispatch token, so a farm lives on the shared platform, the first two
// steps are done at once, and the answer turns on the public address alone.
func TestProvisionStatusAndSlugChecksWithoutDedicatedStacks(t *testing.T) {
	h := requireDB(t)

	missing := h.do(t, http.MethodGet, "/v1/farms/no-existe-"+uuid.NewString()[:6]+"/provision-status", "", nil)
	if missing.Status != http.StatusNotFound {
		t.Fatalf("unknown slug: %d %s", missing.Status, missing.Raw)
	}
	bad := h.do(t, http.MethodGet, "/v1/farms/NO_VALE/provision-status", "", nil)
	if bad.Status != http.StatusBadRequest {
		t.Fatalf("bad slug: %d %s", bad.Status, bad.Raw)
	}

	reserved := h.do(t, http.MethodGet, "/v1/farm-slugs?slug=admin", "", nil)
	if reserved.Body["available"] != false || reserved.Body["reason"] != "reserved" {
		t.Fatalf("reserved: %s", reserved.Raw)
	}
	invalid := h.do(t, http.MethodGet, "/v1/farm-slugs?slug=-x-", "", nil)
	if invalid.Body["available"] != false || invalid.Body["reason"] != "invalid" {
		t.Fatalf("invalid: %s", invalid.Raw)
	}

	slug := "compartida-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")
	signupWithSlug(t, h.server, "Compartida", slug)
	st := h.do(t, http.MethodGet, "/v1/farms/"+slug+"/provision-status", "", nil)
	if st.Status != http.StatusOK || st.Body["dedicated"] != false {
		t.Fatalf("status: %d %s", st.Status, st.Raw)
	}
	steps, _ := st.Body["steps"].([]any)
	if len(steps) != 3 {
		t.Fatalf("steps: %s", st.Raw)
	}
	for _, s := range steps[:2] {
		if m, _ := s.(map[string]any); m["done"] != true {
			t.Fatalf("shared farm step not done: %s", st.Raw)
		}
	}
}

func waitFor(t *testing.T, d time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// TestASecondFarmForTheSameAddressGetsItsOwnStackWithTheNewPassword: the same
// email registers a second farm at /empezar. The new farm is provisioned like
// any other, and its own stack is seeded with the name and password typed on
// THAT registration, so the owner signs in there with the password they just
// chose — while the main domain keeps the account's original password.
func TestASecondFarmForTheSameAddressGetsItsOwnStackWithTheNewPassword(t *testing.T) {
	h := requireDB(t)
	slug := "segunda-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")

	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer gh.Close()
	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer public.Close()

	uploads, _ := os.MkdirTemp("", "bascula-tenant-uploads-")
	defer os.RemoveAll(uploads)
	tcfg := httpapi.DefaultConfig()
	tcfg.UploadDir = uploads
	tcfg.TenantSlug = slug
	tenantAPI := httpapi.New(scratchTenantDB(t, h), auth.NewSigner([]byte("tenant-signing-key-0123456789abcdef"), "bascula"), tcfg)
	internal := httptest.NewServer(tenantAPI.InternalHandler())
	defer internal.Close()

	pcfg := httpapi.DefaultConfig()
	pcfg.UploadDir = uploads
	pcfg.SignupsPerIPPerHour = 1000
	pcfg.SignupsPerEmailPerHour = 1000
	pcfg.GitHubDispatchToken = "gh-test"
	pcfg.GitHubDispatchRepo = "ojardila/bascula"
	pcfg.GitHubAPIURL = gh.URL
	pcfg.TenantInternalURL = internal.URL
	pcfg.TenantPublicURL = public.URL
	pcfg.ProvisionPollEvery = 50 * time.Millisecond
	pcfg.ProvisionWatchFor = 20 * time.Second
	platform := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), pcfg)

	// The first farm lives on the shared platform only (no stack is serving
	// its slug in this test); what matters is that the address has an account.
	ownerEmail := signupWithSlug(t, platform, "Primera finca", "primera-"+uuid.NewString()[:6])

	const newPassword = "clave-de-la-segunda-finca"
	res := call(t, platform, http.MethodPost, "/v1/signup", "", map[string]any{
		"farm":  map[string]any{"name": "San José de prueba", "slug": slug},
		"owner": map[string]any{"email": ownerEmail, "name": "Dueña Segunda", "password": newPassword},
	})
	if res.Status != http.StatusCreated || res.Body["verificationRequired"] != false {
		t.Fatalf("second signup: %d %s", res.Status, res.Raw)
	}

	waitFor(t, 15*time.Second, "tenant seeded", func() bool {
		r, err := http.Get(internal.URL + "/internal/tenant")
		if err != nil {
			return false
		}
		defer r.Body.Close()
		var info map[string]any
		_ = json.NewDecoder(r.Body).Decode(&info)
		return info["seeded"] == true
	})

	login := call(t, tenantAPI, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": ownerEmail, "password": newPassword, "farmSlug": slug,
	})
	if login.Status != http.StatusOK || login.Body["slug"] != slug {
		t.Fatalf("login on the new stack with the new password: %d %s", login.Status, login.Raw)
	}
	me := call(t, tenantAPI, http.MethodGet, "/v1/me", mustString(t, login.Body, "accessToken"), nil)
	if me.Status != http.StatusOK || me.Body["name"] != "Dueña Segunda" {
		t.Fatalf("the new stack's owner is not who registered it: %d %s", me.Status, me.Raw)
	}
	old := call(t, tenantAPI, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": ownerEmail, "password": "una-clave-larga-1", "farmSlug": slug,
	})
	if old.Status != http.StatusUnauthorized {
		t.Fatalf("the account's other password opened the new stack: %d %s", old.Status, old.Raw)
	}

	// The main domain still signs the account in with its own password,
	// into either farm.
	main := call(t, platform, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": ownerEmail, "password": "una-clave-larga-1", "farmSlug": slug,
	})
	if main.Status != http.StatusOK || main.Body["slug"] != slug {
		t.Fatalf("main-domain login into the second farm: %d %s", main.Status, main.Raw)
	}
}
