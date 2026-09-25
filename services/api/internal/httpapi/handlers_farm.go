package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// handleGetFarm returns the farm the token points at. There is no
// /v1/farms/{id}: the tenant travels in the token and a farm id in the path
// invites somebody to trust it.
//
// The weigher gets the same route and a shorter answer: priceCents is dropped
// for him, because that is the price of a kilo and §6 keeps prices away from
// the scale. His client still needs the timezone and the currency to render a
// date and an amount, so those stay.
func (s *Server) handleGetFarm(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	farm, err := store.GetFarm(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if !callerSeesPrivateData(r) {
		farm.PriceMinor = nil
	}
	writeJSON(w, http.StatusOK, farm)
}

// handleUpdateFarm is the configuration screen. Owner only.
func (s *Server) handleUpdateFarm(w http.ResponseWriter, r *http.Request) {
	var body store.Farm
	// decodeNulls, not decode: an emptied box arrives as an explicit null and
	// must clear the field rather than read as "not mentioned".
	cleared, err := decodeNulls(r, &body)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if body.PriceMinor != nil && *body.PriceMinor <= 0 {
		writeError(w, r, domain.BadRequest("priceCents must be positive"))
		return
	}
	// farms.area_ha is numeric(10, 3).
	if err := checkFixedScale("areaHa", body.AreaHa,
		domain.AreaPrecision, domain.AreaScale); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	if body.Timezone != "" {
		// Checked before the UPDATE rather than after. The database refuses a
		// bad IANA name too, but it does so by raising while evaluating the
		// CHECK, which aborts the transaction and leaves nothing but a 500 to
		// return. Asking Postgres for its own list first turns "every business
		// day this farm ever recorded shifts by a day" into a form error.
		ok, err := store.IsKnownTimezone(r.Context(), tx, body.Timezone)
		if err != nil {
			writeError(w, r, err)
			return
		}
		if !ok {
			writeError(w, r, domain.BadRequest("that is not a valid IANA timezone name"))
			return
		}
	}

	updated, err := store.UpdateFarm(r.Context(), tx, body, cleared)
	if err != nil {
		if store.IsCheckViolation(err, "farms_tz_valid") {
			writeError(w, r, domain.BadRequest("that is not a valid IANA timezone name"))
			return
		}
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// ---------------------------------------------------------------------------
// The super-admin console
// ---------------------------------------------------------------------------

// handleListAdminFarms lists the farms on the platform. Public signup is still
// the self-serve door; this console lists, creates and suspends. It still
// cannot read an employee, a work record or a peso of anybody's money, and the
// projection here is the enforcement of that — every column returned is a
// column of `farms`, and none of them is a way to infer what is inside.
func (s *Server) handleListAdminFarms(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	status := r.URL.Query().Get("status")
	switch status {
	case "", "active", "suspended":
	default:
		writeError(w, r, domain.BadRequest(`status must be "active" or "suspended"`))
		return
	}
	farms, err := store.ListAdminFarms(r.Context(), tx, r.URL.Query().Get("q"), status)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": farms})
}

type adminCreateFarmRequest struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Slug       string `json:"slug"`
	Timezone   string `json:"timezone"`
	Currency   string `json:"currency"`
	PriceCents int64  `json:"priceCents"`
	Owner      struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Password string `json:"password"`
	} `json:"owner"`
}

// handleCreateAdminFarm is the operator door: a farm plus its first owner,
// active and verified, without going through public signup.
//
// The address is marked verified because the platform administrator vouched
// for it — the same act as an invite, not the mailbox token of open signup.
// An existing account is attached as owner and its password is not touched.
// A new account gets a password the caller typed, or one minted here and
// returned ONCE, the way invite already does.
//
// The farms-per-email cap does not apply: that ceiling is for self-serve
// signup, not for the person who runs the platform.
func (s *Server) handleCreateAdminFarm(w http.ResponseWriter, r *http.Request) {
	var req adminCreateFarmRequest
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
	email := strings.TrimSpace(strings.ToLower(req.Owner.Email))
	if email == "" || !strings.Contains(email, "@") {
		writeError(w, r, domain.BadRequest("owner.email is required"))
		return
	}
	if req.Owner.Password != "" && len(req.Owner.Password) < 10 {
		writeError(w, r, domain.BadRequest("password must be at least 10 characters"))
		return
	}
	if len(req.Owner.Password) > auth.MaxPasswordLength {
		writeError(w, r, domain.BadRequest("password is too long"))
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
	ok, err := store.IsKnownTimezone(r.Context(), tx, req.Timezone)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if !ok {
		writeError(w, r, domain.BadRequest("that is not a valid IANA timezone name"))
		return
	}

	if req.ID != "" {
		if existing, err := store.GetAdminFarm(r.Context(), tx, req.ID); err == nil {
			writeJSON(w, http.StatusOK, existing)
			return
		} else if !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, r, err)
			return
		}
	}

	user, err := store.FindUserByEmail(r.Context(), tx, email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, err)
		return
	}

	ownerCreated := false
	var temporary string
	if user == nil {
		temporary = req.Owner.Password
		if temporary == "" {
			temporary, err = newTemporaryPassword()
			if err != nil {
				writeError(w, r, domain.Internal("could not mint a password").WithCause(err))
				return
			}
		}
		hash, hashErr := auth.HashPassword(temporary)
		if hashErr != nil {
			writeError(w, r, domain.Internal("could not hash the password").WithCause(hashErr))
			return
		}
		name := strings.TrimSpace(req.Owner.Name)
		user = &store.User{ID: newID(), Email: email, Name: name, PasswordHash: hash}
		if err := store.CreateUser(r.Context(), tx, *user); err != nil {
			writeError(w, r, err)
			return
		}
		if err := store.VerifyUserEmail(r.Context(), tx, user.ID); err != nil {
			writeError(w, r, err)
			return
		}
		ownerCreated = true
	} else if user.EmailVerifiedAt == nil {
		if err := store.VerifyUserEmail(r.Context(), tx, user.ID); err != nil {
			writeError(w, r, err)
			return
		}
	}

	farmID := req.ID
	if farmID == "" {
		farmID = newID()
	}
	ctx, err := tenant.SetForSignup(r.Context(), tx, farmID, user.ID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := createFarmRecord(ctx, tx, &store.NewFarm{
		ID: farmID, Name: req.Name, Timezone: req.Timezone,
		Currency: req.Currency, PriceMinor: req.PriceCents,
	}, req.Slug); err != nil {
		if store.IsUniqueViolation(err, "") {
			writeError(w, r, domain.Conflict(domain.CodeIdempotencyKeyReused,
				"that id is already in use"))
			return
		}
		writeError(w, r, err)
		return
	}
	if err := store.CreateMembership(ctx, tx, farmID, user.ID, domain.RoleOwner); err != nil {
		writeError(w, r, err)
		return
	}
	if err := seedFarm(ctx, tx, farmID, req.PriceCents); err != nil {
		writeError(w, r, err)
		return
	}

	farm, err := store.GetAdminFarm(ctx, tx, farmID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	s.kickTenantProvision(tenantProvision{
		Slug: farm.Slug, FarmName: farm.Name,
		Email: email, OwnerName: user.Name,
	})
	out := map[string]any{
		"id": farm.ID, "name": farm.Name, "slug": farm.Slug, "timezone": farm.Timezone,
		"currency": farm.Currency, "country": farm.Country, "city": farm.City,
		"status": farm.Status, "suspendedAt": farm.SuspendedAt,
		"createdAt":  farm.CreatedAt,
		"ownerEmail": email, "ownerCreated": ownerCreated,
	}
	if ownerCreated && req.Owner.Password == "" {
		out["temporaryPassword"] = temporary
		out["temporaryPasswordNote"] = "shown once: hand it over now, it cannot be read again"
	}
	writeJSON(w, http.StatusCreated, out)
}

// handleSetFarmStatus suspends a farm or brings it back.
//
// Suspension is not a delete, and it takes effect on the NEXT REQUEST.
//
// It used to take up to fifteen minutes, because login and refresh were the only
// two doors that looked: an access token issued a minute before the suspension
// kept working until it expired, and the farm went on settling, paying and
// voiding for a quarter of an hour after somebody decided it must not. The check
// lives in tenant.setContext now — in the round trip that pins the transaction to
// the farm, so it costs nothing extra — and every authenticated route answers 403
// FARM_SUSPENDED at once. The access token stays long, because the handset that
// spends the day without signal is the one that would pay for a short one.
func (s *Server) handleSetFarmStatus(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Status string `json:"status"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	switch body.Status {
	case "active", "suspended":
	default:
		writeError(w, r, domain.BadRequest(`status must be "active" or "suspended"`))
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	farm, err := store.SetFarmStatus(r.Context(), tx, chi.URLParam(r, "id"), body.Status)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, farm)
}
