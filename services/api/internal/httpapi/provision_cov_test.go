package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/kube"
	"github.com/ojardila/bascula/services/api/internal/mailer"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// cpvMailer records what it is asked to send, and fails when told to.
type cpvMailer struct {
	mu   sync.Mutex
	sent []mailer.Message
	fail atomic.Bool
}

func (m *cpvMailer) Send(_ context.Context, msg mailer.Message) error {
	if m.fail.Load() {
		return errors.New("smtp is down")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, msg)
	return nil
}

func (m *cpvMailer) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sent)
}

func cpvServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	cfg.UploadDir = t.TempDir()
	return New(nil, auth.NewSigner([]byte("cpv-signing-key"), "bascula"), cfg)
}

func cpvWait(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ---------------------------------------------------------------------------
// notices.go
// ---------------------------------------------------------------------------

func TestCpvNoticeMessages(t *testing.T) {
	type tc struct {
		name    string
		msg     mailer.Message
		to      string
		subject string
		body    []string
	}
	cases := []tc{
		{"reset", passwordResetMessage("a@x.co", "Ana", "https://l/1"), "a@x.co", "Cambiar su clave de Báscula",
			[]string{"Hola, Ana:", "https://l/1", "30 minutos", "Báscula\n"}},
		{"reset no name", passwordResetMessage("a@x.co", "  ", "https://l/1"), "a@x.co", "Cambiar su clave de Báscula",
			[]string{"Hola,\n"}},
		{"verify", verifyEmailMessage("b@x.co", "Beto", "La Ceiba", "https://l/2"), "b@x.co",
			"Confirme su correo para crear su finca", []string{"Hola, Beto:", "«La Ceiba»", "https://l/2", "48 horas"}},
		{"registered", farmRegisteredNoticeMessage("c@x.co", "", "El Roble"), "c@x.co",
			"Se registró una finca con su correo", []string{"Hola,\n", "«El Roble»"}},
		{"pw changed all", passwordChangedMessage("d@x.co", "Dora", ""), "d@x.co", "Su clave cambió",
			[]string{"Hola, Dora:", "Su clave de Báscula cambió."}},
		{"pw changed farm", passwordChangedMessage("d@x.co", "Dora", " El Roble "), "d@x.co", "Su clave cambió",
			[]string{"Su clave para entrar a El Roble cambió."}},
		{"assistant rw", assistantConnectedMessage("e@x.co", "Eva", "ChatGPT", "El Roble", false), "e@x.co",
			"ChatGPT se conectó a su finca", []string{"ChatGPT se conectó a la finca El Roble", "puede consultar y registrar datos"}},
		{"assistant ro unnamed", assistantConnectedMessage("e@x.co", "Eva", " ", "El Roble", true), "e@x.co",
			"Un asistente se conectó a su finca", []string{"Un asistente se conectó", "puede consultar datos en su nombre"}},
		{"role owner", roleRaisedMessage("f@x.co", "El Roble", "Gil", domain.RoleOwner, "Ana"), "f@x.co",
			"Gil ahora es dueño de El Roble", []string{"Gil ahora es dueño de la finca El Roble. Lo hizo Ana."}},
		{"role admin", roleRaisedMessage("f@x.co", "El Roble", "Gil", domain.RoleAdmin, "Ana"), "f@x.co",
			"Gil ahora es administrador de El Roble", []string{"administrador de la finca El Roble"}},
		{"access weigher", farmAccessGrantedMessage("g@x.co", "Gil", "El Roble", domain.RoleWeigher), "g@x.co",
			"Le dieron acceso a la finca El Roble", []string{"Hola, Gil:", "«El Roble»", "como pesador", "no se envía por correo"}},
		{"access owner", farmAccessGrantedMessage("g@x.co", "", "El Roble", domain.RoleOwner), "g@x.co",
			"Le dieron acceso a la finca El Roble", []string{"como dueño"}},
		{"access admin", farmAccessGrantedMessage("g@x.co", "", "El Roble", domain.RoleAdmin), "g@x.co",
			"Le dieron acceso a la finca El Roble", []string{"como administrador"}},
		{"passkey added", passkeyAddedMessage("h@x.co", "Hugo", "iPhone"), "h@x.co", "Se agregó una llave de acceso",
			[]string{"Hola, Hugo:", "«iPhone»"}},
		{"passkey removed", passkeyRemovedMessage("h@x.co", ""), "h@x.co", "Se quitó una llave de acceso",
			[]string{"Hola,\n", "Su clave sigue sirviendo igual."}},
	}
	for _, c := range cases {
		if c.msg.To != c.to || c.msg.Subject != c.subject {
			t.Errorf("%s: to=%q subject=%q", c.name, c.msg.To, c.msg.Subject)
		}
		for _, want := range c.body {
			if !strings.Contains(c.msg.Body, want) {
				t.Errorf("%s: body lacks %q:\n%s", c.name, want, c.msg.Body)
			}
		}
		if !strings.HasSuffix(c.msg.Body, noticeSignature) {
			t.Errorf("%s: body not signed:\n%s", c.name, c.msg.Body)
		}
	}
}

func TestCpvMailLaterWithoutMailerOrAddress(t *testing.T) {
	mail := &cpvMailer{}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	// No request transaction here, so even a scheduled send would not run;
	// these return before scheduling anything.
	cpvServer(t, Config{Mailer: mail}).mailLater(r, mailer.Message{To: "  ", Subject: "x"})
	cpvServer(t, Config{}).mailLater(r, mailer.Message{To: "a@x.co"})
	if mail.count() != 0 {
		t.Fatalf("sent %d", mail.count())
	}
}

// The role and access notices read who to tell from the request
// transaction; when it fails they log and send nothing.
func TestCpvNoticesWithABrokenTransaction(t *testing.T) {
	mail := &cpvMailer{}
	s := cpvServer(t, Config{Mailer: mail, PublicBaseURL: "https://bascula.example.com"})
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{UserID: "u", FarmID: "f", Role: domain.RoleOwner})
	r := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
	s.noticeRoleRaised(r, brokenTx{}, "a@x.co", "A", domain.RoleOwner)
	s.noticeFarmAccessGranted(r, brokenTx{}, "a@x.co", "A", domain.RoleWeigher)
	s.noticeFarmAccessGranted(httptest.NewRequest(http.MethodGet, "/", nil), brokenTx{}, "a@x.co", "A", domain.RoleWeigher)
	if mail.count() != 0 {
		t.Fatalf("sent %d", mail.count())
	}
}

