package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

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
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.PriceMinor != nil && *body.PriceMinor <= 0 {
		writeError(w, r, domain.BadRequest("priceCents must be positive"))
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

	updated, err := store.UpdateFarm(r.Context(), tx, body)
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

// handleListAdminFarms lists the farms on the platform. Decision 2 turned the
// public signup into the front door and left this console with two jobs: see
// the farms and suspend one. It still cannot read an employee, a work record
// or a peso of anybody's money, and the projection here is the enforcement of
// that — every column returned is a column of `farms`, and none of them is a
// way to infer what is inside.
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

// handleSetFarmStatus suspends a farm or brings it back.
//
// Suspension is not a delete and it is not immediate: login and refresh both
// refuse a suspended farm, so a phone already holding an access token keeps
// working until that token expires, at most fifteen minutes. That is the right
// trade — a shorter token to make suspension instant would mean a refresh every
// few minutes on a handset that spends the day without signal.
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
