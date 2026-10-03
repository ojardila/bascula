package apitest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// cpvFaults is a query tracer that fails chosen queries of a pool: the one
// matching query after skipping `skip` of them, once. It walks the error
// branches after calls made on the pool itself (outside the request
// transaction the fault replay wraps): background watchers, the internal
// seed listener, SECURITY DEFINER lookups. A failed query gets a context that
// is already done, so pgx refuses it before anything reaches the server and
// the connection stays healthy.
type cpvFaults struct {
	mu    sync.Mutex
	match func(sql string) bool
	skip  int
	count bool // count matches without failing them
	seen  int
	hits  int
}

func (f *cpvFaults) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.match == nil || !f.match(d.SQL) {
		return ctx
	}
	f.seen++
	if f.count {
		return ctx
	}
	if f.skip > 0 {
		f.skip--
		return ctx
	}
	f.match = nil
	f.hits++
	done, cancel := context.WithCancel(ctx)
	cancel()
	return done
}

func (f *cpvFaults) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// arm fails the next query whose SQL contains sub, after skipping skip.
func (f *cpvFaults) arm(sub string, skip int) {
	f.armFunc(func(sql string) bool { return strings.Contains(sql, sub) }, skip)
}

func (f *cpvFaults) armFunc(match func(string) bool, skip int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.match, f.skip, f.count, f.seen, f.hits = match, skip, false, 0, 0
}

// countOnly counts the queries containing sub without failing any.
func (f *cpvFaults) countOnly(sub string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.match = func(sql string) bool { return strings.Contains(sql, sub) }
	f.count, f.seen, f.hits = true, 0, 0
}

func (f *cpvFaults) disarm() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.match, f.count = nil, false
}

func (f *cpvFaults) hit() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits > 0
}

func (f *cpvFaults) matched() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.seen
}

func cpvFaultyPool(t *testing.T, dsn string) (*pgxpool.Pool, *cpvFaults) {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	faults := &cpvFaults{}
	cfg.ConnConfig.Tracer = faults
	cfg.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, faults
}

// cpvServer is a platform on the shared database whose pool fails on demand.
func cpvServer(t *testing.T, h *harness, mutate func(*httpapi.Config)) (*httpapi.Server, *cpvFaults) {
	t.Helper()
	pool, faults := cpvFaultyPool(t, h.appDSN)
	return cpvServerOn(t, pool, mutate), faults
}

func cpvServerOn(t *testing.T, pool *pgxpool.Pool, mutate func(*httpapi.Config)) *httpapi.Server {
	t.Helper()
	cfg := httpapi.DefaultConfig()
	cfg.DevEcho = true
	cfg.UploadDir = t.TempDir()
	cfg.SignupsPerIPPerHour = 1000
	cfg.SignupsPerEmailPerHour = 1000
	if mutate != nil {
		mutate(&cfg)
	}
	return httpapi.New(pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)
}

// cpvScratch is an empty, migrated database like scratchTenantDB, with an
// admin pool to arrange it and an application pool that fails on demand.
func cpvScratch(t *testing.T, h *harness) (admin, app *pgxpool.Pool, faults *cpvFaults) {
	t.Helper()
	ctx := context.Background()
	name := "bascula_cpv_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	boot, err := pgxpool.New(ctx, h.adminDSN)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := boot.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		boot.Close()
		t.Fatal(err)
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
		t.Fatal(err)
	}
	admin, err = pgxpool.New(ctx, adminDSN)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	app, faults = cpvFaultyPool(t, appDSNFor(adminDSN))
	return admin, app, faults
}

func cpvSlug(prefix string) string {
	return prefix + "-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")
}

func cpvFailed(t *testing.T, what string, res response) {
	t.Helper()
	if res.Status < 500 {
		t.Fatalf("%s: %d %s, want a server error", what, res.Status, res.Raw)
	}
}

// ---------------------------------------------------------------------------
// The platform pushing the seed into a dedicated stack
// ---------------------------------------------------------------------------