func TestCpvNoticesSkipWithoutMailerRoleOrCaller(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	// No mailer: nothing, not even a look at the transaction.
	cpvServer(t, Config{}).noticeRoleRaised(r, nil, "a@x.co", "A", domain.RoleOwner)
	mail := &cpvMailer{}
	s := cpvServer(t, Config{Mailer: mail})
	// A weigher is not worth a notice.
	s.noticeRoleRaised(r, nil, "a@x.co", "A", domain.RoleWeigher)
	// No caller on the request.
	s.noticeRoleRaised(r, nil, "a@x.co", "A", domain.RoleAdmin)
	// Access notices need the reset door and a caller.
	cpvServer(t, Config{}).noticeFarmAccessGranted(r, nil, "a@x.co", "A", domain.RoleWeigher)
	if mail.count() != 0 {
		t.Fatalf("sent %d", mail.count())
	}
}

// ---------------------------------------------------------------------------
// ready_email.go
// ---------------------------------------------------------------------------

func TestCpvReadyEmailMessage(t *testing.T) {
	m := readyEmailMessage("o@x.co", " Olga ", " La Ceiba ", "https://la-ceiba.example.com/")
	if m.To != "o@x.co" || m.Subject != "Su finca ya está lista" {
		t.Fatalf("%+v", m)
	}
	for _, want := range []string{"Hola, Olga:", "Su finca La Ceiba ya está lista", "https://la-ceiba.example.com/entrar\n"} {
		if !strings.Contains(m.Body, want) {
			t.Fatalf("body lacks %q:\n%s", want, m.Body)
		}
	}
	anon := readyEmailMessage("o@x.co", "", "  ", "https://x")
	if !strings.HasPrefix(anon.Body, "Hola,\n") || !strings.Contains(anon.Body, "Su finca su finca ya") {
		t.Fatalf("anonymous body:\n%s", anon.Body)
	}
}

func TestCpvReadyEmailUnavailable(t *testing.T) {
	// No mailer, and a dedicated stack with one: neither offers the notice.
	for _, cfg := range []Config{{}, {Mailer: &cpvMailer{}, TenantSlug: "la-ceiba"}} {
		s := cpvServer(t, cfg)
		if s.readyEmailAvailable() {
			t.Fatalf("available with %+v", cfg)
		}
		req, sent := s.readyEmailState(context.Background(), "la-ceiba")
		if req || sent {
			t.Fatal("state without a mailer")
		}
		s.sendReadyEmail(context.Background(), "la-ceiba", "https://x")
		s.watchReadyEmail("la-ceiba", time.Now())
		s.ResumeReadyEmails(context.Background())
		res := httptest.NewRecorder()
		s.handleRequestReadyEmail(res, httptest.NewRequest(http.MethodPost, "/v1/farms/la-ceiba/ready-email", nil))
		if res.Code != http.StatusNotFound {
			t.Fatalf("POST ready-email: %d %s", res.Code, res.Body)
		}
	}
	// With a mailer, an empty slug starts no watcher.
	s := cpvServer(t, Config{Mailer: &cpvMailer{}})
	s.watchReadyEmail("", time.Now())
	if len(s.prov.emailing) != 0 {
		t.Fatal("watcher for an empty slug")
	}
}

