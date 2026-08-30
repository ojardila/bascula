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
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

type ctxKey int

const (
	txKey ctxKey = iota
	farmKey
	keepKey
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

// keepChanges is the flag KeepChanges sets and Middleware reads. It is a
// pointer on the context because the handler runs with a derived context the
// middleware never sees again.
type keepChanges struct{ keep bool }

// KeepChanges tells the middleware to COMMIT this request's transaction even
// though the response is an error.
//
// It exists for one shape, and it is a narrow one: a handler that has to record
// something durable AND answer 4xx. The only case today is a reused refresh
// token, where the whole token family is revoked and the answer is 401.
//
// # Why this and not a second connection
//
// The obvious alternative — write the durable part on another pool connection,
// so it survives the rollback — is what this replaced, and it took the platform
// down twice over. Revoking on a second connection while the request
// transaction held row locks on the same rows was a self-deadlock that Postgres
// could not see as one, because the first transaction was waiting on the
// application rather than on the database. And even with the locks removed, a
// handler that holds one pool connection and asks for a second needs TWO of the
// ten to make progress: a dozen concurrent requests deadlock the pool itself,
// with no lock and no database involved at all. Both failures took out every
// farm, and /health kept answering through both, because it touches no
// database.
//
// So: one connection per request, always. This is how a handler keeps a write
// without asking for a second.
//
// The obligation it puts on the caller is real and there is no way around it:
// EVERYTHING the transaction has written up to that point is committed. Call it
// only when the writes so far are exactly the ones that must survive.
func KeepChanges(ctx context.Context) {
	if k, ok := ctx.Value(keepKey).(*keepChanges); ok && k != nil {
		k.keep = true
	}
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
			keep := &keepChanges{}
			ctx = context.WithValue(ctx, keepKey, keep)

			if p, ok := auth.PrincipalFrom(ctx); ok && p.FarmID != "" {
				if err := setContext(ctx, tx, p, enforceMembership); err != nil {
					onError(w, r, err)
					return
				}
				ctx = withFarm(ctx, p.FarmID)
			}

			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r.WithContext(ctx))

			// A write that answered 4xx or 5xx must not leave rows behind —
			// unless the handler said otherwise with KeepChanges, which is how
			// a deliberate side effect survives an error response without
			// reaching for a second pool connection. See KeepChanges.
			if rec.status < 400 || keep.keep {
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

// membershipCheck says whether the caller's membership of this farm has to
// exist already. It does on every request that arrives with a token, and it
// does NOT during signup, where the farm and the membership are being written
// by the very transaction that is pinning itself to them.
type membershipCheck bool

const (
	enforceMembership membershipCheck = true
	membershipPending membershipCheck = false
)

// setContext issues the SET LOCALs and reads current_farm() back in the same
// round trip, so a broken GUC name fails loudly instead of returning zero rows.
func setContext(ctx context.Context, tx pgx.Tx, p *auth.Principal, check membershipCheck) error {
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
	//
	// The farm's status and the caller's membership come back in the SAME round
	// trip, because both have to be checked on every request and a check that
	// costs a second query is a check somebody optimises away. See below.
	var got *string
	var suspendedAt *time.Time
	var member bool
	if err := tx.QueryRow(ctx, `
		SELECT current_farm()::text,
		       (SELECT f.suspended_at FROM farms f WHERE f.id = current_farm()),
		       EXISTS (SELECT 1 FROM memberships m
		                WHERE m.farm_id = current_farm()
		                  AND m.user_id = current_user_id())`).
		Scan(&got, &suspendedAt, &member); err != nil {
		return domain.Internal("could not read back the tenant context").WithCause(err)
	}
	if got == nil || *got != p.FarmID {
		return domain.TenantNotSet().WithCause(fmt.Errorf("app.farm_id did not take"))
	}

	// A suspended farm stops HERE, on every request, and not at the next login.
	//
	// Login and refresh already refuse a suspended farm, and for fifteen minutes
	// that was the whole of it: an access token issued a minute before the
	// suspension kept working until it expired, so the farm went on settling,
	// paying and voiding for a quarter of an hour after somebody decided it must
	// not. Suspension is the platform's only lever, and a lever with a
	// fifteen-minute delay is not one — that window is longer than a payroll run.
	//
	// The alternative everybody reaches for first is a shorter access token, and
	// it is wrong for this system specifically: the handset that spends the day
	// without signal would then be refreshing every few minutes it cannot reach
	// the server. The token stays long and the check moves here, where the
	// transaction is already open and the round trip is already being made.
	//
	// The platform administrator is exempt, and only the platform
	// administrator: the console's token is pinned to a farm like everybody
	// else's, and suspending that farm would lock the person holding the lever
	// out of the room it is in. A farm role, however senior, is not exempt.
	if suspendedAt != nil && !p.Superadmin {
		return domain.Coded(http.StatusForbidden, domain.CodeFarmSuspended,
			"that farm is suspended")
	}

	// And the same cut from the other side: an account that has been taken off
	// this farm stops HERE, on the next request.
	//
	// DELETE /v1/users/{id} already deletes the membership and revokes the
	// refresh tokens, so the person cannot open a NEW session. What it could
	// not touch is the access token already in their pocket, which carries the
	// farm and the role as signed claims and is good for another fifteen
	// minutes — fifteen minutes of reading the payroll and writing to the
	// ledger of a farm that has just removed them. Removal is what a farm does
	// when it stops trusting somebody; a lever that takes a quarter of an hour
	// is the same non-lever the suspension fix was about, and the answer is the
	// same one, in the same round trip.
	//
	// It costs no extra query and it is not a permission check: auth.Matrix
	// still decides what the role may do. This decides whether the caller is
	// still in the room at all, which is a question the token cannot answer
	// because the token is a photograph of a moment that has passed.
	//
	// The platform administrator is exempt, and for the reason the suspension
	// check gives: their token is pinned to a farm like everybody else's, and
	// an owner of that farm removing them would lock the lever holder out of
	// the room the lever is in.
	if check == enforceMembership && !member && !p.Superadmin {
		return domain.Coded(http.StatusForbidden, domain.CodeMembershipRevoked,
			"that account no longer has access to this farm")
	}
	return nil
}

// SetForSignup pins the session to a farm that is being created in this very
// transaction. Signup has no token yet, but the farms and memberships rows it
// writes still have to satisfy their RLS policies, so the farm's own id
// becomes the tenant the moment it is generated.
func SetForSignup(ctx context.Context, tx pgx.Tx, farmID, userID string) (context.Context, error) {
	p := &auth.Principal{UserID: userID, FarmID: farmID, Role: domain.RoleOwner}
	// membershipPending: the membership row is written a few statements from
	// now, by this transaction. Demanding it here would make it impossible to
	// create a farm at all.
	if err := setContext(ctx, tx, p, membershipPending); err != nil {
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

// Unwrap hands http.ResponseController the writer underneath.
//
// It is not decoration. A wrapper that embeds http.ResponseWriter promotes
// exactly the three methods of that interface and NOTHING else, so the
// connection's SetReadDeadline and SetWriteDeadline — which is how a single
// route buys itself a longer body than the server's global ReadTimeout allows
// — become invisible the moment a request passes through here. Without this
// method http.NewResponseController(w).SetReadDeadline returns
// http.ErrNotSupported for every route in the service, and the season import
// would go on being cut off at thirty seconds while appearing to be fixed.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }
