package apitest

import (
	"context"
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
	"github.com/ojardila/bascula/services/api/internal/kube"
)

// fakeCluster is a stand-in Kubernetes API with the objects a farm stack
// grows, one by one, as Argo CD and the operators bring it up.
type fakeCluster struct {
	mu        sync.Mutex
	objects   map[string]any
	forbidden bool
	gets      []string
}

func (c *fakeCluster) set(path string, obj any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.objects[path] = obj
}

func (c *fakeCluster) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if r.Method != http.MethodGet {
		http.Error(w, "read-only", http.StatusMethodNotAllowed)
		return
	}
	c.gets = append(c.gets, r.URL.Path)
	if c.forbidden || r.Header.Get("Authorization") != "Bearer kube-test" {
		http.Error(w, `{"kind":"Status","code":403}`, http.StatusForbidden)
		return
	}
	obj, ok := c.objects[r.URL.Path]
	if !ok {
		http.Error(w, `{"kind":"Status","code":404}`, http.StatusNotFound)
		return
	}
	_ = json.NewEncoder(w).Encode(obj)
}

type stageView struct {
	Key, State string
}

func stagesOf(t *testing.T, st response) (map[string]string, float64) {
	t.Helper()
	raw, _ := st.Body["stages"].([]any)
	out := map[string]string{}
	for _, s := range raw {
		m, _ := s.(map[string]any)
		out[m["key"].(string)] = m["state"].(string)
	}
	p, _ := st.Body["percent"].(float64)
	return out, p
}

