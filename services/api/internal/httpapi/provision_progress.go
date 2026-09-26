package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ojardila/bascula/services/api/internal/kube"
)

// Real progress for «Preparando su finca».
//
// The waiting screen used to show four coarse steps. It now shows weighted,
// monotonic stages read from where the truth is: the cluster itself (read-only,
// through the API's own ServiceAccount; see manifests/cluster/
// bascula-provision-reader.yaml), GitHub Actions for the part before the
// cluster knows anything, Cloudflare for the certificate, and a strictly
// verified HTTPS request for the address. When the cluster cannot be read the
// screen falls back to GitHub Actions and the farm stack's own answer, and
// says so in plain words.

type provisionStage struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	State  string `json:"state"` // done | active | pending
	Weight int    `json:"weight"`
	// DoneAfterSeconds is when, counted from the farm's creation, this
	// process first saw the stage done.
	DoneAfterSeconds *int64 `json:"doneAfterSeconds,omitempty"`
}

type stageDef struct {
	key, label, doing string
	weight            int
}

// Dedicated farm stack, in order. Weights add up to 100 and roughly follow
// how long each part takes.
var dedicatedStages = []stageDef{
	{"received", "Solicitud recibida", "Recibimos su solicitud.", 2},
	{"pipeline_started", "Preparación iniciada", "Estamos iniciando la preparación de su finca.", 5},
	{"pipeline_done", "Preparación registrada", "Estamos registrando su finca en nuestro sistema.", 8},
	{"deployment", "Instalación en marcha", "Estamos instalando los programas de su finca.", 10},
	{"namespace", "Espacio propio", "Estamos creando el espacio propio de su finca.", 5},
	{"database", "Base de datos", "Estamos creando la base de datos exclusiva de su finca.", 20},
	{"migrations", "Tablas de datos", "Estamos preparando las tablas donde se guardan sus datos.", 10},
	{"pods", "Aplicación encendida", "Estamos encendiendo la aplicación de su finca.", 15},
	{"route", "Dirección conectada", "Estamos conectando su dirección web con la aplicación.", 5},
	{"app", "Su usuario", "Estamos copiando su finca, su usuario y su clave.", 5},
	{"certificate", "Conexión segura", "Estamos preparando el candado de seguridad de su dirección.", 10},
	{"site", "Dirección abierta", "Estamos comprobando que su dirección abre de forma segura.", 5},
}

// Shared platform only (no dedicated stacks): the farm works from the first
// second; only its address needs its certificate.
var sharedStages = []stageDef{
	{"received", "Solicitud recibida", "Recibimos su solicitud.", 10},
	{"certificate", "Conexión segura", "Estamos preparando el candado de seguridad de su dirección.", 60},
	{"site", "Dirección abierta", "Estamos comprobando que su dirección abre de forma segura.", 30},
}

// chainLen is how many leading dedicatedStages form one chain: when a later
// one is seen done, every earlier one is done too (a namespace exists only
// after the pipeline ran, and so on). The farm copied into its stack (app),
// the certificate and the site are independent of the chain and each other.
const chainLen = 9

const noteNoCluster = "No podemos ver todos los detalles en este momento; le mostramos el avance que sí conocemos. Su finca sigue preparándose."

// clusterView is what the cluster says about one farm stack.
type clusterView struct {
	Readable   bool
	AppExists  bool
	AppSynced  bool
	Namespace  bool
	Database   bool
	Migrations bool
	Pods       bool
	Route      bool
}

func (s *Server) kubeClient() *kube.Client { return s.cfg.KubeClient }

func (s *Server) argoNamespace() string {
	if s.cfg.ArgoNamespace != "" {
		return s.cfg.ArgoNamespace
	}
	return "argocd"
}

