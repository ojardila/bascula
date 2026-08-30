package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

// ---------------------------------------------------------------------------
// Signup — the open door (decision 2)
// ---------------------------------------------------------------------------

type signupRequest struct {
	Farm struct {
		Name       string `json:"name"`
		Timezone   string `json:"timezone"`
		Currency   string `json:"currency"`
		PriceCents int64  `json:"priceCents"`
	} `json:"farm"`
	Owner struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Password string `json:"password"`
	} `json:"owner"`
}

// handleSignup creates a farm and its first owner. The farm is active from the
// moment it exists — nobody at the platform approves it — but the owner cannot
// open a session until the address is verified.
//
// This is the most exposed surface in the system, so it carries three limits:
// a rate limit per IP and one per address, both of which survive a restart
// because they live in Postgres, and mandatory email verification. It carries
// no password check and no account lookup the caller can observe — see the
// long note further down, and handleCreateFarm, which is where the
// farms-per-account cap went.
//
// The IP the two counters key on is the one established in buildRouter, which
// is the socket's unless an operator named the proxies allowed to override it.
// It is deliberately not read off a header here: a limit whose key the caller
// chooses is not a limit.
//
// # What comes back, and what does not
//
//	201 {"verificationRequired": true}
//
// and in development, where there is no mail sender, the token that would have
// been mailed. That is the WHOLE response, for every address, and the two
// identifiers it used to carry — farmId and userId — moved to
// POST /v1/auth/verify-email, which is the first point at which the caller has
// proved the address is theirs. Handing a farm's id to whoever filled in the
// form was never necessary: the console shows "revise su correo" and goes no
// further, and the phone was never in this flow at all.
func (s *Server) handleSignup(w http.ResponseWriter, r *http.Request) {
	var req signupRequest
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Owner.Email))
	if email == "" || !strings.Contains(email, "@") {
		writeError(w, r, domain.BadRequest("owner.email is required"))
		return
	}
	if len(req.Owner.Password) < 10 {
		writeError(w, r, domain.BadRequest("owner.password must be at least 10 characters"))
		return
	}
	if strings.TrimSpace(req.Farm.Name) == "" {
		writeError(w, r, domain.BadRequest("farm.name is required"))
		return
	}
	if req.Farm.PriceCents <= 0 {
		writeError(w, r, domain.BadRequest("farm.priceCents must be positive"))
		return
	}
	if req.Farm.Timezone == "" {
		req.Farm.Timezone = "America/Bogota"
	}
	if req.Farm.Currency == "" {
		req.Farm.Currency = "COP"
	}

	ip := clientIP(r)
	// The address as it arrived. `email` below is reassigned in the branch that
	// creates nothing, and the attempt row must not record that invention.
	attempted := email
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	// The attempt is recorded outside the request transaction on purpose: a
	// rejected signup rolls that transaction back, and a rate limit that
	// forgets every failure is not a rate limit.
	//
	// It is recorded AFTER that transaction rather than beside it. A `defer`
	// here runs while the middleware still holds the request's connection, so
	// asking the pool for a second one wants two of the thirteen at once — the
	// deadlock the note on tenant.KeepChanges says took the platform down
	// twice, on the one route that needs no credential to reach. Thirteen
	// concurrent signups were enough to stop every farm, with /health still
	// green. tenant.AfterRequest runs the write once the connection is back.
	succeeded := false
	tenant.AfterRequest(r.Context(), func(ctx context.Context) {
		if _, err := s.pool.Exec(ctx,
			`INSERT INTO signup_attempts (id, ip, email, succeeded) VALUES ($1, $2::inet, $3, $4)`,
			uuid.NewString(), ip, attempted, succeeded); err != nil {
			slog.ErrorContext(ctx, "could not record the signup attempt",
				"err", err, "ip", ip)
		}
	})

	n, err := store.CountSignupAttempts(r.Context(), tx, ip, time.Hour)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if n >= s.cfg.SignupsPerIPPerHour {
		writeError(w, r, domain.Coded(http.StatusTooManyRequests, domain.CodeRateLimited,
			"too many signups from this address, try again later"))
		return
	}

	// And the same limit along the other axis, which is the one that still
	// holds when the first is cheap to evade — a botnet, a carrier NAT pool,
	// or a trusted-proxy range an operator wrote one CIDR too wide. The index
	// this rides on, ix_signup_attempts_email, was created in migration 00002
	// and until now nothing queried it.
	//
	// It counts attempts, never accounts, which is what keeps it out of the
	// long argument below: an address with an account and an address without
	// one hit this cap after exactly the same number of tries, so the 429
	// discloses only that somebody has been hammering that address — which the
	// person hammering it already knows.
	byEmail, err := store.CountSignupAttemptsByEmail(r.Context(), tx, attempted, time.Hour)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if byEmail >= s.cfg.SignupsPerEmailPerHour {
		writeError(w, r, domain.Coded(http.StatusTooManyRequests, domain.CodeRateLimited,
			"too many signups for this address, try again later"))
		return
	}

	// An address that already has an account gets the SAME ANSWER as one that
	// does not, and the password in the body is never looked at for either.
	//
	// # What this used to be
	//
	// It used to look at the password, and that made the registration form an
	// oracle for both halves of a credential. Send an address with a wrong
	// password: 409. Send it with the right one: 201, a farm created — a
	// stranger's confirmation that the guess was correct, with no token spent,
	// no failed-login counter touched and no trace on the account it belongs
	// to. A login without a login.
	//
	// The first half of the fix was to notice that "create a second farm for an
	// account that already exists" is an ACTION BY THAT ACCOUNT, and that an
	// account proves who it is by opening a session. So it moved: POST
	// /v1/farms, behind a token, and the farms-per-email cap moved with it,
	// because it is a rule about an account and this endpoint no longer knows
	// which account it would be about.
	//
	// # What was still left, which is this half
	//
	// The 409 itself. It says nothing about the password and it still answers,
	// to anybody who asks, whether a given person banks here. That is worth
	// something on its own — a list of addresses that are coffee farm owners in
	// Huila is a phishing list — and it is worth more as the first step of the
	// attack the 409 was already the second step of.
	//
	// So the answer stopped depending on the account. Same status, same body,
	// and — because a 2 ms reply beside a 26 ms one is the same disclosure said
	// more quietly — the same work: the branch below runs the entire creation
	// against a synthetic address and throws it away. See tenant.DiscardChanges.
	//
	// # And the person who mistyped their address
	//
	// They see "revise su correo", like everybody else, and no mail arrives,
	// because the address they typed is somebody else's. They try again. That
	// is a worse minute for them than "ese correo ya tiene cuenta" would have
	// been, and it is the right trade: the alternative tells every stranger the
	// same thing it tells them.
	//
	// What the person who OWNS that address should get is a message saying
	// somebody tried to register with it and they already have an account —
	// which is what makes this branch honest rather than merely quiet, and
	// which this service cannot send, because it has no mail sender at all yet.
	// The verification mail of the ordinary branch does not exist either. When
	// one is wired in, both messages get written at the same time; until then
	// the two branches are equally silent, which is at least not a new lie.
	user, err := store.FindUserByEmail(r.Context(), tx, email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, err)
		return
	}
	taken := user != nil
	if taken {
		// Nothing this branch writes survives the request. The address is
		// synthetic and unreachable (RFC 2606 reserves .invalid) so that even a
		// failure to discard could not leave a row claiming somebody's mailbox,
		// and the id is fresh so it collides with nothing.
		email = "signup-" + newID() + "@shadow.invalid"
		tenant.DiscardChanges(r.Context())
	}

	passwordHash, err := auth.HashPassword(req.Owner.Password)
	if err != nil {
		writeError(w, r, domain.Internal("could not hash the password").WithCause(err))
		return
	}
	user = &store.User{
		ID: newID(), Email: email, Name: req.Owner.Name, PasswordHash: passwordHash,
	}
	if err := store.CreateUser(r.Context(), tx, *user); err != nil {
		writeError(w, r, err)
		return
	}

	farmID := newID()
	// The farm becomes the tenant of this transaction the moment its id
	// exists, which is what lets the farms and memberships rows satisfy their
	// own RLS policies without any bypass.
	ctx, err := tenant.SetForSignup(r.Context(), tx, farmID, user.ID)
	if err != nil {
		writeError(w, r, err)
		return
	}

	if err := store.CreateFarm(ctx, tx, store.NewFarm{
		ID: farmID, Name: req.Farm.Name, Timezone: req.Farm.Timezone,
		Currency: req.Farm.Currency, PriceMinor: req.Farm.PriceCents,
	}); err != nil {
		writeError(w, r, err)
		return
	}
	if err := store.CreateMembership(ctx, tx, farmID, user.ID, domain.RoleOwner); err != nil {
		writeError(w, r, err)
		return
	}
	if err := seedFarm(ctx, tx, farmID, req.Farm.PriceCents); err != nil {
		writeError(w, r, err)
		return
	}

	secret, hash, err := auth.NewOpaqueToken()
	if err != nil {
		writeError(w, r, domain.Internal("could not mint a verification token").WithCause(err))
		return
	}
	if err := store.InsertEmailVerification(ctx, tx, newID(), user.ID, farmID, hash,
		time.Now().Add(48*time.Hour)); err != nil {
		writeError(w, r, err)
		return
	}

	// The body says what happened to the REQUEST, and nothing about the
	// account: an id here would be the oracle again, in the one place the two
	// branches cannot both tell the truth. farmId and userId are on the
	// verify-email response instead, where the caller has proved the address.
	// The attempt row records what actually happened. It used to be written
	// with `true` on every path, including the rejected ones.
	succeeded = true

	body := map[string]any{"verificationRequired": true}
	if s.cfg.DevEcho {
		// There is no mail sender in sprint 1. Echoing the token is a
		// development affordance and the server refuses to start with it on
		// outside development.
		//
		// The discarded branch echoes its discarded token, so development
		// answers exactly what production answers. It verifies nothing — the
		// row it names was rolled back — and returns the same 400 an expired
		// link returns, which is the truth about a registration that did not
		// happen.
		body["verificationToken"] = secret
	}
	writeJSON(w, http.StatusCreated, body)
}

