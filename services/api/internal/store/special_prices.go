package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// ---------------------------------------------------------------------------
// Special kilo prices per lote and per person (migration 00034).
//
// An exception is a fixed price from a Monday on. A row whose price is NULL
// ends it from that Monday. kilo_price() in the migration is the single rule
// that turns all of this into the price of one weighing:
// persona > lote > semana > finca.
// ---------------------------------------------------------------------------

// SpecialKind names what an exception is attached to.
type SpecialKind string

const (
	SpecialPlot     SpecialKind = "lote"
	SpecialEmployee SpecialKind = "persona"
)

// ParseSpecialKind accepts the path segment used by the API.
func ParseSpecialKind(s string) (SpecialKind, error) {
	switch s {
	case "lotes", "lote", "plots":
		return SpecialPlot, nil
	case "personas", "persona", "employees":
		return SpecialEmployee, nil
	}
	return "", domain.BadRequest(`kind must be "lotes" or "personas"`)
}

func (k SpecialKind) table() (table, idCol string) {
	if k == SpecialPlot {
		return "plot_prices", "plot_id"
	}
	return "employee_prices", "employee_id"
}

// SpecialPriceRow is one dated entry. PriceMinor nil means "sin precio
// especial desde este lunes".
type SpecialPriceRow struct {
	ValidFrom  time.Time `json:"validFrom"`
	PriceMinor *int64    `json:"priceCents"`
	CreatedAt  time.Time `json:"createdAt"`
}

// SpecialPrice is one lote or person that has (or had) an exception.
type SpecialPrice struct {
	Kind         SpecialKind       `json:"kind"`
	TargetID     string            `json:"targetId"`
	TargetName   string            `json:"targetName"`
	CurrentMinor *int64            `json:"currentCents"`
	History      []SpecialPriceRow `json:"history"`
}

