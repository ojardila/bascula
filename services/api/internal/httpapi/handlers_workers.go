package httpapi

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// publicWorker is what the weigher is allowed to see: enough to pick the right
// person off a list at the scale, and nothing else. No document, no phone, no
// address, no photo.
type publicWorker struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	LastName *string `json:"lastName"`
	Tag      *string `json:"tag"`
}

func projectWorker(e store.Employee, full bool) any {
	if full {
		return e
	}
	return publicWorker{ID: e.ID, Name: e.Name, LastName: e.LastName, Tag: e.Tag}
}

func (s *Server) handleListWorkers(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	list, err := store.ListEmployees(r.Context(), tx, r.URL.Query().Get("includeDeleted") == "true")
	if err != nil {
		writeError(w, r, err)
		return
	}
	full := callerSeesPrivateData(r)
	out := make([]any, 0, len(list))
	for _, e := range list {
		out = append(out, projectWorker(e, full))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) handleGetWorker(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	e, err := store.GetEmployee(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, projectWorker(*e, callerSeesPrivateData(r)))
}

func (s *Server) handleCreateWorker(w http.ResponseWriter, r *http.Request) {
	var body store.Employee
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.Name == "" {
		writeError(w, r, domain.BadRequest("name is required"))
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

	// Every write accepts a client id and is idempotent by (farm_id, id):
	// retrying after a timeout returns the existing resource, not a conflict.
	if existing, err := store.GetEmployee(r.Context(), tx, body.ID); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	}

	created, err := store.CreateEmployee(r.Context(), tx, farmID, body)
	if err != nil {
		if store.IsUniqueViolation(err, "ux_employees_doc") {
			writeError(w, r, domain.Conflict(domain.CodeDuplicateDocument,
				"another worker on this farm already has that document"))
			return
		}
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleUpdateWorker(w http.ResponseWriter, r *http.Request) {
	var body store.Employee
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	updated, err := store.UpdateEmployee(r.Context(), tx, chi.URLParam(r, "id"), body)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleDeleteWorker is a logical delete. Nothing in this service issues a
// DELETE against a row: the financial history has to survive the person
// leaving the farm.
func (s *Server) handleDeleteWorker(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := store.SoftDeleteEmployee(r.Context(), tx, chi.URLParam(r, "id")); err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

// handleWorkerProfile is the RSP-007 screen in one call: the person, their
// balance derived from the ledger, their recent movements and their recent
// work.
func (s *Server) handleWorkerProfile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	worker, err := store.GetEmployee(r.Context(), tx, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	balance, err := store.Balance(r.Context(), tx, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	entries, err := store.ListLedger(r.Context(), tx, id, limitParam(r, 50))
	if err != nil {
		writeError(w, r, err)
		return
	}
	tasks, err := store.ListWorkRecords(r.Context(), tx, store.WorkRecordFilter{EmployeeID: id})
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"worker":  worker,
		"balance": balance,
		"ledger":  entries,
		"tasks":   tasks,
	})
}

// callerSeesPrivateData is a projection decision, not an authorisation one:
// the permission table already let this request through. What it picks is how
// much of the row goes on the wire.
func callerSeesPrivateData(r *http.Request) bool {
	p, ok := auth.PrincipalFrom(r.Context())
	return ok && (p.Role == domain.RoleOwner || p.Role == domain.RoleAdmin)
}

func limitParam(r *http.Request, def int) int {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return def
	}
	return n
}