// readCluster reads the farm's Argo CD Application and its namespace
// bascula-{slug}: CNPG Cluster, migrate Job, API/web Deployments, Services
// and HTTPRoute. Read-only GETs. Readable is false when the namespace cannot
// be read at all (no client, forbidden, API server unreachable).
func (s *Server) readCluster(ctx context.Context, slug string) clusterView {
	var v clusterView
	c := s.kubeClient()
	if c == nil {
		return v
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	ns := "bascula-" + slug

	var nsObj struct {
		Status struct {
			Phase string `json:"phase"`
		} `json:"status"`
	}
	switch err := c.Get(ctx, "/api/v1/namespaces/"+ns, &nsObj); {
	case err == nil:
		v.Readable = true
		v.Namespace = nsObj.Status.Phase == "Active"
	case errors.Is(err, kube.ErrNotFound):
		v.Readable = true
	default:
		return v
	}

	var app struct {
		Status struct {
			Sync struct {
				Status string `json:"status"`
			} `json:"sync"`
			OperationState struct {
				Phase string `json:"phase"`
			} `json:"operationState"`
		} `json:"status"`
	}
	if err := c.Get(ctx, "/apis/argoproj.io/v1alpha1/namespaces/"+s.argoNamespace()+"/applications/bascula-"+slug, &app); err == nil {
		v.AppExists = true
		v.AppSynced = app.Status.Sync.Status == "Synced" || app.Status.OperationState.Phase == "Succeeded"
	}
	if !v.Namespace {
		return v
	}

	var db struct {
		Spec struct {
			Instances int `json:"instances"`
		} `json:"spec"`
		Status struct {
			ReadyInstances int `json:"readyInstances"`
		} `json:"status"`
	}
	if err := c.Get(ctx, "/apis/postgresql.cnpg.io/v1/namespaces/"+ns+"/clusters/bascula-db", &db); err == nil {
		v.Database = db.Spec.Instances > 0 && db.Status.ReadyInstances >= db.Spec.Instances
	}

	var job struct {
		Status struct {
			Succeeded int `json:"succeeded"`
		} `json:"status"`
	}
	if err := c.Get(ctx, "/apis/batch/v1/namespaces/"+ns+"/jobs/bascula-migrate", &job); err == nil {
		v.Migrations = job.Status.Succeeded > 0
	}

	ready := func(name string) bool {
		var d struct {
			Spec struct {
				Replicas *int `json:"replicas"`
			} `json:"spec"`
			Status struct {
				ReadyReplicas int `json:"readyReplicas"`
			} `json:"status"`
		}
		if err := c.Get(ctx, "/apis/apps/v1/namespaces/"+ns+"/deployments/"+name, &d); err != nil {
			return false
		}
		want := 1
		if d.Spec.Replicas != nil {
			want = *d.Spec.Replicas
		}
		return want > 0 && d.Status.ReadyReplicas >= want
	}
	v.Pods = ready("bascula-api") && ready("bascula-web")

	var route struct {
		Status struct {
			Parents []struct {
				Conditions []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
				} `json:"conditions"`
			} `json:"parents"`
		} `json:"status"`
	}
	if err := c.Get(ctx, "/apis/gateway.networking.k8s.io/v1/namespaces/"+ns+"/httproutes/bascula", &route); err == nil {
		for _, p := range route.Status.Parents {
			for _, cond := range p.Conditions {
				if cond.Type == "Accepted" && cond.Status == "True" {
					v.Route = true
				}
			}
		}
	}
	if v.Route {
		var svc struct{}
		for _, name := range []string{"bascula-api", "bascula-web"} {
			if err := c.Get(ctx, "/api/v1/namespaces/"+ns+"/services/"+name, &svc); err != nil {
				v.Route = false
			}
		}
	}
	return v
}

// pipelineView is the provision-tenant workflow run for the farm.
type pipelineView struct {
	Known     bool // GitHub answered
	Started   bool
	Done      bool
	Failed    bool
	checkedAt time.Time
}