// ListSpecialPrices returns every lote and person with at least one row,
// lotes first, each with its history newest first and the price in force this
// week (nil when none applies this week).
func ListSpecialPrices(ctx context.Context, tx pgx.Tx) ([]SpecialPrice, error) {
	rows, err := tx.Query(ctx, `
		WITH `+boundsCTE+`,
		all_rows AS (
		  SELECT 'lote' AS kind, pp.plot_id AS target, p.name AS target_name,
		         pp.valid_from, pp.price_minor, pp.created_at
		    FROM plot_prices pp JOIN plots p ON p.farm_id = pp.farm_id AND p.id = pp.plot_id
		   WHERE pp.farm_id = current_farm()
		  UNION ALL
		  SELECT 'persona', ep.employee_id, btrim(e.name || coalesce(' ' || e.last_name, '')), ep.valid_from, ep.price_minor, ep.created_at
		    FROM employee_prices ep JOIN employees e ON e.farm_id = ep.farm_id AND e.id = ep.employee_id
		   WHERE ep.farm_id = current_farm()
		)
		SELECT r.kind, r.target::text, r.target_name, r.valid_from, r.price_minor, r.created_at,
		       (SELECT c.price_minor FROM all_rows c
		         WHERE c.kind = r.kind AND c.target = r.target AND c.valid_from <= (SELECT this_week FROM bounds)
		         ORDER BY c.valid_from DESC LIMIT 1) AS current_minor
		  FROM all_rows r
		 ORDER BY (r.kind = 'persona'), lower(r.target_name), r.target, r.valid_from DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SpecialPrice{}
	for rows.Next() {
		var kind, id, name string
		var row SpecialPriceRow
		var current *int64
		if err := rows.Scan(&kind, &id, &name, &row.ValidFrom, &row.PriceMinor, &row.CreatedAt, &current); err != nil {
			return nil, err
		}
		if n := len(out); n == 0 || out[n-1].TargetID != id || string(out[n-1].Kind) != kind {
			out = append(out, SpecialPrice{Kind: SpecialKind(kind), TargetID: id, TargetName: name,
				CurrentMinor: current, History: []SpecialPriceRow{}})
		}
		last := &out[len(out)-1]
		last.History = append(last.History, row)
	}
	return out, rows.Err()
}

// SetSpecialPrice stores (or corrects) the entry for one Monday. A nil price
// ends the exception from that Monday.
func SetSpecialPrice(ctx context.Context, tx pgx.Tx, farmID, userID string, kind SpecialKind,
	targetID string, validFrom time.Time, priceMinor *int64) error {
	table, col := kind.table()
	tag, err := tx.Exec(ctx, `
		INSERT INTO `+table+` (farm_id, `+col+`, valid_from, price_minor, created_by)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (farm_id, `+col+`, valid_from) DO UPDATE
		  SET price_minor = EXCLUDED.price_minor, created_by = EXCLUDED.created_by, created_at = now()`,
		farmID, targetID, validFrom, priceMinor, nilIfEmpty(userID))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.NotFound("special price")
	}
	return nil
}

// DeleteSpecialPrice removes one dated entry (a mistake), which is different
// from ending an exception: the rule before it applies again.
func DeleteSpecialPrice(ctx context.Context, tx pgx.Tx, kind SpecialKind, targetID string, validFrom time.Time) error {
	table, col := kind.table()
	tag, err := tx.Exec(ctx, `DELETE FROM `+table+`
		WHERE farm_id = current_farm() AND `+col+` = $1 AND valid_from = $2`, targetID, validFrom)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.NotFound("special price")
	}
	return nil
}

// SpecialTargetExists says whether the lote or person exists on this farm, so
// a typo in an id is a 404 rather than a foreign-key 500.
func SpecialTargetExists(ctx context.Context, tx pgx.Tx, kind SpecialKind, targetID string) (bool, error) {
	q := `SELECT EXISTS (SELECT 1 FROM plots WHERE farm_id = current_farm() AND id = $1)`
	if kind == SpecialEmployee {
		q = `SELECT EXISTS (SELECT 1 FROM employees WHERE farm_id = current_farm() AND id = $1)`
	}
	var ok bool
	err := tx.QueryRow(ctx, q, targetID).Scan(&ok)
	return ok, err
}

// SpecialPriceImpact counts the kilo weighings a special price from validFrom
// would touch, up to the next entry for the same lote or person. Settled ones
// keep the price they were settled at (the approved rule), so they are
// counted apart for the warning. For a lote, weighings of a person with their
// own price are counted apart too: the person's price wins.
type SpecialPriceImpact struct {
	Unsettled          int `json:"unsettledRecords"`
	Settled            int `json:"settledRecords"`
	OverriddenByPerson int `json:"overriddenByPerson"`
}

func GetSpecialPriceImpact(ctx context.Context, tx pgx.Tx, kind SpecialKind, targetID string, validFrom time.Time) (*SpecialPriceImpact, error) {
	table, col := kind.table()
	target := `l.employee_id = $1`
	if kind == SpecialPlot {
		target = `EXISTS (SELECT 1 FROM work_record_plots w WHERE w.farm_id = l.farm_id
		                   AND w.work_record_id = l.id AND w.plot_id = $1)`
	}
	var im SpecialPriceImpact
	err := tx.QueryRow(ctx, `
		WITH upto AS (
		  SELECT min(valid_from) AS until FROM `+table+`
		   WHERE farm_id = current_farm() AND `+col+` = $1 AND valid_from > $2
		), recs AS (
		  SELECT l.id,
		         EXISTS (SELECT 1 FROM settlement_items si
		                  WHERE si.payable_id = l.id AND si.voided_at IS NULL) AS settled,
		         ($3 AND EXISTS (SELECT 1 FROM employee_prices ep
		                  WHERE ep.farm_id = l.farm_id AND ep.employee_id = l.employee_id
		                    AND ep.valid_from <= l.week_start AND ep.price_minor IS NOT NULL
		                    AND ep.valid_from = (SELECT max(e2.valid_from) FROM employee_prices e2
		                          WHERE e2.farm_id = l.farm_id AND e2.employee_id = l.employee_id
		                            AND e2.valid_from <= l.week_start))) AS by_person
		    FROM work_records l, upto
		   WHERE l.farm_id = current_farm()
		     AND l.deleted_at IS NULL
		     AND l.rate_source = 'weekly_price'
		     AND l.week_start >= $2
		     AND (upto.until IS NULL OR l.week_start < upto.until)
		     AND `+target+`
		)
		SELECT count(*) FILTER (WHERE NOT settled AND NOT by_person)::int,
		       count(*) FILTER (WHERE settled)::int,
		       count(*) FILTER (WHERE NOT settled AND by_person)::int
		  FROM recs`, targetID, validFrom, kind == SpecialPlot).
		Scan(&im.Unsettled, &im.Settled, &im.OverriddenByPerson)
	if err != nil {
		return nil, err
	}
	return &im, nil
}

// KiloPrice is the resolved price of one weighing and where it came from:
// "persona", "lote", "semana" or "finca".
type KiloPrice struct {
	PriceMinor int64
	Source     string
}

// KiloPrices resolves many weighings at once with kilo_price(). Ids that are
// not kilo weighings of this farm are simply absent from the map.
func KiloPrices(ctx context.Context, tx pgx.Tx, recordIDs []string) (map[string]KiloPrice, error) {
	out := map[string]KiloPrice{}
	if len(recordIDs) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT l.id::text, kp.price_minor, kp.source
		  FROM work_records l
		  CROSS JOIN LATERAL kilo_price(l.farm_id, l.employee_id, l.id, l.week_start) kp
		 WHERE l.farm_id = current_farm() AND l.id = ANY($1::uuid[])`, recordIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var kp KiloPrice
		if err := rows.Scan(&id, &kp.PriceMinor, &kp.Source); err != nil {
			return nil, err
		}
		out[id] = kp
	}
	return out, rows.Err()
}
