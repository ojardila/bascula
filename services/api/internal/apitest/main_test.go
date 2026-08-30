// Package apitest holds the tests that need a real Postgres.
//
// # Why a compose Postgres and not testcontainers
//
// The brief allowed either. This suite talks to the Postgres from
// docker-compose.yml, pointed at by TEST_ADMIN_DATABASE_URL, and the reason is
// concrete rather than a preference:
//
//   - The official postgis/postgis image publishes no linux/arm64 manifest, so
//     on Apple silicon the image has to be pinned to imresamu/postgis anyway.
//     With testcontainers that pin would live in a second place, in Go, and the
//     two would drift the first time somebody bumped one of them.
//   - This suite needs PostGIS, three database roles and RLS enabled, which is
//     exactly what `make migrate` already produces. Reproducing that setup
//     inside a container bootstrap duplicates the migration entry point.
//   - `make up && make migrate && make test` is one Postgres for the whole
//     run, not one per package, and a developer can psql into the same database
//     the failing test used, which is most of the value on a schema this
//     constraint-heavy.
//
// The cost is honest: CI has to start the service before running the tests, and
// a developer who forgets `make up` gets skips. So the skips are loud, and they
// say what to run. Nothing here silently passes without a database.
//
// The suite creates a scratch database of its own per run and drops it at the
// end, so it never touches the development data.
package apitest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
	"github.com/ojardila/bascula/services/api/internal/store"
)

const skipMessage = "TEST_ADMIN_DATABASE_URL is not set: run `make up` and use `make test`"

type harness struct {
	adminDSN string
	appDSN   string
	pool     *pgxpool.Pool
	admin    *pgxpool.Pool
	server   *httpapi.Server
}

var shared *harness

func TestMain(m *testing.M) {
	code, err := setupAndRun(m)
	if err != nil {
		fmt.Fprintln(os.Stderr, "test setup:", err)
		os.Exit(1)
	}
	os.Exit(code)
}

func setupAndRun(m *testing.M) (int, error) {
	baseDSN := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if baseDSN == "" {
		// No database: every database-backed test skips, loudly.
		return m.Run(), nil
	}

	ctx := context.Background()
	dbName := "bascula_test_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")

	bootstrap, err := pgxpool.New(ctx, baseDSN)
	if err != nil {
		return 0, fmt.Errorf("connect to %s: %w", baseDSN, err)
	}
	if err := bootstrap.Ping(ctx); err != nil {
		bootstrap.Close()
		return 0, fmt.Errorf("ping: %w", err)
	}
	if _, err := bootstrap.Exec(ctx, "CREATE DATABASE "+dbName); err != nil {
		bootstrap.Close()
		return 0, fmt.Errorf("create scratch database: %w", err)
	}
	bootstrap.Close()

	adminDSN := replaceDBName(baseDSN, dbName)
	appDSN := appDSNFor(adminDSN)

	defer func() {
		drop, err := pgxpool.New(ctx, baseDSN)
		if err != nil {
			return
		}
		defer drop.Close()
		_, _ = drop.Exec(ctx, "DROP DATABASE IF EXISTS "+dbName+" WITH (FORCE)")
	}()

	if err := store.Migrate(ctx, adminDSN); err != nil {
		return 0, fmt.Errorf("migrate scratch database: %w", err)
	}

	// The application pool connects as bascula_api, which has no BYPASSRLS.
	// Connecting as the superuser here would quietly disable every policy and
	// make the isolation test prove nothing at all.
	pool, err := store.Open(ctx, appDSN)
	if err != nil {
		return 0, fmt.Errorf("open app pool: %w", err)
	}
	defer pool.Close()

	adminPool, err := pgxpool.New(ctx, adminDSN)
	if err != nil {
		return 0, fmt.Errorf("open admin pool: %w", err)
	}
	defer adminPool.Close()

	auth.UseFastHashingForTests()
	cfg := httpapi.DefaultConfig()
	cfg.DevEcho = true
	// Uploads go to a scratch directory that dies with the run, like the
	// scratch database. Nothing here touches a developer's own files.
	uploadDir, err := os.MkdirTemp("", "bascula-uploads-")
	if err != nil {
		return 0, fmt.Errorf("upload dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(uploadDir) }()
	cfg.UploadDir = uploadDir
	cfg.SignupsPerIPPerHour = 1000
	cfg.MaxFarmsPerEmail = 3

	shared = &harness{
		adminDSN: adminDSN,
		appDSN:   appDSN,
		pool:     pool,
		admin:    adminPool,
		server:   httpapi.New(pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg),
	}
	return m.Run(), nil
}

func requireDB(t *testing.T) *harness {
	t.Helper()
	if shared == nil {
		t.Skip(skipMessage)
	}
	return shared
}

func replaceDBName(dsn, name string) string {
	cut := strings.LastIndex(dsn, "/")
	rest := dsn[cut+1:]
	if q := strings.Index(rest, "?"); q >= 0 {
		return dsn[:cut+1] + name + rest[q:]
	}
	return dsn[:cut+1] + name
}

// appDSNFor swaps the superuser credentials for the application role's. The
// password is the development default set by migration 00001.
func appDSNFor(adminDSN string) string {
	at := strings.Index(adminDSN, "@")
	scheme := strings.Index(adminDSN, "://")
	return adminDSN[:scheme+3] + "bascula_api:bascula_api_dev" + adminDSN[at:]
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

type response struct {
	Status int
	Body   map[string]any
	Raw    string
}

// code returns the contract error code, or "" when the response was not an
// error envelope.
func (r response) code() string {
	errObj, ok := r.Body["error"].(map[string]any)
	if !ok {
		return ""
	}
	code, _ := errObj["code"].(string)
	return code
}

func (h *harness) do(t *testing.T, method, path, token string, body any) response {
	t.Helper()
	var reader *strings.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = strings.NewReader(string(raw))
	} else {
		reader = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, reader)
	req.RemoteAddr = "10.0.0.1:12345"
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)

	out := response{Status: rec.Code, Raw: rec.Body.String()}
	if out.Raw != "" {
		_ = json.Unmarshal([]byte(out.Raw), &out.Body)
	}
	return out
}

