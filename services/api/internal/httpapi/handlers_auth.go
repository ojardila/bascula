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
		Slug       string `json:"slug"`
		Timezone   string `json:"timezone"`
		Currency   string `json:"currency"`
		PriceCents int64  `json:"priceCents"`
	} `json:"farm"`
	Owner struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Phone    string `json:"phone"`
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
//	201 {"verificationRequired": false}
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
	// And a ceiling, which is not a strength rule: the hash below is paid for
	// by the server and priced by the caller. See auth.MaxPasswordLength.
	if len(req.Owner.Password) > auth.MaxPasswordLength {
		writeError(w, r, domain.BadRequest("owner.password is too long"))
		return
	}
	if strings.TrimSpace(req.Farm.Name) == "" {
		writeError(w, r, domain.BadRequest("farm.name is required"))
		return
	}
	priceChosen := req.Farm.PriceCents > 0
	if !priceChosen {
		// Not asked on the landing. Seed Recolección at a standing peso-per-kilo
		// so the farm can weigh on day one, but leave it UNCONFIRMED: the
		// onboarding tour's first step asks the owner to confirm or change it,
		// instead of silently paying $800 a kilo.
		req.Farm.PriceCents = 80000
	}
	if req.Farm.Timezone == "" {
		req.Farm.Timezone = "America/Bogota"
	}
	if req.Farm.Currency == "" {
		req.Farm.Currency = "COP"
	}

	ip := clientIP(r)
	// The address as it arrived, which is what the attempt row records.
	attempted := email
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	// ── THE COUNTS COME FIRST, AND NOTHING IS RECORDED ABOVE THEM ─────────
	//
	// The attempt row is registered BELOW both caps, and the order is the whole
	// of the fix. It used to be registered here, before them, and the
	// consequence was not a slower limiter, it was a weapon:
	//
	// tenant.AfterRequest runs on EVERY exit path — that is the property that
	// makes the audit row survive a rejected signup, and it is the right
	// property. But a request the by-email cap had already refused with 429
	// still ran the callback, so the refusal wrote a row for the address it
	// refused, and the sliding window never drained while somebody went on
	// knocking. About five unauthenticated requests an hour, from anywhere,
	// held a chosen address permanently unable to register. Farm owners'
	// addresses are on cooperative rosters, invoices and WhatsApp; the victim
	// saw a generic rate-limit answer, with no way to tell they were being held
	// out and no way to clear it. The attacker paid nothing, because being
	// throttled is not what they were trying to avoid.
	//
	// A counter fed by its own refusals is not a limiter. `succeeded` cannot
	// fix it either — a genuine failed signup must still count — because the
	// distinction that matters is "did this request get as far as trying to
	// create something", and only the position of this registration records
	// that. handleLogin's limiter is the same shape and got it right by not
	// recording an attempt it had already refused; this is that, here.
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

	// Past both caps, so this request is going to TRY to create something, and
	// that is what an attempt is. Everything from here on is recorded whatever
	// happens next — a duplicate address, a bad timezone, a database error, a
	// panic — because all of those are attempts that reached the creation path,
	// and the counters are supposed to see them.
	//
	// The write is outside the request transaction on purpose: a rejected
	// signup rolls that transaction back, and a rate limit that forgets every
	// failure is not a rate limit.
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

	// An address that already has an account is not a reason to stop.
	//
	// Every farm is its own world — its own address and, on a dedicated stack,
	// its own database — and the same person may own several. So a
	// registration with an address that already has an account creates the new
	// farm exactly like any other and makes that account its owner. What the
	// person typed belongs to THAT farm: the name and the password go to
	// farm_owner_credentials (migration 00032), and the seed of the farm's own
	// stack reads them before the users row, so the owner signs in on
	// {slug}.bascula.engp.io with the password they just chose.
	//
	// The account's global password — the one the main domain checks — is
	// never touched, and nothing about the account flows back: a stranger who
	// registers a farm with somebody else's address gets a farm of their own
	// with the password they typed, and cannot read or change anything of that
	// person's. The answer is the same for both branches (201,
	// verificationRequired false), so it still says nothing about whether the
	// address is registered, and both branches do the same work.
	user, err := store.FindUserByEmail(r.Context(), tx, email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, err)
		return
	}
	existing := user != nil

	passwordHash, err := auth.HashPassword(req.Owner.Password)
	if err != nil {
		writeError(w, r, domain.Internal("could not hash the password").WithCause(err))
		return
	}
	phone := strings.TrimSpace(req.Owner.Phone)
	if !existing {
		user = &store.User{
			ID: newID(), Email: email, Name: req.Owner.Name,
			Phone: phone, PasswordHash: passwordHash,
		}
		if err := store.CreateUser(r.Context(), tx, *user); err != nil {
			writeError(w, r, err)
			return
		}
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

	newFarm := store.NewFarm{
		ID: farmID, Name: req.Farm.Name, Timezone: req.Farm.Timezone,
		Currency: req.Farm.Currency, PriceMinor: req.Farm.PriceCents,
		PriceConfirmed: priceChosen,
	}
	if err := createFarmRecord(ctx, tx, &newFarm, req.Farm.Slug); err != nil {
		writeError(w, r, err)
		return
	}
	if err := store.CreateMembership(ctx, tx, farmID, user.ID, domain.RoleOwner); err != nil {
		writeError(w, r, err)
		return
	}
	if existing {
		if err := store.InsertFarmOwnerCredentials(ctx, tx, farmID, user.ID,
			strings.TrimSpace(req.Owner.Name), phone, passwordHash); err != nil {
			writeError(w, r, err)
			return
		}
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
	// An existing account is already somebody's verified address, and the
	// token development echoes must not become a way to verify it on their
	// behalf; so for that branch the token is minted (same work, same answer)
	// and not stored, and verifies nothing.
	if !existing {
		if err := store.InsertEmailVerification(ctx, tx, newID(), user.ID, farmID, hash,
			time.Now().Add(48*time.Hour)); err != nil {
			writeError(w, r, err)
			return
		}
	}
	// There is still no mail sender. The password they just typed is the
	// proof that they meant this address; waiting for a mailbox that never
	// arrives would strand every farm on the landing. When mail is wired,
	// drop this VerifyUserEmail and let the link in the message do it.
	if !existing {
		if err := store.VerifyUserEmail(r.Context(), tx, user.ID); err != nil {
			writeError(w, r, err)
			return
		}
	}

	// The body says what happened to the REQUEST, and nothing about the
	// account: an id here would be the oracle again, in the one place the two
	// branches cannot both tell the truth. farmId and userId are on the
	// verify-email response instead, where the caller has proved the address.
	// The attempt row records what actually happened. It used to be written
	// with `true` on every path, including the rejected ones.
	succeeded = true
	s.kickTenantProvision(tenantProvision{
		Slug: newFarm.Slug, FarmName: newFarm.Name,
		Email: email, OwnerName: req.Owner.Name, Phone: req.Owner.Phone,
	})

	// Always false now: the farm exists and its owner can sign in, whether or
	// not the address already had an account. The key stays for clients that
	// still read it.
	body := map[string]any{"verificationRequired": false}
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

// handleCreateFarm used to add another farm to the account that is signed in.
// It no longer does, for anybody.
//
// Every farm is its own world: its own address, and on a dedicated stack its
// own database. Inside a farm people create users, workers and everything
// else OF THAT FARM, but never another farm. A new farm starts only from the
// public registration on the main domain (/empezar → POST /v1/signup), and the
// operator's own door stays the super-admin console (POST /v1/admin/farms).
//
// The route stays mounted, answering 403, so an app that still has the old
// "Crear otra finca" screen cached gets a plain refusal instead of a 404 that
// reads like the API vanished.
func (s *Server) handleCreateFarm(w http.ResponseWriter, r *http.Request) {
	writeError(w, r, domain.Coded(http.StatusForbidden, domain.CodeForbidden,
		"a farm cannot create another farm; new farms are registered at https://bascula.engp.io/empezar"))
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
	FarmSlug string `json:"farmSlug"`
	DeviceID string `json:"deviceId"`
}

type sessionResponse struct {
	AccessToken  string      `json:"accessToken"`
	RefreshToken string      `json:"refreshToken"`
	ExpiresIn    int         `json:"expiresIn"`
	FarmID       string      `json:"farmId"`
	FarmName     string      `json:"farmName"`
	Slug         string      `json:"slug"`
	Role         domain.Role `json:"role"`
}

// handleLogin opens a session, and is the one door in this service that an
// unauthenticated stranger is invited to knock on repeatedly. Two things follow
// from that, and neither was here.
//
// # The count
//
// There was no limit of any kind: no lockout, no delay, and no row written
// afterwards. A spray — one common password against every address on the
// platform, then the next password — could run all night at whatever rate the
// network allowed and leave nothing behind to notice it by. signup got a
// Postgres-backed limiter in migration 00002 on the grounds that it was "the
// most exposed surface in the system", which it is not; this is. The counter
// lives in the same place and for the same stated reason: an in-memory bucket
// forgets everything on deploy, and a deploy is a thing an attacker can wait
// for.
//
// # The clock
//
// The two branches below answered the same status and the same body, and the
// comment on the old one — "Same answer whether the address exists or not" —
// was true about the bytes and false about the reply. An address with no
// account returned in about a millisecond because it returned BEFORE the
// Argon2id verification; an address with one paid 19 MiB and tens of
// milliseconds first. An order of magnitude, readable with `curl -w
// %{time_total}` from anywhere in the world, is a working answer to "does this
// person bank here" — which handleSignup goes to the trouble of
// the same answer for every address to avoid giving, on the strength of the argument that
// "a list of addresses that are coffee farm owners in Huila is a phishing
// list". The same list was on offer here, one endpoint away, for free.
//
// So the branch with no account verifies against auth.DecoyHash: the same
// algorithm, the same parameters, the same cost, on a password nobody holds.
// The order of the checks matters as much as the decoy does — everything that
// happens before the verification has to happen for both addresses, or the
// difference simply moves upstream.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	// Refused before the hash and not after it, because the whole point of a
	// maximum is that the expensive part never sees the oversized input. See
	// auth.MaxPasswordLength.
	if len(req.Password) > auth.MaxPasswordLength {
		writeError(w, r, domain.BadRequest("password is too long"))
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	invalid := domain.Coded(http.StatusUnauthorized, domain.CodeInvalidCredentials,
		"email or password is not correct")

	email := strings.ToLower(strings.TrimSpace(req.Email))
	ip := clientIP(r)

	// The limit is consulted BEFORE the account is looked up, which is what
	// keeps it from becoming the oracle the decoy hash below exists to close:
	// a 429 that only ever arrived for real addresses would say exactly what a
	// fast 401 used to say.
	failedForThisPair, failedForIP, err := store.CountLoginFailures(
		r.Context(), tx, email, ip, s.cfg.LoginFailureWindow)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if failedForThisPair >= s.cfg.LoginFailuresPerEmailPerIP || failedForIP >= s.cfg.LoginFailuresPerIP {
		// Nothing is recorded here, and that is the difference between a
		// lockout that ends and one that does not. If a refused attempt also
		// counted, an attacker could hold somebody's address locked for ever by
		// going on knocking after the door had already been shut to them — the
		// lock would be renewed by the very traffic it was refusing. The window
		// only drains if the refusals stop being written, so they are not.
		//
		// The correct password gets this answer too. That is deliberate: the
		// limit is a property of the door, not of the guess, and a lockout that
		// stepped aside for the right password would tell whoever tripped it
		// that they had just found the right password.
		//
		// It is only safe to say that because BOTH axes are bounded by the
		// caller's own address. A stranger who fills the (victim's address,
		// stranger's IP) bucket has refused themselves and nobody else; the
		// victim's own pair, from their own office, is at zero. See
		// store.CountLoginFailures for why counting an address alone made this
		// same line a way to hold a farm's owner out of their own payroll.
		writeError(w, r, domain.Coded(http.StatusTooManyRequests, domain.CodeRateLimited,
			"too many failed sign-in attempts; try again later"))
		return
	}

	// refuse answers the caller AND keeps the failure, in this request's own
	// transaction. The response is a 401, which the tenant middleware rolls
	// back, so the row would vanish with it.
	//
	// KeepChanges and not AfterRequest, and the distinction is the one
	// AfterRequest's own note draws: it is for a write that must survive its
	// transaction being rolled back, which is signup's problem — the attempt
	// row has to outlive a farm that was refused, and committing the two
	// together would commit the farm. Here there is no half-built anything.
	// When this line runs the transaction has executed nothing but SELECTs, so
	// the row above is the entirety of what gets committed, which is exactly
	// the obligation KeepChanges puts on its caller. One connection, and the
	// count is durable before the 401 leaves rather than shortly after it.
	// handleRefresh is the other handler with this shape.
	refuse := func() {
		if err := store.RecordLoginFailure(r.Context(), tx, newID(), ip, email); err != nil {
			// Not swallowed, and not answered as a 401 either. A limiter that
			// silently fails to count is the state this whole change is about,
			// and a login door that has quietly stopped counting should be
			// loud rather than convenient.
			writeError(w, r, domain.Internal(
				"could not record the failed sign-in").WithCause(err))
			return
		}
		tenant.KeepChanges(r.Context())
		writeError(w, r, invalid)
	}

	user, err := store.FindUserByEmail(r.Context(), tx, email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, err)
		return
	}
	// The hash to check against, which is a real one either way. Reading it out
	// of the user when there is one and out of the decoy when there is not is
	// the ONLY difference the two branches are allowed to have, and it is a
	// pointer read.
	hash := auth.DecoyHash()
	if user != nil {
		hash = user.PasswordHash
	}
	ok, err := auth.VerifyPassword(req.Password, hash)
	// `user == nil` is last in the condition rather than first because it must
	// not short-circuit the verification above out of existence: the work is
	// the point, and an early return placed anywhere before this line puts the
	// millisecond gap straight back.
	if err != nil || !ok || user == nil {
		refuse()
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

	// Host (and X-Forwarded-Host) may pin a farm the caller already belongs
	// to. A slug they cannot see is ignored — same answer as no pin — so a
	// stranger's host does not leak whether that farm exists. JWT farm_id is
	// still the tenant after this; the pin only chooses which membership to
	// open.
	pinnedID, err := loginFarmPin(r.Context(), tx, r, req.FarmSlug)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if pinnedID != "" && req.FarmID != "" && pinnedID != req.FarmID {
		writeError(w, r, domain.BadRequest("farmId does not match the host"))
		return
	}
	if pinnedID != "" {
		req.FarmID = pinnedID
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
			farms = append(farms, map[string]any{
				"id": m.FarmID, "name": m.FarmName, "slug": m.FarmSlug, "role": m.Role,
			})
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
	return s.issueSessionFor(r, tx, user, m, deviceID, familyID, nil)
}

// issueSessionFor is issueSession for a family an OAuth client (an MCP
// connector) holds: oauthClientID tags every token in it, which is what the
// «Conexiones» block in Configuración lists and revokes.
func (s *Server) issueSessionFor(r *http.Request, tx pgx.Tx, user *store.User,
	m *store.Membership, deviceID, familyID string, oauthClientID *string) (*sessionResponse, error) {

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
		OAuthClientID: oauthClientID,
	}, hash); err != nil {
		return nil, err
	}
	return &sessionResponse{
		AccessToken: access, RefreshToken: secret,
		ExpiresIn: int(auth.AccessTTL.Seconds()),
		FarmID:    m.FarmID, FarmName: m.FarmName, Slug: m.FarmSlug, Role: m.Role,
	}, nil
}

// loginFarmPin resolves a farm from the request Host (or farmSlug) if that
// farm is visible to the user already pinned with SetUser. Invisible slugs
// are dropped rather than refused.
func loginFarmPin(ctx context.Context, tx pgx.Tx, r *http.Request, bodySlug string) (string, error) {
	hostID, err := visibleFarmIDBySlug(ctx, tx, farmSlugFromHost(r))
	if err != nil {
		return "", err
	}
	bodyID, err := visibleFarmIDBySlug(ctx, tx, strings.ToLower(strings.TrimSpace(bodySlug)))
	if err != nil {
		return "", err
	}
	if hostID != "" && bodyID != "" && hostID != bodyID {
		return "", domain.BadRequest("farmSlug does not match the host")
	}
	if bodyID != "" {
		return bodyID, nil
	}
	return hostID, nil
}

func visibleFarmIDBySlug(ctx context.Context, tx pgx.Tx, slug string) (string, error) {
	if slug == "" {
		return "", nil
	}
	f, err := store.GetFarmBySlug(ctx, tx, slug)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return f.ID, nil
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
	session, err := s.rotateRefresh(r, tx, req.RefreshToken, req.DeviceID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

// rotateRefresh is the rotation itself, shared by POST /v1/auth/refresh and
// the OAuth token endpoint's refresh_token grant, so an assistant's session
// is exactly as revocable — and a replayed token exactly as fatal — as a
// handset's.
func (s *Server) rotateRefresh(r *http.Request, tx pgx.Tx, secret, deviceID string) (*sessionResponse, error) {
	tok, err := store.FindRefreshToken(r.Context(), tx, auth.HashToken(secret))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.Coded(http.StatusUnauthorized, domain.CodeTokenExpired,
				"that refresh token is not valid")
		}
		return nil, err
	}
	if tok.RevokedAt != nil {
		return nil, domain.Coded(http.StatusUnauthorized, domain.CodeTokenReused,
			"that session was closed")
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
			return nil, domain.Internal(
				"could not close the reused session").WithCause(err)
		}
		// Everything this transaction has written is exactly the revocation
		// above, which is the obligation KeepChanges puts on its caller.
		tenant.KeepChanges(r.Context())
		return nil, domain.Coded(http.StatusUnauthorized, domain.CodeTokenReused,
			"that refresh token was already used; the session has been closed")
	}
	if time.Now().After(tok.ExpiresAt) {
		return nil, domain.Coded(http.StatusUnauthorized, domain.CodeTokenExpired,
			"that refresh token expired")
	}

	user, err := store.FindUserByID(r.Context(), tx, tok.UserID)
	if err != nil {
		return nil, err
	}
	if err := tenant.SetUser(r.Context(), tx, user.ID); err != nil {
		return nil, err
	}
	m, err := store.GetMembership(r.Context(), tx, tok.FarmID, tok.UserID)
	if err != nil {
		return nil, err
	}
	if m.SuspendedAt != nil {
		return nil, domain.Coded(http.StatusForbidden, domain.CodeFarmSuspended,
			"that farm is suspended")
	}
	if err := store.MarkRefreshRotated(r.Context(), tx, tok.ID); err != nil {
		return nil, err
	}

	device := deviceID
	if device == "" && tok.DeviceID != nil {
		device = *tok.DeviceID
	}
	session, err := s.issueSessionFor(r, tx, user, m, device, tok.FamilyID, tok.OAuthClientID)
	if err != nil {
		return nil, err
	}
	return session, nil
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
			"id": m.FarmID, "name": m.FarmName, "slug": m.FarmSlug,
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