// readPipeline finds the provision-tenant run for this slug (its run-name is
// "Provision tenant {slug}") created after the farm, cached for 4 s.
func (s *Server) readPipeline(ctx context.Context, slug string, createdAt time.Time) pipelineView {
	if !s.dedicatedProvisioning() {
		return pipelineView{}
	}
	s.prov.mu.Lock()
	if p, ok := s.prov.pipelines[slug]; ok && time.Since(p.checkedAt) < 4*time.Second {
		s.prov.mu.Unlock()
		return p
	}
	s.prov.mu.Unlock()

	api := strings.TrimRight(s.cfg.GitHubAPIURL, "/")
	if api == "" {
		api = "https://api.github.com"
	}
	since := createdAt.Add(-2 * time.Minute).UTC().Format("2006-01-02T15:04:05Z")
	u := fmt.Sprintf("%s/repos/%s/actions/workflows/provision-tenant.yml/runs?per_page=30&created=%s",
		api, strings.TrimSpace(s.cfg.GitHubDispatchRepo), url.QueryEscape(">="+since))
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var p pipelineView
	if req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil); err == nil {
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(s.cfg.GitHubDispatchToken))
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		if res, err := http.DefaultClient.Do(req); err == nil {
			var body struct {
				Runs []struct {
					DisplayTitle string `json:"display_title"`
					Status       string `json:"status"`
					Conclusion   string `json:"conclusion"`
				} `json:"workflow_runs"`
			}
			if res.StatusCode == http.StatusOK && json.NewDecoder(res.Body).Decode(&body) == nil {
				p.Known = true
				want := "provision tenant " + slug
				for _, r := range body.Runs {
					if strings.ToLower(strings.TrimSpace(r.DisplayTitle)) != want {
						continue
					}
					p.Started = true
					if r.Status == "completed" {
						p.Done = r.Conclusion == "success"
						p.Failed = r.Conclusion != "success"
					}
					break // newest first
				}
			}
			_ = res.Body.Close()
		}
	}
	p.checkedAt = time.Now()
	s.prov.mu.Lock()
	s.prov.pipelines[slug] = p
	s.prov.mu.Unlock()
	return p
}

// stageMemory keeps what this process has seen per slug, so stages never go
// back and the percentage only grows.
type stageMemory struct {
	doneAt  map[string]time.Time
	percent int
}

func (s *Server) stageSeen(slug, key string) bool {
	s.prov.mu.Lock()
	defer s.prov.mu.Unlock()
	if m, ok := s.prov.stages[slug]; ok {
		_, seen := m.doneAt[key]
		return seen
	}
	return false
}