func TestCpvReadyEmailWatcherGivesUpAndIsSingle(t *testing.T) {
	s := cpvServer(t, Config{Mailer: &cpvMailer{}, TenantPublicURL: "http://127.0.0.1:1",
		ProvisionPollEvery: 10 * time.Millisecond})
	// Already watching: the second call returns at once.
	s.prov.emailing["dup"] = true
	s.watchReadyEmail("dup", time.Now())
	if !s.prov.emailing["dup"] {
		t.Fatal("the existing watcher was dropped")
	}
	// Past its budget: the watcher never finds it ready and lets go.
	s.watchReadyEmail("tarde", time.Now().Add(-s.provisionWatchFor()+100*time.Millisecond))
	cpvWait(t, "watcher released", func() bool {
		s.prov.mu.Lock()
		defer s.prov.mu.Unlock()
		return !s.prov.emailing["tarde"]
	})
}

// ---------------------------------------------------------------------------
// provision.go
// ---------------------------------------------------------------------------

func TestCpvProvisionDefaults(t *testing.T) {
	s := cpvServer(t, Config{})
	if got := s.tenantInternalURL("la-ceiba"); got != "http://bascula-api.bascula-la-ceiba.svc.cluster.local:8081" {
		t.Fatalf("internal url %q", got)
	}
	if got := s.tenantPublicURL("la-ceiba"); got != "https://la-ceiba.bascula.engp.io" {
		t.Fatalf("public url %q", got)
	}
	if got := expandSlugTemplate("http://one-stand-in/", "x"); got != "http://one-stand-in" {
		t.Fatalf("template without %%s: %q", got)
	}
	if s.provisionWatchFor() != 45*time.Minute || s.provisionSlowAfter() != 15*time.Minute {
		t.Fatal("default durations")
	}
	if provisionStatusTTL(provisionStatus{Ready: true}) != time.Minute || provisionStatusTTL(provisionStatus{}) != 4*time.Second {
		t.Fatal("status ttl")
	}
	if s.dedicatedProvisioning() {
		t.Fatal("dedicated without a token")
	}
	if c := strictProbeClient(); c.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("probe client follows redirects")
	}
	// Without dedicated provisioning nothing is watched or dispatched.
	s.watchTenant("la-ceiba")
	s.kickTenantProvision(tenantProvision{Slug: "la-ceiba"})
	if len(s.prov.watching) != 0 {
		t.Fatal("watching without dedicated provisioning")
	}
}

func TestCpvKickTenantProvisionReportsGitHubFailures(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	var hits atomic.Int32
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		bodies = append(bodies, body)
		mu.Unlock()
		if r.URL.Path != "/repos/o/gitops/dispatches" || r.Header.Get("Authorization") != "Bearer tok" ||
			r.Header.Get("X-GitHub-Api-Version") != "2022-11-28" {
			http.Error(w, "unexpected", http.StatusBadRequest)
			return
		}
		hits.Add(1)
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer gh.Close()
	stack := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer stack.Close()
	s := cpvServer(t, Config{GitHubDispatchToken: " tok ", GitHubDispatchRepo: " o/gitops ", GitHubAPIURL: gh.URL + "/",
		TenantInternalURL: stack.URL, ProvisionPollEvery: 10 * time.Millisecond, ProvisionWatchFor: 60 * time.Millisecond})
	s.kickTenantProvision(tenantProvision{Slug: "la-ceiba", FarmName: "La\nCeiba", Email: " O@X.co ",
		OwnerName: "Olga\tR", Phone: "+57 300\n"})
	cpvWait(t, "dispatch", func() bool { return hits.Load() == 1 })
	mu.Lock()
	payload, _ := bodies[0]["client_payload"].(map[string]any)
	ev := bodies[0]["event_type"]
	mu.Unlock()
	if ev != "provision-tenant" || payload["slug"] != "la-ceiba" || payload["mode"] != "dedicated" ||
		payload["ref"] != s.provisionRunRef("la-ceiba") {
		t.Fatalf("dispatch = %v %v", ev, payload)
	}
	for _, k := range []string{"farmName", "ownerName", "email", "phone"} {
		if v, _ := payload[k].(string); strings.ContainsAny(v, "\n\t") {
			t.Fatalf("%s not sanitized: %q", k, v)
		}
	}
	// The watcher it started gives up once its budget is spent.
	cpvWait(t, "watcher released", func() bool {
		s.prov.mu.Lock()
		defer s.prov.mu.Unlock()
		return !s.prov.watching["la-ceiba"]
	})

	// GitHub unreachable: logged, nothing else.
	down := cpvServer(t, Config{GitHubDispatchToken: "tok", GitHubDispatchRepo: "o/gitops", GitHubAPIURL: "http://127.0.0.1:1",
		TenantInternalURL: "http://127.0.0.1:1", ProvisionPollEvery: 10 * time.Millisecond, ProvisionWatchFor: 30 * time.Millisecond})
	down.kickTenantProvision(tenantProvision{Slug: "otra"})
	// A repo that makes no URL: the request is never built.
	bad := cpvServer(t, Config{GitHubDispatchToken: "tok", GitHubDispatchRepo: "o/gitops", GitHubAPIURL: "http://[::1",
		TenantInternalURL: "http://127.0.0.1:1", ProvisionPollEvery: 10 * time.Millisecond, ProvisionWatchFor: 30 * time.Millisecond})
	bad.kickTenantProvision(tenantProvision{Slug: "otra"})
	// An empty slug dispatches nothing.
	bad.kickTenantProvision(tenantProvision{})
	time.Sleep(100 * time.Millisecond)
}

