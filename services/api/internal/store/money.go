package store

import (
	"context"
	"encoding/json"
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
func Settle(ctx context.Context, tx pgx.Tx, farmID, employeeID, settlementID string,
	from, to time.Time, payableIDs []string, note *string, createdBy string,
	on *time.Time) (*Settlement, error) {

	pending, err := Pending(ctx, tx, employeeID, from, to)
	if err != nil {
		return nil, err
	}
	chosen := filterPayables(pending, payableIDs)
	if len(chosen) == 0 {
		return nil, domain.Conflict(domain.CodeNothingToSettle,
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
		return nil, domain.Conflict(domain.CodeNothingToSettle,
			"the settlement adds up to nothing")
	}

	s := Settlement{
		ID: settlementID, EmployeeID: employeeID, PeriodStart: periodStart, PeriodEnd: to,
		GrossMinor: gross, Status: "open", Note: note, Items: chosen,
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO settlements (id, farm_id, employee_id, period_start, period_end,
		                         gross_minor, note, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING created_at`,
		settlementID, farmID, employeeID, periodStart, to, gross, note, createdBy).Scan(&s.CreatedAt)
	if err != nil {
		return nil, err
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
				return nil, domain.Conflict(domain.CodePayableAlreadyClaimed,
					"a payable is already part of a live settlement").
					WithDetails(map[string]any{
						"payableId":         p.PayableID,
						"winningSettlement": winner,
					}).WithCause(err)
			}
			return nil, err
		}
	}

	day, err := dayOrToday(ctx, tx, on)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO ledger (id, farm_id, employee_id, kind, amount_minor, local_day,
		                    settlement_id, note, created_by)
		VALUES ($1, $2, $3, 'devengo', $4, $5, $6, $7, $8)`,
		uuid.NewString(), farmID, employeeID, gross, day, settlementID, note, createdBy); err != nil {
		return nil, err
	}
	return &s, nil
}

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
func VoidSettlement(ctx context.Context, tx pgx.Tx, farmID, settlementID, createdBy string,
	on *time.Time) (*Settlement, error) {
	var status string
	if err := tx.QueryRow(ctx,
		`SELECT status::text FROM settlements WHERE id = $1 FOR UPDATE`, settlementID).
		Scan(&status); err != nil {
		return nil, err
	}
	if status == "void" {
		return nil, domain.Conflict(domain.CodeSettlementAlreadyVoid,
			"the settlement is already void")
	}

	if _, err := tx.Exec(ctx, `
		UPDATE settlement_items SET voided_at = now()
		 WHERE settlement_id = $1 AND voided_at IS NULL`, settlementID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE settlements SET status = 'void', voided_at = now() WHERE id = $1`, settlementID); err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, `
		SELECT id::text, employee_id::text, amount_minor
		  FROM ledger
		 WHERE settlement_id = $1 AND kind = 'devengo'
		   AND NOT EXISTS (SELECT 1 FROM ledger r WHERE r.reverses_id = ledger.id)`, settlementID)
	if err != nil {
		return nil, err
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
			return nil, err
		}
		toReverse = append(toReverse, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	day, err := dayOrToday(ctx, tx, on)
	if err != nil {
		return nil, err
	}
	for _, e := range toReverse {
		if _, err := tx.Exec(ctx, `
			INSERT INTO ledger (id, farm_id, employee_id, kind, amount_minor, local_day,
			                    settlement_id, reverses_id, created_by)
			VALUES ($1, $2, $3, 'reverso', $4, $5, $6, $7, $8)`,
			uuid.NewString(), farmID, e.employeeID, -e.amount, day, settlementID, e.id, createdBy); err != nil {
			return nil, err
		}
	}
	return GetSettlement(ctx, tx, settlementID)
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

// AddLedgerEntry appends one movement. Nothing here is ever edited: the sign
// rules, the append-only rules and the reversal trigger live in the database,
// so this function is a plain insert and the constraints do the arguing.
func AddLedgerEntry(ctx context.Context, tx pgx.Tx, farmID string, e NewLedgerEntry) (*LedgerEntry, error) {
	d, err := dayOrToday(ctx, tx, e.LocalDay)
	if err != nil {
		return nil, err
	}
	day := &d
	var out LedgerEntry
	err = tx.QueryRow(ctx, `
		INSERT INTO ledger (id, farm_id, employee_id, kind, amount_minor, local_day,
		                    method, note, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7::pay_method, $8, $9)
		RETURNING id::text, employee_id::text, kind, amount_minor, local_day,
		          settlement_id::text, method::text, note, reverses_id::text, created_at`,
		e.ID, farmID, e.EmployeeID, e.Kind, e.AmountMinor, day, e.Method, e.Note, e.CreatedBy).
		Scan(&out.ID, &out.EmployeeID, &out.Kind, &out.AmountMinor, &out.LocalDay,
			&out.SettlementID, &out.Method, &out.Note, &out.ReversesID, &out.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ReverseLedgerEntry cancels a movement with its exact opposite. The unique
// partial index on reverses_id is what makes it happen once and only once; a
// second attempt is 409 ALREADY_REVERSED.
func ReverseLedgerEntry(ctx context.Context, tx pgx.Tx, farmID, entryID, createdBy string,
	note *string, on *time.Time) (*LedgerEntry, error) {
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
		return nil, err
	}
	if kind == domain.KindReversal {
		return nil, domain.Conflict(domain.CodeAlreadyReversed, "a reversal cannot be reversed")
	}

	day, err := dayOrToday(ctx, tx, on)
	if err != nil {
		return nil, err
	}
	var out LedgerEntry
	err = tx.QueryRow(ctx, `
		INSERT INTO ledger (id, farm_id, employee_id, kind, amount_minor, local_day,
		                    settlement_id, note, reverses_id, created_by)
		VALUES ($1, $2, $3, 'reverso', $4, $5, $6, $7, $8, $9)
		RETURNING id::text, employee_id::text, kind, amount_minor, local_day,
		          settlement_id::text, method::text, note, reverses_id::text, created_at`,
		uuid.NewString(), farmID, employeeID, -amount, day, settlementID, note, entryID, createdBy).
		Scan(&out.ID, &out.EmployeeID, &out.Kind, &out.AmountMinor, &out.LocalDay,
			&out.SettlementID, &out.Method, &out.Note, &out.ReversesID, &out.CreatedAt)
	if err != nil {
		if IsUniqueViolation(err, "ux_ledger_reverses") {
			return nil, domain.Conflict(domain.CodeAlreadyReversed,
				"that movement was already reversed").WithCause(err)
		}
		return nil, err
	}
	return &out, nil
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
