package httpapi

import (
	"encoding/json"
	"math/big"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

type workRecordRequest struct {
	ID          string      `json:"id"`
	ActivityID  string      `json:"activityId"`
	WorkerID    string      `json:"workerId"`
	Quantity    json.Number `json:"quantity"`
	RateCents   *int64      `json:"rateCents"`
	DateFrom    string      `json:"dateFrom"`
	DateTo      string      `json:"dateTo"`
	PlotIDs     []string    `json:"plotIds"`
	PlotCropIDs []string    `json:"plotCropIds"`
	Note        *string     `json:"note"`
	DeviceID    *string     `json:"deviceId"`
}

// handleCreateWorkRecord records that somebody performed an activity. It is the one
// write in the system that decides money at write time, so most of it is about
// which price applies and when it froze.
func (s *Server) handleCreateWorkRecord(w http.ResponseWriter, r *http.Request) {
	var body workRecordRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	s.createWorkRecordFrom(w, r, body)
}

// createWorkRecordFrom is the body of the write, taken apart from the decoding
// so the legacy /v1/pickups facade can reach it after translating the phone's
// vocabulary. There is exactly one implementation of this write and both doors
// go through it: the price rules and the weigher's restrictions cannot drift
// between them because there is nothing to drift from.
func (s *Server) createWorkRecordFrom(w http.ResponseWriter, r *http.Request, body workRecordRequest) {
	if body.ActivityID == "" || body.WorkerID == "" {
		writeError(w, r, domain.BadRequest("activityId and workerId are required"))
		return
	}
	if body.ID == "" {
		body.ID = newID()
	}
	from, to, err := parseWorkRecordDates(body)
	if err != nil {
		writeError(w, r, err)
		return
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
	principal, _ := auth.PrincipalFrom(r.Context())

	if existing, err := store.GetWorkRecord(r.Context(), tx, body.ID); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	}

	activity, err := store.GetActivity(r.Context(), tx, body.ActivityID)
	if err != nil {
		writeError(w, r, err)
		return
	}

	// The weigher records weighings and nothing else. A weighing is an
	// activity priced by the week, which means the weigher never sees a rate,
	// never sets one, and never needs to: the price is applied at settlement.
	// Any other activity would require reading a rate, which his RLS policies
	// forbid anyway; refusing here makes it a clear 403 instead of an
	// unexplained NO_RATE_IN_FORCE.
	if principal.Role == domain.RoleWeigher {
		if activity.RateSource != domain.RateWeeklyPrice {
			writeError(w, r, domain.Forbidden(
				"a weigher may only record work priced by the week"))
			return
		}
		if body.RateCents != nil {
			writeError(w, r, domain.Forbidden("a weigher may not set a rate"))
			return
		}
	}

	quantity := body.Quantity
	if activity.PayScheme == domain.PaySchemeContract {
		// A contract is one thing done once: amount = round(1 * total).
		quantity = json.Number("1")
	}
	qty, ok := new(big.Rat).SetString(string(quantity))
	if !ok || qty.Sign() <= 0 {
		writeError(w, r, domain.BadRequest("quantity must be a positive number"))
		return
	}
	// The column is numeric(12, 3) and Postgres would ROUND a fourth decimal
	// place rather than refuse it — storing a weight nobody weighed and
	// charging for it. See domain/numeric.go.
	if err := domain.CheckNumeric("quantity", string(quantity),
		domain.QuantityPrecision, domain.QuantityScale); err != nil {
		writeError(w, r, err)
		return
	}

	record := store.WorkRecord{
		ID: body.ID, EmployeeID: body.WorkerID, ActivityID: activity.ID,
		PayScheme: activity.PayScheme, Quantity: quantity, Note: body.Note,
		DeviceID: body.DeviceID,
		PlotIDs:  body.PlotIDs, PlotCropIDs: body.PlotCropIDs,
	}
	if principal != nil && principal.UserID != "" {
		record.CreatedBy = &principal.UserID
	}

	switch {
	case body.RateCents != nil:
		// The caller named the price, so it freezes here and a date range is
		// perfectly legal.
		if *body.RateCents <= 0 {
			writeError(w, r, domain.BadRequest("rateCents must be positive"))
			return
		}
		record.RateSource = domain.RateExplicit
		record.PriceMinor = body.RateCents

	case activity.RateSource == domain.RateWeeklyPrice:
		// The price is the week's, looked up when the settlement runs. This is
		// what the phone does today and it is preserved exactly.
		record.RateSource = domain.RateWeeklyPrice

	default:
		// Derived from the activity's rate in force on the day of the work,
		// and frozen right now.
		record.RateSource = domain.RateActivityDated
		rate, err := store.RateInForce(r.Context(), tx, activity.ID, from)
		if err != nil {
			writeError(w, r, domain.Conflict(domain.CodeNoRateInForce,
				"that activity has no rate in force on that date").WithCause(err))
			return
		}
		record.PriceMinor = &rate.RateMinor
	}

	// Decision 4, enforced before the database enforces it again: a record
	// whose price is derived from a date must be a single day. A wage from
	// Tuesday to Tuesday has no single validity period and no single week.
	if record.RateSource.Derived() && !from.Equal(to) {
		writeError(w, r, domain.BadRequest(
			"a work record priced by date must be a single day; send rateCents to freeze a price over a range").
			WithDetails(map[string]any{"code": string(domain.CodeRangeNeedsFrozenRate)}))
		return
	}

	if record.PriceMinor != nil {
		amount := domain.AmountMinor(qty, *record.PriceMinor)
		if amount <= 0 {
			writeError(w, r, domain.BadRequest("the work record adds up to zero"))
			return
		}
		record.AmountMinor = &amount
	}
	// The unit rides on the activity, so a weigher who may not read a single
	// price still records kilos rather than a bare number.
	record.UnitID = activity.UnitID

	started, err := store.InstantForLocalDay(r.Context(), tx, from)
	if err != nil {
		writeError(w, r, err)
		return
	}
	record.StartedAt = started
	if !to.Equal(from) {
		ended, err := store.InstantForLocalDay(r.Context(), tx, to)
		if err != nil {
			writeError(w, r, err)
			return
		}
		record.EndedAt = &ended
	}

	created, err := store.CreateWorkRecord(r.Context(), tx, farmID, record)
	if err != nil {
		writeError(w, r, err)
		return
	}

	// Decision 8, on this door too. The rule and its boundary live in
	// store.ReactivateForWork; what changes here is only where the work came
	// from. `deviceId` is whatever the caller named, then whatever the token
	// carries; on the web console there is neither, and `source: "web"` is
	// what makes that null mean "a browser" rather than "unknown".
	device := body.DeviceID
	if device == nil && principal != nil && principal.DeviceID != "" {
		device = &principal.DeviceID
	}
	if _, err := store.ReactivateForWork(r.Context(), tx, farmID, store.NewReactivation{
		ID: newID(), EmployeeID: body.WorkerID, WorkRecordID: created.ID,
		WorkedAt: started, DeviceID: device, Source: reactivationSource(device),
		By: principalUserID(principal),
	}); err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// reactivationSource names the door the work came through. The legacy
// /v1/pickups facade and /v1/work-records are both "web" unless the caller
// named a handset, which is the honest reading: this endpoint is the console,
// and a device id on it means a phone talking through the old facade.
func reactivationSource(device *string) string {
	if device != nil && *device != "" {
		return "sync"
	}
	return "web"
}

func parseWorkRecordDates(body workRecordRequest) (from, to time.Time, err error) {
	if body.DateFrom == "" {
		return from, to, domain.BadRequest("dateFrom is required, YYYY-MM-DD")
	}
	from, err = time.Parse("2006-01-02", body.DateFrom)
	if err != nil {
		return from, to, domain.BadRequest("dateFrom must be YYYY-MM-DD")
	}
	if body.DateTo == "" {
		return from, from, nil
	}
	to, err = time.Parse("2006-01-02", body.DateTo)
	if err != nil {
		return from, to, domain.BadRequest("dateTo must be YYYY-MM-DD")
	}
	if to.Before(from) {
		return from, to, domain.BadRequest("dateTo cannot be before dateFrom")
	}
	return from, to, nil
}

func (s *Server) handleListWorkRecords(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	f, err := workRecordFilter(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := confirmWorkRecordFilter(r, f); err != nil {
		writeError(w, r, err)
		return
	}
	// The weigher gets only his own rows, and that narrowing is the RLS policy
	// on work_records, not a WHERE clause written here.
	list, err := store.ListWorkRecords(r.Context(), tx, f)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

// confirmWorkRecordFilter is the zero trap, closed on the four ids this filter
// accepts.
//
// Every row it lets through carries `amountCents`, and a console showing "what
// this worker picked this fortnight" adds them up. Narrowing by another farm's
// worker returned `{"items": []}` and 200 — "this person did no work" — which
// is a completely credible sentence and is also what a real worker who has been
// off sick looks like. Same for an activity, a plot and a crop.
//
// The rule is stated at the top of handlers_reports.go and enforced by
// confirmOurs everywhere in stock and money; the two doors into the work
// records were the ones it never reached. GET /v1/reactivations, which reads
// the same `workerId` parameter, has guarded it since sprint 6.
func confirmWorkRecordFilter(r *http.Request, f store.WorkRecordFilter) error {
	return confirmOurs(r, map[string]string{
		"employee": f.EmployeeID,
		"activity": f.ActivityID,
		"plot":     f.PlotID,
		"plotCrop": f.PlotCropID,
	})
}

func workRecordFilter(r *http.Request) (store.WorkRecordFilter, error) {
	f := store.WorkRecordFilter{
		EmployeeID: r.URL.Query().Get("workerId"),
		ActivityID: r.URL.Query().Get("activityId"),
		PlotID:     r.URL.Query().Get("plotId"),
		PlotCropID: r.URL.Query().Get("plotCropId"),
		Filter:     listFilter(r),
	}
	if raw := r.URL.Query().Get("payScheme"); raw != "" {
		scheme := domain.PayScheme(raw)
		if !scheme.Valid() {
			return f, domain.BadRequest("payScheme must be contrato, tiempo or unidad_trabajo")
		}
		f.PayScheme = scheme
	}
	if raw := r.URL.Query().Get("from"); raw != "" {
		d, err := time.Parse("2006-01-02", raw)
		if err != nil {
			return f, domain.BadRequest("from must be YYYY-MM-DD")
		}
		f.From = &d
	}
	if raw := r.URL.Query().Get("to"); raw != "" {
		d, err := time.Parse("2006-01-02", raw)
		if err != nil {
			return f, domain.BadRequest("to must be YYYY-MM-DD")
		}
		f.To = &d
	}
	return f, nil
}

// handleUpdateWorkRecord corrects a record that has not been paid. See
// store.UpdateWorkRecord for what it refuses to touch and why: the short
// version is that everything which decides the price is out of reach, and a
// record already inside a live settlement answers 409 WORK_RECORD_SETTLED
// rather than being edited under the payment.
func (s *Server) handleUpdateWorkRecord(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Quantity *json.Number `json:"quantity"`
		Note     *string      `json:"note"`
		Status   string       `json:"status"`
		// Listed so the refusal has a sentence in it. Without these fields the
		// decoder's DisallowUnknownFields still answers 400, but with
		// "malformed request body", and a caller reading that goes looking for
		// a typo instead of finding out that the rule is deliberate.
		RateCents  *int64  `json:"rateCents"`
		WorkerID   *string `json:"workerId"`
		ActivityID *string `json:"activityId"`
		DateFrom   *string `json:"dateFrom"`
		DateTo     *string `json:"dateTo"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if err := validStatus(body.Status); err != nil {
		writeError(w, r, err)
		return
	}
	if body.RateCents != nil || body.WorkerID != nil || body.ActivityID != nil ||
		body.DateFrom != nil || body.DateTo != nil {
		writeError(w, r, domain.BadRequest(
			"the worker, the activity, the dates and the frozen price cannot be changed; "+
				"delete this record and write the one you meant, in that order"))
		return
	}
	if body.Quantity != nil {
		qty, ok := new(big.Rat).SetString(body.Quantity.String())
		if !ok || qty.Sign() <= 0 {
			writeError(w, r, domain.BadRequest("quantity must be a positive number"))
			return
		}
		if err := domain.CheckNumeric("quantity", body.Quantity.String(),
			domain.QuantityPrecision, domain.QuantityScale); err != nil {
			writeError(w, r, err)
			return
		}
	}

	id := chi.URLParam(r, "id")
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	// Order matters, in both directions. A restore has to happen before the
	// edit, because UpdateWorkRecord only touches live rows; a removal has to
	// happen after it, for the same reason. A body that both corrects a
	// quantity and files the record away therefore does both, instead of
	// silently dropping one.
	if body.Status == "active" {
		if err := store.RestoreWorkRecord(r.Context(), tx, id); err != nil && err != store.NoRows {
			writeError(w, r, err)
			return
		}
	}

	updated, err := store.UpdateWorkRecord(r.Context(), tx, id, body.Quantity, body.Note)
	if err != nil {
		writeError(w, r, err)
		return
	}

	if body.Status == "inactive" {
		if err := store.SoftDeleteWorkRecord(r.Context(), tx, id); err != nil {
			writeError(w, r, err)
			return
		}
		if updated, err = store.GetWorkRecord(r.Context(), tx, id); err != nil {
			writeError(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleGetWorkRecord(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	l, err := store.GetWorkRecord(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, l)
}

// handleDeleteWorkRecord is a logical delete, and it refuses on a settled
// record: work that has already been paid is cancelled by voiding its
// settlement, not by editing it away.
func (s *Server) handleDeleteWorkRecord(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := store.SoftDeleteWorkRecord(r.Context(), tx, chi.URLParam(r, "id")); err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}