// TestProvisionProgressFollowsTheCluster: the waiting screen's stages come
// from GitHub Actions, then the cluster (Argo CD Application, namespace, CNPG,
// migrate Job, Deployments, HTTPRoute), then Cloudflare and the address. The
// percentage only grows, is never 100 before the farm is ready, and the
// current step is plain Spanish.
func TestProvisionProgressFollowsTheCluster(t *testing.T) {
	h := requireDB(t)
	slug := "progreso-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")
	ns := "/api/v1/namespaces/bascula-" + slug

	var mu sync.Mutex
	runStatus := "" // "", in_progress, completed
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.URL.Path == "/repos/ojardila/bascula/dispatches":
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == "/repos/ojardila/bascula/actions/workflows/provision-tenant.yml/runs":
			runs := []any{map[string]any{"display_title": "Provision tenant otra-finca", "status": "completed", "conclusion": "success"}}
			if runStatus != "" {
				conclusion := ""
				if runStatus == "completed" {
					conclusion = "success"
				}
				runs = append([]any{map[string]any{"display_title": "Provision tenant " + slug, "status": runStatus, "conclusion": conclusion}}, runs...)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"workflow_runs": runs})
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer gh.Close()

	cluster := &fakeCluster{objects: map[string]any{}}
	kapi := httptest.NewServer(cluster)
	defer kapi.Close()

	certActive := false
	cf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		ssl := "pending_validation"
		if certActive {
			ssl = "active"
		}
		view := map[string]any{"id": "h1", "hostname": "x", "status": "active", "ssl": map[string]any{"status": ssl}}
		var result any = view
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/custom_hostnames") {
			result = []any{view}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": result})
	}))
	defer cf.Close()

	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer public.Close()

	uploads, _ := os.MkdirTemp("", "bascula-progress-")
	defer os.RemoveAll(uploads)
	tcfg := httpapi.DefaultConfig()
	tcfg.UploadDir = uploads
	tcfg.TenantSlug = slug
	tenantAPI := httpapi.New(scratchTenantDB(t, h), auth.NewSigner([]byte("tenant-signing-key-0123456789abcdef"), "bascula"), tcfg)
	stackUp := false
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		up := stackUp
		mu.Unlock()
		if !up {
			http.Error(w, "no stack yet", http.StatusBadGateway)
			return
		}
		tenantAPI.InternalHandler().ServeHTTP(w, r)
	}))
	defer internal.Close()

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
	pcfg.ProvisionWatchFor = 60 * time.Second
	pcfg.CloudflareSaaSToken = "cf-test"
	pcfg.CloudflareZoneID = "zone-test"
	pcfg.CloudflareAPIURL = cf.URL
	pcfg.KubeClient = &kube.Client{BaseURL: kapi.URL, Token: "kube-test"}
	pcfg.ReconcileEvery = time.Hour
	platform := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), pcfg)

	signupWithSlug(t, platform, "Progreso", slug)

	last := -1.0
	get := func() (map[string]string, response) {
		time.Sleep(4100 * time.Millisecond) // past the per-slug status cache
		st := call(t, platform, http.MethodGet, "/v1/farms/"+slug+"/provision-status", "", nil)
		if st.Status != http.StatusOK {
			t.Fatalf("status: %d %s", st.Status, st.Raw)
		}
		stages, p := stagesOf(t, st)
		if p < last {
			t.Fatalf("percent went back: %v -> %v (%s)", last, p, st.Raw)
		}
		if st.Body["ready"] != true && p >= 100 {
			t.Fatalf("100%% before ready: %s", st.Raw)
		}
		if cur, _ := st.Body["current"].(string); cur == "" {
			t.Fatalf("no current step: %s", st.Raw)
		}
		last = p
		return stages, st
	}

	// Nothing yet but the request.
	stages, st := get()
	if stages["received"] != "done" || stages["pipeline_started"] != "active" || st.Body["source"] != "cluster" {
		t.Fatalf("start: %s", st.Raw)
	}
	if st.Body["ready"] == true {
		t.Fatal("ready at start")
	}

	// The pipeline runs, then finishes; Argo creates the Application.
	mu.Lock()
	runStatus = "in_progress"
	mu.Unlock()
	stages, st = get()
	if stages["pipeline_started"] != "done" || stages["pipeline_done"] == "done" {
		t.Fatalf("pipeline running: %s", st.Raw)
	}
	mu.Lock()
	runStatus = "completed"
	mu.Unlock()
	cluster.set("/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/bascula-"+slug,
		map[string]any{"status": map[string]any{"sync": map[string]any{"status": "OutOfSync"}}})
	stages, st = get()
	if stages["pipeline_done"] != "done" || stages["deployment"] != "active" {
		t.Fatalf("pipeline done: %s", st.Raw)
	}

	// Namespace and a database that is not healthy yet.
	cluster.set(ns, map[string]any{"status": map[string]any{"phase": "Active"}})
	cluster.set("/apis/postgresql.cnpg.io/v1/namespaces/bascula-"+slug+"/clusters/bascula-db",
		map[string]any{"spec": map[string]any{"instances": 1}, "status": map[string]any{"readyInstances": 0}})
	stages, st = get()
	if stages["namespace"] != "done" || stages["deployment"] != "done" || stages["database"] != "active" {
		t.Fatalf("namespace: %s", st.Raw)
	}
	if !strings.Contains(st.Body["current"].(string), "base de datos") {
		t.Fatalf("current should talk about the database: %s", st.Raw)
	}

	// Database healthy, migrations done, pods ready, route accepted.
	cluster.set("/apis/postgresql.cnpg.io/v1/namespaces/bascula-"+slug+"/clusters/bascula-db",
		map[string]any{"spec": map[string]any{"instances": 1}, "status": map[string]any{"readyInstances": 1}})
	cluster.set("/apis/batch/v1/namespaces/bascula-"+slug+"/jobs/bascula-migrate", map[string]any{"status": map[string]any{"succeeded": 1}})
	for _, d := range []string{"bascula-api", "bascula-web"} {
		cluster.set("/apis/apps/v1/namespaces/bascula-"+slug+"/deployments/"+d,
			map[string]any{"spec": map[string]any{"replicas": 1}, "status": map[string]any{"readyReplicas": 1}})
		cluster.set(ns+"/services/"+d, map[string]any{})
	}
	cluster.set("/apis/gateway.networking.k8s.io/v1/namespaces/bascula-"+slug+"/httproutes/bascula",
		map[string]any{"status": map[string]any{"parents": []any{map[string]any{"conditions": []any{map[string]any{"type": "Accepted", "status": "True"}}}}}})
	stages, st = get()
	for _, k := range []string{"database", "migrations", "pods", "route"} {
		if stages[k] != "done" {
			t.Fatalf("%s not done: %s", k, st.Raw)
		}
	}
	if stages["app"] == "done" || st.Body["ready"] == true {
		t.Fatalf("app/ready before the stack answered: %s", st.Raw)
	}

	// The stack answers and gets its farm; the certificate is still pending.
	mu.Lock()
	stackUp = true
	mu.Unlock()
	waitFor(t, 20*time.Second, "farm copied into the stack", func() bool {
		stages, st = get()
		return stages["app"] == "done"
	})
	if stages["certificate"] == "done" || stages["site"] == "done" || st.Body["ready"] == true {
		t.Fatalf("ready without certificate: %s", st.Raw)
	}

	// Certificate active: ready, 100 %.
	mu.Lock()
	certActive = true
	mu.Unlock()
	waitFor(t, 20*time.Second, "ready", func() bool {
		stages, st = get()
		return st.Body["ready"] == true
	})
	if p, _ := st.Body["percent"].(float64); p != 100 {
		t.Fatalf("ready but percent %v", p)
	}
	for k, v := range stages {
		if v != "done" {
			t.Fatalf("ready with %s %s", k, v)
		}
	}
}

