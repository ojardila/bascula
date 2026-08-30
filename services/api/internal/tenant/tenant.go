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
	afterKey
	platformOnlyKey
)

// platformRole is what app.role says for a caller who holds no membership of
// the farm their token names.
//
// It is not a fourth farm role and no policy mentions it, which is the point:
// current_role_name() is compared against 'owner', 'admin' and 'weigher' by
// every policy that guards money, so a value outside that set is refused by all
// of them at once. Leaving the token's `role` claim in place instead would hand
// a platform administrator who was removed from a farm the ledger, the
// settlements, the prices and the private notes of that farm — as the owner it
// says he is — which is the opposite of what the flag means.
const platformRole = "platform"

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

// PlatformOnly reports that this request comes from a platform administrator
// who is NOT a member of the farm the token names, so the only thing they may
// reach is the console.
//
// The two are separate on purpose. auth.Rule says it in one line — "a
// super-admin administers farms from the outside and cannot read inside one" —
// and until this existed, only the first half was true. The membership check
// exempts the platform administrator, because a farm that removed them must not
// be able to lock the lever holder out of the room the lever is in; but the
// exemption was letting them keep the farm as well as the console, with the
// token's `role` claim in front of row level security and nothing left to
// contradict it. The exemption stays; what it exempts them from is now only the
// door, not the farm behind it. See requireAction, which is the layer that
// knows which action was asked for.
func PlatformOnly(ctx context.Context) bool {
	only, _ := ctx.Value(platformOnlyKey).(bool)
	return only
}

// keepChanges is the flag KeepChanges sets and Middleware reads. It is a
// pointer on the context because the handler runs with a derived context the
// middleware never sees again.
type keepChanges struct{ keep, discard bool }

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

// DiscardChanges is KeepChanges' mirror: ROLL BACK this request's transaction
// even though the response is a success.
//
// It exists for one shape too, and it is narrower still: a handler that has to
// SPEND the same work as another branch without keeping any of it. The only
// case today is signup answering an address that already has an account. That
// answer has to be indistinguishable from the answer a new address gets — same
// status, same body, and the same time on the clock, because a reply that comes
// back in 2 ms where the other takes 26 tells an unauthenticated caller which
// branch it took just as loudly as a 409 does. So the branch runs the whole
// creation, against a synthetic address, and throws it away here.
//
// Doing the work and discarding it is the only version of this that stays true
// as the work changes: a sleep tuned to today's 26 ms is a measurement that
// rots, and it would have to be re-tuned every time seedFarm grows a table.
//
// If both this and KeepChanges are called, this one wins. Nothing calls both,
// and if anything ever does, losing a write is the recoverable half of that
// mistake.
func DiscardChanges(ctx context.Context) {
	if k, ok := ctx.Value(keepKey).(*keepChanges); ok && k != nil {
		k.discard = true
	}
}

// afterRequest is the list AfterRequest appends to and Middleware drains.
type afterRequest struct{ fns []func(context.Context) }

// AfterRequest registers work to run once this request's transaction is over
// and its pool connection has been handed back.
//
// It exists for the shape that has already taken this platform down twice, and
// that the note on KeepChanges describes from the other side: a handler that
// holds the request transaction and then asks the pool for a SECOND connection
// needs two of the thirteen to make progress, so thirteen concurrent requests
// deadlock the pool itself, with no lock and no database involved. /health goes
// on answering throughout, because it touches no database.
//
// KeepChanges is the answer when the durable write BELONGS to the request's own
// transaction. This is the answer when it must survive that transaction being
// rolled back — an audit row that a rejected request must still leave behind.
// The callback runs with the connection already returned, so it can take one of
// its own without ever wanting two at once.
//
// The context it receives is the request's, minus the transaction: tenant.Tx
// returns an error inside it, deliberately. Errors are the callback's to
// handle; nothing can be written to the response by then.
func AfterRequest(ctx context.Context, fn func(context.Context)) {
	if a, ok := ctx.Value(afterKey).(*afterRequest); ok && a != nil {
		a.fns = append(a.fns, fn)
	}
}

func withTx(ctx context.Context, tx pgx.Tx) context.Context {
	return context.WithValue(ctx, txKey, tx)
}

func withFarm(ctx context.Context, farmID string) context.Context {
	return context.WithValue(ctx, farmKey, farmID)
}

