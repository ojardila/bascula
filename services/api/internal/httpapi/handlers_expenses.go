package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// Expenses — RSP-030 … RSP-033.
//
// NOTHING IN THIS FILE TOUCHES A WORKER'S LEDGER, and that is a design
// decision rather than an omission.
//
// The use case document uses one word, "gasto", for two different things:
// RSP-030 means the cost of a spraying, RSP-007 means what an employee owes
// the farm. They look alike on a form — a value, a date, a description — and
// they are not the same thing at all. An expense is the farm's own accounting.
// A debt is one line in one person's balance. Wire them together and recording
// the cost of the spraying quietly takes money out of somebody's wages.
//
// So a debt is POST /v1/deductions and only that, an expense is here and only
// here, and there is no import of the ledger in this file. The database agrees:
// `expenses` has no employee_id column at all. A test in internal/apitest
// checks it from the other side, so this stops being an argument and becomes a
// property.

func (s *Server) handleListExpenses(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.ExpenseFilter{
		Filter:     listFilter(r),
		ActivityID: q.Get("activityId"),
		PlotID:     q.Get("plotId"),
	}
	var err error
	if f.From, err = optionalDate(q.Get("from")); err != nil {
		writeError(w, r, err)
		return
	}
	if f.To, err = optionalDate(q.Get("to")); err != nil {
		writeError(w, r, err)
		return
	}
	// The list ends in a total, so an activity or plot of another farm would
	// come back as a believable zero. Confirm first.
	if err := confirmOurs(r, map[string]string{
		"activity": f.ActivityID, "plot": f.PlotID,
	}); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	list, totals, err := store.ListExpenses(r.Context(), tx, f)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": list, "totalCents": totals.Minor, "count": totals.Count,
	})
}

func (s *Server) handleGetExpense(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	e, err := store.GetExpense(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

// validateExpenseTarget is RSP-031's "Tipo de gasto" as a rule rather than as
// a select. Charged to an activity, or to a plot/crop. Not both, not neither.
//
// "Neither" is the case worth refusing loudly: an expense imputed to nothing
// shows up in the total and in no breakdown, and the gap between the two is
// what nobody can account for at the end of the year. The database says the
// same thing (`expense_target`); this only says it in a form's vocabulary.
func validateExpenseTarget(activityID, plotID *string) error {
	hasActivity := activityID != nil && *activityID != ""
	hasPlot := plotID != nil && *plotID != ""
	switch {
	case hasActivity && hasPlot:
		return domain.Coded(400, domain.CodeExpenseTargetInvalid,
			"an expense is charged to an activity or to a plot/crop, not to both")
	case !hasActivity && !hasPlot:
		return domain.Coded(400, domain.CodeExpenseTargetInvalid,
			"an expense is charged to an activity or to a plot/crop; it cannot be charged to neither")
	}
	return nil
}

type expenseRequest struct {
	store.NewExpense
	Status string `json:"status"`
}

func (s *Server) handleCreateExpense(w http.ResponseWriter, r *http.Request) {
	var body expenseRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.Concept == "" {
		writeError(w, r, domain.BadRequest("concept is required"))
		return
	}
	if body.AmountMinor <= 0 {
		writeError(w, r, domain.BadRequest("amountCents must be positive"))
		return
	}
	if err := validateExpenseTarget(body.ActivityID, body.PlotID); err != nil {
		writeError(w, r, err)
		return
	}
	if body.ID == "" {
		body.ID = newID()
	}
	if err := confirmOurs(r, map[string]string{
		"activity": deref(body.ActivityID), "plot": deref(body.PlotID),
		"plotCrop": deref(body.PlotCropID), "attachment": deref(body.ReceiptID),
	}); err != nil {
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
	if existing, err := store.GetExpense(r.Context(), tx, body.ID); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	}
	body.CreatedBy = principalID(r)
	created, err := store.CreateExpense(r.Context(), tx, farmID, body.NewExpense)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// handleUpdateExpense is RSP-032. The imputation moves as a unit: sending any
// of activityId, plotId or plotCropId replaces all three, because "charge this
// to the plot instead" is impossible to express field by field — the old
// activityId would survive the patch and expense_target would refuse the
// result, correctly and unhelpfully.
func (s *Server) handleUpdateExpense(w http.ResponseWriter, r *http.Request) {
	var body expenseRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if err := validStatus(body.Status); err != nil {
		writeError(w, r, err)
		return
	}
	if body.AmountMinor < 0 {
		writeError(w, r, domain.BadRequest("amountCents must be positive"))
		return
	}
	retarget := body.ActivityID != nil || body.PlotID != nil || body.PlotCropID != nil
	if retarget {
		if err := validateExpenseTarget(body.ActivityID, body.PlotID); err != nil {
			writeError(w, r, err)
			return
		}
	}
	if err := confirmOurs(r, map[string]string{
		"activity": deref(body.ActivityID), "plot": deref(body.PlotID),
		"plotCrop": deref(body.PlotCropID), "attachment": deref(body.ReceiptID),
	}); err != nil {
		writeError(w, r, err)
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	if _, err := store.GetExpense(r.Context(), tx, id); err != nil {
		writeError(w, r, err)
		return
	}
	switch body.Status {
	case "inactive":
		if err := store.SoftDeleteExpense(r.Context(), tx, id); err != nil && err != store.NoRows {
			writeError(w, r, err)
			return
		}
	case "active":
		if err := store.RestoreExpense(r.Context(), tx, id); err != nil {
			writeError(w, r, err)
			return
		}
	}
	updated, err := store.UpdateExpense(r.Context(), tx, id, body.NewExpense, retarget)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleDeleteExpense is RSP-033: eliminar deja el gasto inactivo. Unlike a
// sale this really is only a flag, because an expense carries no stock
// movement — there is nothing to give back.
func (s *Server) handleDeleteExpense(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := store.SoftDeleteExpense(r.Context(), tx, chi.URLParam(r, "id")); err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}
