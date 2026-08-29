package store

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// WorkRecord is the one payable entity — `work_records` in Postgres,
// /v1/work-records on the wire, and "labor" in the Spanish interface, which is
// the owner's word. A weighing is a work record of a work-unit activity with
// dateFrom = dateTo, and there is no separate pickups table: two payable tables
// would need two anti double-pay locks, and one settlement could never take
// both.
type WorkRecord struct {
	ID          string            `json:"id"`
	EmployeeID  string            `json:"workerId"`
	ActivityID  string            `json:"activityId"`
	PayScheme   domain.PayScheme  `json:"payScheme"`
	RateSource  domain.RateSource `json:"rateSource"`
	StartedAt   time.Time         `json:"startedAt"`
	EndedAt     *time.Time        `json:"endedAt"`
	LocalDay    time.Time         `json:"dateFrom"`
	EndLocalDay time.Time         `json:"dateTo"`
	WeekStart   time.Time         `json:"weekStart"`
	Quantity    json.Number       `json:"quantity"`
	// settledAmount is what the live settlement line paid for this record, if
	// any. Unexported: callers read EffectiveMinor.
	settledAmount *int64  `json:"-"`
	UnitID        *string `json:"unitId"`
	PriceMinor    *int64  `json:"rateCents"`
	AmountMinor   *int64  `json:"amountCents"`
	Note          *string `json:"note"`
	// DeviceID is the handset that recorded it. The column existed from
	// migration 00005 and nothing wrote it, so every record looked as if it
	// came from nowhere; the sync push needs it to say WHICH phone sent a
	// weighing, and so does the reactivation trail of decision 8.
	DeviceID    *string    `json:"deviceId"`
	CreatedBy   *string    `json:"createdBy"`
	CreatedAt   time.Time  `json:"createdAt"`
	DeletedAt   *time.Time `json:"deletedAt"`
	PlotIDs     []string   `json:"plotIds"`
	PlotCropIDs []string   `json:"plotCropIds"`
	Settled     bool       `json:"settled"`

	// What the record is worth, always a number, so a screen never has to show
	// a zero it does not mean. AmountMinor above is the row's own truth and is
	// null for anything priced by the week, because that price is not chosen
	// until the week is settled — which left every harvest record in the
	// console showing $0, settled ones included.
	//
	// EffectiveMinor is the settled amount when there is one, and otherwise the
	// quantity at the price in force for its week: the same number the
	// settlement would post today. AmountIsEstimate says which of the two it
	// is, because "what we owe" and "what we paid" must never look alike.
	EffectiveMinor   int64 `json:"estimatedAmountCents"`
	AmountIsEstimate bool  `json:"amountIsEstimate"`
}

const workRecordCols = `l.id::text, l.employee_id::text, l.activity_id::text, l.pay_scheme,
	l.rate_source, l.started_at, l.ended_at, l.local_day, l.end_local_day, l.week_start,
	l.quantity::text, l.unit_id::text, l.price_minor, l.amount_minor, l.note,
	l.device_id::text, l.created_by::text, l.created_at, l.deleted_at,
	EXISTS (SELECT 1 FROM settlement_items si
	         WHERE si.payable_id = l.id AND si.voided_at IS NULL) AS settled,
	(SELECT si.amount_minor FROM settlement_items si
	  WHERE si.payable_id = l.id AND si.voided_at IS NULL LIMIT 1) AS settled_amount`

func scanWorkRecord(row pgx.Row) (*WorkRecord, error) {
	var l WorkRecord
	var qty string
	err := row.Scan(&l.ID, &l.EmployeeID, &l.ActivityID, &l.PayScheme, &l.RateSource,
		&l.StartedAt, &l.EndedAt, &l.LocalDay, &l.EndLocalDay, &l.WeekStart,
		&qty, &l.UnitID, &l.PriceMinor, &l.AmountMinor, &l.Note, &l.DeviceID,
		&l.CreatedBy, &l.CreatedAt, &l.DeletedAt, &l.Settled, &l.settledAmount)
	if err != nil {
		return nil, err
	}
	l.Quantity = json.Number(qty)
	l.PlotIDs = []string{}
	l.PlotCropIDs = []string{}
	return &l, nil
}

