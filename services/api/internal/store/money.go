package store

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// ---------------------------------------------------------------------------
// The ported SQL.
//
// These two statements are the money. They are ports of BALANCE_SQL and
// PENDING_SQL in apps/mobile/src/schema.ts, kept as close to the original text
// as the dialect allows — the shape of the CASE arms, the sign handling, the
// COALESCE around every sum. Rewriting them into something more idiomatic
// would prove nothing about what the phone executes, which is the whole reason
// the phone keeps its SQL in a file of its own.
// ---------------------------------------------------------------------------

// balanceSQL: one worker's position, straight from the ledger. Positive means
// the farm owes them, so a positive balance is their credit. Reversals are
// told apart by sign: reversing an earning is negative, reversing a payment
// positive.
const balanceSQL = `
  SELECT $1::uuid AS employee_id,
         COALESCE(SUM(CASE WHEN kind = 'devengo' THEN amount_minor
                           WHEN kind = 'reverso' AND amount_minor < 0 THEN amount_minor END), 0)
           AS earned_minor,
         COALESCE(-SUM(CASE WHEN kind IN ('pago','anticipo') THEN amount_minor
                            WHEN kind = 'reverso' AND amount_minor > 0 THEN amount_minor END), 0)
           AS paid_minor,
         COALESCE(-SUM(CASE WHEN kind = 'deduccion' THEN amount_minor END), 0) AS deducted_minor,
         COALESCE(SUM(amount_minor), 0) AS balance_minor,
         MAX(local_day) AS last_movement_on
    FROM ledger WHERE employee_id = $1`

// pendingSQL: payables in range that no live settlement has claimed.
//
// The phone's version reads `pk.id NOT IN (SELECT pickupId FROM
// settlement_items WHERE voidedAt IS NULL)`; here the same anti-join runs
// against work_records, which absorbed pickups.
//
// One deliberate departure from docs/arquitectura-api.md: that document says
// the ported queries gain `WHERE a.pay_scheme = 'unidad_trabajo'`. That filter
// is right for the comparative index and the anomaly rules — comparing
// productivity between day wages means nothing — but it is wrong here. The
// same document's own argument for a single payable table is that a picker who
// also cleared brush the same week must receive ONE settlement. Filtering
// pending payables by pay scheme would bring back exactly the two-path problem
// the unification removed, so PENDING stays scheme-agnostic.
const pendingSQL = `
  SELECT l.id::text, l.activity_id::text, a.name, l.pay_scheme, l.rate_source,
         l.quantity::text, l.unit_id::text, l.price_minor, l.amount_minor,
         l.local_day, l.week_start
    FROM work_records l
    JOIN activities a ON a.farm_id = l.farm_id AND a.id = l.activity_id
   WHERE l.employee_id = $1
     AND l.deleted_at IS NULL
     AND l.local_day BETWEEN $2::date AND $3::date
     AND l.id NOT IN (SELECT si.payable_id FROM settlement_items si WHERE si.voided_at IS NULL)
   ORDER BY l.local_day, l.id`

