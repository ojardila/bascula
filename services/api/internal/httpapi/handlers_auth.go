package httpapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

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
// a per-IP rate limit that survives a restart because it lives in Postgres, a
// cap on farms per email address, and mandatory email verification.
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
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	// The attempt is recorded outside the request transaction on purpose: a
	// rejected signup rolls that transaction back, and a rate limit that
	// forgets every failure is not a rate limit.
	defer func() {
		_, _ = s.pool.Exec(r.Context(),
			`INSERT INTO signup_attempts (id, ip, email, succeeded) VALUES ($1, $2::inet, $3, $4)`,
			uuid.NewString(), ip, email, true)
	}()

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

	// An existing address may open a second farm, but only by proving it owns
	// the account, and only up to the cap.
	user, err := store.FindUserByEmail(r.Context(), tx, email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, err)
		return
	}
	if user != nil {
		ok, verifyErr := auth.VerifyPassword(req.Owner.Password, user.PasswordHash)
		if verifyErr != nil || !ok {
			writeError(w, r, domain.Coded(http.StatusConflict, domain.CodeEmailTaken,
				"that address already has an account"))
			return
		}
		// The count runs against `memberships`, whose policy is
		// `farm_id = current_farm() OR user_id = current_user_id()`. At this
		// point in a signup NEITHER is set: there is no token, no farm has
		// been generated yet, and app.user_id is still empty. RLS therefore
		// answered every count with 0 and the cap never once fired — the
		// silent zero this codebase spends three documents refusing, sitting
		// in the limit that is supposed to hold the most exposed surface in
		// the system.
		//
		// The user is pinned first. It is the same pin login uses before a
		// farm is chosen, and SetForSignup overwrites it a few lines below
		// with the pair the farm's own rows need.
		if err := tenant.SetUser(r.Context(), tx, user.ID); err != nil {
			writeError(w, r, err)
			return
		}
		owned, err := store.CountOwnedFarms(r.Context(), tx, user.ID)
		if err != nil {
			writeError(w, r, err)
			return
		}
		if owned >= s.cfg.MaxFarmsPerEmail {
			writeError(w, r, domain.Coded(http.StatusConflict, domain.CodeFarmLimitReached,
				"that address already owns as many farms as it may"))
			return
		}
	} else {
		hash, err := auth.HashPassword(req.Owner.Password)
		if err != nil {
			writeError(w, r, domain.Internal("could not hash the password").WithCause(err))
			return
		}
		user = &store.User{
			ID: newID(), Email: email, Name: req.Owner.Name, PasswordHash: hash,
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

	body := map[string]any{
		"farmId":               farmID,
		"userId":               user.ID,
		"verificationRequired": true,
	}
	if s.cfg.DevEcho {
		// There is no mail sender in sprint 1. Echoing the token is a
		// development affordance and the server refuses to start with it on
		// outside development.
		body["verificationToken"] = secret
	}
	writeJSON(w, http.StatusCreated, body)
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
	userID, err := store.ConsumeEmailVerification(r.Context(), tx, auth.HashToken(req.Token))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, r, domain.BadRequest("that verification link is not valid any more"))
			return
		}
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"userId": userID, "verified": true})
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

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || host == "" {
		if r.RemoteAddr != "" {
			return r.RemoteAddr
		}
		return "127.0.0.1"
	}
	return host
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