// handleCreateFarm adds another farm to the account that is already logged in.
//
// This is the half of the old signup that could not stay public. Creating a
// second farm for an existing address needed proof that the caller owns that
// address, the only proof a public endpoint could ask for was the password, and
// asking for a password without issuing a session turned the registration form
// into a place to test guesses. A session IS that proof, and it is one the
// account can see, revoke and rate-limit.
//
// # What it means for the console
//
// The screen that used to POST /v1/signup with an existing owner's credentials
// must now POST /v1/farms with that owner's access token, and drop the password
// field from the form. The response carries the new farm's id; the caller's
// current token is still pinned to the OLD farm — the tenant travels in the
// token and this route does not mint one — so the console switches by logging in
// again with `farmId`, exactly as it already does for an account that belongs to
// several farms.
//
// # Who may call it
//
// Any member of any farm, and that is deliberate. Owning a farm is a property of
// the ACCOUNT, not of the role it holds somewhere else: a person who keeps the
// scale on a neighbour's farm and wants a farm of their own would otherwise have
// to register a second email address to get one, which teaches exactly the habit
// this cap exists to discourage. The cap is what bounds it, and the cap is per
// account.
func (s *Server) handleCreateFarm(w http.ResponseWriter, r *http.Request) {
	var req struct {
		// ID names the farm, and is what makes this write idempotent by
		// (farm_id, id) like every other write in this service. A double click
		// on a "create farm" button is a real event with real consequences —
		// two farms, one of them empty and permanently counted against the cap
		// — and the console has already been bitten once by a double click
		// (web audit A1, which paid a worker twice).
		ID         string `json:"id"`
		Name       string `json:"name"`
		Timezone   string `json:"timezone"`
		Currency   string `json:"currency"`
		PriceCents int64  `json:"priceCents"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, r, domain.BadRequest("name is required"))
		return
	}
	if req.PriceCents <= 0 {
		writeError(w, r, domain.BadRequest("priceCents must be positive"))
		return
	}
	if req.Timezone == "" {
		req.Timezone = "America/Bogota"
	}
	if req.Currency == "" {
		req.Currency = "COP"
	}

	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	p, _ := auth.PrincipalFrom(r.Context())

	// A bad IANA name is refused before the farm exists rather than after, for
	// the reason handleUpdateFarm gives: the CHECK raises while it is being
	// evaluated, which aborts the transaction and leaves nothing but a 500.
	ok, err := store.IsKnownTimezone(r.Context(), tx, req.Timezone)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if !ok {
		writeError(w, r, domain.BadRequest("that is not a valid IANA timezone name"))
		return
	}

	// The idempotency check comes before the cap, and the order is the same one
	// addLedgerEntry argues for: a retry of a farm this account already made
	// must not be refused by a limit that its own first attempt filled up.
	//
	// It looks the farm up THROUGH the membership, so a resend answers only for
	// a farm this account is actually in. An id that belongs to somebody else is
	// invisible here and collides on the primary key below, where it is a 409
	// and never a farm quietly handed over.
	if req.ID != "" {
		var name, tz, currency, role string
		err := tx.QueryRow(r.Context(), `
			SELECT f.name, f.timezone, f.currency, m.role::text
			  FROM farms f
			  JOIN memberships m ON m.farm_id = f.id AND m.user_id = $2
			 WHERE f.id = $1`, req.ID, p.UserID).Scan(&name, &tz, &currency, &role)
		if err == nil {
			owned, err := store.CountOwnedFarms(r.Context(), tx, p.UserID)
			if err != nil {
				writeError(w, r, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"farmId": req.ID, "name": name, "timezone": tz, "currency": currency,
				"role": role, "owned": owned, "limit": s.cfg.MaxFarmsPerEmail,
			})
			return
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, r, err)
			return
		}
	}

	// The cap, in the one place that knows whose account this is. The count runs
	// against `memberships`, whose policy is `farm_id = current_farm() OR
	// user_id = current_user_id()`, and app.user_id is set by the tenant
	// middleware from the token — so unlike the signup this was lifted out of,
	// it is a count of real rows and not RLS answering zero.
	owned, err := store.CountOwnedFarms(r.Context(), tx, p.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if owned >= s.cfg.MaxFarmsPerEmail {
		writeError(w, r, domain.Coded(http.StatusConflict, domain.CodeFarmLimitReached,
			"that account already owns as many farms as it may").
			WithDetails(map[string]any{"owned": owned, "limit": s.cfg.MaxFarmsPerEmail}))
		return
	}

	// From here the transaction belongs to the NEW farm: its rows have to
	// satisfy their own RLS policies, and the caller's old tenant would refuse
	// every one of them. Nothing else runs in this request afterwards.
	farmID := req.ID
	if farmID == "" {
		farmID = newID()
	}
	ctx, err := tenant.SetForSignup(r.Context(), tx, farmID, p.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := store.CreateFarm(ctx, tx, store.NewFarm{
		ID: farmID, Name: req.Name, Timezone: req.Timezone,
		Currency: req.Currency, PriceMinor: req.PriceCents,
	}); err != nil {
		// The id exists and the lookup above could not see it, which means it
		// belongs to a farm this account is not in. Naming it would confirm
		// another account's id, so it gets the answer every other reused id
		// gets here.
		if store.IsUniqueViolation(err, "") {
			writeError(w, r, domain.Conflict(domain.CodeIdempotencyKeyReused,
				"that id is already in use"))
			return
		}
		writeError(w, r, err)
		return
	}
	if err := store.CreateMembership(ctx, tx, farmID, p.UserID, domain.RoleOwner); err != nil {
		writeError(w, r, err)
		return
	}
	if err := seedFarm(ctx, tx, farmID, req.PriceCents); err != nil {
		writeError(w, r, err)
		return
	}

	// No token comes back, and that is not an omission. The tenant travels in
	// the access token; minting one here would hand the caller a second live
	// session they did not ask for and cannot see in a list. They log in again
	// with this farmId when they want to work in it.
	writeJSON(w, http.StatusCreated, map[string]any{
		"farmId":   farmID,
		"name":     req.Name,
		"timezone": req.Timezone,
		"currency": req.Currency,
		"role":     domain.RoleOwner,
		"owned":    owned + 1,
		"limit":    s.cfg.MaxFarmsPerEmail,
	})
}

// seedFarm gives a new farm the minimum it needs to weigh coffee on day one: a
// kilo, and a "Recoleccion" activity priced from the weekly price table, which
// is exactly the behaviour the phone already has.
func seedFarm(ctx context.Context, tx pgx.Tx, farmID string, priceMinor int64) error {
	if err := store.SeedCatalogs(ctx, tx, farmID, newID); err != nil {
		return err
	}
	unitID, err := store.EnsureWorkUnit(ctx, tx, farmID, newID(), "kg", "Kilo", ptrFloat(1))
	if err != nil {
		return err
	}
	_, err = store.CreateActivity(ctx, tx, farmID, store.NewActivity{
		ID:         newID(),
		Name:       "Recoleccion",
		Category:   "cosecha", // one of the seeded categories
		PayScheme:  domain.PaySchemeWorkUnit,
		RateSource: domain.RateWeeklyPrice,
		UnitID:     &unitID,
		Rate: store.ActivityRate{
			ValidFrom: time.Now().UTC().AddDate(-1, 0, 0),
			RateMinor: priceMinor,
		},
	}, newID)
	return err
}

// ---------------------------------------------------------------------------
// Login, refresh, logout
// ---------------------------------------------------------------------------

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	FarmID   string `json:"farmId"`
	DeviceID string `json:"deviceId"`
}

type sessionResponse struct {
	AccessToken  string      `json:"accessToken"`
	RefreshToken string      `json:"refreshToken"`
	ExpiresIn    int         `json:"expiresIn"`
	FarmID       string      `json:"farmId"`
	FarmName     string      `json:"farmName"`
	Role         domain.Role `json:"role"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	invalid := domain.Coded(http.StatusUnauthorized, domain.CodeInvalidCredentials,
		"email or password is not correct")

	user, err := store.FindUserByEmail(r.Context(), tx, strings.ToLower(strings.TrimSpace(req.Email)))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Same answer whether the address exists or not.
			writeError(w, r, invalid)
			return
		}
		writeError(w, r, err)
		return
	}
	ok, err := auth.VerifyPassword(req.Password, user.PasswordHash)
	if err != nil || !ok {
		writeError(w, r, invalid)
		return
	}
	if user.EmailVerifiedAt == nil {
		writeError(w, r, domain.Coded(http.StatusForbidden, domain.CodeEmailNotVerified,
			"verify the email address before opening a session"))
		return
	}

	// The memberships policy lets a user read their own rows once app.user_id
	// is set. This is how the farm list exists before a farm is chosen.
	if err := tenant.SetUser(r.Context(), tx, user.ID); err != nil {
		writeError(w, r, err)
		return
	}
	memberships, err := store.ListMemberships(r.Context(), tx, user.ID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if len(memberships) == 0 {
		writeError(w, r, domain.Forbidden("that account belongs to no farm"))
		return
	}

	var chosen *store.Membership
	switch {
	case req.FarmID != "":
		for i := range memberships {
			if memberships[i].FarmID == req.FarmID {
				chosen = &memberships[i]
			}
		}
		if chosen == nil {
			writeError(w, r, domain.Forbidden("that account does not belong to that farm"))
			return
		}
	case len(memberships) == 1:
		chosen = &memberships[0]
	default:
		farms := make([]map[string]any, 0, len(memberships))
		for _, m := range memberships {
			farms = append(farms, map[string]any{"id": m.FarmID, "name": m.FarmName, "role": m.Role})
		}
		writeError(w, r, domain.BadRequest("choose a farm").
			WithDetails(map[string]any{"farms": farms}))
		return
	}
	if chosen.SuspendedAt != nil {
		writeError(w, r, domain.Coded(http.StatusForbidden, domain.CodeFarmSuspended,
			"that farm is suspended"))
		return
	}

	session, err := s.issueSession(r, tx, user, chosen, req.DeviceID, newID())
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

// issueSession mints the pair: a short access token carrying sub, farm_id and
// role, and an opaque refresh token whose sha256 is all Postgres keeps.
func (s *Server) issueSession(r *http.Request, tx pgx.Tx, user *store.User,
	m *store.Membership, deviceID, familyID string) (*sessionResponse, error) {

	access, err := s.signer.Issue(user.ID, m.FarmID, m.Role, deviceID, user.IsSuperadmin)
	if err != nil {
		return nil, domain.Internal("could not issue the access token").WithCause(err)
	}
	secret, hash, err := auth.NewOpaqueToken()
	if err != nil {
		return nil, domain.Internal("could not mint a refresh token").WithCause(err)
	}
	var device *string
	if deviceID != "" {
		device = &deviceID
	}
	if err := store.InsertRefreshToken(r.Context(), tx, store.RefreshToken{
		ID: newID(), FamilyID: familyID, UserID: user.ID, FarmID: m.FarmID,
		DeviceID: device, ExpiresAt: time.Now().Add(auth.RefreshTTL),
	}, hash); err != nil {
		return nil, err
	}
	return &sessionResponse{
		AccessToken: access, RefreshToken: secret,
		ExpiresIn: int(auth.AccessTTL.Seconds()),
		FarmID:    m.FarmID, FarmName: m.FarmName, Role: m.Role,
	}, nil
}

type refreshRequest struct {
	RefreshToken string `json:"refreshToken"`
	DeviceID     string `json:"deviceId"`
}

// handleRefresh rotates. Every refresh token is single use: presenting one
// that was already rotated means a replay or a stolen copy, and the whole
// family dies rather than the request merely failing.
func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req refreshRequest
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	tok, err := store.FindRefreshToken(r.Context(), tx, auth.HashToken(req.RefreshToken))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, r, domain.Coded(http.StatusUnauthorized, domain.CodeTokenExpired,
				"that refresh token is not valid"))
			return
		}
		writeError(w, r, err)
		return
	}
	if tok.RevokedAt != nil {
		writeError(w, r, domain.Coded(http.StatusUnauthorized, domain.CodeTokenReused,
			"that session was closed"))
		return
	}
	if tok.RotatedAt != nil {
		// Reuse: a replay, or a stolen copy. The whole family dies.
		//
		// The revocation has to SURVIVE this response, and this response is a
		// 401, which the tenant middleware rolls back. It is done here, in the
		// request's own transaction, and kept with tenant.KeepChanges — ONE
		// connection, which is the whole point.
		//
		// It used to be done twice: once here and once on a second pool
		// connection so it would outlive the rollback. That took the platform
		// down two different ways. The second connection waited on row locks
		// this transaction held and could not release until the handler
		// returned — a deadlock Postgres cannot see as one, because the waiting
		// side is the application. And a handler that holds one of the ten pool
		// connections while asking for a second needs two to make progress, so
		// a dozen concurrent requests exhaust the pool with no lock involved at
		// all. Both left every farm unable to log in, and /health kept
		// answering through both because it touches no database.
		//
		// The trigger is the ordinary path, not an attack: a handset on two
		// bars of signal refreshes, loses the reply, and retries with the same
		// token.
		if err := store.RevokeFamily(r.Context(), tx, tok.FamilyID); err != nil {
			// Not swallowed. A revocation that failed leaves a token somebody
			// may have stolen alive, and answering "the session has been
			// closed" would be a lie about the one thing this branch is for.
			writeError(w, r, domain.Internal(
				"could not close the reused session").WithCause(err))
			return
		}
		// Everything this transaction has written is exactly the revocation
		// above, which is the obligation KeepChanges puts on its caller.
		tenant.KeepChanges(r.Context())
		writeError(w, r, domain.Coded(http.StatusUnauthorized, domain.CodeTokenReused,
			"that refresh token was already used; the session has been closed"))
		return
	}
	if time.Now().After(tok.ExpiresAt) {
		writeError(w, r, domain.Coded(http.StatusUnauthorized, domain.CodeTokenExpired,
			"that refresh token expired"))
		return
	}

	user, err := store.FindUserByID(r.Context(), tx, tok.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := tenant.SetUser(r.Context(), tx, user.ID); err != nil {
		writeError(w, r, err)
		return
	}
	m, err := store.GetMembership(r.Context(), tx, tok.FarmID, tok.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if m.SuspendedAt != nil {
		writeError(w, r, domain.Coded(http.StatusForbidden, domain.CodeFarmSuspended,
			"that farm is suspended"))
		return
	}
	if err := store.MarkRefreshRotated(r.Context(), tx, tok.ID); err != nil {
		writeError(w, r, err)
		return
	}

	device := req.DeviceID
	if device == "" && tok.DeviceID != nil {
		device = *tok.DeviceID
	}
	session, err := s.issueSession(r, tx, user, m, device, tok.FamilyID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	var req refreshRequest
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	tok, err := store.FindRefreshToken(r.Context(), tx, auth.HashToken(req.RefreshToken))
	if err == nil {
		if err := store.RevokeFamily(r.Context(), tx, tok.FamilyID); err != nil {
			writeError(w, r, err)
			return
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, err)
		return
	}
	// Logging out an unknown token is still a successful logout.
	writeJSON(w, http.StatusNoContent, nil)
}

type verifyEmailRequest struct {
	Token string `json:"token"`
}

func (s *Server) handleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	var req verifyEmailRequest
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	userID, farmID, err := store.ConsumeEmailVerification(r.Context(), tx, auth.HashToken(req.Token))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, r, domain.BadRequest("that verification link is not valid any more"))
			return
		}
		writeError(w, r, err)
		return
	}
	// farmId is here and not on the signup response, and the difference is the
	// whole of finding 12's second half: this caller has proved the address is
	// theirs by presenting something that was sent to it. See handleSignup.
	writeJSON(w, http.StatusOK, map[string]any{
		"userId": userID, "farmId": farmID, "verified": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.PrincipalFrom(r.Context())
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	user, err := store.FindUserByID(r.Context(), tx, p.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	m, err := store.GetMembership(r.Context(), tx, p.FarmID, p.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":    user.ID,
		"email": user.Email,
		"name":  user.Name,
		"role":  m.Role,
		"farm": map[string]any{
			"id": m.FarmID, "name": m.FarmName,
			"timezone": m.Timezone, "currency": m.Currency,
		},
		"superadmin": user.IsSuperadmin,
	})
}

// clientIP is the address the rate limit counts and signup_attempts records.
//
// It reads what the ClientIPFrom* middleware in buildRouter established and
// asks no questions about how. That indirection is the fix: this function used
// to parse r.RemoteAddr, which middleware.RealIP had already overwritten with
// an attacker-supplied header, so the one place in the codebase that looks
// like it is reading the socket was reading the request body's neighbour
// instead. Whether a header may move the address is now one decision, taken
// once, in Config.TrustedProxyCIDRs.
//
// The fallback is only reachable when RemoteAddr held nothing parseable as an
// address, which for net/http means a listener that is not TCP. Writing to a
// NOT NULL inet column beats failing a signup over it, and everything from
// such a listener lands in the same bucket, which is the conservative way to
// be wrong.
func clientIP(r *http.Request) string {
	if ip := middleware.GetClientIP(r.Context()); ip != "" {
		return ip
	}
	return "127.0.0.1"
}

func newID() string {
	// UUIDv7: the timestamp lives in the high bits, so rows insert at the end
	// of the B-tree instead of scattering it, and ORDER BY id is almost
	// chronological. Clients may send their own; this is the fallback.
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.NewString()
	}
	return id.String()
}

func ptrFloat(f float64) *float64 { return &f }