func TestCpvTenantInfoRefusesWhatTheStackSays(t *testing.T) {
	var answer atomic.Value
	stack := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a := answer.Load().(string)
		if a == "500" {
			http.Error(w, "x", http.StatusInternalServerError)
			return
		}
		_, _ = io.WriteString(w, a)
	}))
	defer stack.Close()
	s := cpvServer(t, Config{TenantInternalURL: stack.URL})
	for _, c := range []struct{ answer, want string }{
		{"500", "status 500"},
		{"{not json", "invalid"},
		{`{"slug":"otra","database":true}`, `serves "otra", not "la-ceiba"`},
	} {
		answer.Store(c.answer)
		if _, err := s.tenantInfo(context.Background(), "la-ceiba"); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Fatalf("%s: err = %v", c.answer, err)
		}
	}
	answer.Store(`{"slug":"la-ceiba","database":true,"seeded":true}`)
	info, err := s.tenantInfo(context.Background(), "la-ceiba")
	if err != nil || !info.Database || !info.Seeded {
		t.Fatalf("info = %+v %v", info, err)
	}
	// A seeded stack is done; one without its database is not yet.
	if !s.trySeedTenant("la-ceiba") {
		t.Fatal("seeded stack not reported seeded")
	}
	answer.Store(`{"slug":"la-ceiba","database":false}`)
	if s.trySeedTenant("la-ceiba") {
		t.Fatal("stack without its database reported seeded")
	}
	answer.Store("500")
	if s.trySeedTenant("la-ceiba") {
		t.Fatal("unanswering stack reported seeded")
	}
	// A URL that does not parse, and one nobody listens on.
	for _, u := range []string{"http://[::1", "http://127.0.0.1:1"} {
		if _, err := cpvServer(t, Config{TenantInternalURL: u}).tenantInfo(context.Background(), "x"); err == nil {
			t.Fatalf("%s: no error", u)
		}
	}
}

func TestCpvProbePublic(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusOK)
	var cacheControl atomic.Value
	pub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cacheControl.Store(r.Header.Get("Cache-Control") + "|" + r.URL.Query().Get("probe"))
		w.WriteHeader(int(status.Load()))
	}))
	defer pub.Close()
	s := cpvServer(t, Config{PublicProbeClient: pub.Client()})
	if !s.probePublic(context.Background(), pub.URL) {
		t.Fatal("200 is not up")
	}
	if cc := cacheControl.Load().(string); !strings.HasPrefix(cc, "no-cache|") || cc == "no-cache|" {
		t.Fatalf("probe headers %q", cc)
	}
	status.Store(http.StatusServiceUnavailable)
	if s.probePublic(context.Background(), pub.URL) {
		t.Fatal("503 is up")
	}
	if s.probePublic(context.Background(), "http://[::1") || s.probePublic(context.Background(), "http://127.0.0.1:1") {
		t.Fatal("broken address is up")
	}
	// The default client verifies TLS: a self-signed address is not up.
	tlsPub := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer tlsPub.Close()
	if cpvServer(t, Config{}).probePublic(context.Background(), tlsPub.URL) {
		t.Fatal("unverified certificate counted as up")
	}
}

