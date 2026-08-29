package httpapi

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// handleListActivities serves the same route to everybody and a different
// projection to the weigher: his list arrives without a single rate in it. The
// RLS policies on the activity_pay_* tables say the same thing a second time,
// so a forgotten projection here still cannot leak a price.
func (s *Server) handleListActivities(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	on := time.Now().UTC()
	if raw := r.URL.Query().Get("on"); raw != "" {
		parsed, err := time.Parse("2006-01-02", raw)
		if err != nil {
			writeError(w, r, domain.BadRequest("on must be a date, YYYY-MM-DD"))
			return
		}
		on = parsed
	}
	list, err := store.ListActivities(r.Context(), tx, callerSeesPrivateData(r), on,
		listFilter(r), r.URL.Query().Get("category"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

type activityRequest struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	CategoryID string            `json:"categoryId"`
	Category   string            `json:"category"`
	PayScheme  domain.PayScheme  `json:"payScheme"`
	RateSource domain.RateSource `json:"rateSource"`
	UnitID     *string           `json:"unitId"`
	Rate       rateRequest       `json:"rate"`
}

type rateRequest struct {
	ValidFrom  string   `json:"validFrom"`
	RateCents  int64    `json:"rateCents"`
	TimeUnit   *string  `json:"timeUnit"`
	CustomQty  *float64 `json:"customQty"`
	CustomUnit *string  `json:"customUnit"`
}

func (rr rateRequest) toStore() (store.ActivityRate, error) {
	out := store.ActivityRate{
		RateMinor: rr.RateCents, TimeUnit: rr.TimeUnit,
		CustomQty: rr.CustomQty, CustomUnit: rr.CustomUnit,
	}
	if rr.ValidFrom == "" {
		out.ValidFrom = time.Now().UTC().Truncate(24 * time.Hour)
		return out, nil
	}
	parsed, err := time.Parse("2006-01-02", rr.ValidFrom)
	if err != nil {
		return out, domain.BadRequest("rate.validFrom must be a date, YYYY-MM-DD")
	}
	out.ValidFrom = parsed
	return out, nil
}

func (s *Server) handleCreateActivity(w http.ResponseWriter, r *http.Request) {
	var body activityRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.Name == "" {
		writeError(w, r, domain.BadRequest("name is required"))
		return
	}
	if !body.PayScheme.Valid() {
		writeError(w, r, domain.BadRequest("payScheme must be contrato, tiempo or unidad_trabajo"))
		return
	}
	if body.Category == "" && body.CategoryID == "" {
		writeError(w, r, domain.BadRequest("categoryId or category is required"))
		return
	}
	if body.RateSource == "" {
		body.RateSource = domain.RateActivityDated
	}
	if body.RateSource == domain.RateWeeklyPrice && body.PayScheme != domain.PaySchemeWorkUnit {
		writeError(w, r, domain.BadRequest("only a work-unit activity can be priced by the week"))
		return
	}
	if body.RateSource == domain.RateExplicit {
		writeError(w, r, domain.BadRequest(
			"an activity is priced by date or by the week; 'explicit' belongs to a task"))
		return
	}
	if body.Rate.RateCents <= 0 {
		writeError(w, r, domain.BadRequest("rate.rateCents must be positive"))
		return
	}
	if body.PayScheme == domain.PaySchemeWorkUnit && body.UnitID == nil {
		writeError(w, r, domain.BadRequest("a work-unit activity needs unitId"))
		return
	}
	if body.PayScheme != domain.PaySchemeWorkUnit && body.UnitID != nil {
		writeError(w, r, domain.BadRequest("only a work-unit activity has a unit"))
		return
	}
	rate, err := body.Rate.toStore()
	if err != nil {
		writeError(w, r, err)
		return
	}
	if body.ID == "" {
		body.ID = newID()
	}

	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	farmID, err := tenant.FarmID(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	if existing, err := store.GetActivity(r.Context(), tx, body.ID); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	}

	created, err := store.CreateActivity(r.Context(), tx, farmID, store.NewActivity{
		ID: body.ID, Name: body.Name, CategoryID: body.CategoryID, Category: body.Category,
		PayScheme: body.PayScheme, RateSource: body.RateSource, UnitID: body.UnitID,
		Rate: rate,
	}, newID)
	if err != nil {
		if store.IsUniqueViolation(err, "ux_activities_name") {
			writeError(w, r, domain.Conflict(domain.CodeDuplicateName,
				"this farm already has an activity with that name"))
			return
		}
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// handleUpdateActivity renames, recategorises, archives and unarchives. What
// it cannot do is change the pay scheme or the rate source, and neither can any
// other route: work records already written are pinned to (activity_id,
// pay_scheme) by a composite foreign key, and their price shape was decided by
// that scheme on the day they were written. Turning "tala por jornal" into a
// per-kilo activity would rewrite the meaning of money already earned. An
// activity that pays differently is a different activity.
func (s *Server) handleUpdateActivity(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string  `json:"name"`
		CategoryID string  `json:"categoryId"`
		Category   string  `json:"category"`
		Status     string  `json:"status"`
		PayScheme  *string `json:"payScheme"`
		RateSource *string `json:"rateSource"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if err := validStatus(body.Status); err != nil {
		writeError(w, r, err)
		return
	}
	if body.PayScheme != nil || body.RateSource != nil {
		writeError(w, r, domain.BadRequest(
			"payScheme and rateSource cannot be changed; an activity that pays differently is a different activity"))
		return
	}

	id := chi.URLParam(r, "id")
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	farmID, err := tenant.FarmID(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	switch body.Status {
	case "inactive":
		if err := store.ArchiveActivity(r.Context(), tx, id); err != nil && err != store.NoRows {
			writeError(w, r, err)
			return
		}
	case "active":
		if err := store.RestoreActivity(r.Context(), tx, id); err != nil && err != store.NoRows {
			writeError(w, r, err)
			return
		}
	}

	if body.CategoryID == "" && body.Category != "" {
		item, err := store.EnsureCatalogItem(r.Context(), tx,
			store.CatalogActivityCategories, farmID, newID(), body.Category)
		if err != nil {
			writeError(w, r, err)
			return
		}
		body.CategoryID = item.ID
	}

	updated, err := store.UpdateActivity(r.Context(), tx, id, body.Name, body.CategoryID)
	if err != nil {
		if store.IsUniqueViolation(err, "ux_activities_name") {
			writeError(w, r, domain.Conflict(domain.CodeDuplicateName,
				"this farm already has an activity with that name"))
			return
		}
		writeError(w, r, err)
		return
	}
	if callerSeesPrivateData(r) {
		if rate, err := store.RateInForce(r.Context(), tx, updated.ID, time.Now().UTC()); err == nil {
			updated.Rate = rate
		}
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleSetActivityRate opens a new validity period. It never edits an old
// one, because a rate already frozen onto a record has to stay explainable: the
// answer to "why was I paid this" is a row with a date on it.
func (s *Server) handleSetActivityRate(w http.ResponseWriter, r *http.Request) {
	var body rateRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.RateCents <= 0 {
		writeError(w, r, domain.BadRequest("rateCents must be positive"))
		return
	}
	rate, err := body.toStore()
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	activity, err := store.GetActivity(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := store.SetActivityRate(r.Context(), tx, activity.ID, activity.PayScheme, rate); err != nil {
		writeError(w, r, err)
		return
	}
	rates, err := store.ListActivityRates(r.Context(), tx, activity.ID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"activityId": activity.ID, "rates": rates})
}

func (s *Server) handleListActivityRates(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	rates, err := store.ListActivityRates(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rates})
}

func (s *Server) handleArchiveActivity(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := store.ArchiveActivity(r.Context(), tx, chi.URLParam(r, "id")); err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

func (s *Server) handleListWorkUnits(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	units, err := store.ListWorkUnits(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": units})
}

type workUnitRequest struct {
	ID       string   `json:"id"`
	Code     string   `json:"code"`
	Label    string   `json:"label"`
	KgFactor *float64 `json:"kgFactor"`
}

// handleCreateWorkUnit is idempotent by (farm_id, lower(code)), which is what
// makes the "add it if it is not there" button safe to press twice.
func (s *Server) handleCreateWorkUnit(w http.ResponseWriter, r *http.Request) {
	var body workUnitRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.Code == "" {
		writeError(w, r, domain.BadRequest("code is required"))
		return
	}
	if body.Label == "" {
		body.Label = body.Code
	}
	if body.ID == "" {
		body.ID = newID()
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	farmID, err := tenant.FarmID(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	id, err := store.EnsureWorkUnit(r.Context(), tx, farmID, body.ID, body.Code, body.Label, body.KgFactor)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "code": body.Code, "label": body.Label, "kgFactor": body.KgFactor,
	})
}