func (h *harness) mustDo(t *testing.T, method, path, token string, body any, want int) response {
	t.Helper()
	res := h.do(t, method, path, token, body)
	if res.Status != want {
		t.Fatalf("%s %s: got %d want %d: %s", method, path, res.Status, want, res.Raw)
	}
	return res
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type farmFixture struct {
	FarmID      string
	OwnerUserID string
	// OwnerEmail is here so a test that changes the owner's own role can do
	// what a real client does next: get a token that agrees with the database.
	// See relogin.
	OwnerEmail   string
	OwnerToken   string
	AdminToken   string
	WeigherToken string
	WeigherID    string
	PriceCents   int64
}

var emailSeq int

// signupFarm walks the real public signup, verifies the address and logs in,
// so the fixture exercises the same door a farm actually comes through.
func (h *harness) signupFarm(t *testing.T, name string, priceCents int64) *farmFixture {
	t.Helper()
	emailSeq++
	email := fmt.Sprintf("owner%d-%s@example.com", emailSeq, uuid.NewString()[:8])

	res := h.mustDo(t, http.MethodPost, "/v1/signup", "", map[string]any{
		"farm": map[string]any{
			"name": name, "timezone": "America/Bogota", "currency": "COP",
			"priceCents": priceCents,
		},
		"owner": map[string]any{
			"email": email, "name": "Owner", "password": "una-clave-larga-1",
		},
	}, http.StatusCreated)

	// The signup response says nothing that depends on the address — no farm
	// id, no user id — because saying it for one address and not another is
	// what made this endpoint an oracle. The ids come back from verify-email,
	// which is the first request that has proved the address is the caller's.
	token, _ := res.Body["verificationToken"].(string)
	if token == "" {
		t.Fatalf("signup returned no verification token: %s", res.Raw)
	}
	if _, leaked := res.Body["farmId"]; leaked {
		t.Fatalf("signup handed out a farm id again: %s", res.Raw)
	}

	// Before verification, no session.
	pre := h.do(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": email, "password": "una-clave-larga-1",
	})
	if pre.code() != string(domain.CodeEmailNotVerified) {
		t.Fatalf("login before verification: got %d %s, want EMAIL_NOT_VERIFIED",
			pre.Status, pre.Raw)
	}

	verified := h.mustDo(t, http.MethodPost, "/v1/auth/verify-email", "",
		map[string]any{"token": token}, http.StatusOK)
	farmID, _ := verified.Body["farmId"].(string)
	userID, _ := verified.Body["userId"].(string)
	if farmID == "" || userID == "" {
		t.Fatalf("verify-email named no farm and no user: %s", verified.Raw)
	}

	login := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": email, "password": "una-clave-larga-1",
	}, http.StatusOK)
	access, _ := login.Body["accessToken"].(string)

	f := &farmFixture{
		FarmID: farmID, OwnerUserID: userID, OwnerEmail: email,
		OwnerToken: access, PriceCents: priceCents,
	}
	f.AdminToken = h.addUser(t, farmID, domain.RoleAdmin, "")
	f.WeigherID, f.WeigherToken = h.addUserWithID(t, farmID, domain.RoleWeigher)
	return f
}

// relogin swaps the fixture's owner token for a fresh one.
//
// A test that changes a role through the API leaves the token in its hand
// describing a role its holder no longer has, and that token is now refused —
// ROLE_CHANGED, on the next request, which is the whole point of the check in
// tenant.setContext. A client meets this and refreshes without anybody
// noticing; a test has to say so out loud.
func (h *harness) relogin(t *testing.T, f *farmFixture) {
	t.Helper()
	login := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": f.OwnerEmail, "password": "una-clave-larga-1",
	}, http.StatusOK)
	f.OwnerToken = mustString(t, login.Body, "accessToken")
}

