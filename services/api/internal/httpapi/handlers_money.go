package httpapi

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

func (s *Server) handlePending(w http.ResponseWriter, r *http.Request) {
	workerID := r.URL.Query().Get("workerId")
	if workerID == "" {
		writeError(w, r, domain.BadRequest("workerId is required"))
		return
	}
	from, to, err := parseRange(r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	items, err := store.Pending(r.Context(), tx, workerID, from, to)
	if err != nil {
		writeError(w, r, err)
		return
	}
	var total int64
	for _, p := range items {
		total += p.AmountMinor
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workerId": workerID, "from": from, "to": to,
		"items": items, "totalCents": total,
	})
}

func (s *Server) handleWorkerBalance(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	// The balance query sums a ledger, so an id that matches nothing sums to
	// zero and comes back as a perfectly plausible "owes nothing". On the
	// phone that is harmless: the id always came from the picker. Over HTTP it
	// is not, because a worker of another farm and a worker who never existed
	// would both read as settled up. Confirm the worker is ours first, and let
	// a miss fall through to the usual 404.
	id := chi.URLParam(r, "id")
	if _, err := store.GetEmployee(r.Context(), tx, id); err != nil {
		writeError(w, r, err)
		return
	}
	b, err := store.Balance(r.Context(), tx, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, b)
}

func (s *Server) handleListBalances(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	list, err := store.ListBalances(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

func (s *Server) handleWorkerLedger(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	entries, err := store.ListLedger(r.Context(), tx, chi.URLParam(r, "id"), limitParam(r, 100))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": entries})
}

type settlementRequest struct {
	ID         string   `json:"id"`
	WorkerID   string   `json:"workerId"`
	From       string   `json:"from"`
	To         string   `json:"to"`
	PayableIDs []string `json:"payableIds"`
	Note       *string  `json:"note"`
}

// handleSettlementPreview prices the period without writing anything. It is
// the same code path the real settlement uses, so what the screen shows and
// what gets written cannot drift apart.
func (s *Server) handleSettlementPreview(w http.ResponseWriter, r *http.Request) {
	var body settlementRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	from, to, err := parseRange(body.From, body.To)
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	items, err := store.Pending(r.Context(), tx, body.WorkerID, from, to)
	if err != nil {
		writeError(w, r, err)
		return
	}
	balance, err := store.Balance(r.Context(), tx, body.WorkerID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	var gross int64
	for _, p := range items {
		gross += p.AmountMinor
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workerId": body.WorkerID, "from": from, "to": to,
		"items": items, "grossCents": gross, "balance": balance,
	})
}

func (s *Server) handleCreateSettlement(w http.ResponseWriter, r *http.Request) {
	var body settlementRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.WorkerID == "" {
		writeError(w, r, domain.BadRequest("workerId is required"))
		return
	}
	from, to, err := parseRange(body.From, body.To)
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
	if existing, err := store.GetSettlement(r.Context(), tx, body.ID); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	}
	p, _ := auth.PrincipalFrom(r.Context())

	settlement, err := store.Settle(r.Context(), tx, farmID, body.WorkerID, body.ID,
		from, to, body.PayableIDs, body.Note, p.UserID, nil)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, settlement)
}

func (s *Server) handleGetSettlement(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	settlement, err := store.GetSettlement(r.Context(), tx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, settlement)
}

func (s *Server) handleVoidSettlement(w http.ResponseWriter, r *http.Request) {
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
	p, _ := auth.PrincipalFrom(r.Context())
	settlement, err := store.VoidSettlement(r.Context(), tx, farmID, chi.URLParam(r, "id"), p.UserID, nil)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, settlement)
}

// ---------------------------------------------------------------------------
// Ledger movements
// ---------------------------------------------------------------------------

type ledgerRequest struct {
	ID          string  `json:"id"`
	WorkerID    string  `json:"workerId"`
	AmountCents int64   `json:"amountCents"`
	Method      *string `json:"method"`
	Note        *string `json:"note"`
	Date        string  `json:"date"`
	// AllowOverpayment resolves a straight contradiction between the two
	// sources of truth. docs/arquitectura-api.md says a payment larger than
	// the balance is 409 AMOUNT_EXCEEDS_BALANCE; golden case 07
	// (pago-mayor-al-saldo) says the phone lets it through and the worker ends
	// up owing the difference, "el saldo no se recorta".
	//
	// Both are right about different things. The 409 is a guard against a
	// typo on the payment screen, which is what the architecture note is
	// about. But the server must be able to do what the phone already does
	// with real money, or the web is strictly less capable than the phone
	// during the very transition when both are live (decision 3).
	//
	// So the guard is the default and this is how a caller says "yes, I know,
	// pay it anyway" — at which point the excess simply behaves as an advance,
	// exactly as it does on the phone. The domain layer has no such guard, so
	// the golden cases run against it unchanged.
	AllowOverpayment bool `json:"allowOverpayment"`
}

// handlePayment records money handed over. The client sends a positive amount
// and the sign is applied here: a 'pago' is negative in the ledger, and the
// database refuses a positive one outright.
func (s *Server) handlePayment(w http.ResponseWriter, r *http.Request) {
	s.addLedgerEntry(w, r, domain.KindPayment, true)
}

// handleAdvance records money handed over ahead of the work. No balance check:
// exceeding the balance is what an advance is.
func (s *Server) handleAdvance(w http.ResponseWriter, r *http.Request) {
	s.addLedgerEntry(w, r, domain.KindAdvance, false)
}