// LocalDayFor asks Postgres what calendar day an instant falls on in the
// farm's own timezone. Go never computes this: the farm's zone lives in the
// farms row, and a 19:30 weighing in Bogota is already tomorrow in UTC.
func LocalDayFor(ctx context.Context, tx pgx.Tx, at time.Time) (time.Time, error) {
	var day time.Time
	err := tx.QueryRow(ctx, `
		SELECT ($1::timestamptz AT TIME ZONE f.timezone)::date
		  FROM farms f WHERE f.id = current_farm()`, at).Scan(&day)
	return day, err
}

// InstantForLocalDay turns a calendar day into an instant that lands back on
// that same day in the farm's zone. Midday, deliberately: a midnight timestamp
// plus a daylight saving shift is exactly how work ends up filed on the day
// before.
func InstantForLocalDay(ctx context.Context, tx pgx.Tx, day time.Time) (time.Time, error) {
	var at time.Time
	err := tx.QueryRow(ctx, `
		SELECT ($1::date + time '12:00') AT TIME ZONE f.timezone
		  FROM farms f WHERE f.id = current_farm()`, day).Scan(&at)
	return at, err
}

type WorkRecordFilter struct {
	EmployeeID string
	ActivityID string
	PlotID     string
	PlotCropID string
	From       *time.Time
	To         *time.Time
	// PayScheme narrows to one way of paying. It is what makes the legacy
	// /v1/pickups facade a filter rather than a second table: a weighing is a
	// work record of an 'unidad_trabajo' activity and nothing else.
	PayScheme domain.PayScheme
	Filter
}

