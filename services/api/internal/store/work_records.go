package store

import (
	"context"
	"encoding/json"
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
	UnitID      *string           `json:"unitId"`
	PriceMinor  *int64            `json:"rateCents"`
	AmountMinor *int64            `json:"amountCents"`
	Note        *string           `json:"note"`
	CreatedBy   *string           `json:"createdBy"`
	CreatedAt   time.Time         `json:"createdAt"`
	DeletedAt   *time.Time        `json:"deletedAt"`
	PlotIDs     []string          `json:"plotIds"`
	PlotCropIDs []string          `json:"plotCropIds"`
	Settled     bool              `json:"settled"`
}

const workRecordCols = `l.id::text, l.employee_id::text, l.activity_id::text, l.pay_scheme,
	l.rate_source, l.started_at, l.ended_at, l.local_day, l.end_local_day, l.week_start,
	l.quantity::text, l.unit_id::text, l.price_minor, l.amount_minor, l.note,
	l.created_by::text, l.created_at, l.deleted_at,
	EXISTS (SELECT 1 FROM settlement_items si
	         WHERE si.payable_id = l.id AND si.voided_at IS NULL) AS settled`

func scanWorkRecord(row pgx.Row) (*WorkRecord, error) {
	var l WorkRecord
	var qty string
	err := row.Scan(&l.ID, &l.EmployeeID, &l.ActivityID, &l.PayScheme, &l.RateSource,
		&l.StartedAt, &l.EndedAt, &l.LocalDay, &l.EndLocalDay, &l.WeekStart,
		&qty, &l.UnitID, &l.PriceMinor, &l.AmountMinor, &l.Note,
		&l.CreatedBy, &l.CreatedAt, &l.DeletedAt, &l.Settled)
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
	From       *time.Time
	To         *time.Time
}

func ListWorkRecords(ctx context.Context, tx pgx.Tx, f WorkRecordFilter) ([]WorkRecord, error) {
	rows, err := tx.Query(ctx, `
		SELECT `+workRecordCols+`
		  FROM work_records l
		 WHERE l.deleted_at IS NULL
		   AND ($1::uuid IS NULL OR l.employee_id = $1)
		   AND ($2::uuid IS NULL OR l.activity_id = $2)
		   AND ($3::date IS NULL OR l.local_day >= $3)
		   AND ($4::date IS NULL OR l.end_local_day <= $4)
		   AND ($5::uuid IS NULL OR EXISTS (
		         SELECT 1 FROM work_record_plots lp WHERE lp.work_record_id = l.id AND lp.plot_id = $5))
		 ORDER BY l.local_day DESC, l.created_at DESC`,
		nilUUID(f.EmployeeID), nilUUID(f.ActivityID), f.From, f.To, nilUUID(f.PlotID))
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

func attachWorkRecordLinks(ctx context.Context, tx pgx.Tx, records []WorkRecord, ids []string) ([]WorkRecord, error) {
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
			                    amount_minor, note, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, $12, $13, $14)
			RETURNING *
		)
		SELECT `+workRecordCols+` FROM ins l`,
		l.ID, farmID, l.EmployeeID, l.ActivityID, l.PayScheme, l.RateSource,
		l.StartedAt, l.EndedAt, l.Quantity.String(), l.UnitID, l.PriceMinor,
		l.AmountMinor, l.Note, l.CreatedBy))
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
	return out, nil
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