func withPlatformOnly(ctx context.Context) context.Context {
	return context.WithValue(ctx, platformOnlyKey, true)
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
			after := &afterRequest{}
			ctx = context.WithValue(ctx, afterKey, after)

			// The callbacks run on the way out of EVERY path through this
			// middleware, including the ones that answer before the handler is
			// reached. An audit row that only survives when the request got as
			// far as the handler is not an audit row.
			defer func() {
				if len(after.fns) == 0 {
					return
				}
				if !committed {
					_ = tx.Rollback(ctx)
					committed = true
				}
				bare := context.WithValue(r.Context(), afterKey, (*afterRequest)(nil))
				for _, fn := range after.fns {
					fn(bare)
				}
			}()

			if p, ok := auth.PrincipalFrom(ctx); ok && p.FarmID != "" {
				outside, err := setContext(ctx, tx, p, enforceMembership)
				if err != nil {
					onError(w, r, err)
					return
				}
				ctx = withFarm(ctx, p.FarmID)
				if outside {
					ctx = withPlatformOnly(ctx)
				}
			}

			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r.WithContext(ctx))

			// A write that answered 4xx or 5xx must not leave rows behind —
			// unless the handler said otherwise with KeepChanges, which is how
			// a deliberate side effect survives an error response without
			// reaching for a second pool connection. See KeepChanges.
			//
			// And the mirror: DiscardChanges throws away a successful
			// request's writes, which is how signup spends the same work on an
			// address it will not create anything for. See DiscardChanges.
			if (rec.status < 400 || keep.keep) && !keep.discard {
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
//
// It reports whether the caller is a platform administrator standing OUTSIDE
// the farm their token names — see PlatformOnly.
func setContext(ctx context.Context, tx pgx.Tx, p *auth.Principal, check membershipCheck) (bool, error) {
	// app.superadmin is read from the users row here, and never taken from the
	// token.
	//
	// It was the fourth claim and the only one nothing contradicted. It is also
	// the one with the most in it: it exempts its holder from the three checks
	// below, it opens p_farms to every farm on the platform, and it is the
	// whole of what auth.Matrix asks for the console. And is_superadmin was
	// read from the database at login and at refresh and nowhere else, so
	// taking the flag off somebody — a platform administrator who left, an
	// account that turned out to be in the wrong hands — did nothing at all for
	// fifteen minutes: they went on listing and suspending other people's
	// farms, and went on being exempt from suspension and from removal, until
	// the token expired of its own accord. The same sentence the role check
	// below is written under applies here and costs more: the token is a
	// photograph of a moment that has passed.
	//
	// The row costs nothing to read: the CASE runs inside a statement the
	// request already makes, keyed by the user id the token was signed for.
	_, err := tx.Exec(ctx, `
		SELECT set_config('app.farm_id',    $1, true),
		       set_config('app.role',       $2, true),
		       set_config('app.user_id',    $3, true),
		       set_config('app.superadmin',
		                  CASE WHEN (SELECT u.is_superadmin FROM users u
		                              WHERE u.id = nullif($3, '')::uuid)
		                       THEN 'on' ELSE '' END, true)`,
		p.FarmID, string(p.Role), p.UserID)
	if err != nil {
		return false, domain.Internal("could not establish the tenant context").WithCause(err)
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
	// liveRole is the role the DATABASE says this account holds on this farm
	// right now. NULL means there is no membership row at all, which is the
	// revocation case below; a non-NULL value that disagrees with the token is
	// the role-drift case after it.
	var liveRole *string
	// platform is the platform flag as the DATABASE has it, read back through
	// the very setting the p_farms policy consults, for the same reason
	// current_farm() is read back rather than assumed.
	var platform bool
	if err := tx.QueryRow(ctx, `
		SELECT current_farm()::text,
		       (SELECT f.suspended_at FROM farms f WHERE f.id = current_farm()),
		       (SELECT m.role::text FROM memberships m
		         WHERE m.farm_id = current_farm()
		           AND m.user_id = current_user_id()),
		       coalesce(current_setting('app.superadmin', true), '') = 'on'`).
		Scan(&got, &suspendedAt, &liveRole, &platform); err != nil {
		return false, domain.Internal("could not read back the tenant context").WithCause(err)
	}
	member := liveRole != nil
	if got == nil || *got != p.FarmID {
		return false, domain.TenantNotSet().WithCause(fmt.Errorf("app.farm_id did not take"))
	}

	// The token claims the platform flag and the row does not have it. That
	// claim is the one that would waive all three checks that follow, so it is
	// answered before any of them.
	//
	// It is a 401 and not a 403, and it is the ROLE_CHANGED argument exactly:
	// suspension and revocation refuse a caller who cannot mend anything by
	// asking again — a new token would be refused too — while this caller is
	// welcome, is an ordinary member of this farm, and holds a token that has
	// merely gone out of date. handleRefresh re-reads is_superadmin and mints
	// one without the flag, both clients retry a 401 exactly once after
	// refreshing, and the console then answers the ordinary 403 that
	// auth.Matrix gives anybody who is not a platform administrator. A 403 here
	// would leave the console in the person's menu, failing, instead of taking
	// it out of their hands.
	//
	// The other direction — the row has the flag and the token does not — is
	// not a refusal and must not become one: nothing stale is being used, the
	// claim simply arrives with the next refresh, and until then the row is
	// what the exemptions below and app.superadmin follow.
	if p.Superadmin && !platform {
		return false, domain.Coded(http.StatusUnauthorized, domain.CodePlatformRoleChanged,
			"this account is no longer a platform administrator; get a new access token")
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
	if suspendedAt != nil && !platform {
		return false, domain.Coded(http.StatusForbidden, domain.CodeFarmSuspended,
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
	if check == enforceMembership && !member && !platform {
		return false, domain.Coded(http.StatusForbidden, domain.CodeMembershipRevoked,
			"that account no longer has access to this farm")
	}

	// And the third cut, which is the one that costs money: the person is still
	// on the farm, but not in the role the token says.
	//
	// An administrator demoted to weigher kept fifteen minutes of the money —
	// the settlements, the ledger, the balances — because BOTH layers that
	// decide read the claim and not the row. auth.Matrix is handed p.Role,
	// which came out of the token; and app.role, four statements up, is set
	// from the same claim, so row level security was being told the same stale
	// thing. Neither layer could have caught it. This is where the row is, so
	// this is where it is caught.
	//
	// Unlike its two siblings it is a 401, and that is deliberate. Suspension
	// and revocation are decisions the caller cannot undo — a new token would
	// be refused too, so sending the client to refresh would only make it fail
	// twice. A role change is the opposite: the account is welcome, its token
	// is simply out of date, and handleRefresh mints the new role from
	// store.GetMembership. Both clients retry a 401 exactly once after
	// refreshing, so a demotion costs the phone one round trip and nobody sees
	// a screen. The refusal the demoted person then meets on a money route
	// comes from the permission matrix, in the role they actually hold.
	//
	// The check is skipped when there is no membership row (the case above owns
	// that, and signup has none yet by construction), and NOT skipped for the
	// platform administrator: the two exemptions above exist because a
	// suspended or revoked lever-holder could not get a working token back, and
	// here they always can.
	if check == enforceMembership && member && *liveRole != string(p.Role) {
		return false, domain.Coded(http.StatusUnauthorized, domain.CodeRoleChanged,
			"your role on this farm has changed; get a new access token")
	}

	// And the case the three checks leave standing: a platform administrator
	// with no membership row on the farm their token names.
	//
	// The revocation check above lets them through by design, and the role
	// check is written to stand aside when there is no membership row, so the
	// `role` claim was reaching app.role with nothing on the other side of it
	// to compare against. A platform administrator taken off farm X went on
	// being its `owner` for the rest of the token: app.farm_id = X, app.role =
	// owner, and every policy on that farm open — the payroll, the ledger, the
	// private notes. The exemption exists so that a farm cannot lock the lever
	// holder out of the console, and it is not a way into the farm.
	//
	// So the claim is dropped and app.role becomes a value no policy knows.
	// This is the second half of PlatformOnly and not a substitute for it: the
	// middleware shuts the door on the farm's routes, and this makes the row
	// level security behind that door refuse as well, which is the same
	// belt-and-braces the money policies are written under — "denying it in
	// the middleware is the message; denying it here is the guarantee".
	if check == enforceMembership && !member {
		if _, err := tx.Exec(ctx,
			`SELECT set_config('app.role', $1, true)`, platformRole); err != nil {
			return false, domain.Internal("could not narrow the tenant role").WithCause(err)
		}
		return true, nil
	}
	return false, nil
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
	if _, err := setContext(ctx, tx, p, membershipPending); err != nil {
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

// ReleaseEarly ends this request's transaction now and hands the pool
// connection back, while the handler goes on doing something that does not need
// a database.
//
// There is exactly one shape that needs it, and it is the mirror image of the
// one KeepChanges warns about. A handler that has decided its answer but must
// still spend real time on the wire — draining an upload it is about to
// refuse — would otherwise hold a connection for the whole of that time,
// `idle in transaction`, having no further use for it. Ten of those is the pool
// gone, which is the outage the season import's own gate exists to prevent; a
// gate that held a connection while turning people away would be the same
// failure wearing the uniform of the fix.
//
// It rolls back. Anything written so far is lost, which is correct for the
// only caller and is the reason this is not called Commit: a handler that has
// something to keep and something to answer wants KeepChanges, not this.
//
// After it, Tx returns a closed transaction and every store call fails. Call it
// last, and only when the database part of the request is over.
func ReleaseEarly(ctx context.Context) {
	if k, ok := ctx.Value(keepKey).(*keepChanges); ok && k != nil {
		k.discard = true
	}
	if tx, ok := ctx.Value(txKey).(pgx.Tx); ok && tx != nil {
		_ = tx.Rollback(ctx)
	}
}