// handleDeduction records what the worker owes the farm. This is not an
// expense: an expense is the farm's own accounting and never touches anybody's
// ledger. Mixing them would take the cost of a spraying out of somebody's pay.
func (s *Server) handleDeduction(w http.ResponseWriter, r *http.Request) {
	s.addLedgerEntry(w, r, domain.KindDeduction, false)
}

func (s *Server) handleAdjustment(w http.ResponseWriter, r *http.Request) {
	s.addLedgerEntry(w, r, domain.KindAdjust, false)
}

func (s *Server) addLedgerEntry(w http.ResponseWriter, r *http.Request, kind domain.LedgerKind, checkBalance bool) {
	var body ledgerRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.WorkerID == "" {
		writeError(w, r, domain.BadRequest("workerId is required"))
		return
	}
	if body.AmountCents == 0 {
		writeError(w, r, domain.BadRequest("amountCents cannot be zero"))
		return
	}
	if body.ID == "" {
		body.ID = newID()
	}

	amount := body.AmountCents
	switch kind {
	case domain.KindPayment, domain.KindAdvance, domain.KindDeduction:
		if amount < 0 {
			// Accept either convention from the client and normalise; the
			// database would reject the wrong sign anyway.
			amount = -amount
		}
		if body.Method != nil && !domain.PayMethod(*body.Method).Valid() {
			writeError(w, r, domain.BadRequest("method must be efectivo, transferencia or otro"))
			return
		}
		if kind == domain.KindDeduction && body.Method != nil {
			writeError(w, r, domain.BadRequest("a deduction has no payment method"))
			return
		}
		amount = -amount
	}

	var day *time.Time
	if body.Date != "" {
		d, err := time.Parse("2006-01-02", body.Date)
		if err != nil {
			writeError(w, r, domain.BadRequest("date must be YYYY-MM-DD"))
			return
		}
		day = &d
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
	p, _ := auth.PrincipalFrom(r.Context())

	if checkBalance && !body.AllowOverpayment {
		balance, err := store.Balance(r.Context(), tx, body.WorkerID)
		if err != nil {
			writeError(w, r, err)
			return
		}
		// Partial and full payment need no flag of their own: a payment is
		// partial when it is less than the balance. The check runs against the
		// derived balance, never against a stored total.
		if -amount > balance.BalanceMinor {
			writeError(w, r, domain.Conflict(domain.CodeAmountExceedsBalance,
				"the payment is larger than what is owed").
				WithDetails(map[string]any{"balanceCents": balance.BalanceMinor}))
			return
		}
	}

	entry, err := store.AddLedgerEntry(r.Context(), tx, farmID, store.NewLedgerEntry{
		ID: body.ID, EmployeeID: body.WorkerID, Kind: kind, AmountMinor: amount,
		LocalDay: day, Method: body.Method, Note: body.Note, CreatedBy: p.UserID,
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, entry)
}

// handleReverseLedger is how a mistake is undone. Nothing in the ledger is
// edited or deleted — the database has rules that forbid both — so the only
// way back is a movement that cancels the first one exactly, once.
func (s *Server) handleReverseLedger(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Note *string `json:"note"`
	}
	if r.ContentLength > 0 {
		if err := decode(r, &body); err != nil {
			writeError(w, r, err)
			return
		}
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
	p, _ := auth.PrincipalFrom(r.Context())
	entry, err := store.ReverseLedgerEntry(r.Context(), tx, farmID, chi.URLParam(r, "id"), p.UserID, body.Note, nil)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, entry)
}

// ---------------------------------------------------------------------------
// Weekly price
// ---------------------------------------------------------------------------

func (s *Server) handleGetWeekPrice(w http.ResponseWriter, r *http.Request) {
	monday, err := parseMonday(chi.URLParam(r, "monday"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	price, err := store.WeekPrice(r.Context(), tx, monday)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"weekStart": monday.Format("2006-01-02"), "priceCents": price,
	})
}

func (s *Server) handleSetWeekPrice(w http.ResponseWriter, r *http.Request) {
	monday, err := parseMonday(chi.URLParam(r, "monday"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	var body struct {
		PriceCents int64 `json:"priceCents"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.PriceCents <= 0 {
		writeError(w, r, domain.BadRequest("priceCents must be positive"))
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
	if err := store.SetWeekPrice(r.Context(), tx, farmID, monday, body.PriceCents); err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"weekStart": monday.Format("2006-01-02"), "priceCents": body.PriceCents,
	})
}

// parseMonday insists the week is named by its Monday's ISO date. The phone's
// old "2026-W33" comment is obsolete; WEEK_OF already produces the Monday.
func parseMonday(raw string) (time.Time, error) {
	d, err := time.Parse("2006-01-02", raw)
	if err != nil {
		return d, domain.BadRequest("the week is named by its Monday, YYYY-MM-DD")
	}
	if !domain.MondayOf(d).Equal(d) {
		return d, domain.BadRequest("that date is not a Monday")
	}
	return d, nil
}

func parseRange(fromRaw, toRaw string) (from, to time.Time, err error) {
	if fromRaw == "" || toRaw == "" {
		return from, to, domain.BadRequest("from and to are required, YYYY-MM-DD")
	}
	from, err = time.Parse("2006-01-02", fromRaw)
	if err != nil {
		return from, to, domain.BadRequest("from must be YYYY-MM-DD")
	}
	to, err = time.Parse("2006-01-02", toRaw)
	if err != nil {
		return from, to, domain.BadRequest("to must be YYYY-MM-DD")
	}
	if to.Before(from) {
		return from, to, domain.BadRequest("to cannot be before from")
	}
	return from, to, nil
}