// fillStages turns the raw signals into the stage list, percent, current
// step and source of the status. st.Ready must already hold the gate's verdict.
func (s *Server) fillStages(ctx context.Context, st *provisionStatus, createdAt time.Time,
	database, app, certificate, web bool) {
	slug := st.Slug
	done := map[string]bool{"received": true}
	defs := sharedStages
	if st.Dedicated {
		defs = dedicatedStages
		cv := s.readCluster(ctx, slug)
		// GitHub is asked only until the pipeline is known to be done.
		var pv pipelineView
		if !s.stageSeen(slug, "pipeline_done") {
			pv = s.readPipeline(ctx, slug, createdAt)
		}
		done["pipeline_started"] = pv.Started
		done["pipeline_done"] = pv.Done
		done["app"] = app
		if cv.Readable {
			st.Source = "cluster"
			done["deployment"] = cv.AppSynced
			done["namespace"] = cv.Namespace
			done["database"] = cv.Database
			done["migrations"] = cv.Migrations
			done["pods"] = cv.Pods
			done["route"] = cv.Route
			if cv.AppExists {
				done["pipeline_started"], done["pipeline_done"] = true, true
			}
		} else {
			// Fallback: the stack's own answer covers the database; the
			// app answering means migrations ran and its pods are up.
			st.Note = noteNoCluster
			st.Source = "basic"
			if pv.Known {
				st.Source = "pipeline"
			}
			done["database"] = database
			done["migrations"] = app
			done["pods"] = app
			done["route"] = app && web
		}
		done["site"] = web && certificate && done["route"] && done["pods"]
	} else {
		st.Source = "basic"
		done["site"] = web && certificate
	}
	done["certificate"] = certificate
	if st.Ready {
		for _, d := range defs {
			done[d.key] = true
		}
	}

	// A later link of the chain implies every earlier one.
	if st.Dedicated {
		for i := chainLen - 1; i > 0; i-- {
			if done[defs[i].key] {
				for j := 0; j < i; j++ {
					done[defs[j].key] = true
				}
				break
			}
		}
	}

	now := time.Now()
	s.prov.mu.Lock()
	mem, ok := s.prov.stages[slug]
	if !ok {
		mem = &stageMemory{doneAt: map[string]time.Time{}}
		s.prov.stages[slug] = mem
	}
	var newly []string
	for _, d := range defs {
		if done[d.key] {
			if _, seen := mem.doneAt[d.key]; !seen {
				mem.doneAt[d.key] = now
				newly = append(newly, d.key)
			}
		} else if _, seen := mem.doneAt[d.key]; seen {
			done[d.key] = true // never go back
		}
	}
	percent := 0
	st.Stages = make([]provisionStage, 0, len(defs))
	active := false
	for _, d := range defs {
		ps := provisionStage{Key: d.key, Label: d.label, Weight: d.weight, State: "pending"}
		if done[d.key] {
			ps.State = "done"
			percent += d.weight
			secs := int64(mem.doneAt[d.key].Sub(createdAt).Seconds())
			if secs < 0 {
				secs = 0
			}
			ps.DoneAfterSeconds = &secs
		} else if !active {
			ps.State = "active"
			active = true
			st.Current = d.doing
		}
		st.Stages = append(st.Stages, ps)
	}
	if !st.Ready && percent >= 100 {
		percent = 99 // everything seen but the gate says no: never claim 100
		if st.Current == "" {
			st.Current = "Estamos haciendo la última comprobación de seguridad."
		}
	}
	if percent < mem.percent {
		percent = mem.percent
	}
	mem.percent = percent
	s.prov.mu.Unlock()
	st.Percent = percent
	if st.Ready {
		st.Percent = 100
		st.Current = "¡Su finca está lista!"
	}
	for _, k := range newly {
		slog.Info("provision stage done", "slug", slug, "stage", k,
			"afterSeconds", int64(now.Sub(createdAt).Seconds()))
	}
}

// reconcileFarmHostnames makes sure every dedicated farm namespace
// (bascula-{slug}) has its Cloudflare custom hostname, whatever happened at
// signup: a farm made before certificates existed, a pod restarted mid-way,
// a Cloudflare error, a stack created by hand. Runs shortly after start and
// then every ReconcileEvery.
func (s *Server) reconcileFarmHostnames(ctx context.Context) {
	if s.kubeClient() == nil || !s.farmCertificates() {
		return
	}
	every := s.cfg.ReconcileEvery
	if every <= 0 {
		every = 10 * time.Minute
	}
	t := time.NewTimer(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		s.ReconcileFarmHostnamesOnce(ctx)
		t.Reset(every)
	}
}

// ReconcileFarmHostnamesOnce is one pass: list namespaces, and for every
// active bascula-{slug} whose certificate this process has not seen active,
// (re)start the certificate watcher, which creates the custom hostname if
// it is missing. Exported for tests.
func (s *Server) ReconcileFarmHostnamesOnce(ctx context.Context) int {
	c := s.kubeClient()
	if c == nil || !s.farmCertificates() {
		return 0
	}
	rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				Phase string `json:"phase"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := c.Get(rctx, "/api/v1/namespaces", &list); err != nil {
		slog.Warn("farm hostname reconcile: list namespaces", "err", err)
		return 0
	}
	n := 0
	for _, it := range list.Items {
		name := it.Metadata.Name
		if !strings.HasPrefix(name, "bascula-") || it.Status.Phase != "Active" {
			continue
		}
		slug, err := normalizeFarmSlug(strings.TrimPrefix(name, "bascula-"))
		if err != nil {
			continue // bascula-dev and other reserved names are not farms
		}
		if cs := s.certStateOf(slug); cs.Active || cs.Watching {
			continue
		}
		s.ensureFarmCertificate(slug)
		n++
	}
	if n > 0 {
		slog.Info("farm hostname reconcile", "started", n)
	}
	return n
}
