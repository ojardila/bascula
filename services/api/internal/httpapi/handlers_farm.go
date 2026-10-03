// SPDX-License-Identifier: MIT

package httpapi

import (
	"context"
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
			writeError(w, r, domain.BadRequest(msgInvalidTimezone))
			return
		}
	}

	updated, err := store.UpdateFarm(r.Context(), tx, body, cleared)
	if err != nil {
		if store.IsCheckViolation(err, "farms_tz_valid") {
			writeError(w, r, domain.BadRequest(msgInvalidTimezone))
			return
		}
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleSetHarvestMode turns «Modo cosecha» on or off. Owner or administrator.
//
// A route of its own rather than a field of PUT /v1/farm, because that route
// is the owner's alone (it carries the price and the timezone) and this switch
// is one the administrator running the harvest should be able to flip.
func (s *Server) handleSetHarvestMode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.Enabled == nil {
		writeError(w, r, domain.BadRequest("enabled is required (true or false)"))
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	on, err := store.SetHarvestMode(r.Context(), tx, *body.Enabled)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"harvestMode": on})
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
	email, err := adminFarmCheckRequest(&req)
	if err != nil {
		writeError(w, r, err)
		return
	}

	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := adminFarmCheckTimezone(r.Context(), tx, req.Timezone); err != nil {
		writeError(w, r, err)
		return
	}

	if req.ID != "" && adminFarmReplay(w, r, tx, req.ID) {
		return
	}

	user, ownerCreated, temporary, err := adminFarmOwner(r, tx, email, &req)
	if err != nil {
		writeError(w, r, err)
		return
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
	if err := adminFarmCreate(ctx, tx, farmID, user.ID, &req); err != nil {
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
		// Lets the console watch the farm's address come up.
		"provisionTicket": s.provisionTicket(farm.Slug),
	}
	if ownerCreated && req.Owner.Password == "" {
		out["temporaryPassword"] = temporary
		out["temporaryPasswordNote"] = "shown once: hand it over now, it cannot be read again"
	}
	writeJSON(w, http.StatusCreated, out)
}

// adminFarmCheckRequest validates the operator's request, fills the default
// timezone and currency, and returns the owner's normalized email.
func adminFarmCheckRequest(req *adminCreateFarmRequest) (string, error) {
	if strings.TrimSpace(req.Name) == "" {
		return "", domain.BadRequest("name is required")
	}
	// Like signup: these leave the service in the provision-tenant dispatch.
	if err := validFarmName("name", req.Name); err != nil {
		return "", err
	}
	if err := validOwnerName("owner.name", req.Owner.Name); err != nil {
		return "", err
	}
	if req.PriceCents <= 0 {
		return "", domain.BadRequest("priceCents must be positive")
	}
	email := strings.TrimSpace(strings.ToLower(req.Owner.Email))
	if email == "" || !strings.Contains(email, "@") {
		return "", domain.BadRequest("owner.email is required")
	}
	if err := validEmail("owner.email", email); err != nil {
		return "", err
	}
	if req.Owner.Password != "" && len(req.Owner.Password) < 10 {
		return "", domain.BadRequest("password must be at least 10 characters")
	}
	if len(req.Owner.Password) > auth.MaxPasswordLength {
		return "", domain.BadRequest("password is too long")
	}
	if req.Timezone == "" {
		req.Timezone = "America/Bogota"
	}
	if req.Currency == "" {
		req.Currency = "COP"
	}
	return email, nil
}

// adminFarmReplay answers a retried request whose farm id already exists
// with that farm. It returns true when it has answered.
func adminFarmReplay(w http.ResponseWriter, r *http.Request, tx pgx.Tx, id string) bool {
	existing, err := store.GetAdminFarm(r.Context(), tx, id)
	if err == nil {
		writeJSON(w, http.StatusOK, existing)
		return true
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, err)
		return true
	}
	return false
}

// adminFarmOwner finds the owner's account, verifying its address, or creates
// it verified with the caller's password or a minted one. temporary is the
// new account's password; created says whether the account is new.
func adminFarmOwner(r *http.Request, tx pgx.Tx, email string, req *adminCreateFarmRequest) (user *store.User, created bool, temporary string, err error) {
	user, err = store.FindUserByEmail(r.Context(), tx, email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, "", err
	}
	if user != nil {
		if user.EmailVerifiedAt == nil {
			if err := store.VerifyUserEmail(r.Context(), tx, user.ID); err != nil {
				return nil, false, "", err
			}
		}
		return user, false, "", nil
	}
	user, temporary, err = adminFarmNewOwner(r, tx, email, req)
	if err != nil {
		return nil, false, "", err
	}
	return user, true, temporary, nil
}

// adminFarmNewOwner creates the owner's account, verified, with the caller's
// password or a minted one, and returns it with that password.
func adminFarmNewOwner(r *http.Request, tx pgx.Tx, email string, req *adminCreateFarmRequest) (*store.User, string, error) {
	var err error
	temporary := req.Owner.Password
	if temporary == "" {
		temporary, err = newTemporaryPassword()
		if err != nil {
			return nil, "", domain.Internal("could not mint a password").WithCause(err)
		}
	}
	hash, hashErr := auth.HashPassword(temporary)
	if hashErr != nil {
		return nil, "", domain.Internal("could not hash the password").WithCause(hashErr)
	}
	name := strings.TrimSpace(req.Owner.Name)
	user := &store.User{ID: newID(), Email: email, Name: name, PasswordHash: hash}
	if err := store.CreateUser(r.Context(), tx, *user); err != nil {
		return nil, "", err
	}
	if err := store.VerifyUserEmail(r.Context(), tx, user.ID); err != nil {
		return nil, "", err
	}
	return user, temporary, nil
}

// adminFarmCheckTimezone refuses a timezone the database does not know.
func adminFarmCheckTimezone(ctx context.Context, tx pgx.Tx, tz string) error {
	ok, err := store.IsKnownTimezone(ctx, tx, tz)
	if err != nil {
		return err
	}
	if !ok {
		return domain.BadRequest(msgInvalidTimezone)
	}
	return nil
}

// adminFarmCreate writes the farm, its owner's membership and its seed data.
func adminFarmCreate(ctx context.Context, tx pgx.Tx, farmID, userID string, req *adminCreateFarmRequest) error {
	if err := createFarmRecord(ctx, tx, &store.NewFarm{
		ID: farmID, Name: req.Name, Timezone: req.Timezone,
		Currency: req.Currency, PriceMinor: req.PriceCents,
		PriceConfirmed: true, // required and chosen by the caller
	}, req.Slug); err != nil {
		if store.IsUniqueViolation(err, "") {
			return domain.Conflict(domain.CodeIdempotencyKeyReused,
				"that id is already in use")
		}
		return err
	}
	if err := store.CreateMembership(ctx, tx, farmID, userID, domain.RoleOwner); err != nil {
		return err
	}
	return seedFarm(ctx, tx, farmID, req.PriceCents)
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