// Balance runs the ported balance query.
func Balance(ctx context.Context, tx pgx.Tx, employeeID string) (*domain.Balance, error) {
	var b domain.Balance
	err := tx.QueryRow(ctx, balanceSQL, employeeID).
		Scan(&b.EmployeeID, &b.EarnedMinor, &b.PaidMinor, &b.DeductedMinor,
			&b.BalanceMinor, &b.LastMovementOn)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

// Payable is one unsettled work record, priced.
type Payable struct {
	PayableID    string            `json:"payableId"`
	ActivityID   string            `json:"activityId"`
	ActivityName string            `json:"activity"`
	PayScheme    domain.PayScheme  `json:"payScheme"`
	RateSource   domain.RateSource `json:"rateSource"`
	Quantity     json.Number       `json:"quantity"`
	UnitID       *string           `json:"unitId"`
	LocalDay     time.Time         `json:"date"`
	WeekStart    time.Time         `json:"weekStart"`
	PriceMinor   int64             `json:"rateCents"`
	AmountMinor  int64             `json:"amountCents"`
	Voided       bool              `json:"voided"`
}

// Pending lists what a worker is owed for but has not been settled, with each
// line already priced. Two freezing moments meet here:
//
//   - weekly_price: the price is looked up NOW, at settlement time, from the
//     week's price. This is exactly what the phone does today and it is
//     preserved unchanged.
//   - everything else: the price was frozen when the record was written, and
//     this function only reads it back.
func Pending(ctx context.Context, tx pgx.Tx, employeeID string, from, to time.Time) ([]Payable, error) {
	rows, err := tx.Query(ctx, pendingSQL, employeeID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type raw struct {
		Payable
		frozenPrice  *int64
		frozenAmount *int64
	}
	var pending []raw
	for rows.Next() {
		var r raw
		var qty string
		if err := rows.Scan(&r.PayableID, &r.ActivityID, &r.ActivityName, &r.PayScheme,
			&r.RateSource, &qty, &r.UnitID, &r.frozenPrice, &r.frozenAmount,
			&r.LocalDay, &r.WeekStart); err != nil {
			return nil, err
		}
		r.Quantity = json.Number(qty)
		pending = append(pending, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := []Payable{}
	for _, r := range pending {
		p := r.Payable
		switch r.RateSource {
		case domain.RateWeeklyPrice:
			price, err := WeekPrice(ctx, tx, r.WeekStart)
			if err != nil {
				return nil, err
			}
			qty, ok := new(big.Rat).SetString(string(r.Quantity))
			if !ok {
				return nil, domain.Internal("unparsable quantity on work record " + r.PayableID)
			}
			p.PriceMinor = price
			p.AmountMinor = domain.AmountMinor(qty, price)
		default:
			if r.frozenPrice == nil || r.frozenAmount == nil {
				return nil, domain.Internal("work record " + r.PayableID + " has no frozen price")
			}
			p.PriceMinor = *r.frozenPrice
			p.AmountMinor = *r.frozenAmount
		}
		out = append(out, p)
	}
	return out, nil
}

// Debts lists what the worker owes the farm and what the farm has already
// advanced: the "Lista de deudas" half of the RSP-008 screen.
//
// Two things it deliberately is not. It is not expenses — an expense is the
// farm's own accounting and never touches anybody's ledger, and mixing the two
// would take the cost of a spraying out of somebody's wage (§2 of the entrega-2
// document says so in as many words). And it is not a second subtraction: every
// row here is already inside the derived balance, so a caller that subtracts
// these from the balance charges the worker twice.
//
// The amounts keep the ledger's own sign, negative, rather than being flipped
// to a friendlier positive. The sign convention is load-bearing across the
// whole module and re-signing it in one endpoint is how a convention rots.
func Debts(ctx context.Context, tx pgx.Tx, employeeID string) ([]LedgerEntry, error) {
	rows, err := tx.Query(ctx, `
		SELECT l.id::text, l.employee_id::text, l.kind, l.amount_minor, l.local_day,
		       l.settlement_id::text, l.method::text, l.note, l.reverses_id::text, l.created_at
		  FROM ledger l
		 WHERE l.employee_id = $1
		   AND l.kind IN ('deduccion', 'anticipo')
		   AND NOT EXISTS (SELECT 1 FROM ledger r WHERE r.reverses_id = l.id)
		 ORDER BY l.local_day DESC, l.created_at DESC`, employeeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []LedgerEntry{}
	for rows.Next() {
		var e LedgerEntry
		if err := rows.Scan(&e.ID, &e.EmployeeID, &e.Kind, &e.AmountMinor, &e.LocalDay,
			&e.SettlementID, &e.Method, &e.Note, &e.ReversesID, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// WeekPrice is the port of costForWeek: the week's override if the owner set
// one, otherwise the farm's standing price.
func WeekPrice(ctx context.Context, tx pgx.Tx, weekStart time.Time) (int64, error) {
	var price int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(
			(SELECT wp.price_minor FROM week_prices wp
			  WHERE wp.farm_id = current_farm() AND wp.week_start = $1),
			(SELECT fc.price_minor FROM farm_config fc WHERE fc.farm_id = current_farm()))`,
		weekStart).Scan(&price)
	return price, err
}

func SetWeekPrice(ctx context.Context, tx pgx.Tx, farmID string, weekStart time.Time, priceMinor int64) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO week_prices (farm_id, week_start, price_minor) VALUES ($1, $2, $3)
		ON CONFLICT (farm_id, week_start) DO UPDATE SET price_minor = EXCLUDED.price_minor`,
		farmID, weekStart, priceMinor)
	return err
}

// ---------------------------------------------------------------------------
// settle / void / reverse
// ---------------------------------------------------------------------------

type Settlement struct {
	ID          string     `json:"id"`
	EmployeeID  string     `json:"workerId"`
	PeriodStart time.Time  `json:"periodStart"`
	PeriodEnd   time.Time  `json:"periodEnd"`
	GrossMinor  int64      `json:"grossCents"`
	Status      string     `json:"status"`
	Note        *string    `json:"note"`
	CreatedAt   time.Time  `json:"createdAt"`
	VoidedAt    *time.Time `json:"voidedAt"`
	Items       []Payable  `json:"items"`
}

// Settle turns a set of payables into one settlement and one `devengo`.
//
// The anti double-pay lock is the partial unique index
// ux_items_payable_live, not a check in this function: a payable belongs to
// exactly one live settlement, and the database is what says so. Two
// concurrent settlements racing for the same payable end with one unique
// violation, which surfaces as 409 PAYABLE_ALREADY_CLAIMED with the winning
// settlement in the details so the phone can re-derive its state.
// `on` is the day the farm believes it is when the settlement is made; nil
// means today in the farm's timezone. The golden cases pin it so that a case
// gives the same answer today and in three years.
//
// `expectedGross` is §5.5 of docs/sincronizacion.md: the figure the caller was
// shown by /v1/settlements/preview. When it is set and the settlement would not
// add up to it, NOTHING is written and the answer is 409 GROSS_CHANGED. The
// HTTP layer requires it; the store keeps it optional so the golden cases,
// which are a replay of a phone that never had a preview screen, still run
// against this function unchanged. Nothing else may pass nil — see the note on
// handleCreateSettlement.
func Settle(ctx context.Context, tx pgx.Tx, farmID, employeeID, settlementID string,
	from, to time.Time, payableIDs []string, expectedGross *int64, note *string, createdBy string,
	on *time.Time) (*Settlement, bool, error) {

	// The idempotency check comes FIRST, before anything is derived. It has to:
	// on a retry the payables are already locked by the very settlement being
	// retried, so Pending would come back empty and the honest-looking answer
	// would be 409 NOTHING_TO_SETTLE — a business error covering for a network
	// one, in front of somebody waiting to be paid.
	if existing, err := findSettlement(ctx, tx, settlementID); err != nil {
		return nil, false, err
	} else if existing != nil {
		if existing.EmployeeID != employeeID {
			return nil, false, domain.Conflict(domain.CodeIdempotencyKeyReused,
				"that id already names a settlement for another worker")
		}
		return existing, false, nil
	}

	pending, err := Pending(ctx, tx, employeeID, from, to)
	if err != nil {
		return nil, false, err
	}
	chosen := filterPayables(pending, payableIDs)
	if len(chosen) == 0 {
		return nil, false, domain.Conflict(domain.CodeNothingToSettle,
			"there is nothing to settle in that period")
	}

	var gross int64
	// The period the settlement records is the period it actually covers, not
	// the window the caller happened to ask over. A caller asking from
	// 1970-01-01 means "everything outstanding", and writing 1970 onto the
	// receipt would be nonsense; the period starts at the Monday of the
	// earliest payable taken in.
	periodStart := to
	for _, p := range chosen {
		gross += p.AmountMinor
		if p.WeekStart.Before(periodStart) {
			periodStart = p.WeekStart
		}
	}
	if gross <= 0 {
		return nil, false, domain.Conflict(domain.CodeNothingToSettle,
			"the settlement adds up to nothing")
	}

	// §5.5. The last thing before the first INSERT, and after the idempotency
	// check on purpose: a retry of a settlement that already exists returns
	// that settlement without ever consulting the expectation, because by then
	// the week may legitimately have been repriced and the money has already
	// been counted out. A retry must not be refused over a figure that no
	// longer decides anything.
	if expectedGross != nil && *expectedGross != gross {
		details, err := grossChangedDetails(ctx, tx, *expectedGross, gross, pending, chosen, payableIDs)
		if err != nil {
			return nil, false, err
		}
		return nil, false, domain.Conflict(domain.CodeGrossChanged,
			"the settlement no longer adds up to the figure the caller was shown").
			WithDetails(details)
	}

	s := Settlement{
		ID: settlementID, EmployeeID: employeeID, PeriodStart: periodStart, PeriodEnd: to,
		GrossMinor: gross, Status: "open", Note: note, Items: chosen,
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO settlements (id, farm_id, employee_id, period_start, period_end,
		                         gross_minor, note, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (id) DO NOTHING
		RETURNING created_at`,
		settlementID, farmID, employeeID, periodStart, to, gross, note, createdBy).Scan(&s.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Two identical requests raced past the check above. The loser reads
		// back the winner's settlement instead of writing a second one.
		existing, findErr := findSettlement(ctx, tx, settlementID)
		if findErr != nil {
			return nil, false, findErr
		}
		if existing == nil {
			return nil, false, domain.Conflict(domain.CodeIdempotencyKeyReused,
				"that id is already in use")
		}
		return existing, false, nil
	}
	if err != nil {
		return nil, false, err
	}

	for _, p := range chosen {
		_, err := tx.Exec(ctx, `
			INSERT INTO settlement_items (id, farm_id, settlement_id, payable_id, week_start,
			                              quantity, price_minor, amount_minor)
			VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8)`,
			uuid.NewString(), farmID, settlementID, p.PayableID, p.WeekStart,
			p.Quantity.String(), p.PriceMinor, p.AmountMinor)
		if err != nil {
			if IsUniqueViolation(err, "ux_items_payable_live") {
				winner, _ := winningSettlement(ctx, tx, p.PayableID)
				return nil, false, domain.Conflict(domain.CodePayableAlreadyClaimed,
					"a payable is already part of a live settlement").
					WithDetails(map[string]any{
						"payableId":         p.PayableID,
						"winningSettlement": winner,
					}).WithCause(err)
			}
			return nil, false, err
		}
	}

	day, err := dayOrToday(ctx, tx, on)
	if err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ledger (id, farm_id, employee_id, kind, amount_minor, local_day,
		                    settlement_id, note, created_by)
		VALUES ($1, $2, $3, 'devengo', $4, $5, $6, $7, $8)`,
		uuid.NewString(), farmID, employeeID, gross, day, settlementID, note, createdBy); err != nil {
		return nil, false, err
	}
	return &s, true, nil
}

// findSettlement is GetSettlement with "not there" as a value rather than an
// error, for the idempotency checks.
func findSettlement(ctx context.Context, tx pgx.Tx, id string) (*Settlement, error) {
	out, err := GetSettlement(ctx, tx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return out, nil
}

// FilterPayables narrows a pending list to the ids the caller named. Exported
// because the preview has to apply the SAME narrowing the settlement will: a
// preview that priced the whole period while the settlement priced a chosen
// subset would hand the caller a grossCents that its own expectedGrossCents
// could never match.
func FilterPayables(all []Payable, ids []string) []Payable { return filterPayables(all, ids) }

func filterPayables(all []Payable, ids []string) []Payable {
	if len(ids) == 0 {
		return all
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	out := []Payable{}
	for _, p := range all {
		if want[p.PayableID] {
			out = append(out, p)
		}
	}
	return out
}

// grossChangedDetails says WHAT MOVED the figure, which is the whole reason
// GROSS_CHANGED exists rather than a bare 409.
//
// Two things can move it between a preview and a press of the button, and the
// screen has to be able to name which:
//
//   - payables came or went. A late weighing arrived, or somebody else's
//     settlement took one. Reported exactly, as `addedPayableIds` and
//     `removedPayableIds`, whenever the caller named the set it saw in
//     `payableIds`. A caller that named no set is asking for "everything
//     pending", so it cannot be told which of them are new — it is told the
//     new total instead.
//   - the week was repriced. `weeksInSettlement` carries every week this settlement
//     spans WITH THE PRICE NOW IN FORCE. When nothing was added or removed the
//     difference can only have come from one of those prices, and the client —
//     which is holding the preview it just showed — knows which.
//
// Nothing here guesses. A cause the server cannot establish is not reported as
// one: the caller gets the new figures and the sets, never an invented reason.
func grossChangedDetails(ctx context.Context, tx pgx.Tx, expected, actual int64,
	pending, chosen []Payable, askedFor []string) (map[string]any, error) {

	added := []string{}
	removed := []string{}
	if len(askedFor) > 0 {
		inPending := map[string]bool{}
		for _, p := range pending {
			inPending[p.PayableID] = true
		}
		asked := map[string]bool{}
		for _, id := range askedFor {
			asked[id] = true
			if !inPending[id] {
				// Named by the caller and no longer settleable: deleted, or
				// claimed by a settlement that got there first.
				removed = append(removed, id)
			}
		}
		for _, p := range pending {
			if !asked[p.PayableID] {
				added = append(added, p.PayableID)
			}
		}
	}

	// Every week this settlement spans, with the price standing NOW. It is not
	// a list of weeks that changed, and it must not be presented as one: the
	// caller never told us what price it was shown, so we cannot know. It was
	// called changedWeeks once and a screen built on it would have blamed a
	// reprice for a late weighing.
	weeks := []map[string]any{}
	seen := map[string]bool{}
	for _, p := range chosen {
		key := p.WeekStart.Format("2006-01-02")
		if seen[key] {
			continue
		}
		seen[key] = true
		price, err := WeekPrice(ctx, tx, p.WeekStart)
		if err != nil {
			return nil, err
		}
		weeks = append(weeks, map[string]any{"weekStart": key, "priceCents": price})
	}

	return map[string]any{
		"expectedCents":     expected,
		"actualCents":       actual,
		"addedPayableIds":   added,
		"removedPayableIds": removed,
		"weeksInSettlement": weeks,
		// Whether the two id lists above mean anything. Without payableIds we
		// can only compare totals, so empty lists say "we were not told what
		// you saw", not "nothing moved" — and a screen that cannot tell those
		// apart will explain the difference wrongly.
		"payableIdsProvided": len(askedFor) > 0,
	}, nil
}

func winningSettlement(ctx context.Context, tx pgx.Tx, payableID string) (map[string]any, error) {
	var id string
	var gross int64
	var created time.Time
	err := tx.QueryRow(ctx, `
		SELECT s.id::text, s.gross_minor, s.created_at
		  FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id
		 WHERE si.payable_id = $1 AND si.voided_at IS NULL`, payableID).Scan(&id, &gross, &created)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "grossCents": gross, "createdAt": created}, nil
}

func GetSettlement(ctx context.Context, tx pgx.Tx, id string) (*Settlement, error) {
	var s Settlement
	err := tx.QueryRow(ctx, `
		SELECT id::text, employee_id::text, period_start, period_end, gross_minor,
		       status::text, note, created_at, voided_at
		  FROM settlements WHERE id = $1`, id).
		Scan(&s.ID, &s.EmployeeID, &s.PeriodStart, &s.PeriodEnd, &s.GrossMinor,
			&s.Status, &s.Note, &s.CreatedAt, &s.VoidedAt)
	if err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, `
		SELECT si.payable_id::text, l.activity_id::text, a.name, l.pay_scheme, l.rate_source,
		       si.quantity::text, l.unit_id::text, l.local_day, si.week_start,
		       si.price_minor, si.amount_minor, si.voided_at IS NOT NULL
		  FROM settlement_items si
		  JOIN work_records l ON l.id = si.payable_id
		  JOIN activities a ON a.id = l.activity_id
		 WHERE si.settlement_id = $1
		 ORDER BY l.local_day, si.payable_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	s.Items = []Payable{}
	for rows.Next() {
		var p Payable
		var qty string
		if err := rows.Scan(&p.PayableID, &p.ActivityID, &p.ActivityName, &p.PayScheme,
			&p.RateSource, &qty, &p.UnitID, &p.LocalDay, &p.WeekStart,
			&p.PriceMinor, &p.AmountMinor, &p.Voided); err != nil {
			return nil, err
		}
		p.Quantity = json.Number(qty)
		s.Items = append(s.Items, p)
	}
	return &s, rows.Err()
}

// VoidSettlement cancels a settlement without editing a thing. The items keep
// their rows for the record but get a voided_at, which is what releases their
// payables from the lock; the earning is cancelled by a reversal, never deleted.
//
// `reversalID` is the client-generated id of the reversal this void writes,
// and it is the idempotency key of the whole operation. A void has no row of
// its own to key on — it is a flag and a reversal — so the reversal's id is
// what a resent request is recognised by. Same three outcomes as
// ReverseLedgerEntry, for the same reason: with the key it is a safe retry,
// without one a second void is a second attempt to hand the money back, and
// this function is not allowed to guess which.
func VoidSettlement(ctx context.Context, tx pgx.Tx, farmID, settlementID, reversalID, createdBy string,
	on *time.Time) (*Settlement, bool, error) {
	var status string
	if err := tx.QueryRow(ctx,
		`SELECT status::text FROM settlements WHERE id = $1 FOR UPDATE`, settlementID).
		Scan(&status); err != nil {
		return nil, false, err
	}
	if status == "void" {
		if reversalID != "" {
			existing, err := FindLedgerEntry(ctx, tx, reversalID)
			if err != nil {
				return nil, false, err
			}
			// The reversal this very request wrote the first time round.
			if existing != nil && existing.SettlementID != nil &&
				*existing.SettlementID == settlementID && existing.Kind == domain.KindReversal {
				out, err := GetSettlement(ctx, tx, settlementID)
				return out, false, err
			}
		}
		return nil, false, domain.Conflict(domain.CodeSettlementAlreadyVoid,
			"the settlement is already void")
	}

	if _, err := tx.Exec(ctx, `
		UPDATE settlement_items SET voided_at = now()
		 WHERE settlement_id = $1 AND voided_at IS NULL`, settlementID); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE settlements SET status = 'void', voided_at = now() WHERE id = $1`, settlementID); err != nil {
		return nil, false, err
	}

	rows, err := tx.Query(ctx, `
		SELECT id::text, employee_id::text, amount_minor
		  FROM ledger
		 WHERE settlement_id = $1 AND kind = 'devengo'
		   AND NOT EXISTS (SELECT 1 FROM ledger r WHERE r.reverses_id = ledger.id)`, settlementID)
	if err != nil {
		return nil, false, err
	}
	type entry struct {
		id, employeeID string
		amount         int64
	}
	var toReverse []entry
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.id, &e.employeeID, &e.amount); err != nil {
			rows.Close()
			return nil, false, err
		}
		toReverse = append(toReverse, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}

	day, err := dayOrToday(ctx, tx, on)
	if err != nil {
		return nil, false, err
	}
	for i, e := range toReverse {
		// The caller's id names the first reversal, which in practice is the
		// only one: Settle writes exactly one devengo per settlement, and
		// ledger_devengo_has_settlement keeps it that way. Any further ones
		// get their own ids — they are not what the retry is recognised by.
		rowID := uuid.NewString()
		if i == 0 && reversalID != "" {
			rowID = reversalID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO ledger (id, farm_id, employee_id, kind, amount_minor, local_day,
			                    settlement_id, reverses_id, created_by)
			VALUES ($1, $2, $3, 'reverso', $4, $5, $6, $7, $8)`,
			rowID, farmID, e.employeeID, -e.amount, day, settlementID, e.id, createdBy); err != nil {
			return nil, false, err
		}
	}
	out, err := GetSettlement(ctx, tx, settlementID)
	return out, true, err
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

type LedgerEntry struct {
	ID           string            `json:"id"`
	EmployeeID   string            `json:"workerId"`
	Kind         domain.LedgerKind `json:"kind"`
	AmountMinor  int64             `json:"amountCents"`
	LocalDay     time.Time         `json:"date"`
	SettlementID *string           `json:"settlementId"`
	Method       *string           `json:"method"`
	Note         *string           `json:"note"`
	ReversesID   *string           `json:"reversesId"`
	CreatedAt    time.Time         `json:"createdAt"`
}

// dayOrToday takes the caller's business day when there is one, and otherwise
// asks the farm what day it is. It is never the server's calendar day.
func dayOrToday(ctx context.Context, tx pgx.Tx, on *time.Time) (time.Time, error) {
	if on != nil {
		return *on, nil
	}
	return LocalToday(ctx, tx)
}

// LocalToday is the farm's calendar day, not the server's.
func LocalToday(ctx context.Context, tx pgx.Tx) (time.Time, error) {
	var day time.Time
	err := tx.QueryRow(ctx, `
		SELECT (now() AT TIME ZONE f.timezone)::date FROM farms f WHERE f.id = current_farm()`).
		Scan(&day)
	return day, err
}

type NewLedgerEntry struct {
	ID          string
	EmployeeID  string
	Kind        domain.LedgerKind
	AmountMinor int64
	LocalDay    *time.Time
	Method      *string
	Note        *string
	CreatedBy   string
}

const ledgerCols = `id::text, employee_id::text, kind, amount_minor, local_day,
	settlement_id::text, method::text, note, reverses_id::text, created_at`

func scanLedgerEntry(row pgx.Row) (*LedgerEntry, error) {
	var e LedgerEntry
	err := row.Scan(&e.ID, &e.EmployeeID, &e.Kind, &e.AmountMinor, &e.LocalDay,
		&e.SettlementID, &e.Method, &e.Note, &e.ReversesID, &e.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// FindLedgerEntry returns the movement with this id, or (nil, nil) when this
// farm has none. It is the lookup the idempotent write paths do FIRST, before
// they derive anything — see the comment on Matches.
func FindLedgerEntry(ctx context.Context, tx pgx.Tx, id string) (*LedgerEntry, error) {
	e, err := scanLedgerEntry(tx.QueryRow(ctx,
		`SELECT `+ledgerCols+` FROM ledger WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return e, nil
}

// Matches reports whether a movement already in the ledger is the same write
// the caller is now making — which is what makes resending it safe.
//
// It compares only what the client actually stated. A field the client left
// out cannot disagree with anything, and `date` in particular is derived from
// the farm's clock when it is absent: comparing a derived day would turn a
// retry sent after midnight into a spurious conflict.
//
// `note` is deliberately NOT compared. It decides no money, and a client that
// appends "(reintento)" to its note on the second attempt must not be told its
// payment failed. Everything that decides money is compared, and a difference
// in any of it is a 409 rather than a shrug.
func (e *LedgerEntry) Matches(n NewLedgerEntry, kind domain.LedgerKind) bool {
	if e.EmployeeID != n.EmployeeID || e.Kind != kind || e.AmountMinor != n.AmountMinor {
		return false
	}
	if n.LocalDay != nil && !sameDay(e.LocalDay, *n.LocalDay) {
		return false
	}
	if n.Method != nil && (e.Method == nil || *e.Method != *n.Method) {
		return false
	}
	return true
}

func sameDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}

// AddLedgerEntry appends one movement, idempotently by (farm_id, id).
//
// Nothing here is ever edited: the sign rules, the append-only rules and the
// reversal trigger live in the database, so the insert is plain and the
// constraints do the arguing. What the insert is NOT is bare.
//
// ON CONFLICT DO NOTHING is the whole fix. A bare INSERT answered a resent
// payment with a primary key violation, which aborts the transaction and
// surfaces as a 500 — and the foreman who has already handed over the cash has
// no way to tell whether it landed. That is not a rare edge: a farm with two
// bars of signal times out, and every client retries on its own.
//
// DO NOTHING rather than DO UPDATE, because DO UPDATE needs the UPDATE
// privilege the app role deliberately does not have on the ledger, and because
// there is nothing to update: the row that is already there IS the answer.
//
// It returns whether it wrote, so the handler can answer 201 the first time
// and 200 on the retry.
func AddLedgerEntry(ctx context.Context, tx pgx.Tx, farmID string, e NewLedgerEntry) (*LedgerEntry, bool, error) {
	d, err := dayOrToday(ctx, tx, e.LocalDay)
	if err != nil {
		return nil, false, err
	}
	day := &d
	out, err := scanLedgerEntry(tx.QueryRow(ctx, `
		INSERT INTO ledger (id, farm_id, employee_id, kind, amount_minor, local_day,
		                    method, note, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7::pay_method, $8, $9)
		ON CONFLICT (id) DO NOTHING
		RETURNING `+ledgerCols,
		e.ID, farmID, e.EmployeeID, e.Kind, e.AmountMinor, day, e.Method, e.Note, e.CreatedBy))
	if err == nil {
		return out, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, err
	}

	// The id was taken. Normally the handler has already resolved this and we
	// only get here when two identical requests raced, but the check is
	// repeated rather than assumed: this function is the last thing between a
	// duplicate and the money.
	existing, err := FindLedgerEntry(ctx, tx, e.ID)
	if err != nil {
		return nil, false, err
	}
	if existing == nil {
		// A row with that id exists and this farm cannot see it. Saying so is
		// not an option — that would confirm another farm's id — and 404 would
		// be a lie about a write that genuinely cannot be performed. The id is
		// in use; that is all the caller gets, and all it needs.
		return nil, false, domain.Conflict(domain.CodeIdempotencyKeyReused,
			"that id is already in use")
	}
	if !existing.Matches(e, e.Kind) {
		return nil, false, domain.Conflict(domain.CodeIdempotencyKeyReused,
			"that id already names a different movement").
			WithDetails(map[string]any{"existing": existing})
	}
	return existing, false, nil
}

// ReverseLedgerEntry cancels a movement with its exact opposite. The unique
// partial index on reverses_id is what makes it happen once and only once.
//
// `reversalID` is the client-generated id OF THE REVERSAL, and it is what
// makes retrying safe. With it, the three outcomes are distinct and all three
// are needed:
//
//	same id, already written  -> 200 with the reversal that is already there.
//	                             The retry the contract promises is safe.
//	a different id, already reversed -> 409 ALREADY_REVERSED. Not a retry: a
//	                             second, separate attempt to undo the same
//	                             movement, and undoing it twice would hand the
//	                             money back twice.
//	no id at all              -> 409 ALREADY_REVERSED, because without a key
//	                             there is no way to tell those two apart, and
//	                             guessing in favour of "it was a retry" is
//	                             guessing with somebody's wages.
func ReverseLedgerEntry(ctx context.Context, tx pgx.Tx, farmID, entryID, reversalID, createdBy string,
	note *string, on *time.Time) (*LedgerEntry, bool, error) {
	if reversalID != "" {
		existing, err := FindLedgerEntry(ctx, tx, reversalID)
		if err != nil {
			return nil, false, err
		}
		if existing != nil {
			if existing.ReversesID == nil || *existing.ReversesID != entryID {
				return nil, false, domain.Conflict(domain.CodeIdempotencyKeyReused,
					"that id already names a different movement")
			}
			return existing, false, nil
		}
	}

	var employeeID string
	var amount int64
	var kind domain.LedgerKind
	var settlementID *string
	// No FOR UPDATE: a row lock needs the UPDATE privilege, and the app role
	// does not have it on the ledger by design. It is not needed either, since
	// the ledger is append-only and ux_ledger_reverses settles any race.
	err := tx.QueryRow(ctx, `
		SELECT employee_id::text, amount_minor, kind, settlement_id::text
		  FROM ledger WHERE id = $1`, entryID).
		Scan(&employeeID, &amount, &kind, &settlementID)
	if err != nil {
		return nil, false, err
	}
	if kind == domain.KindReversal {
		return nil, false, domain.Conflict(domain.CodeAlreadyReversed, "a reversal cannot be reversed")
	}

	day, err := dayOrToday(ctx, tx, on)
	if err != nil {
		return nil, false, err
	}
	newRowID := reversalID
	if newRowID == "" {
		newRowID = uuid.NewString()
	}
	out, err := scanLedgerEntry(tx.QueryRow(ctx, `
		INSERT INTO ledger (id, farm_id, employee_id, kind, amount_minor, local_day,
		                    settlement_id, note, reverses_id, created_by)
		VALUES ($1, $2, $3, 'reverso', $4, $5, $6, $7, $8, $9)
		ON CONFLICT (id) DO NOTHING
		RETURNING `+ledgerCols,
		newRowID, farmID, employeeID, -amount, day, settlementID, note, entryID, createdBy))
	if err != nil {
		if IsUniqueViolation(err, "ux_ledger_reverses") {
			return nil, false, domain.Conflict(domain.CodeAlreadyReversed,
				"that movement was already reversed").WithCause(err)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			// The id belongs to a row this farm cannot see. Same answer as
			// AddLedgerEntry, for the same reason.
			return nil, false, domain.Conflict(domain.CodeIdempotencyKeyReused,
				"that id is already in use")
		}
		return nil, false, err
	}
	return out, true, nil
}

func ListLedger(ctx context.Context, tx pgx.Tx, employeeID string, limit int) ([]LedgerEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, employee_id::text, kind, amount_minor, local_day,
		       settlement_id::text, method::text, note, reverses_id::text, created_at
		  FROM ledger WHERE employee_id = $1
		 ORDER BY local_day DESC, created_at DESC
		 LIMIT $2`, employeeID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []LedgerEntry{}
	for rows.Next() {
		var e LedgerEntry
		if err := rows.Scan(&e.ID, &e.EmployeeID, &e.Kind, &e.AmountMinor, &e.LocalDay,
			&e.SettlementID, &e.Method, &e.Note, &e.ReversesID, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ListBalances is the farm-wide view: every worker with their position.
func ListBalances(ctx context.Context, tx pgx.Tx) ([]domain.Balance, error) {
	rows, err := tx.Query(ctx, `
		SELECT e.id::text,
		       COALESCE(SUM(CASE WHEN l.kind = 'devengo' THEN l.amount_minor
		                         WHEN l.kind = 'reverso' AND l.amount_minor < 0 THEN l.amount_minor END), 0),
		       COALESCE(-SUM(CASE WHEN l.kind IN ('pago','anticipo') THEN l.amount_minor
		                          WHEN l.kind = 'reverso' AND l.amount_minor > 0 THEN l.amount_minor END), 0),
		       COALESCE(-SUM(CASE WHEN l.kind = 'deduccion' THEN l.amount_minor END), 0),
		       COALESCE(SUM(l.amount_minor), 0),
		       MAX(l.local_day)
		  FROM employees e LEFT JOIN ledger l ON l.employee_id = e.id
		 WHERE e.deleted_at IS NULL
		 GROUP BY e.id
		 ORDER BY 5 DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.Balance{}
	for rows.Next() {
		var b domain.Balance
		if err := rows.Scan(&b.EmployeeID, &b.EarnedMinor, &b.PaidMinor,
			&b.DeductedMinor, &b.BalanceMinor, &b.LastMovementOn); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