// cpvStack stands in for a dedicated stack's internal listener: it says its
// database is up and not seeded, and answers seeds as told.
type cpvStack struct {
	mu     sync.Mutex
	slug   string
	mode   string // refuse | drop | accept
	seeded bool
	seeds  []map[string]any
	drops  int
}

func (s *cpvStack) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch r.URL.Path {
	case "/internal/tenant":
		_ = json.NewEncoder(w).Encode(map[string]any{"slug": s.slug, "database": true, "seeded": s.seeded})
	case "/internal/tenant/seed":
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch s.mode {
		case "drop":
			s.drops++
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
		case "accept":
			s.seeds = append(s.seeds, body)
			s.seeded = true
			w.WriteHeader(http.StatusCreated)
		default:
			s.seeds = append(s.seeds, body)
			http.Error(w, `{"error":"this stack serves another farm"}`, http.StatusForbidden)
		}
	default:
		http.NotFound(w, r)
	}
}

func (s *cpvStack) get(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn()
}

func TestCpvSeedPushRetriesThroughRefusalsAndFailures(t *testing.T) {
	h := requireDB(t)
	slug := cpvSlug("cpv-seed")
	ownerEmail := signupWithSlug(t, h.server, "Finca Semilla", slug)

	stack := &cpvStack{slug: slug, mode: "refuse"}
	internal := httptest.NewServer(stack)
	defer internal.Close()
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer gh.Close()
	platform, faults := cpvServer(t, h, func(cfg *httpapi.Config) {
		cfg.GitHubDispatchToken = "gh-test"
		cfg.GitHubDispatchRepo = "ojardila/gitops"
		cfg.GitHubAPIURL = gh.URL
		cfg.TenantInternalURL = internal.URL
		cfg.TenantPublicURL = "http://127.0.0.1:1"
		cfg.ProvisionPollEvery = 20 * time.Millisecond
		cfg.ProvisionWatchFor = 30 * time.Second
	})

	// The waiting screen sees an unseeded stack and starts the watcher.
	st := call(t, platform, http.MethodGet, provisionStatusPath(slug), "", nil)
	if st.Status != http.StatusOK || st.Body["dedicated"] != true || st.Body["ready"] != false {
		t.Fatalf("status: %d %s", st.Status, st.Raw)
	}

	// The stack refuses: the watcher keeps trying, and what it pushes is the
	// farm and its owner.
	waitFor(t, 5*time.Second, "refused seeds", func() bool {
		n := 0
		stack.get(func() { n = len(stack.seeds) })
		return n >= 2
	})
	var first map[string]any
	stack.get(func() { first = stack.seeds[0] })
	farm, _ := first["farm"].(map[string]any)
	members, _ := first["members"].([]any)
	if farm["slug"] != slug || farm["name"] != "Finca Semilla" || len(members) != 1 {
		t.Fatalf("seed = %v", first)
	}
	if m, _ := members[0].(map[string]any); m["role"] != "owner" || !strings.EqualFold(m["email"].(string), ownerEmail) ||
		m["passwordHash"] == "" {
		t.Fatalf("seed member = %v", members[0])
	}

	// The stack drops the connection: the same.
	stack.get(func() { stack.mode = "drop" })
	waitFor(t, 5*time.Second, "dropped seed", func() bool {
		n := 0
		stack.get(func() { n = stack.drops })
		return n >= 1
	})
	stack.get(func() { stack.mode = "refuse" })

	// Every database call building the seed fails once; the watcher survives
	// each and tries again.
	for _, sub := range []string{
		"FROM farm_by_slug($1)",
		"set_config('app.farm_id'",
		"LEFT JOIN farm_config c",
		"LEFT JOIN farm_owner_credentials c",
	} {
		faults.arm(sub, 0)
		waitFor(t, 5*time.Second, "fault on "+sub, faults.hit)
	}
	faults.armFunc(func(sql string) bool { return strings.HasPrefix(strings.TrimSpace(sql), "begin") }, 0)
	waitFor(t, 5*time.Second, "fault on begin", faults.hit)
	faults.disarm()

	// A farm with no owner has nothing to seed: no push reaches the stack.
	ctx := context.Background()
	if _, err := h.admin.Exec(ctx, `UPDATE memberships SET role = 'admin'
		 WHERE farm_id = (SELECT id FROM farms WHERE slug = $1)`, slug); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	var before, after int
	stack.get(func() { before = len(stack.seeds) })
	time.Sleep(200 * time.Millisecond)
	stack.get(func() { after = len(stack.seeds) })
	if after != before {
		t.Fatalf("pushed %d seeds for a farm with no owner", after-before)
	}
	if _, err := h.admin.Exec(ctx, `UPDATE memberships SET role = 'owner'
		 WHERE farm_id = (SELECT id FROM farms WHERE slug = $1)`, slug); err != nil {
		t.Fatal(err)
	}

	// Finally it takes it, and the status says so.
	stack.get(func() { stack.mode = "accept" })
	waitFor(t, 5*time.Second, "accepted seed", func() bool {
		seeded := false
		stack.get(func() { seeded = stack.seeded })
		return seeded
	})
}

