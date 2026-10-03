// SPDX-License-Identifier: MIT

package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/mailer"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// The handlers in handlers_users.go, handlers_password.go, handlers_auth.go,
// handlers_uploads.go and handlers_onboarding.go each refuse to go on without
// a request transaction and a farm. The sweep in fault_sweep_test.go reaches
// most of those refusals, but sends bodies that stop at validation first; this
// file sends bodies that pass validation, so the refusal itself is what
// answers.

type cauMailer struct{}

func (cauMailer) Send(context.Context, mailer.Message) error { return nil }

func cauServer(t *testing.T) *Server {
	t.Helper()
	t.Setenv("APP_ENV", "development")
	return New(nil, nil, Config{
		UploadDir: t.TempDir(), Mailer: cauMailer{},
		PublicBaseURL: "https://bascula.example.com",
	})
}

const cauFarmID = "0192f3a0-0000-7000-8000-0000000000c1"

type cauCall struct {
	name    string
	method  string
	route   string
	path    string
	handler http.HandlerFunc
	body    string
	// tx puts a (never used) transaction on the context with an empty farm,
	// so tenant.Tx passes and tenant.FarmID is what refuses.
	tx     bool
	status int
	code   domain.Code
}

func (c cauCall) serve(t *testing.T) *httptest.ResponseRecorder {
	t.Helper()
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := auth.WithPrincipal(req.Context(), &auth.Principal{
				UserID: cauFarmID, FarmID: cauFarmID, Role: domain.RoleOwner,
			})
			if c.tx {
				ctx = tenant.WithTestTx(ctx, brokenTx{}, "")
			}
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.MethodFunc(c.method, c.route, c.handler)
	req := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "10.99.0.1:1234"
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func cauErrCode(t *testing.T, rec *httptest.ResponseRecorder) domain.Code {
	t.Helper()
	var env struct {
		Error struct {
			Code domain.Code `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	return env.Error.Code
}

func TestCauHandlersRefuseWithoutTenant(t *testing.T) {
	s := cauServer(t)
	const monday = "2026-08-24"
	signup := `{"farm":{"name":"Finca sin tenant","priceCents":90000},` +
		`"owner":{"email":"cau-sin-tenant@example.com","name":"Dueno","password":"una-clave-larga-1"}}`
	notSet := domain.CodeTenantNotSet

	calls := []cauCall{
		{name: "signup", method: http.MethodPost, route: "/v1/signup", path: "/v1/signup",
			handler: s.handleSignup, body: signup, status: 500, code: notSet},
		{name: "change password", method: http.MethodPost, route: "/v1/me/password", path: "/v1/me/password",
			handler: s.handleChangePassword,
			body:    `{"currentPassword":"una-clave-larga-1","newPassword":"otra-clave-larga-2"}`,
			status:  500, code: notSet},
		{name: "reset request", method: http.MethodPost, route: "/r", path: "/r",
			handler: s.handleRequestPasswordReset, body: `{"email":"cau-reset@example.com"}`,
			status: 500, code: notSet},
		{name: "reset spend", method: http.MethodPost, route: "/r", path: "/r",
			handler: s.handleResetPassword, body: `{"token":"x","password":"otra-clave-larga-2"}`,
			status: 500, code: notSet},
		{name: "invite, no transaction", method: http.MethodPost, route: "/u", path: "/u",
			handler: s.handleInviteUser, body: `{"email":"cau-inv@example.com","role":"weigher"}`,
			status: 500, code: notSet},
		{name: "invite, no farm", method: http.MethodPost, route: "/u", path: "/u", tx: true,
			handler: s.handleInviteUser, body: `{"email":"cau-inv@example.com","role":"weigher"}`,
			status: 500, code: notSet},
		{name: "role change", method: http.MethodPatch, route: "/u/{id}", path: "/u/" + cauFarmID,
			handler: s.handleUpdateUserRole, body: `{"role":"weigher"}`, status: 500, code: notSet},
		{name: "remove, no farm", method: http.MethodDelete, route: "/u/{id}", path: "/u/" + cauFarmID,
			tx: true, handler: s.handleRemoveUser, status: 500, code: notSet},
		{name: "upload ticket, no farm", method: http.MethodPost, route: "/up", path: "/up", tx: true,
			handler: s.handleCreateUpload, body: `{}`, status: 500, code: notSet},
		{name: "price impact", method: http.MethodGet, route: "/p/{monday}", path: "/p/" + monday,
			handler: s.handleBasePriceImpact, status: 500, code: notSet},
		{name: "set price, bad json", method: http.MethodPut, route: "/p/{monday}", path: "/p/" + monday,
			handler: s.handleSetBasePrice, body: `{"priceCents":`, status: 400},
		{name: "set price, no transaction", method: http.MethodPut, route: "/p/{monday}", path: "/p/" + monday,
			handler: s.handleSetBasePrice, body: `{"priceCents":90000}`, status: 500, code: notSet},
		{name: "set price, no farm", method: http.MethodPut, route: "/p/{monday}", path: "/p/" + monday,
			tx: true, handler: s.handleSetBasePrice, body: `{"priceCents":90000}`, status: 500, code: notSet},
		{name: "tour, bad json", method: http.MethodPut, route: "/t/{tour}", path: "/t/owner",
			handler: s.handleSaveTour, body: `{"step":`, status: 400},
		{name: "tour, no transaction", method: http.MethodPut, route: "/t/{tour}", path: "/t/owner",
			handler: s.handleSaveTour, body: `{"step":2,"status":"later"}`, status: 500, code: notSet},
		{name: "reset request, bad json", method: http.MethodPost, route: "/r", path: "/r",
			handler: s.handleRequestPasswordReset, body: `{"email":`, status: 400},
		{name: "reset spend, bad json", method: http.MethodPost, route: "/r", path: "/r",
			handler: s.handleResetPassword, body: `["token"]`, status: 400},
	}
	for _, c := range calls {
		t.Run(c.name, func(t *testing.T) {
			rec := c.serve(t)
			if rec.Code != c.status {
				t.Fatalf("got %d want %d: %s", rec.Code, c.status, rec.Body.String())
			}
			if c.code != "" && cauErrCode(t, rec) != c.code {
				t.Fatalf("code %q, want %q: %s", cauErrCode(t, rec), c.code, rec.Body.String())
			}
		})
	}
}

// A role the rank table does not know ranks below every real one, so a
// principal carrying one grants nothing and acts on nobody.
func TestCauUnknownRoleGrantsNothing(t *testing.T) {
	odd := &auth.Principal{Role: domain.Role("capataz")}
	if roleRank(odd.Role) != 0 {
		t.Fatalf("an unknown role ranks %d", roleRank(odd.Role))
	}
	if err := mayGrant(odd, domain.RoleWeigher); err == nil {
		t.Fatal("an unknown role granted weigher")
	}
	if err := mayActOn(odd, domain.RoleWeigher); err == nil {
		t.Fatal("an unknown role acted on a weigher")
	}
	if err := mayGrant(nil, domain.RoleWeigher); err == nil {
		t.Fatal("no caller granted weigher")
	}
	if err := mayActOn(nil, domain.RoleWeigher); err == nil {
		t.Fatal("no caller acted on a weigher")
	}
}

// uniqueTx answers every Exec with the error it holds.
type uniqueTx struct {
	pgx.Tx
	err error
}

func (u uniqueTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, u.err
}

// Two invites racing for the same new address: the loser is told to invite
// again, with EMAIL_TAKEN, and any other failure is passed through as is.
func TestCauInviteRaceForANewAddress(t *testing.T) {
	ctx := context.Background()
	race := &pgconn.PgError{Code: "23505", ConstraintName: "ux_users_email"}
	_, err := createInvitedUser(ctx, uniqueTx{err: race}, "cau@example.com", "Cau", "hash")
	var de *domain.Error
	if !errors.As(err, &de) || de.Status != http.StatusConflict || de.Code != domain.CodeEmailTaken {
		t.Fatalf("the losing invite got %v, want 409 EMAIL_TAKEN", err)
	}
	_, err = createInvitedUser(ctx, uniqueTx{err: errDBDown}, "cau@example.com", "Cau", "hash")
	if !errors.Is(err, errDBDown) {
		t.Fatalf("an ordinary failure became %v", err)
	}
	u, err := createInvitedUser(ctx, uniqueTx{}, "cau@example.com", "Cau", "hash")
	if err != nil || u.Email != "cau@example.com" || u.PasswordHash != "hash" {
		t.Fatalf("a clean insert: %v %+v", err, u)
	}
}

// The reset link's origin: the caller's own farm address when it is one of
// ours (keeping the configured port), PUBLIC_BASE_URL otherwise, and
// PUBLIC_BASE_URL untouched when it names no host at all.
func TestCauPasswordResetBase(t *testing.T) {
	cases := []struct{ base, host, want string }{
		{"https://bascula.example.com:8443/", "finca.bascula.example.com", "https://finca.bascula.example.com:8443"},
		{"https://bascula.example.com", "evil.com?.bascula.example.com", "https://bascula.example.com"},
		{"https://bascula.example.com", "otro.sitio.com", "https://bascula.example.com"},
		{"bascula-sin-host", "finca.bascula.example.com", "bascula-sin-host"},
		{"http://%zz", "finca.bascula.example.com", "http://%zz"},
	}
	for _, c := range cases {
		s := &Server{cfg: Config{PublicBaseURL: c.base}}
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		r.Host = c.host
		if got := s.passwordResetBase(r); got != c.want {
			t.Errorf("base %q from %q: got %q want %q", c.base, c.host, got, c.want)
		}
	}
}

// The signup attempt row is written after the request, on its own; a write
// that fails is logged and swallowed rather than breaking anything.
func TestCauSignupAttemptWriteFailureIsLogged(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, "postgres://nadie:nada@127.0.0.1:1/nada?connect_timeout=1")
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	s := &Server{pool: pool}
	s.recordSignupAttempt(ctx, "10.0.0.1", "cau@example.com", false)
}

// scriptedTx answers QueryRow with the next scripted row, in order. It stands
// in for a database whose rows disagree with the caller's token, which the
// tenant middleware never lets through: these are the checks that stay in
// place behind it.
type scriptedTx struct {
	pgx.Tx
	rows [][]any
}

type scriptedRow struct{ vals []any }

func (r scriptedRow) Scan(dest ...any) error {
	if len(dest) != len(r.vals) {
		return errDBDown
	}
	for i, d := range dest {
		switch p := d.(type) {
		case *string:
			*p = r.vals[i].(string)
		case *domain.Role:
			*p = r.vals[i].(domain.Role)
		case **time.Time:
			*p = nil
		case *time.Time:
			*p = time.Now()
		case *bool:
			*p = r.vals[i].(bool)
		case *int:
			*p = r.vals[i].(int)
		default:
			return errDBDown
		}
	}
	return nil
}

func (s *scriptedTx) QueryRow(context.Context, string, ...any) pgx.Row {
	if len(s.rows) == 0 {
		return brokenRow{}
	}
	row := s.rows[0]
	s.rows = s.rows[1:]
	return scriptedRow{vals: row}
}

func cauFarmUserRow(id string, role domain.Role) []any {
	return []any{id, "cau@example.com", "Cau", role, nil, nil, false}
}

func cauServeScripted(t *testing.T, s *Server, p *auth.Principal, tx pgx.Tx, method, body string,
	h http.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := auth.WithPrincipal(req.Context(), p)
			next.ServeHTTP(w, req.WithContext(tenant.WithTestTx(ctx, tx, cauFarmID)))
		})
	})
	r.MethodFunc(method, "/u/{id}", h)
	req := httptest.NewRequest(method, "/u/"+cauFarmID, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// Nobody raises their own role, even holding a token that says they could.
func TestCauSelfRaiseRefusedBehindAStaleToken(t *testing.T) {
	s := cauServer(t)
	p := &auth.Principal{UserID: cauFarmID, FarmID: cauFarmID, Role: domain.RoleOwner}
	tx := &scriptedTx{rows: [][]any{cauFarmUserRow(cauFarmID, domain.RoleAdmin)}}
	rec := cauServeScripted(t, s, p, tx, http.MethodPatch, `{"role":"owner"}`, s.handleUpdateUserRole)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "raise your own role") {
		t.Fatalf("self raise: %d %s", rec.Code, rec.Body.String())
	}
}

// A farm keeps an owner even when the rank and self checks have nothing to
// say: removing the last owner is refused on its own count.
func TestCauRemovingTheLastOwnerIsRefusedOnItsOwn(t *testing.T) {
	s := cauServer(t)
	p := &auth.Principal{UserID: "0192f3a0-0000-7000-8000-0000000000c2", FarmID: cauFarmID, Role: domain.RoleOwner}
	tx := &scriptedTx{rows: [][]any{cauFarmUserRow(cauFarmID, domain.RoleOwner), {1}}}
	rec := cauServeScripted(t, s, p, tx, http.MethodDelete, "", s.handleRemoveUser)
	if rec.Code != http.StatusConflict || cauErrCode(t, rec) != domain.CodeLastOwner {
		t.Fatalf("last owner removal: %d %s", rec.Code, rec.Body.String())
	}
}
