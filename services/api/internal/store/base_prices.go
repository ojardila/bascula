package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// BasePriceSince is the SQL that resolves the farm's base price for a Monday
// from the effective-dated history (migration 00030). It takes the farm id
// expression and the Monday expression so the same rule reads the same way in
// WeekPrice and in the reports, which must never disagree on what a kilo is
// worth.
func basePriceSQL(farmExpr, mondayExpr string) string {
	return `(SELECT fp.price_minor FROM farm_prices fp
	          WHERE fp.farm_id = ` + farmExpr + ` AND fp.valid_from <= ` + mondayExpr + `
	          ORDER BY fp.valid_from DESC LIMIT 1)`
}

// BasePrice is one row of the farm's base price history.
type BasePrice struct {
	ValidFrom  time.Time `json:"validFrom"`
	PriceMinor int64     `json:"priceCents"`
	CreatedAt  time.Time `json:"createdAt"`
}

// BasePriceState is what the price screen and the onboarding tour need: the
// price in force this week, whether an owner has ever confirmed it, and the
// whole history, newest first.
type BasePriceState struct {
	CurrentMinor int64       `json:"currentCents"`
	Confirmed    bool        `json:"confirmed"`
	ThisWeek     time.Time   `json:"thisWeek"`
	History      []BasePrice `json:"history"`
}

// GetBasePrice reads the history. The early "since always" row that the
// migration and signup write is part of it: it is the price the farm started
// with.
func GetBasePrice(ctx context.Context, tx pgx.Tx) (*BasePriceState, error) {
	var st BasePriceState
	if err := tx.QueryRow(ctx, `
		WITH `+boundsCTE+`
		SELECT b.this_week,
		       COALESCE(`+basePriceSQL("current_farm()", "b.this_week")+`, fc.price_minor),
		       fc.price_confirmed_at IS NOT NULL
		  FROM bounds b, farm_config fc WHERE fc.farm_id = current_farm()`).
		Scan(&st.ThisWeek, &st.CurrentMinor, &st.Confirmed); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT valid_from, price_minor, created_at FROM farm_prices
		 WHERE farm_id = current_farm() ORDER BY valid_from DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	st.History = []BasePrice{}
	for rows.Next() {
		var p BasePrice
		if err := rows.Scan(&p.ValidFrom, &p.PriceMinor, &p.CreatedAt); err != nil {
			return nil, err
		}
		st.History = append(st.History, p)
	}
	return &st, rows.Err()
}

// BasePriceImpact counts what a base price starting on validFrom would move,
// and what it would not. Only weighings priced by the week are affected; a
// week with its own price keeps it, and a settled weighing keeps the price it
// was settled at — the approved rule is that a new price never changes a
// settled week.
type BasePriceImpact struct {
	Unsettled         int `json:"unsettledRecords"`
	Settled           int `json:"settledRecords"`
	WeeksWithOwnPrice int `json:"weeksWithOwnPrice"`
}

// GetBasePriceImpact looks from validFrom up to the next history row after it
// (which keeps its own price), or forever.
func GetBasePriceImpact(ctx context.Context, tx pgx.Tx, validFrom time.Time) (*BasePriceImpact, error) {
	var im BasePriceImpact
	err := tx.QueryRow(ctx, `
		WITH upto AS (
		  SELECT min(valid_from) AS until FROM farm_prices
		   WHERE farm_id = current_farm() AND valid_from > $1
		), recs AS (
		  SELECT l.id,
		         EXISTS (SELECT 1 FROM settlement_items si
		                  WHERE si.payable_id = l.id AND si.voided_at IS NULL) AS settled
		    FROM work_records l, upto
		   WHERE l.farm_id = current_farm()
		     AND l.deleted_at IS NULL
		     AND l.rate_source = 'weekly_price'
		     AND l.week_start >= $1
		     AND (upto.until IS NULL OR l.week_start < upto.until)
		     AND NOT EXISTS (SELECT 1 FROM week_prices wp
		                      WHERE wp.farm_id = l.farm_id AND wp.week_start = l.week_start)
		)
		SELECT (SELECT count(*) FILTER (WHERE NOT settled) FROM recs)::int,
		       (SELECT count(*) FILTER (WHERE settled) FROM recs)::int,
		       (SELECT count(*) FROM week_prices wp, upto
		         WHERE wp.farm_id = current_farm() AND wp.week_start >= $1
		           AND (upto.until IS NULL OR wp.week_start < upto.until))::int`,
		validFrom).Scan(&im.Unsettled, &im.Settled, &im.WeeksWithOwnPrice)
	if err != nil {
		return nil, err
	}
	return &im, nil
}

// SetBasePrice stores a base price from validFrom (a Monday) and marks the
// farm's price as confirmed. Setting the same Monday twice corrects it.
// farm_config.price_minor follows the price in force this week, because it is
// what the handset and the weigher's projection still read.
func SetBasePrice(ctx context.Context, tx pgx.Tx, farmID, userID string, validFrom time.Time, priceMinor int64) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO farm_prices (farm_id, valid_from, price_minor, created_by)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (farm_id, valid_from) DO UPDATE
		  SET price_minor = EXCLUDED.price_minor, created_by = EXCLUDED.created_by,
		      created_at = now()`,
		farmID, validFrom, priceMinor, nilIfEmpty(userID)); err != nil {
		return err
	}
	return syncCurrentBasePrice(ctx, tx, true)
}

// syncCurrentBasePrice copies the price in force this week into farm_config.
func syncCurrentBasePrice(ctx context.Context, tx pgx.Tx, confirm bool) error {
	_, err := tx.Exec(ctx, `
		WITH `+boundsCTE+`
		UPDATE farm_config fc SET
		  price_minor = COALESCE(`+basePriceSQL("fc.farm_id", "(SELECT this_week FROM bounds)")+`, fc.price_minor),
		  price_confirmed_at = CASE WHEN $1 THEN coalesce(fc.price_confirmed_at, now())
		                            ELSE fc.price_confirmed_at END
		 WHERE fc.farm_id = current_farm()`, confirm)
	return err
}