func ListWorkRecords(ctx context.Context, tx pgx.Tx, f WorkRecordFilter) ([]WorkRecord, error) {
	rows, err := tx.Query(ctx, `
		SELECT `+workRecordCols+`
		  FROM work_records l
		  JOIN activities a ON a.farm_id = l.farm_id AND a.id = l.activity_id
		  JOIN employees  e ON e.farm_id = l.farm_id AND e.id = l.employee_id
		 WHERE ($6 OR l.deleted_at IS NULL)
		   AND (NOT $7 OR l.deleted_at IS NOT NULL)
		   AND ($1::uuid IS NULL OR l.employee_id = $1)
		   AND ($2::uuid IS NULL OR l.activity_id = $2)
		   AND ($3::date IS NULL OR l.local_day >= $3)
		   AND ($4::date IS NULL OR l.end_local_day <= $4)
		   AND ($5::uuid IS NULL OR EXISTS (
		         SELECT 1 FROM work_record_plots lp WHERE lp.work_record_id = l.id AND lp.plot_id = $5))
		   AND ($8::uuid IS NULL OR EXISTS (
		         SELECT 1 FROM work_record_plot_crops lc
		          WHERE lc.work_record_id = l.id AND lc.plot_crop_id = $8))
		   AND ($9::pay_scheme IS NULL OR l.pay_scheme = $9)
		   AND ($10::text IS NULL
		        OR a.name ILIKE '%' || $10 || '%'
		        OR (e.name || ' ' || coalesce(e.last_name, '')) ILIKE '%' || $10 || '%'
		        OR coalesce(l.note, '') ILIKE '%' || $10 || '%')
		 ORDER BY l.local_day DESC, l.created_at DESC`,
		nilUUID(f.EmployeeID), nilUUID(f.ActivityID), f.From, f.To, nilUUID(f.PlotID),
		f.includeDeleted(), f.onlyDeleted(), nilUUID(f.PlotCropID),
		nilIfEmpty(string(f.PayScheme)), nilIfEmpty(f.Q))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []WorkRecord{}
	ids := []string{}
	for rows.Next() {
		l, err := scanWorkRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *l)
		ids = append(ids, l.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return attachWorkRecordLinks(ctx, tx, out, ids)
}

func GetWorkRecord(ctx context.Context, tx pgx.Tx, id string) (*WorkRecord, error) {
	l, err := scanWorkRecord(tx.QueryRow(ctx, `SELECT `+workRecordCols+` FROM work_records l WHERE l.id = $1`, id))
	if err != nil {
		return nil, err
	}
	out, err := attachWorkRecordLinks(ctx, tx, []WorkRecord{*l}, []string{l.ID})
	if err != nil {
		return nil, err
	}
	return &out[0], nil
}

// priceWorkRecords fills in what each record is worth, so no screen has to
// decide what a null amount means. A settled record is worth what its
// settlement line paid; an unsettled one priced by the week is worth its
// quantity at the price in force for that week — the number the settlement
// would post if it ran now. Everything else already froze its own amount.
//
// Week prices are looked up once per distinct week, not once per record: a
// season list is thousands of rows over a few dozen weeks.
func priceWorkRecords(ctx context.Context, tx pgx.Tx, records []WorkRecord) error {
	prices := map[string]int64{}
	for i := range records {
		r := &records[i]
		switch {
		case r.settledAmount != nil:
			r.EffectiveMinor, r.AmountIsEstimate = *r.settledAmount, false
		case r.AmountMinor != nil:
			r.EffectiveMinor, r.AmountIsEstimate = *r.AmountMinor, false
		case r.RateSource == domain.RateWeeklyPrice:
			key := r.WeekStart.Format("2006-01-02")
			price, ok := prices[key]
			if !ok {
				p, err := WeekPrice(ctx, tx, r.WeekStart)
				if err != nil {
					return err
				}
				price = p
				prices[key] = price
			}
			qty, ok := new(big.Rat).SetString(r.Quantity.String())
			if !ok {
				return fmt.Errorf("work record %s has an unreadable quantity %q", r.ID, r.Quantity)
			}
			r.EffectiveMinor = domain.AmountMinor(qty, price)
			r.AmountIsEstimate = true
		default:
			// No frozen amount and no way to derive one. Zero here is the truth,
			// not a stand-in for a value we failed to fetch.
			r.EffectiveMinor, r.AmountIsEstimate = 0, true
		}
	}
	return nil
}

func attachWorkRecordLinks(ctx context.Context, tx pgx.Tx, records []WorkRecord, ids []string) ([]WorkRecord, error) {
	if err := priceWorkRecords(ctx, tx, records); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return records, nil
	}
	index := map[string]int{}
	for i, l := range records {
		index[l.ID] = i
	}

	plotRows, err := tx.Query(ctx, `
		SELECT work_record_id::text, plot_id::text FROM work_record_plots WHERE work_record_id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	for plotRows.Next() {
		var recordID, plotID string
		if err := plotRows.Scan(&recordID, &plotID); err != nil {
			plotRows.Close()
			return nil, err
		}
		if i, ok := index[recordID]; ok {
			records[i].PlotIDs = append(records[i].PlotIDs, plotID)
		}
	}
	plotRows.Close()
	if err := plotRows.Err(); err != nil {
		return nil, err
	}

	cropRows, err := tx.Query(ctx, `
		SELECT work_record_id::text, plot_crop_id::text FROM work_record_plot_crops WHERE work_record_id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	defer cropRows.Close()
	for cropRows.Next() {
		var recordID, cropID string
		if err := cropRows.Scan(&recordID, &cropID); err != nil {
			return nil, err
		}
		if i, ok := index[recordID]; ok {
			records[i].PlotCropIDs = append(records[i].PlotCropIDs, cropID)
		}
	}
	return records, cropRows.Err()
}

// CreateWorkRecord writes the record and its plot and crop links. local_day and
// end_local_day are deliberately absent from the column list: the trigger
// computes them in the farm's timezone, and Go never writes them.
func CreateWorkRecord(ctx context.Context, tx pgx.Tx, farmID string, l WorkRecord) (*WorkRecord, error) {
	out, err := scanWorkRecord(tx.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO work_records (id, farm_id, employee_id, activity_id, pay_scheme, rate_source,
			                    started_at, ended_at, quantity, unit_id, price_minor,
			                    amount_minor, note, device_id, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, $12, $13, $14, $15)
			RETURNING *
		)
		SELECT `+workRecordCols+` FROM ins l`,
		l.ID, farmID, l.EmployeeID, l.ActivityID, l.PayScheme, l.RateSource,
		l.StartedAt, l.EndedAt, l.Quantity.String(), l.UnitID, l.PriceMinor,
		l.AmountMinor, l.Note, nilUUID(deref(l.DeviceID)), l.CreatedBy))
	if err != nil {
		return nil, err
	}

	for _, plotID := range l.PlotIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO work_record_plots (work_record_id, plot_id, farm_id) VALUES ($1, $2, $3)
			ON CONFLICT DO NOTHING`, out.ID, plotID, farmID); err != nil {
			return nil, err
		}
		out.PlotIDs = append(out.PlotIDs, plotID)
	}
	for _, cropID := range l.PlotCropIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO work_record_plot_crops (work_record_id, plot_crop_id, farm_id) VALUES ($1, $2, $3)
			ON CONFLICT DO NOTHING`, out.ID, cropID, farmID); err != nil {
			return nil, err
		}
		out.PlotCropIDs = append(out.PlotCropIDs, cropID)
	}
	// Price it before it goes back, so what the caller is handed after writing
	// is the same shape it will read a second later. A create that answered
	// with a zero and a list that answered with the real figure is a difference
	// nobody would think to look for.
	priced := []WorkRecord{*out}
	if err := priceWorkRecords(ctx, tx, priced); err != nil {
		return nil, err
	}
	out.EffectiveMinor, out.AmountIsEstimate = priced[0].EffectiveMinor, priced[0].AmountIsEstimate
	return out, nil
}

// IsSettled reports whether a live settlement has claimed this record.
func IsSettled(ctx context.Context, tx pgx.Tx, id string) (bool, error) {
	var settled bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM settlement_items si
		                WHERE si.payable_id = $1 AND si.voided_at IS NULL)`, id).Scan(&settled)
	return settled, err
}

