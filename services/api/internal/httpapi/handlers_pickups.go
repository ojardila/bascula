package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// The legacy pickup facade.
//
// There is no pickups table and there never will be: two payable tables mean
// two anti double-pay locks and no way for one settlement to take both, and a
// picker who also cleared brush the same week needs one settlement, not two.
// A pickup is a work record of a work-unit activity with dateFrom = dateTo, and
// that is the whole of it (docs/arquitectura-api.md §1).
//
// So this file is a translation, not a second implementation. Every write goes
// through the same handler the web uses, which is the property that matters:
// the price rules, the timezone handling, the idempotency by (farm_id, id) and
// the weigher's restrictions cannot drift between the phone's door and the
// web's, because there is only one door behind both. The phone does not get
// its own code path to be wrong in.
//
// It exists so the phone in a farm's pocket keeps working through the
// transition (decision 3), and it is deprecated the day the phone moves to
// /v1/work-records — deprecated, not deleted, because there is always one old
// handset left in one farm.

type pickupRequest struct {
	ID         string      `json:"id"`
	WorkerID   string      `json:"workerId"`
	EmployeeID string      `json:"employeeId"`
	Weight     json.Number `json:"weight"`
	Quantity   json.Number `json:"quantity"`
	Date       string      `json:"date"`
	ActivityID string      `json:"activityId"`
	CropID     string      `json:"cropId"`
	PlotID     string      `json:"plotId"`
	Note       *string     `json:"note"`
	DeviceID   *string     `json:"deviceId"`
}

// handleCreatePickup translates the phone's vocabulary and hands the result to
// the ordinary work-record handler.
//
// The activity defaults to the farm's seeded "Recoleccion" — work unit, priced
// from the week — which is exactly the shape the phone has always written. It
// is looked up rather than assumed: a farm that renamed it, or that weighs two
// crops, still resolves to a real activity of its own instead of a hardcoded
// id that would belong to somebody else's farm.
func (s *Server) handleCreatePickup(w http.ResponseWriter, r *http.Request) {
	var body pickupRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	workerID := body.WorkerID
	if workerID == "" {
		workerID = body.EmployeeID
	}
	quantity := body.Quantity
	if quantity == "" {
		quantity = body.Weight
	}
	if workerID == "" || quantity == "" {
		writeError(w, r, domain.BadRequest("workerId and weight are required"))
		return
	}
	if body.Date == "" {
		writeError(w, r, domain.BadRequest("date is required, YYYY-MM-DD"))
		return
	}

	activityID := body.ActivityID
	if activityID == "" {
		tx, err := tenant.Tx(r.Context())
		if err != nil {
			writeError(w, r, err)
			return
		}
		activityID, err = store.HarvestActivityID(r.Context(), tx)
		if err != nil {
			writeError(w, r, err)
			return
		}
	}

	var plotIDs, cropIDs []string
	if body.PlotID != "" {
		plotIDs = []string{body.PlotID}
	}
	if body.CropID != "" {
		// The phone's cropId is a plot_crop here. The mapping is 1:1 and
		// deterministic only until a farm registers a second crop in a lot;
		// after that the facade cannot invent which one was meant, which is
		// the real deadline on the phone's migration, not a preference.
		cropIDs = []string{body.CropID}
	}

	s.createWorkRecordFrom(w, r, workRecordRequest{
		ID: body.ID, ActivityID: activityID, WorkerID: workerID,
		Quantity: quantity, DateFrom: body.Date, DateTo: body.Date,
		PlotIDs: plotIDs, PlotCropIDs: cropIDs,
		Note: body.Note, DeviceID: body.DeviceID,
	})
}

// handleListPickups is the same list, filtered to what a pickup is: work paid
// by the unit of work. A day's wage is not a weighing and never shows up here,
// which is what keeps the phone's screens looking exactly as they did.
func (s *Server) handleListPickups(w http.ResponseWriter, r *http.Request) {
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
	f.PayScheme = domain.PaySchemeWorkUnit
	list, err := store.ListWorkRecords(r.Context(), tx, f)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

// handleGetPickup answers 404 for a work record that is not a weighing. The
// row exists and belongs to this farm, but through this door it is not a
// pickup, and returning a day's wage to a caller asking for a weighing would
// put a record with no unit on a screen that only knows how to show kilos.
func (s *Server) handleGetPickup(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	record, err := store.GetWorkRecord(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	if record.PayScheme != domain.PaySchemeWorkUnit {
		writeError(w, r, domain.NotFound("resource not found"))
		return
	}
	writeJSON(w, http.StatusOK, record)
}

// handleDeletePickup is the same logical delete, with the same refusal on a
// settled record.
func (s *Server) handleDeletePickup(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	id := chi.URLParam(r, "id")
	record, err := store.GetWorkRecord(r.Context(), tx, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if record.PayScheme != domain.PaySchemeWorkUnit {
		writeError(w, r, domain.NotFound("resource not found"))
		return
	}
	if err := store.SoftDeleteWorkRecord(r.Context(), tx, id); err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}
