// SPDX-License-Identifier: MIT

package tenant

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

// c2otDeadPool is a pool whose every connection attempt is refused: port 1 on
// the loopback has nothing listening. pgxpool connects lazily, so building it
// succeeds and the failure arrives at Begin, which is the fault under test.
func c2otDeadPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), "postgres://nobody:nothing@127.0.0.1:1/none?sslmode=disable&connect_timeout=2")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// c2otPool connects as the superuser to the migrated database the suite runs
// against. It skips without one, like every database-backed test here.
func c2otPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_ADMIN_DATABASE_URL is not set: run `make up` and use `make test`")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func c2otCode(err error) domain.Code {
	var de *domain.Error
	if errors.As(err, &de) {
		return de.Code
	}
	return ""
}

// When no transaction can be opened the middleware answers through onError
// with INTERNAL and never runs the handler.
func TestMiddlewareReportsATransactionThatCannotOpen(t *testing.T) {
	var got error
	reached := false
	h := Middleware(c2otDeadPool(t), func(w http.ResponseWriter, _ *http.Request, err error) {
		got = err
		w.WriteHeader(http.StatusInternalServerError)
	})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/anything", nil))
	if reached {
		t.Fatal("the handler must not run without a transaction")
	}
	if c2otCode(got) != domain.CodeInternal || rec.Code != http.StatusInternalServerError {
		t.Fatalf("onError got %v (status %d), want INTERNAL", got, rec.Code)
	}
}

// RunAs passes the pool's failure straight back when it cannot begin.
func TestRunAsReportsATransactionThatCannotOpen(t *testing.T) {
	ran := false
	err := RunAs(context.Background(), c2otDeadPool(t), &auth.Principal{UserID: uuid.NewString(), FarmID: uuid.NewString(), Role: domain.RoleOwner},
		func(context.Context, pgx.Tx) error { ran = true; return nil })
	if err == nil || ran {
		t.Fatalf("RunAs = %v, ran = %v; want an error and no callback", err, ran)
	}
}

// A principal with no farm pins nothing, so current_farm() reads back NULL
// and RunAs refuses with TENANT_NOT_SET instead of running fn unscoped.
func TestRunAsRefusesWhenTheFarmDoesNotTake(t *testing.T) {
	pool := c2otPool(t)
	ran := false
	err := RunAs(context.Background(), pool, &auth.Principal{Role: domain.RoleOwner},
		func(context.Context, pgx.Tx) error { ran = true; return nil })
	if c2otCode(err) != domain.CodeTenantNotSet || ran {
		t.Fatalf("RunAs = %v, ran = %v; want TENANT_NOT_SET and no callback", err, ran)
	}
}

// An error from fn is returned and its writes are rolled back. The caller is
// a platform administrator outside a farm, the one principal that passes the
// tenant checks without a farm or a membership row existing.
func TestRunAsReturnsTheCallbackErrorAndKeepsNothing(t *testing.T) {
	pool := c2otPool(t)
	ctx := context.Background()
	admin := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, password_hash, is_superadmin) VALUES ($1, $2, 'x', true)`,
		admin, "c2ot-"+admin+"@example.com"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, admin) })

	farm := uuid.NewString()
	ghost := uuid.NewString()
	boom := errors.New("callback failed")
	err := RunAs(ctx, pool, &auth.Principal{UserID: admin, FarmID: farm, Role: domain.RoleOwner, Superadmin: true},
		func(ctx context.Context, tx pgx.Tx) error {
			if got, err := FarmID(ctx); err != nil || got != farm {
				t.Errorf("FarmID in RunAs = %q, %v", got, err)
			}
			var role string
			if err := tx.QueryRow(ctx, `SELECT current_setting('app.role')`).Scan(&role); err != nil || role != platformRole {
				t.Errorf("app.role = %q, %v; want %q", role, err, platformRole)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
				ghost, "c2ot-"+ghost+"@example.com"); err != nil {
				t.Errorf("insert: %v", err)
			}
			return boom
		})
	if !errors.Is(err, boom) {
		t.Fatalf("RunAs = %v, want %v", err, boom)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = $1`, ghost).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rows left behind by a failed RunAs: %d, %v", n, err)
	}
}

// DiscardChanges rolls back a successful request, and wins over KeepChanges
// when a handler calls both.
func TestDiscardChangesRollsBackASuccess(t *testing.T) {
	pool := c2otPool(t)
	ghost := uuid.NewString()
	h := Middleware(pool, func(w http.ResponseWriter, _ *http.Request, err error) {
		t.Errorf("onError: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tx, err := Tx(r.Context())
		if err != nil {
			t.Errorf("Tx: %v", err)
			return
		}
		if _, err := tx.Exec(r.Context(), `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
			ghost, "c2ot-"+ghost+"@example.com"); err != nil {
			t.Errorf("insert: %v", err)
		}
		KeepChanges(r.Context())
		DiscardChanges(r.Context())
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, ghost) })

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/signup", nil))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d", rec.Code)
	}
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM users WHERE id = $1`, ghost).Scan(&n); err != nil || n != 0 {
		t.Fatalf("a discarded request left %d rows (%v)", n, err)
	}
}

// Outside the middleware DiscardChanges has nothing to flag and must not panic.
func TestDiscardChangesOutsideARequestIsANoOp(t *testing.T) {
	DiscardChanges(context.Background())
}
