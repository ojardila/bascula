package httpapi

import (
	"net/http"
	"strconv"
	"strings"
	"time"

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
	list, err := store.ListEmployees(r.Context(), tx, listFilter(r))
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

	// §5.6. The unique index on the document is partial on deleted_at, so a
	// person who was taken off the payroll leaves their cédula free and this
	// insert would happily succeed — creating a second file for one person,
	// splitting their balance, and telling nobody. The web is offered the
	// restore instead: PATCH {"status":"active"} on the id in `details`.
	if prior, err := store.FindDeletedByDocument(r.Context(), tx, body.DocumentType, body.DocID); err != nil {
		writeError(w, r, err)
		return
	} else if prior != nil {
		writeError(w, r, domain.Conflict(domain.CodeEmployeeExistsDeleted,
			"a worker with that document is on this farm, deactivated; restore them instead of creating a second file").
			WithDetails(map[string]any{
				"employeeId": prior.ID,
				"name":       prior.Name,
				"lastName":   prior.LastName,
				"deletedAt":  prior.DeletedAt,
			}))
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

// updateWorkerRequest is the employee columns plus a status, because the whole
// interface says "Eliminar nunca borra": taking somebody off the payroll and
// putting them back on next harvest are both a PATCH on the same row, never a
// DELETE and a second registration under a new id that loses their history.
type updateWorkerRequest struct {
	store.Employee
	Status string `json:"status"`
}

func (s *Server) handleUpdateWorker(w http.ResponseWriter, r *http.Request) {
	var body updateWorkerRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if err := validStatus(body.Status); err != nil {
		writeError(w, r, err)
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	p, _ := auth.PrincipalFrom(r.Context())

	// The status transition runs first, so a body that both reactivates and
	// renames works: UpdateEmployee only touches rows that are not deleted.
	switch body.Status {
	case "inactive":
		if err := store.SoftDeleteEmployee(r.Context(), tx, id, principalUserID(p)); err != nil && err != store.NoRows {
			writeError(w, r, err)
			return
		}
	case "active":
		if _, err := store.RestoreEmployee(r.Context(), tx, id); err != nil {
			writeError(w, r, err)
			return
		}
	}

	updated, err := store.UpdateEmployee(r.Context(), tx, id, body.Employee)
	if err != nil {
		if body.Status == "inactive" {
			// Deactivating and nothing else: UpdateEmployee skips deleted
			// rows by design, so read the row back instead of 404-ing on a
			// change that did happen.
			e, getErr := store.GetEmployee(r.Context(), tx, id)
			if getErr == nil {
				writeJSON(w, http.StatusOK, e)
				return
			}
		}
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
	p, _ := auth.PrincipalFrom(r.Context())
	if err := store.SoftDeleteEmployee(r.Context(), tx, chi.URLParam(r, "id"), principalUserID(p)); err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

// principalUserID is the caller's id, or "" when there is no session to name.
// It exists so a nil principal cannot panic on a path that only wants to write
// down who did something.
func principalUserID(p *auth.Principal) string {
	if p == nil {
		return ""
	}
	return p.UserID
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
	notes, err := store.ListNotes(r.Context(), tx, id, limitParam(r, 50))
	if err != nil {
		writeError(w, r, err)
		return
	}
	// Decision 8's condition, on the screen of the person it concerns. If this
	// worker was ever brought back on by an arriving weighing, it says so here,
	// with the labour and the handset that did it.
	reactivations, err := store.ListReactivations(r.Context(), tx, id, limitParam(r, 50))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"worker":        worker,
		"balance":       balance,
		"ledger":        entries,
		"tasks":         tasks,
		"notes":         notes,
		"reactivations": reactivations,
	})
}

// handleListReactivations is the farm-wide audit of decision 8.
//
// It is a route of its own and not only a field on the worker's profile,
// because of who has to read it. The condition the owner attached to the
// automatic reactivation is that the person who took somebody OFF the payroll
// can see that it was undone — and that person is not browsing worker files
// one by one looking for a change. They need one list of what the automatism
// did, newest first.
func (s *Server) handleListReactivations(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	workerID := r.URL.Query().Get("workerId")
	if workerID != "" {
		// A filter by somebody else's worker must not read as "nothing was
		// reactivated for this person". Same rule as every other endpoint that
		// narrows by a resource: confirm it is ours first.
		if _, err := store.GetEmployee(r.Context(), tx, workerID); err != nil {
			writeError(w, r, err)
			return
		}
	}
	items, err := store.ListReactivations(r.Context(), tx, workerID, limitParam(r, 100))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// handleWorkerPayables is the RSP-008 screen: one list of work, one list of
// debts, and one total.
//
// The guard on the first line is the whole reason this is not three calls. Every
// number below comes out of a SUM, and a SUM over an id that matches nothing
// returns zero rather than an error. Zero is a perfectly credible answer —
// "this person is settled up" — and it is what a worker of another farm and a
// worker who never existed would both produce. So the worker is confirmed to be
// ours before anything is added up, and a miss falls through to the ordinary
// 404.
func (s *Server) handleWorkerPayables(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	if _, err := store.GetEmployee(r.Context(), tx, id); err != nil {
		writeError(w, r, err)
		return
	}

	// No range given means everything outstanding, which is what the screen
	// asks for: the owner pays what is owed, not what is owed this fortnight.
	from, to := time.Unix(0, 0).UTC(), time.Now().UTC().AddDate(1, 0, 0)
	if raw := r.URL.Query().Get("from"); raw != "" {
		if from, err = time.Parse("2006-01-02", raw); err != nil {
			writeError(w, r, domain.BadRequest("from must be YYYY-MM-DD"))
			return
		}
	}
	if raw := r.URL.Query().Get("to"); raw != "" {
		if to, err = time.Parse("2006-01-02", raw); err != nil {
			writeError(w, r, domain.BadRequest("to must be YYYY-MM-DD"))
			return
		}
	}

	tasks, err := store.Pending(r.Context(), tx, id, from, to)
	if err != nil {
		writeError(w, r, err)
		return
	}
	debts, err := store.Debts(r.Context(), tx, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	balance, err := store.Balance(r.Context(), tx, id)
	if err != nil {
		writeError(w, r, err)
		return
	}

	var gross int64
	for _, t := range tasks {
		gross += t.AmountMinor
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workerId": id,
		"tasks":    tasks,
		"debts":    debts,
		"balance":  balance,
		// grossCents is the unsettled work above. balanceCents is what the
		// ledger already says, deductions and advances included. totalCents is
		// their sum: what the farm would owe if everything listed were settled
		// right now.
		//
		// The debts are NOT subtracted again here and must not be by the
		// caller either — they are already inside balanceCents, and taking
		// them off twice charges the worker for the same debt twice.
		"grossCents":   gross,
		"balanceCents": balance.BalanceMinor,
		"totalCents":   balance.BalanceMinor + gross,
	})
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

func (s *Server) handleListWorkerNotes(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	// Same reasoning as the balance: an unknown worker must not read as a
	// person with nothing written about them.
	if _, err := store.GetEmployee(r.Context(), tx, id); err != nil {
		writeError(w, r, err)
		return
	}
	notes, err := store.ListNotes(r.Context(), tx, id, limitParam(r, 100))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": notes})
}

// handleAddWorkerNote appends a note. There is no PATCH and no DELETE on one,
// and there never will be: a note that can be rewritten afterwards is not a
// record of anything. It is also the most dangerous free text in the system,
// which is why decision 1 nails it to the farm — the registry service has no
// read path to this table and the column that would let one exist was never
// created.
func (s *Server) handleAddWorkerNote(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID   string  `json:"id"`
		Text string  `json:"text"`
		Date string  `json:"date"`
		Note *string `json:"note"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.Text == "" && body.Note != nil {
		body.Text = *body.Note
	}
	if strings.TrimSpace(body.Text) == "" {
		writeError(w, r, domain.BadRequest("text is required"))
		return
	}
	if body.ID == "" {
		body.ID = newID()
	}
	var on *time.Time
	if body.Date != "" {
		d, err := time.Parse("2006-01-02", body.Date)
		if err != nil {
			writeError(w, r, domain.BadRequest("date must be YYYY-MM-DD"))
			return
		}
		on = &d
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
	if _, err := store.GetEmployee(r.Context(), tx, id); err != nil {
		writeError(w, r, err)
		return
	}
	p, _ := auth.PrincipalFrom(r.Context())

	note, err := store.CreateNote(r.Context(), tx, farmID, store.NewNote{
		ID: body.ID, EmployeeID: id, Body: body.Text, NotedOn: on, CreatedBy: p.UserID,
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, note)
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

// offsetParam reads the page offset. A negative or unparsable one is 0 rather
// than an error: an offset is a position in a list, and there is no page
// before the first.
func offsetParam(r *http.Request) int {
	raw := r.URL.Query().Get("offset")
	if raw == "" {
		return 0
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// listFilter reads the two query parameters every list endpoint takes. The
// legacy `includeDeleted=true` is kept as a synonym for `status=all`, because
// the phone already sends it.
func listFilter(r *http.Request) store.Filter {
	f := store.Filter{
		Q:      strings.TrimSpace(r.URL.Query().Get("q")),
		Status: r.URL.Query().Get("status"),
	}
	if f.Status == "" && r.URL.Query().Get("includeDeleted") == "true" {
		f.Status = "all"
	}
	return f
}

// validStatus rejects a status nobody meant. An unrecognised value is a 400
// rather than a silent no-op: "status":"Inactive" quietly doing nothing is how
// a delete button ships broken.
func validStatus(status string) error {
	switch status {
	case "", "active", "inactive":
		return nil
	}
	return domain.BadRequest(`status must be "active" or "inactive"`)
}