// UpdateWorkRecord corrects a record that has not been paid yet, and it can
// change exactly two things: the quantity and the note.
//
// What it refuses to change is the interesting half. The worker is somebody
// else's money. The date decides which rate period and which week apply, so
// moving it silently reprices the line. The activity decides the pay scheme,
// which a composite foreign key pins to the row. And the frozen price stays
// frozen: that is the answer to "why was I paid this". Any of those is a
// different work record — delete this one and write that one, in that order,
// so the anti double-pay lock sees both.
//
// The amount is recomputed here rather than accepted from the caller, by the
// one money rule: amount = round(quantity * rate). A caller that could send
// its own total could send one that does not match its own line.
func UpdateWorkRecord(ctx context.Context, tx pgx.Tx, id string,
	quantity *json.Number, note *string) (*WorkRecord, error) {

	settled, err := IsSettled(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if settled {
		return nil, domain.Conflict(domain.CodeWorkRecordSettled,
			"the work record is part of a live settlement; void the settlement first")
	}

	var qty *string
	if quantity != nil {
		q := quantity.String()
		qty = &q
	}
	out, err := scanWorkRecord(tx.QueryRow(ctx, `
		WITH upd AS (
			UPDATE work_records SET
				quantity     = coalesce($2::numeric, quantity),
				amount_minor = CASE WHEN price_minor IS NULL THEN NULL
				                    ELSE round(coalesce($2::numeric, quantity) * price_minor)::bigint END,
				note         = coalesce($3, note)
			 WHERE id = $1 AND deleted_at IS NULL
			 RETURNING *
		)
		SELECT `+workRecordCols+` FROM upd l`, id, qty, note))
	if err != nil {
		return nil, err
	}
	res, err := attachWorkRecordLinks(ctx, tx, []WorkRecord{*out}, []string{out.ID})
	if err != nil {
		return nil, err
	}
	return &res[0], nil
}

// RestoreWorkRecord puts a logically deleted record back. It becomes payable
// again the moment it returns, which is why it is an administrator's action.
func RestoreWorkRecord(ctx context.Context, tx pgx.Tx, id string) error {
	tag, err := tx.Exec(ctx, `
		UPDATE work_records SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

// SoftDeleteWorkRecord refuses to touch a record a live settlement has
// claimed: money already paid does not get edited, it gets reversed.
func SoftDeleteWorkRecord(ctx context.Context, tx pgx.Tx, id string) error {
	var settled bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM settlement_items si
		                WHERE si.payable_id = $1 AND si.voided_at IS NULL)`, id).Scan(&settled)
	if err != nil {
		return err
	}
	if settled {
		return domain.Conflict(domain.CodeWorkRecordSettled,
			"the work record is part of a live settlement and cannot be removed")
	}
	tag, err := tx.Exec(ctx, `
		UPDATE work_records SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

func nilUUID(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
