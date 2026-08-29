// Package tenant owns the one line that makes row level security do its job:
// SET LOCAL app.farm_id, inside the transaction that serves the request.
//
// SET LOCAL dies with the transaction, so a pooled connection cannot carry one
// farm's context into the next request. The value comes from the access token
// and never from a client parameter.
package tenant

import (
	"context"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

type ctxKey int

const (
	txKey ctxKey = iota
	farmKey
)

// Tx returns the transaction serving this request.
//
// A handler that reaches the database without one would run outside the tenant
// context, where RLS answers every query with zero rows and no error. That
// silence is the dangerous failure mode this whole package exists to prevent,
// so the absence of a transaction is an error, never an empty result.
func Tx(ctx context.Context) (pgx.Tx, error) {
	tx, ok := ctx.Value(txKey).(pgx.Tx)
	if !ok || tx == nil {
		return nil, domain.TenantNotSet().WithCause(fmt.Errorf("no transaction on context"))
	}
	return tx, nil
}

// FarmID returns the farm this request is scoped to, or TENANT_NOT_SET.
func FarmID(ctx context.Context) (string, error) {
	id, _ := ctx.Value(farmKey).(string)
	if id == "" {
		return "", domain.TenantNotSet().WithCause(fmt.Errorf("app.farm_id is unset"))
	}
	return id, nil
}

// HasFarm reports whether a tenant context was established.
func HasFarm(ctx context.Context) bool {
	id, _ := ctx.Value(farmKey).(string)
	return id != ""
}

func withTx(ctx context.Context, tx pgx.Tx) context.Context {
	return context.WithValue(ctx, txKey, tx)
}

func withFarm(ctx context.Context, farmID string) context.Context {
	return context.WithValue(ctx, farmKey, farmID)
}

// Middleware is the second link of the chain: Auth -> Tenant -> Require.
//
// It opens the request transaction and, when the caller carries a farm, pins
// the database session to it. Then it checks that the pinning actually took:
// if the GUC were misspelled, every query would come back empty and look like
// a brand new farm. Better a 500 on the first request than a silent empty
// worker list.
func Middleware(pool *pgxpool.Pool, onError func(http.ResponseWriter, *http.Request, error)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()

			tx, err := pool.Begin(ctx)
			if err != nil {
				onError(w, r, domain.Internal("could not open a transaction").WithCause(err))
				return
			}
			committed := false
			defer func() {
				if !committed {
					_ = tx.Rollback(ctx)
				}
			}()

			ctx = withTx(ctx, tx)

			if p, ok := auth.PrincipalFrom(ctx); ok && p.FarmID != "" {
				if err := setContext(ctx, tx, p); err != nil {
					onError(w, r, err)
					return
				}
				ctx = withFarm(ctx, p.FarmID)
			}

			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r.WithContext(ctx))

			// A write that answered 4xx or 5xx must not leave rows behind.
			if rec.status < 400 {
				if err := tx.Commit(ctx); err != nil {
					// Nothing useful can be written now: the handler already
					// sent its status line.
					_ = err
				}
				committed = true
			}
		})
	}
}

// setContext issues the SET LOCALs and reads current_farm() back in the same
// round trip, so a broken GUC name fails loudly instead of returning zero rows.
func setContext(ctx context.Context, tx pgx.Tx, p *auth.Principal) error {
	superadmin := ""
	if p.Superadmin {
		superadmin = "on"
	}
	_, err := tx.Exec(ctx, `
		SELECT set_config('app.farm_id',    $1, true),
		       set_config('app.role',       $2, true),
		       set_config('app.user_id',    $3, true),
		       set_config('app.superadmin', $4, true)`,
		p.FarmID, string(p.Role), p.UserID, superadmin)
	if err != nil {
		return domain.Internal("could not establish the tenant context").WithCause(err)
	}

	// Read it back through the very function the policies call. A misspelled
	// GUC name would otherwise turn every query into an empty result set, and
	// an empty worker list is indistinguishable from a brand new farm.
	var got *string
	if err := tx.QueryRow(ctx, `SELECT current_farm()::text`).Scan(&got); err != nil {
		return domain.Internal("could not read back the tenant context").WithCause(err)
	}
	if got == nil || *got != p.FarmID {
		return domain.TenantNotSet().WithCause(fmt.Errorf("app.farm_id did not take"))
	}
	return nil
}

// SetForSignup pins the session to a farm that is being created in this very
// transaction. Signup has no token yet, but the farms and memberships rows it
// writes still have to satisfy their RLS policies, so the farm's own id
// becomes the tenant the moment it is generated.
func SetForSignup(ctx context.Context, tx pgx.Tx, farmID, userID string) (context.Context, error) {
	p := &auth.Principal{UserID: userID, FarmID: farmID, Role: domain.RoleOwner}
	if err := setContext(ctx, tx, p); err != nil {
		return ctx, err
	}
	return withFarm(ctx, farmID), nil
}

// SetUser pins only the user, with no farm. Login needs it: the memberships
// policy lets a user read their own rows, which is how the farm list is built
// before any farm has been chosen.
func SetUser(ctx context.Context, tx pgx.Tx, userID string) error {
	_, err := tx.Exec(ctx, `SELECT set_config('app.user_id', $1, true)`, userID)
	if err != nil {
		return domain.Internal("could not set the user context").WithCause(err)
	}
	return nil
}

type statusRecorder struct {
	http.ResponseWriter
	status  int
	written bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.written {
		s.status = code
		s.written = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	s.written = true
	return s.ResponseWriter.Write(b)
}