func (h *harness) addUser(t *testing.T, farmID string, role domain.Role, _ string) string {
	t.Helper()
	_, token := h.addUserWithID(t, farmID, role)
	return token
}

// addUserWithID seeds a member directly. There is no user management endpoint
// in this sprint, and inventing one just to have fixtures would be building
// the wrong thing for the wrong reason.
func (h *harness) addUserWithID(t *testing.T, farmID string, role domain.Role) (string, string) {
	t.Helper()
	ctx := context.Background()
	userID := uuid.NewString()
	emailSeq++
	email := fmt.Sprintf("%s%d-%s@example.com", role, emailSeq, uuid.NewString()[:8])

	hash, err := auth.HashPassword("una-clave-larga-1")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	_, err = h.admin.Exec(ctx, `
		INSERT INTO users (id, email, name, password_hash, email_verified_at)
		VALUES ($1, $2, $3, $4, now())`, userID, email, string(role), hash)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	_, err = h.admin.Exec(ctx,
		`INSERT INTO memberships (farm_id, user_id, role) VALUES ($1, $2, $3)`,
		farmID, userID, role)
	if err != nil {
		t.Fatalf("seed membership: %v", err)
	}

	signer := auth.NewSigner([]byte("test-signing-key"), "bascula")
	token, err := signer.Issue(userID, farmID, role, "", false)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	return userID, token
}

// withTenant runs fn inside a transaction pinned to a farm, as the API role.
// It is how a test reaches the store layer directly without going through HTTP.
func (h *harness) withTenant(t *testing.T, farmID, userID string, role domain.Role, fn func(ctx context.Context, tx pgx.Tx)) {
	t.Helper()
	ctx := context.Background()
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `
		SELECT set_config('app.farm_id', $1, true),
		       set_config('app.role',    $2, true),
		       set_config('app.user_id', $3, true)`, farmID, string(role), userID)
	if err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	// Always rolled back: these probes deliberately provoke constraint
	// violations, which abort the transaction, and nothing here needs to
	// persist anyway.
	fn(ctx, tx)
}

// withTenantCommit is withTenant for writes that must stick. One transaction
// per call, so a sequence of them gets the distinct now() per statement that a
// sequence of HTTP requests would.
//
// It returns whatever fn returned, and commits only when that is nil. A commit
// attempted on a transaction fn already aborted reports "commit unexpectedly
// resulted in rollback", which hides the constraint that actually fired — and
// that constraint is usually the whole finding.
func (h *harness) withTenantCommit(t *testing.T, farmID, userID string, role domain.Role,
	fn func(ctx context.Context, tx pgx.Tx) error) error {
	t.Helper()
	ctx := context.Background()
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `
		SELECT set_config('app.farm_id', $1, true),
		       set_config('app.role',    $2, true),
		       set_config('app.user_id', $3, true)`, farmID, string(role), userID)
	if err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if err := fn(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

func day(s string) time.Time {
	d, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return d
}

// oldestSeq is the farm's lowest retained sync_log seq, which is what
// handlers_sync.go compares a cursor against. Read on the admin pool because
// a test asking what retention left behind is not a tenant's question.
func (h *harness) oldestSeq(t *testing.T, farmID string) int64 {
	t.Helper()
	var seq *int64
	if err := h.admin.QueryRow(context.Background(),
		`SELECT MIN(seq) FROM sync_log WHERE farm_id = $1`, farmID).Scan(&seq); err != nil {
		t.Fatalf("oldest seq: %v", err)
	}
	if seq == nil {
		return 0
	}
	return *seq
}

// pruneSyncLog removes a farm's oldest sync_log rows the way store.PruneSync
// removes them: one transaction on the schema owner's pool, with
// `app.sync_prune` set LOCAL on it.
//
// Both halves are load-bearing. Migration 00014 makes that flag the single
// exception the append-only trigger honours, and it is read with
// `current_setting` on the executing session — so a flag set on one connection
// and a DELETE issued on another is no permission at all. And the tenant pool
// cannot do it whatever it sets: `bascula_api` carries the REVOKE and gets
// `permission denied for table sync_log`.
func (h *harness) pruneSyncLog(t *testing.T, farmID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := h.admin.Begin(ctx)
	if err != nil {
		t.Fatalf("prune begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT set_config('app.sync_prune', 'on', true)`); err != nil {
		t.Fatalf("prune flag: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM sync_log WHERE farm_id = $1 AND seq <= (
		   SELECT MIN(seq) + 2 FROM sync_log WHERE farm_id = $1)`, farmID); err != nil {
		t.Fatalf("the prune was refused, so nothing was retained away: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("prune commit: %v", err)
	}
}