func TestCpvProvisionStatusRefusals(t *testing.T) {
	s := cpvServer(t, Config{})
	res := httptest.NewRecorder()
	s.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/v1/farms/la-ceiba/provision-status", nil))
	if res.Code != http.StatusNotFound {
		t.Fatalf("no ticket: %d %s", res.Code, res.Body)
	}
	// A cached answer is served without asking anything.
	s.prov.cache["la-ceiba"] = cachedStatus{at: time.Now(), status: provisionStatus{Slug: "la-ceiba", Percent: 42}}
	ticket := s.signer.SignTicket("provision-status", "la-ceiba", time.Hour)
	res = httptest.NewRecorder()
	s.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/v1/farms/la-ceiba/provision-status?ticket="+ticket, nil))
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"percent":42`) {
		t.Fatalf("cached: %d %s", res.Code, res.Body)
	}
	s.forgetStatus("la-ceiba")
	if _, ok := s.prov.cache["la-ceiba"]; ok {
		t.Fatal("forgetStatus kept the cache")
	}
}

func TestCpvProvisionStatusWaiterLeavesWithItsCaller(t *testing.T) {
	s := cpvServer(t, Config{})
	// Somebody else is computing this slug's status and never finishes.
	s.prov.inflight["la-ceiba"] = &statusCall{done: make(chan struct{})}
	ticket := s.signer.SignTicket("provision-status", "la-ceiba", time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodGet, "/v1/farms/la-ceiba/provision-status?ticket="+ticket, nil).WithContext(ctx)
	res := httptest.NewRecorder()
	s.ServeHTTP(res, req)
	if res.Body.Len() != 0 {
		t.Fatalf("answered a caller that left: %d %s", res.Code, res.Body)
	}
	// And when that computation fails, its waiters get the error.
	call := s.prov.inflight["la-ceiba"]
	call.err = domain.BadRequest("nope")
	close(call.done)
	res = httptest.NewRecorder()
	s.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/v1/farms/la-ceiba/provision-status?ticket="+ticket, nil))
	if res.Code != http.StatusBadRequest {
		t.Fatalf("waiter of a failed computation: %d %s", res.Code, res.Body)
	}
}

// ---------------------------------------------------------------------------
// tenant_internal.go
// ---------------------------------------------------------------------------

func TestCpvValidTenantSeed(t *testing.T) {
	s := cpvServer(t, Config{TenantSlug: "la-ceiba"})
	seed := func(slug, id string, members ...tenantSeedMember) *tenantSeed {
		var sd tenantSeed
		sd.Farm.Slug, sd.Farm.ID, sd.Members = slug, id, members
		return &sd
	}
	owner := tenantSeedMember{ID: "u1", Role: "owner"}
	weigher := tenantSeedMember{ID: "u2", Role: "weigher"}
	for _, c := range []struct {
		seed *tenantSeed
		want int
	}{
		{seed("otra", "f", owner), http.StatusForbidden},
		{seed("la-ceiba", "", owner), http.StatusBadRequest},
		{seed("la-ceiba", "f"), http.StatusBadRequest},
		{seed("la-ceiba", "f", weigher), http.StatusBadRequest},
	} {
		_, err := s.validTenantSeed(c.seed)
		var de *domain.Error
		if !errors.As(err, &de) || de.Status != c.want {
			t.Fatalf("%+v: err = %v", c.seed, err)
		}
	}
	got, err := s.validTenantSeed(seed("la-ceiba", "f", weigher, owner))
	if err != nil || got.ID != "u1" {
		t.Fatalf("owner = %+v %v", got, err)
	}
	// A platform (no TenantSlug) accepts no seed, not even for an empty slug.
	if _, err := cpvServer(t, Config{}).validTenantSeed(seed("", "f", owner)); err == nil {
		t.Fatal("platform accepted a seed")
	}
}

func TestCpvInternalSeedRefusesBadBodies(t *testing.T) {
	h := cpvServer(t, Config{TenantSlug: "la-ceiba"}).InternalHandler()
	for _, c := range []struct {
		body string
		want int
	}{
		{"{not json", http.StatusBadRequest},
		{`{"farm":{"id":"f","slug":"otra"},"members":[{"role":"owner"}]}`, http.StatusForbidden},
		{`{"farm":{"id":"f","slug":"la-ceiba"},"members":[{"role":"weigher"}]}`, http.StatusBadRequest},
	} {
		res := httptest.NewRecorder()
		h.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/internal/tenant/seed", strings.NewReader(c.body)))
		if res.Code != c.want {
			t.Fatalf("%s: %d %s", c.body, res.Code, res.Body)
		}
	}
}

// ---------------------------------------------------------------------------
// provision_progress.go
// ---------------------------------------------------------------------------

func TestCpvReadClusterBranches(t *testing.T) {
	objs := map[string]string{}
	var mu sync.Mutex
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		body, ok := objs[r.URL.Path]
		mu.Unlock()
		switch {
		case !ok:
			http.NotFound(w, r)
		case body == "403":
			http.Error(w, "no", http.StatusForbidden)
		default:
			_, _ = io.WriteString(w, body)
		}
	}))
	defer api.Close()
	set := func(path, body string) {
		mu.Lock()
		objs[path] = body
		mu.Unlock()
	}
	s := cpvServer(t, Config{KubeClient: &kube.Client{BaseURL: api.URL, Token: "t"}, ArgoNamespace: "argo"})
	ctx := context.Background()
	ns := "/api/v1/namespaces/bascula-la-ceiba"

	// Forbidden namespace: unreadable.
	set(ns, "403")
	if v := s.readCluster(ctx, "la-ceiba"); v.Readable {
		t.Fatalf("forbidden namespace readable: %+v", v)
	}
	// Missing namespace: readable, nothing there.
	mu.Lock()
	delete(objs, ns)
	mu.Unlock()
	if v := s.readCluster(ctx, "la-ceiba"); !v.Readable || v.Namespace {
		t.Fatalf("missing namespace: %+v", v)
	}
	set(ns, `{"status":{"phase":"Active"}}`)
	set("/apis/argoproj.io/v1alpha1/namespaces/argo/applications/bascula-la-ceiba", `{"status":{"operationState":{"phase":"Succeeded"}}}`)
	set("/apis/argoproj.io/v1alpha1/namespaces/argo/applications/bascula-la-ceiba", `{"status":{"operationState":{"phase":"Succeeded"}}}`)
	// No database cluster yet.
	if v := s.readCluster(ctx, "la-ceiba"); !v.Namespace || v.Database {
		t.Fatalf("view without a database cluster = %+v", v)
	}
	set("/apis/postgresql.cnpg.io/v1/namespaces/bascula-la-ceiba/clusters/bascula-db", `{"spec":{"instances":2},"status":{"readyInstances":1}}`)
	set("/apis/batch/v1/namespaces/bascula-la-ceiba/jobs/bascula-migrate", `{"status":{"succeeded":1}}`)
	set("/apis/apps/v1/namespaces/bascula-la-ceiba/deployments/bascula-api", `{"spec":{"replicas":2},"status":{"readyReplicas":2}}`)
	set("/apis/apps/v1/namespaces/bascula-la-ceiba/deployments/bascula-web", `{"status":{"readyReplicas":1}}`)
	set("/apis/gateway.networking.k8s.io/v1/namespaces/bascula-la-ceiba/httproutes/bascula",
		`{"status":{"parents":[{"conditions":[{"type":"Accepted","status":"True"}]}]}}`)
	set("/api/v1/namespaces/bascula-la-ceiba/services/bascula-api", `{}`)
	v := s.readCluster(ctx, "la-ceiba")
	if !v.Readable || !v.Namespace || !v.AppExists || !v.AppSynced || v.Database || !v.Migrations || !v.Pods || v.Route {
		t.Fatalf("view (web service missing, db half ready) = %+v", v)
	}
	set("/apis/postgresql.cnpg.io/v1/namespaces/bascula-la-ceiba/clusters/bascula-db", `{"spec":{"instances":1},"status":{"readyInstances":1}}`)
	set("/api/v1/namespaces/bascula-la-ceiba/services/bascula-web", `{}`)
	if v := s.readCluster(ctx, "la-ceiba"); !v.Database || !v.Route {
		t.Fatalf("view (all there) = %+v", v)
	}
	// A route nobody accepted is not connected.
	set("/apis/gateway.networking.k8s.io/v1/namespaces/bascula-la-ceiba/httproutes/bascula",
		`{"status":{"parents":[{"conditions":[{"type":"Accepted","status":"False"}]}]}}`)
	if v := s.readCluster(ctx, "la-ceiba"); v.Route {
		t.Fatalf("unaccepted route connected: %+v", v)
	}
	// Default Argo namespace.
	if cpvServer(t, Config{}).argoNamespace() != "argocd" {
		t.Fatal("default argo namespace")
	}
}

func TestCpvReadPipeline(t *testing.T) {
	var answer atomic.Value
	answer.Store("")
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a := answer.Load().(string)
		if a == "" {
			http.Error(w, "rate limited", http.StatusForbidden)
			return
		}
		_, _ = io.WriteString(w, a)
	}))
	defer gh.Close()
	s := cpvServer(t, Config{GitHubDispatchToken: "tok", GitHubDispatchRepo: "o/gitops", GitHubAPIURL: gh.URL})
	created := time.Now()
	if p := s.readPipeline(context.Background(), "la-ceiba", created); p.Known {
		t.Fatalf("403 known: %+v", p)
	}
	// Cached for a few seconds.
	answer.Store(`{"workflow_runs":[]}`)
	if p := s.readPipeline(context.Background(), "la-ceiba", created); p.Known {
		t.Fatal("cache not used")
	}
	ref := s.provisionRunRef("la-ceiba")
	for _, c := range []struct {
		runs                  string
		started, done, failed bool
	}{
		{`{"display_title":"Provision tenant otra","status":"completed","conclusion":"success"}`, false, false, false},
		{`{"display_title":"Provision tenant ` + ref + `","status":"in_progress"}`, true, false, false},
		{`{"display_title":" provision tenant ` + ref + ` ","status":"completed","conclusion":"failure"}`, true, false, true},
		{`{"display_title":"Provision tenant ` + ref + `","status":"completed","conclusion":"success"}`, true, true, false},
	} {
		s.prov.mu.Lock()
		delete(s.prov.pipelines, "la-ceiba")
		s.prov.mu.Unlock()
		answer.Store(`{"workflow_runs":[` + c.runs + `]}`)
		p := s.readPipeline(context.Background(), "la-ceiba", created)
		if !p.Known || p.Started != c.started || p.Done != c.done || p.Failed != c.failed {
			t.Fatalf("%s: %+v", c.runs, p)
		}
	}
	// Default GitHub address: unreachable here or not, it must not panic.
	if p := cpvServer(t, Config{}).readPipeline(context.Background(), "x", created); p.Known {
		t.Fatal("pipeline known without provisioning")
	}
}

func TestCpvFillStagesFallbackAndCap(t *testing.T) {
	s := cpvServer(t, Config{GitHubDispatchToken: "tok", GitHubDispatchRepo: "o/gitops", GitHubAPIURL: "http://127.0.0.1:1"})
	created := time.Now().Add(-time.Minute)
	// No cluster, GitHub unreachable: basic source, with the note.
	st := provisionStatus{Slug: "la-ceiba", Dedicated: true}
	s.fillStages(context.Background(), &st, created, true, true, true, true)
	if st.Source != "basic" || st.Note != noteNoCluster {
		t.Fatalf("fallback: %+v", st)
	}
	// Everything seen done but the gate says no: 99, never 100.
	if st.Percent != 99 || st.Current != "Estamos haciendo la última comprobación de seguridad." {
		t.Fatalf("capped: %d %q", st.Percent, st.Current)
	}
	// Signals that go back do not take progress back.
	st2 := provisionStatus{Slug: "la-ceiba", Dedicated: true}
	s.fillStages(context.Background(), &st2, created, false, false, false, false)
	if st2.Percent != 99 {
		t.Fatalf("progress went back: %d", st2.Percent)
	}
	for _, sg := range st2.Stages {
		if sg.State != "done" {
			t.Fatalf("stage %s went back to %s", sg.Key, sg.State)
		}
	}
	// Shared platform, ready.
	sh := provisionStatus{Slug: "otra", Ready: true}
	s.fillStages(context.Background(), &sh, created, true, true, true, true)
	if sh.Percent != 100 || sh.Current != "¡Su finca está lista!" || sh.Source != "basic" {
		t.Fatalf("shared ready: %+v", sh)
	}
}

func TestCpvReconcileWithoutCertificatesOrCluster(t *testing.T) {
	if n := cpvServer(t, Config{}).ReconcileFarmHostnamesOnce(context.Background()); n != 0 {
		t.Fatalf("reconciled %d without a cluster", n)
	}
	s := cpvServer(t, Config{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.reconcileFarmHostnames(ctx) // returns at once: no cluster, no certificates
}

// ---------------------------------------------------------------------------
// Branches only a stand-in transaction or transport reaches
// ---------------------------------------------------------------------------

// cpvFarmRow answers farm_by_slug: a farm, its owner, created now.
type cpvFarmRow struct{}

func (cpvFarmRow) Scan(dest ...any) error {
	*(dest[0].(*string)) = "0192f3a0-0000-7000-8000-000000000001"
	owner := "0192f3a0-0000-7000-8000-0000000000aa"
	*(dest[1].(**string)) = &owner
	*(dest[2].(*time.Time)) = time.Now()
	return nil
}

// cpvLookupOnlyTx finds the farm and fails every write.
type cpvLookupOnlyTx struct{ brokenTx }

func (cpvLookupOnlyTx) QueryRow(context.Context, string, ...any) pgx.Row { return cpvFarmRow{} }

func cpvReadyEmailRequest(s *Server, ctx context.Context) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/v1/farms/la-ceiba/ready-email?ticket="+
		s.signer.SignTicket("provision-status", "la-ceiba", time.Hour), nil)
	rc := chi.NewRouteContext()
	rc.URLParams.Add("slug", "la-ceiba")
	return r.WithContext(context.WithValue(ctx, chi.RouteCtxKey, rc))
}

func TestCpvReadyEmailRequestTransactionFailures(t *testing.T) {
	s := cpvServer(t, Config{Mailer: &cpvMailer{}})
	for _, c := range []struct {
		name string
		ctx  context.Context
	}{
		{"no transaction", context.Background()},
		{"lookup fails", tenant.WithTestTx(context.Background(), brokenTx{}, "")},
		{"request fails", tenant.WithTestTx(context.Background(), cpvLookupOnlyTx{}, "")},
	} {
		res := httptest.NewRecorder()
		s.handleRequestReadyEmail(res, cpvReadyEmailRequest(s, c.ctx))
		if res.Code < 500 {
			t.Fatalf("%s: %d %s", c.name, res.Code, res.Body)
		}
	}
}

func TestCpvReadyEmailWatcherDefaultPoll(t *testing.T) {
	// No poll interval configured and a farm already past its window: the
	// watcher starts, finds no time left and lets go without a look.
	s := cpvServer(t, Config{Mailer: &cpvMailer{}})
	s.watchReadyEmail("vieja", time.Now().Add(-time.Hour-s.provisionWatchFor()))
	cpvWait(t, "watcher released", func() bool {
		s.prov.mu.Lock()
		defer s.prov.mu.Unlock()
		return !s.prov.emailing["vieja"]
	})
	if cpvServer(t, Config{ProvisionSlowAfter: time.Second}).provisionSlowAfter() != time.Second {
		t.Fatal("configured slow-after ignored")
	}
}

// cpvTransport answers every request made through http.DefaultTransport.
type cpvTransport struct {
	mu    sync.Mutex
	hosts []string
}

func (c *cpvTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	c.mu.Lock()
	c.hosts = append(c.hosts, r.Method+" "+r.URL.Host+r.URL.Path)
	c.mu.Unlock()
	return &http.Response{StatusCode: http.StatusServiceUnavailable, Body: io.NopCloser(strings.NewReader("")),
		Header: http.Header{}, Request: r}, nil
}

func (c *cpvTransport) saw(want string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, h := range c.hosts {
		if strings.HasPrefix(h, want) {
			return true
		}
	}
	return false
}

func TestCpvGitHubDefaultsToItsPublicAPI(t *testing.T) {
	stand := &cpvTransport{}
	orig := http.DefaultTransport
	http.DefaultTransport = stand
	defer func() { http.DefaultTransport = orig }()

	s := cpvServer(t, Config{GitHubDispatchToken: "tok", GitHubDispatchRepo: "o/gitops",
		TenantInternalURL: "http://stack.invalid", ProvisionPollEvery: 10 * time.Millisecond,
		ProvisionWatchFor: 30 * time.Millisecond})
	s.kickTenantProvision(tenantProvision{Slug: "la-ceiba"})
	cpvWait(t, "dispatch", func() bool { return stand.saw("POST api.github.com/repos/o/gitops/dispatches") })
	if p := s.readPipeline(context.Background(), "la-ceiba", time.Now()); p.Known {
		t.Fatalf("a 503 from GitHub read as known: %+v", p)
	}
	if !stand.saw("GET api.github.com/repos/o/gitops/actions/workflows/provision-tenant.yml/runs") {
		t.Fatal("pipeline not read from api.github.com")
	}
	cpvWait(t, "watcher released", func() bool {
		s.prov.mu.Lock()
		defer s.prov.mu.Unlock()
		return !s.prov.watching["la-ceiba"]
	})
}

func TestCpvReconcileSkipsWatchedAndActiveHostnames(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/namespaces" {
			http.NotFound(w, r)
			return
		}
		_, _ = io.WriteString(w, `{"items":[
			{"metadata":{"name":"bascula-activa"},"status":{"phase":"Active"}},
			{"metadata":{"name":"bascula-vigilada"},"status":{"phase":"Active"}},
			{"metadata":{"name":"bascula-borrandose"},"status":{"phase":"Terminating"}},
			{"metadata":{"name":"bascula-dev"},"status":{"phase":"Active"}},
			{"metadata":{"name":"kube-system"},"status":{"phase":"Active"}}]}`)
	}))
	defer api.Close()
	kc := &kube.Client{BaseURL: api.URL, Token: "t"}
	cf := Config{KubeClient: kc, CloudflareSaaSToken: "cf", CloudflareZoneID: "zone", CloudflareAPIURL: "http://127.0.0.1:1"}
	s := cpvServer(t, cf)
	s.prov.mu.Lock()
	s.prov.certs["activa"] = &certState{Active: true}
	s.prov.certs["vigilada"] = &certState{Watching: true}
	s.prov.mu.Unlock()
	if n := s.ReconcileFarmHostnamesOnce(context.Background()); n != 0 {
		t.Fatalf("started %d watchers, want 0", n)
	}
	// A cluster but no Cloudflare: nothing to reconcile.
	if n := cpvServer(t, Config{KubeClient: kc}).ReconcileFarmHostnamesOnce(context.Background()); n != 0 {
		t.Fatalf("reconciled %d without certificates", n)
	}
	// The loop, with its default interval, stops with its context.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.reconcileFarmHostnames(ctx)
}

// Once the gate has said ready and the screen showed 100, a later look that
// finds the address down keeps 100 (progress never goes back) while ready
// turns false: the only way the percentage is ever held up by memory.
func TestCpvPercentNeverDropsAfterReady(t *testing.T) {
	s := cpvServer(t, Config{})
	created := time.Now().Add(-time.Minute)
	ready := provisionStatus{Slug: "la-ceiba", Ready: true}
	s.fillStages(context.Background(), &ready, created, true, true, true, true)
	later := provisionStatus{Slug: "la-ceiba"}
	s.fillStages(context.Background(), &later, created, true, true, true, false)
	if ready.Percent != 100 || later.Percent != 100 || later.Ready {
		t.Fatalf("ready %d, later %d (ready=%v)", ready.Percent, later.Percent, later.Ready)
	}
}