// ---------------------------------------------------------------------------
// The dedicated stack's internal listener
// ---------------------------------------------------------------------------

func TestCpvInternalSeedRollsBackEveryFailedQuery(t *testing.T) {
	h := requireDB(t)
	admin, app, faults := cpvScratch(t, h)
	slug := cpvSlug("cpv-stack")
	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = t.TempDir()
	cfg.TenantSlug = slug
	stackAPI := httpapi.New(app, auth.NewSigner([]byte("tenant-signing-key-0123456789abcdef"), "bascula"), cfg)
	internal := stackAPI.InternalHandler()
	ctx := context.Background()

	// Somebody already has an account on this stack: the seed reuses it and
	// never overwrites it.
	existingID, existingEmail := uuid.NewString(), "ya-estaba-"+uuid.NewString()[:6]+"@example.com"
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateUser(ctx, tx, store.User{ID: existingID, Email: existingEmail, Name: "Ya Estaba",
		PasswordHash: "hash-propio"}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	ownerID, adminID := uuid.NewString(), uuid.NewString()
	verified := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	seed := map[string]any{
		"farm": map[string]any{"id": uuid.NewString(), "name": "Finca Pila", "slug": slug,
			"timezone": "America/Bogota", "currency": "COP", "priceMinor": 0},
		"members": []map[string]any{
			{"id": ownerID, "email": "duena-" + uuid.NewString()[:6] + "@example.com", "name": "Dueña",
				"passwordHash": "hash-duena", "emailVerifiedAt": verified, "role": "owner"},
			{"id": adminID, "email": "admin-" + uuid.NewString()[:6] + "@example.com", "name": "Admin",
				"passwordHash": "hash-admin", "role": "admin"},
			{"id": uuid.NewString(), "email": existingEmail, "name": "Otro nombre",
				"passwordHash": "otro-hash", "role": "weigher"},
		},
	}

	// The listener's own answer, with its database failing and not.
	faults.armFunc(func(string) bool { return true }, 0)
	down := call(t, internal, http.MethodGet, "/internal/tenant", "", nil)
	if down.Status != http.StatusOK || down.Body["database"] != false || down.Body["seeded"] != false {
		t.Fatalf("tenant info with the database failing: %s", down.Raw)
	}

	// Fail the 1st query of the seed, then the 2nd, ... until one run makes
	// it through: each failed run answers an error and leaves nothing behind.
	created := false
	for n := 0; n < 200 && !created; n++ {
		faults.armFunc(func(string) bool { return true }, n)
		res := call(t, internal, http.MethodPost, "/internal/tenant/seed", "", seed)
		hit := faults.hit()
		faults.disarm()
		if !hit {
			if res.Status != http.StatusCreated || res.Body["created"] != true {
				t.Fatalf("seed with no fault: %d %s", res.Status, res.Raw)
			}
			created = true
			break
		}
		cpvFailed(t, fmt.Sprintf("seed failing at query %d", n+1), res)
		if info := call(t, internal, http.MethodGet, "/internal/tenant", "", nil); info.Body["seeded"] != false {
			t.Fatalf("a seed failing at query %d left the farm behind: %s", n+1, info.Raw)
		}
	}
	if !created {
		t.Fatal("the seed never went through")
	}

	info := call(t, internal, http.MethodGet, "/internal/tenant", "", nil)
	if info.Body["slug"] != slug || info.Body["database"] != true || info.Body["seeded"] != true {
		t.Fatalf("tenant info after the seed: %s", info.Raw)
	}
	var name, hash string
	if err := admin.QueryRow(ctx, `SELECT name, password_hash FROM users WHERE id = $1`, existingID).Scan(&name, &hash); err != nil {
		t.Fatal(err)
	}
	if name != "Ya Estaba" || hash != "hash-propio" {
		t.Fatalf("the existing account was overwritten: %q %q", name, hash)
	}
	var ownerVerified, adminVerified bool
	if err := admin.QueryRow(ctx, `SELECT
		(SELECT email_verified_at IS NOT NULL FROM users WHERE id = $1),
		(SELECT email_verified_at IS NOT NULL FROM users WHERE id = $2)`, ownerID, adminID).
		Scan(&ownerVerified, &adminVerified); err != nil {
		t.Fatal(err)
	}
	if !ownerVerified || adminVerified {
		t.Fatalf("verified: owner %v admin %v", ownerVerified, adminVerified)
	}
	var price int64
	var confirmed bool
	if err := admin.QueryRow(ctx, `SELECT c.price_minor, c.price_confirmed_at IS NOT NULL
		  FROM farm_config c JOIN farms f ON f.id = c.farm_id WHERE f.slug = $1`, slug).Scan(&price, &confirmed); err != nil {
		t.Fatal(err)
	}
	if price != 80000 || confirmed {
		t.Fatalf("a seed without a price: %d confirmed=%v, want the default unconfirmed", price, confirmed)
	}
	var memberships int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM memberships m JOIN farms f ON f.id = m.farm_id
		 WHERE f.slug = $1`, slug).Scan(&memberships); err != nil {
		t.Fatal(err)
	}
	if memberships != 3 {
		t.Fatalf("memberships = %d, want 3", memberships)
	}

	// A second push is a no-op, and a failing lookup of the farm is an error,
	// not a second farm.
	again := call(t, internal, http.MethodPost, "/internal/tenant/seed", "", seed)
	if again.Status != http.StatusOK || again.Body["created"] != false {
		t.Fatalf("second seed: %d %s", again.Status, again.Raw)
	}
	faults.arm("FROM farm_by_slug($1)", 0)
	cpvFailed(t, "seed with the farm lookup failing", call(t, internal, http.MethodPost, "/internal/tenant/seed", "", seed))
	faults.disarm()
}

// ---------------------------------------------------------------------------
// Status, slug and name lookups when the database fails
// ---------------------------------------------------------------------------

func TestCpvPublicLookupsFailClosed(t *testing.T) {
	h := requireDB(t)
	slug := cpvSlug("cpv-look")
	signupWithSlug(t, h.server, "Finca Consulta", slug)
	public := httptest.NewServer(a3HealthOnly())
	defer public.Close()
	srv, faults := cpvServer(t, h, func(cfg *httpapi.Config) {
		cfg.TenantPublicURL = public.URL
		cfg.Mailer = &recordingMailer{}
	})

	faults.arm("FROM farm_by_slug($1)", 0)
	cpvFailed(t, "status, farm lookup failing", call(t, srv, http.MethodGet, provisionStatusPath(slug), "", nil))
	faults.arm("farm_awaiting_owner_email", 0)
	cpvFailed(t, "status, awaiting lookup failing", call(t, srv, http.MethodGet, provisionStatusPath(slug), "", nil))
	faults.arm("FROM farm_by_slug($1)", 0)
	cpvFailed(t, "slug check, lookup failing", call(t, srv, http.MethodGet, "/v1/farm-slugs?slug="+slug, "", nil))
	faults.arm("farm_display_name", 0)
	cpvFailed(t, "farm name, lookup failing", call(t, srv, http.MethodGet, "/v1/farm-name?slug="+slug, "", nil))
	name := call(t, srv, http.MethodGet, "/v1/farm-name?slug="+slug, "", nil)
	if name.Status != http.StatusOK || name.Body["name"] != "Finca Consulta" {
		t.Fatalf("farm name: %d %s", name.Status, name.Raw)
	}

	// The notice state failing is not the status failing: it just says not
	// requested.
	faults.arm("farm_ready_email_state", 0)
	st := call(t, srv, http.MethodGet, provisionStatusPath(slug), "", nil)
	if !faults.hit() || st.Status != http.StatusOK || st.Body["notifyAvailable"] != true || st.Body["notifyRequested"] != false {
		t.Fatalf("status with the notice state failing: %d %s", st.Status, st.Raw)
	}
	faults.disarm()
}

// ---------------------------------------------------------------------------
// The ready email
// ---------------------------------------------------------------------------

func TestCpvReadyEmailClaimSendAndReleaseFailures(t *testing.T) {
	h := requireDB(t)
	slug := cpvSlug("cpv-lista")
	ownerEmail := signupWithSlug(t, h.server, "Finca Lista", slug)
	public := httptest.NewServer(a3HealthOnly())
	defer public.Close()
	mail := &recordingMailer{}
	pool, faults := cpvFaultyPool(t, h.appDSN)
	// A fresh server per look: a ready status is cached for a minute, and
	// it is computing the status that sends the email.
	fresh := func() *httpapi.Server {
		return cpvServerOn(t, pool, func(cfg *httpapi.Config) {
			cfg.TenantPublicURL = public.URL
			cfg.Mailer = mail
		})
	}
	ctx := context.Background()
	// The owner asked, on a screen this process never saw.
	if _, err := h.admin.Exec(ctx, `SELECT farm_ready_email_request($1)`, slug); err != nil {
		t.Fatal(err)
	}
	look := func() response {
		t.Helper()
		st := call(t, fresh(), http.MethodGet, provisionStatusPath(slug), "", nil)
		if st.Status != http.StatusOK || st.Body["ready"] != true || st.Body["notifyRequested"] != true {
			t.Fatalf("status: %d %s", st.Status, st.Raw)
		}
		return st
	}

	// The claim fails: nothing is sent.
	faults.arm("farm_ready_email_claim", 0)
	look()
	waitFor(t, 5*time.Second, "claim attempt", faults.hit)
	time.Sleep(100 * time.Millisecond)
	if mail.count() != 0 {
		t.Fatalf("sent %d without a claim", mail.count())
	}

	// The send fails and so does the release: the claim stays taken, so no
	// later look sends it either.
	mail.fail.Store(true)
	faults.arm("farm_ready_email_release", 0)
	look()
	waitFor(t, 5*time.Second, "release attempt", faults.hit)
	mail.fail.Store(false)
	look()
	time.Sleep(200 * time.Millisecond)
	if mail.count() != 0 {
		t.Fatalf("sent %d while the claim was held", mail.count())
	}

	// The claim given back, the next look sends it, to the owner.
	if _, err := h.admin.Exec(ctx, `SELECT farm_ready_email_release($1)`, slug); err != nil {
		t.Fatal(err)
	}
	st := look()
	waitForMail(t, mail, 1)
	mail.mu.Lock()
	msg := mail.sent[0]
	mail.mu.Unlock()
	if !strings.EqualFold(msg.To, ownerEmail) || msg.Subject != "Su finca ya está lista" ||
		!strings.Contains(msg.Body, st.Body["url"].(string)+"/entrar") || !strings.Contains(msg.Body, "Finca Lista") {
		t.Fatalf("email = %+v", msg)
	}

	// Resuming with the pending list failing does nothing.
	faults.arm("farm_ready_email_pending", 0)
	fresh().ResumeReadyEmails(ctx)
	if !faults.hit() {
		t.Fatal("resume did not ask for pending notices")
	}
	faults.disarm()
	time.Sleep(100 * time.Millisecond)
	if mail.count() != 1 {
		t.Fatalf("sent %d, want 1", mail.count())
	}
}

func TestCpvReadyEmailRequestRefusals(t *testing.T) {
	h := requireDB(t)
	slug := cpvSlug("cpv-pide")
	signupWithSlug(t, h.server, "Finca Pide", slug)
	mail := &recordingMailer{}
	srv, faults := cpvServer(t, h, func(cfg *httpapi.Config) {
		cfg.Mailer = mail
		cfg.TenantPublicURL = "http://127.0.0.1:1"
	})

	// A ticket for a farm that does not exist: 404.
	ghost := cpvSlug("cpv-nadie")
	if res := call(t, srv, http.MethodPost, readyEmailPath(ghost), "", nil); res.Status != http.StatusNotFound {
		t.Fatalf("unknown farm: %d %s", res.Status, res.Raw)
	}
	// The status for it: the same 404, ticket or not.
	if res := call(t, srv, http.MethodGet, provisionStatusPath(ghost), "", nil); res.Status != http.StatusNotFound {
		t.Fatalf("status of an unknown farm: %d %s", res.Status, res.Raw)
	}
	// An invalid slug: 400.
	if res := call(t, srv, http.MethodPost, "/v1/farms/NO_VALE/ready-email", "", nil); res.Status != http.StatusBadRequest {
		t.Fatalf("bad slug: %d %s", res.Status, res.Raw)
	}
	// The lookup or the request failing: an error, nothing requested.
	faults.arm("FROM farm_by_slug($1)", 0)
	cpvFailed(t, "ready-email, lookup failing", call(t, srv, http.MethodPost, readyEmailPath(slug), "", nil))
	faults.arm("farm_ready_email_request", 0)
	cpvFailed(t, "ready-email, request failing", call(t, srv, http.MethodPost, readyEmailPath(slug), "", nil))
	faults.disarm()
	var requested bool
	if err := h.admin.QueryRow(context.Background(), `SELECT requested FROM farm_ready_email_state($1)`, slug).
		Scan(&requested); err != nil {
		t.Fatal(err)
	}
	if requested {
		t.Fatal("a failed request was recorded")
	}

	// A farm past its preparation window has nothing to announce.
	old := cpvServerOn(t, h.pool, func(cfg *httpapi.Config) {
		cfg.Mailer = mail
		cfg.ProvisionWatchFor = time.Nanosecond
	})
	res := call(t, old, http.MethodPost, readyEmailPath(slug), "", nil)
	if res.Status != http.StatusBadRequest || !strings.Contains(res.Raw, "no longer being prepared") {
		t.Fatalf("old farm: %d %s", res.Status, res.Raw)
	}
	if mail.count() != 0 {
		t.Fatalf("sent %d", mail.count())
	}
}

// ---------------------------------------------------------------------------
// Security notices
// ---------------------------------------------------------------------------

func TestCpvRoleNoticeFailuresNeverUndoTheChange(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca Aviso Cpv", 90000)
	coOwner, _ := h.addUserWithID(t, f.FarmID, "weigher")
	ctx := context.Background()
	if _, err := h.admin.Exec(ctx, `UPDATE memberships SET role = 'owner' WHERE farm_id = $1 AND user_id = $2`,
		f.FarmID, coOwner); err != nil {
		t.Fatal(err)
	}
	var coOwnerEmail string
	if err := h.admin.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, coOwner).Scan(&coOwnerEmail); err != nil {
		t.Fatal(err)
	}
	mail := &recordingMailer{}
	srv, faults := cpvServer(t, h, func(cfg *httpapi.Config) { cfg.Mailer = mail })
	setRole := func(role string) response {
		t.Helper()
		res := call(t, srv, http.MethodPatch, "/v1/users/"+f.WeigherID, f.OwnerToken, map[string]any{"role": role})
		if res.Status != http.StatusOK || res.Body["role"] != role {
			t.Fatalf("set role %s: %d %s", role, res.Status, res.Raw)
		}
		return res
	}

	// How many membership reads a raise makes; the last is the notice's.
	const membershipSQL = "FROM memberships m JOIN farms f ON f.id = m.farm_id"
	faults.countOnly(membershipSQL)
	setRole("admin")
	reads := faults.matched()
	faults.disarm()
	waitForMail(t, mail, 1)
	setRole("weigher")

	// The farm read failing, then the owners list: the role still changes,
	// nobody is told.
	faults.arm(membershipSQL, reads-1)
	setRole("admin")
	if !faults.hit() {
		t.Fatal("the notice's membership read was not reached")
	}
	setRole("weigher")
	faults.arm("m.role = 'owner' AND m.user_id <> $1", 0)
	setRole("admin")
	if !faults.hit() {
		t.Fatal("the owners list was not read")
	}
	setRole("weigher")
	faults.disarm()
	time.Sleep(100 * time.Millisecond)
	if mail.count() != 1 {
		t.Fatalf("sent %d, want only the first notice", mail.count())
	}

	// The send failing: logged, the change stands.
	mail.fail.Store(true)
	setRole("admin")
	time.Sleep(150 * time.Millisecond)
	mail.fail.Store(false)
	if mail.count() != 1 {
		t.Fatalf("a failed send was recorded: %d", mail.count())
	}

	// Made owner: the co-owner hears it; the new owner is not told about
	// themselves.
	setRole("owner")
	waitForMail(t, mail, 2)
	time.Sleep(100 * time.Millisecond)
	mail.mu.Lock()
	defer mail.mu.Unlock()
	if len(mail.sent) != 2 {
		t.Fatalf("notices: %+v", mail.sent)
	}
	last := mail.sent[1]
	if last.To != coOwnerEmail || !strings.Contains(last.Subject, "ahora es dueño de Finca Aviso Cpv") ||
		!strings.Contains(last.Body, "Lo hizo Owner (") {
		t.Fatalf("owner notice: %+v", last)
	}
}

func TestCpvSessionRevocationFailuresAreLoggedOnly(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca Revoca Cpv", 90000)
	key := newSoftPasskey(t)
	created := h.registerPasskey(t, f.OwnerToken, key)
	srv, faults := cpvServer(t, h, nil)

	// Removing a passkey: closing the sessions it opened fails, the removal
	// stands.
	faults.arm("passkey_id = $2", 0)
	req := httptest.NewRequest(http.MethodDelete, "/v1/me/passkeys/"+created["id"].(string), nil)
	req.RemoteAddr = "10.0.0.9:12345"
	req.Header.Set("Origin", passkeyOrigin)
	req.Header.Set("Authorization", "Bearer "+f.OwnerToken)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || !faults.hit() {
		t.Fatalf("remove passkey: %d %s (revocation reached: %v)", rec.Code, rec.Body, faults.hit())
	}

	// Changing the password: closing the sessions on other farms fails, the
	// change stands.
	faults.arm("farm_id <> $2", 0)
	res := call(t, srv, http.MethodPost, "/v1/me/password", f.OwnerToken, map[string]any{
		"currentPassword": f.loginSecret(), "newPassword": newSecret,
	})
	if res.Status != http.StatusOK || !faults.hit() {
		t.Fatalf("change password: %d %s (revocation reached: %v)", res.Status, res.Raw, faults.hit())
	}
	faults.disarm()
	h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": f.OwnerEmail, "password": newSecret,
	}, http.StatusOK)
}