// TestProvisionProgressFallsBackWithoutCluster: when the cluster cannot be
// read, progress comes from GitHub Actions and the stack's own answer, and the
// screen gets a plain note instead of an error.
func TestProvisionProgressFallsBackWithoutCluster(t *testing.T) {
	h := requireDB(t)
	slug := "sincluster-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/runs") {
			_ = json.NewEncoder(w).Encode(map[string]any{"workflow_runs": []any{
				map[string]any{"display_title": "Provision tenant " + slug, "status": "in_progress"}}})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer gh.Close()
	cluster := &fakeCluster{objects: map[string]any{}, forbidden: true}
	kapi := httptest.NewServer(cluster)
	defer kapi.Close()
	public := httptest.NewServer(http.NotFoundHandler())
	defer public.Close()

	pcfg := httpapi.DefaultConfig()
	pcfg.UploadDir = t.TempDir()
	pcfg.MaxFarmsPerEmail = 3
	pcfg.SignupsPerIPPerHour = 1000
	pcfg.SignupsPerEmailPerHour = 1000
	pcfg.GitHubDispatchToken = "gh-test"
	pcfg.GitHubDispatchRepo = "ojardila/bascula"
	pcfg.GitHubAPIURL = gh.URL
	pcfg.TenantInternalURL = "http://127.0.0.1:1"
	pcfg.TenantPublicURL = public.URL
	pcfg.KubeClient = &kube.Client{BaseURL: kapi.URL, Token: "kube-test"}
	pcfg.ReconcileEvery = time.Hour
	platform := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), pcfg)
	signupWithSlug(t, platform, "Sin cluster", slug)

	st := call(t, platform, http.MethodGet, "/v1/farms/"+slug+"/provision-status", "", nil)
	stages, p := stagesOf(t, st)
	if st.Body["source"] != "pipeline" || st.Body["note"] == nil || st.Body["note"] == "" {
		t.Fatalf("fallback not announced: %s", st.Raw)
	}
	if stages["pipeline_started"] != "done" || stages["pipeline_done"] == "done" || p <= 0 || p >= 100 {
		t.Fatalf("fallback stages: %s", st.Raw)
	}
	if strings.Contains(st.Raw, "403") || strings.Contains(strings.ToLower(st.Raw), "forbidden") {
		t.Fatalf("internal details leaked: %s", st.Raw)
	}
}

// TestReconcileCreatesMissingFarmHostnames: a farm namespace nobody asked a
// certificate for (made by hand, before certificates existed, a lost
// watcher) gets its custom hostname from the periodic sweep. Reserved names
// such as bascula-dev are not farms.
func TestReconcileCreatesMissingFarmHostnames(t *testing.T) {
	h := requireDB(t)
	var mu sync.Mutex
	created := map[string]bool{}
	cf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/custom_hostnames") {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": []any{}})
			return
		}
		if r.Method == http.MethodPost {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			created[body["hostname"].(string)] = true
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": map[string]any{"id": "h", "status": "active", "ssl": map[string]any{"status": "active"}}})
	}))
	defer cf.Close()
	cluster := &fakeCluster{objects: map[string]any{
		"/api/v1/namespaces": map[string]any{"items": []any{
			map[string]any{"metadata": map[string]any{"name": "bascula"}, "status": map[string]any{"phase": "Active"}},
			map[string]any{"metadata": map[string]any{"name": "bascula-dev"}, "status": map[string]any{"phase": "Active"}},
			map[string]any{"metadata": map[string]any{"name": "bascula-olvidada"}, "status": map[string]any{"phase": "Active"}},
			map[string]any{"metadata": map[string]any{"name": "bascula-borrandose"}, "status": map[string]any{"phase": "Terminating"}},
			map[string]any{"metadata": map[string]any{"name": "otra-app"}, "status": map[string]any{"phase": "Active"}},
		}},
	}}
	kapi := httptest.NewServer(cluster)
	defer kapi.Close()

	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = t.TempDir()
	cfg.CloudflareSaaSToken = "cf-test"
	cfg.CloudflareZoneID = "zone-test"
	cfg.CloudflareAPIURL = cf.URL
	cfg.ProvisionPollEvery = 20 * time.Millisecond
	cfg.KubeClient = &kube.Client{BaseURL: kapi.URL, Token: "kube-test"}
	cfg.ReconcileEvery = time.Hour
	srv := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)

	if n := srv.ReconcileFarmHostnamesOnce(context.Background()); n != 1 {
		t.Fatalf("reconcile started %d watchers, want 1", n)
	}
	waitFor(t, 5*time.Second, "hostname created", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return created["olvidada.bascula.engp.io"]
	})
	mu.Lock()
	defer mu.Unlock()
	if len(created) != 1 {
		t.Fatalf("created = %v, want only olvidada", created)
	}
}
