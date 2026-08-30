package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

type WorkUnit struct {
	ID       string   `json:"id"`
	Code     string   `json:"code"`
	Label    string   `json:"label"`
	KgFactor *float64 `json:"kgFactor"`
	// InUse says whether any activity or work record points at this unit. It
	// is what decides whether the farm may delete it or only retire it, and it
	// is returned so the console can say which of the two a button will do
	// before it is pressed.
	InUse bool `json:"inUse"`
}

// ActivityRate is one period of an activity's price history. Decision 4: the
// rate is not a loose column any more, it is a row with a valid_from, and a
// work record freezes the one in force on its day.
type ActivityRate struct {
	ValidFrom  time.Time `json:"validFrom"`
	RateMinor  int64     `json:"rateCents"`
	TimeUnit   *string   `json:"timeUnit"`
	CustomQty  *float64  `json:"customQty"`
	CustomUnit *string   `json:"customUnit"`
}

type Activity struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	CategoryID string            `json:"categoryId"`
	Category   string            `json:"category"`
	PayScheme  domain.PayScheme  `json:"payScheme"`
	RateSource domain.RateSource `json:"rateSource"`
	// UnitID is on the activity and not on its rate: the unit is what is being
	// counted, not what it costs. The weigher can therefore see that he is
	// weighing kilos while being unable to read a single price.
	UnitID     *string    `json:"unitId"`
	ArchivedAt *time.Time `json:"archivedAt"`
	// Rate is omitted entirely for the weigher: same route, different
	// projection. It is nil when the caller may not see prices.
	Rate *ActivityRate `json:"rate,omitempty"`
}

// ListWorkUnits returns the farm's live units. Archived ones are left out:
// they exist so that records already written still resolve, not so that a
// picker offers a unit the farm stopped using.
func ListWorkUnits(ctx context.Context, tx pgx.Tx) ([]WorkUnit, error) {
	rows, err := tx.Query(ctx, `
		SELECT u.id::text, u.code, u.label, u.kg_factor::float8,
		       EXISTS (SELECT 1 FROM activities a WHERE a.unit_id = u.id)
		    OR EXISTS (SELECT 1 FROM work_records w WHERE w.unit_id = u.id)
		  FROM work_units u
		 WHERE u.archived_at IS NULL
		 ORDER BY u.code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []WorkUnit{}
	for rows.Next() {
		var u WorkUnit
		if err := rows.Scan(&u.ID, &u.Code, &u.Label, &u.KgFactor, &u.InUse); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// UpdateWorkUnit renames a unit or corrects its factor.
//
// A farm that typed "canata" had to live with it until now. Changing kg_factor
// is allowed and is not retroactive by accident: work_records store the
// quantity in the unit, so a corrected factor changes what future conversions
// say and leaves every recorded quantity exactly as it was written.
//
// touchFactor separates "leave the factor alone" from "set it to nothing". A
// PATCH that only renames must not wipe kg_factor: it is what converts a
// canasta into kilos, so losing it silently changes what a picker is paid.
func UpdateWorkUnit(ctx context.Context, tx pgx.Tx, id, code, label string,
	kgFactor *float64, touchFactor bool) (*WorkUnit, error) {
	var u WorkUnit
	err := tx.QueryRow(ctx, `
		UPDATE work_units
		   SET code = COALESCE(NULLIF($2, ''), code),
		       label = COALESCE(NULLIF($3, ''), label),
		       kg_factor = CASE WHEN $5 THEN $4 ELSE kg_factor END
		 WHERE id = $1 AND archived_at IS NULL
		 RETURNING id::text, code, label, kg_factor::float8,
		           EXISTS (SELECT 1 FROM activities a WHERE a.unit_id = work_units.id)
		        OR EXISTS (SELECT 1 FROM work_records w WHERE w.unit_id = work_units.id)`,
		id, code, label, kgFactor, touchFactor).Scan(&u.ID, &u.Code, &u.Label, &u.KgFactor, &u.InUse)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// WorkUnitInUse reports whether any activity or work record points at the unit.
func WorkUnitInUse(ctx context.Context, tx pgx.Tx, id string) (bool, error) {
	var used bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM activities WHERE unit_id = $1)
		    OR EXISTS (SELECT 1 FROM work_records WHERE unit_id = $1)`, id).Scan(&used)
	return used, err
}

// ArchiveWorkUnit retires a unit that history points at.
//
// Not a delete, and the difference is somebody's pay: a work record that says
// "40 canastas" means nothing once the canasta is gone. Archiving takes it out
// of the pickers and leaves every record that already referenced it readable.
func ArchiveWorkUnit(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, `
		UPDATE work_units SET archived_at = now()
		 WHERE id = $1 AND archived_at IS NULL`, id)
	return err
}

// DeleteWorkUnit removes a unit nothing points at. The caller must have
// established that with WorkUnitInUse; the WHERE clause repeats the check
// anyway, because between the two statements is a transaction another writer
// could have used to reference it.
func DeleteWorkUnit(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, `
		DELETE FROM work_units
		 WHERE id = $1
		   AND NOT EXISTS (SELECT 1 FROM activities WHERE unit_id = $1)
		   AND NOT EXISTS (SELECT 1 FROM work_records WHERE unit_id = $1)`, id)
	return err
}

// EnsureWorkUnit is idempotent by (farm_id, lower(code)), so the "add it if it
// does not exist" button never duplicates.
func EnsureWorkUnit(ctx context.Context, tx pgx.Tx, farmID, id, code, label string, kgFactor *float64) (string, error) {
	var out string
	err := tx.QueryRow(ctx, `
		INSERT INTO work_units (id, farm_id, code, label, kg_factor)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (farm_id, lower(code)) WHERE archived_at IS NULL
		  DO UPDATE SET label = work_units.label
		RETURNING id::text`, id, farmID, code, label, kgFactor).Scan(&out)
	return out, err
}

const activityCols = `a.id::text, a.name, a.category_id::text, c.name,
	a.pay_scheme, a.rate_source, a.unit_id::text, a.archived_at`

const activityFrom = ` FROM activities a JOIN activity_categories c ON c.id = a.category_id`

// ListActivities returns the farm's catalogue. withRates is false for the
// weigher, who gets the same list without a single price in it.
func ListActivities(ctx context.Context, tx pgx.Tx, withRates bool, on time.Time,
	f Filter, category string) ([]Activity, error) {

	rows, err := tx.Query(ctx, `
		SELECT `+activityCols+activityFrom+`
		 WHERE ($1 OR a.archived_at IS NULL)
		   AND (NOT $2 OR a.archived_at IS NOT NULL)
		   AND ($3::text IS NULL OR a.name ILIKE '%' || $3 || '%')
		   AND ($4::text IS NULL OR c.name ILIKE $4 OR c.id::text = $4)
		 ORDER BY c.name, a.name`,
		f.includeDeleted(), f.onlyDeleted(), nilIfEmpty(f.Q), nilIfEmpty(category))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Activity{}
	for rows.Next() {
		var a Activity
		if err := rows.Scan(&a.ID, &a.Name, &a.CategoryID, &a.Category,
			&a.PayScheme, &a.RateSource, &a.UnitID, &a.ArchivedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !withRates {
		return out, nil
	}
	for i := range out {
		rate, err := RateInForce(ctx, tx, out[i].ID, on)
		if err != nil && err != NoRows {
			return nil, err
		}
		out[i].Rate = rate
	}
	return out, nil
}

func GetActivity(ctx context.Context, tx pgx.Tx, id string) (*Activity, error) {
	var a Activity
	err := tx.QueryRow(ctx, `SELECT `+activityCols+activityFrom+` WHERE a.id = $1`, id).
		Scan(&a.ID, &a.Name, &a.CategoryID, &a.Category, &a.PayScheme, &a.RateSource,
			&a.UnitID, &a.ArchivedAt)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// RateInForce returns the rate period covering `on`. A period runs from its
// valid_from until the next one starts, which is why the anti-overlap
// guarantee needs nothing more than the primary key: there is no way to write
// two periods that cover the same day.
func RateInForce(ctx context.Context, tx pgx.Tx, activityID string, on time.Time) (*ActivityRate, error) {
	var r ActivityRate
	err := tx.QueryRow(ctx, `
		SELECT valid_from, rate_minor, time_unit, custom_qty::float8, custom_unit
		  FROM (
			SELECT valid_from, total_minor AS rate_minor,
			       NULL::text AS time_unit, NULL::numeric AS custom_qty, NULL::text AS custom_unit
			  FROM activity_pay_contract WHERE activity_id = $1
			UNION ALL
			SELECT valid_from, rate_minor, unit::text, custom_qty, custom_unit
			  FROM activity_pay_time WHERE activity_id = $1
			UNION ALL
			SELECT valid_from, price_minor, NULL::text, NULL::numeric, NULL::text
			  FROM activity_pay_work_unit WHERE activity_id = $1
		  ) r
		 WHERE valid_from <= $2
		 ORDER BY valid_from DESC
		 LIMIT 1`, activityID, on).
		Scan(&r.ValidFrom, &r.RateMinor, &r.TimeUnit, &r.CustomQty, &r.CustomUnit)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// HarvestActivityID resolves the activity a bare weighing belongs to: the
// farm's work-unit activity priced from the week, which every farm is seeded
// with as "Recoleccion". It is looked up and never hardcoded — a farm may have
// renamed it, and an id baked into Go would be another farm's row.
//
// A farm that has more than one is not a failure: the oldest is the seeded one
// and the phone, which knows nothing about activities, means that one. A farm
// with none gets a 409 rather than a silent guess, because the alternative is
// filing coffee under whatever activity happened to sort first.
func HarvestActivityID(ctx context.Context, tx pgx.Tx) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `
		SELECT a.id::text FROM activities a
		 WHERE a.archived_at IS NULL
		   AND a.pay_scheme = 'unidad_trabajo'
		   AND a.rate_source = 'weekly_price'
		 ORDER BY a.id
		 LIMIT 1`).Scan(&id)
	if err == pgx.ErrNoRows {
		return "", domain.Conflict(domain.CodeNoRateInForce,
			"this farm has no activity priced by the week; send activityId explicitly")
	}
	return id, err
}

type NewActivity struct {
	ID   string
	Name string
	// CategoryID names an existing catalogue row; Category is a name, which is
	// created in the catalogue if the farm has not used it before.
	CategoryID string
	Category   string
	PayScheme  domain.PayScheme
	RateSource domain.RateSource
	UnitID     *string
	Rate       ActivityRate
}

// CreateActivity writes the activity and its first rate period in the same
// transaction; the deferred constraint trigger refuses an activity that ends
// the transaction without one.
func CreateActivity(ctx context.Context, tx pgx.Tx, farmID string, a NewActivity, newID func() string) (*Activity, error) {
	if a.CategoryID == "" {
		if a.Category == "" {
			return nil, domain.BadRequest("an activity needs categoryId or category")
		}
		item, err := EnsureCatalogItem(ctx, tx, CatalogActivityCategories, farmID, newID(), a.Category)
		if err != nil {
			return nil, err
		}
		a.CategoryID = item.ID
	}
	var out Activity
	err := tx.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO activities (id, farm_id, name, category_id, pay_scheme,
			                        rate_source, unit_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING *
		)
		SELECT `+activityCols+` FROM ins a JOIN activity_categories c ON c.id = a.category_id`,
		a.ID, farmID, a.Name, a.CategoryID, a.PayScheme, a.RateSource, a.UnitID).
		Scan(&out.ID, &out.Name, &out.CategoryID, &out.Category, &out.PayScheme,
			&out.RateSource, &out.UnitID, &out.ArchivedAt)
	if err != nil {
		return nil, err
	}
	if err := SetActivityRate(ctx, tx, out.ID, a.PayScheme, a.Rate); err != nil {
		return nil, err
	}
	out.Rate = &a.Rate
	return &out, nil
}

// SetActivityRate opens a new validity period, or corrects one that starts on
// the same day. It never edits history: a rate that was already frozen onto a
// record stays frozen there.
func SetActivityRate(ctx context.Context, tx pgx.Tx, activityID string, scheme domain.PayScheme, r ActivityRate) error {
	if r.ValidFrom.IsZero() {
		r.ValidFrom = time.Now().UTC()
	}
	switch scheme {
	case domain.PaySchemeContract:
		_, err := tx.Exec(ctx, `
			INSERT INTO activity_pay_contract (activity_id, valid_from, total_minor)
			VALUES ($1, $2, $3)
			ON CONFLICT (activity_id, valid_from) DO UPDATE SET total_minor = EXCLUDED.total_minor`,
			activityID, r.ValidFrom, r.RateMinor)
		return err
	case domain.PaySchemeTime:
		unit := "jornal"
		if r.TimeUnit != nil {
			unit = *r.TimeUnit
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO activity_pay_time (activity_id, valid_from, unit, custom_qty, custom_unit, rate_minor)
			VALUES ($1, $2, $3::time_unit, $4, $5, $6)
			ON CONFLICT (activity_id, valid_from) DO UPDATE
			  SET rate_minor = EXCLUDED.rate_minor, unit = EXCLUDED.unit,
			      custom_qty = EXCLUDED.custom_qty, custom_unit = EXCLUDED.custom_unit`,
			activityID, r.ValidFrom, unit, r.CustomQty, r.CustomUnit, r.RateMinor)
		return err
	case domain.PaySchemeWorkUnit:
		_, err := tx.Exec(ctx, `
			INSERT INTO activity_pay_work_unit (activity_id, valid_from, price_minor)
			VALUES ($1, $2, $3)
			ON CONFLICT (activity_id, valid_from) DO UPDATE
			  SET price_minor = EXCLUDED.price_minor`,
			activityID, r.ValidFrom, r.RateMinor)
		return err
	}
	return domain.BadRequest("unknown pay scheme")
}

// ListActivityRates returns the whole price history of one activity, which is
// what makes a past payment explainable.
func ListActivityRates(ctx context.Context, tx pgx.Tx, activityID string) ([]ActivityRate, error) {
	rows, err := tx.Query(ctx, `
		SELECT valid_from, rate_minor, time_unit, custom_qty::float8, custom_unit
		  FROM (
			SELECT valid_from, total_minor AS rate_minor,
			       NULL::text AS time_unit, NULL::numeric AS custom_qty, NULL::text AS custom_unit
			  FROM activity_pay_contract WHERE activity_id = $1
			UNION ALL
			SELECT valid_from, rate_minor, unit::text, custom_qty, custom_unit
			  FROM activity_pay_time WHERE activity_id = $1
			UNION ALL
			SELECT valid_from, price_minor, NULL::text, NULL::numeric, NULL::text
			  FROM activity_pay_work_unit WHERE activity_id = $1
		  ) r ORDER BY valid_from DESC`, activityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ActivityRate{}
	for rows.Next() {
		var r ActivityRate
		if err := rows.Scan(&r.ValidFrom, &r.RateMinor, &r.TimeUnit,
			&r.CustomQty, &r.CustomUnit); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpdateActivity renames an activity or moves it between categories. It
// deliberately cannot change pay_scheme or rate_source: work records already
// written carry a composite foreign key onto (id, pay_scheme), and a record's
// price shape was decided by the scheme on the day it was written. Changing it
// afterwards would rewrite the meaning of money already earned, which is the
// one thing this service never does. A different pay scheme is a different
// activity.
func UpdateActivity(ctx context.Context, tx pgx.Tx, id string, name, categoryID string) (*Activity, error) {
	var out Activity
	err := tx.QueryRow(ctx, `
		WITH upd AS (
			UPDATE activities SET
				name        = coalesce($2, name),
				category_id = coalesce($3::uuid, category_id)
			 WHERE id = $1
			 RETURNING *
		)
		SELECT `+activityCols+` FROM upd a JOIN activity_categories c ON c.id = a.category_id`,
		id, nilIfEmpty(name), nilUUID(categoryID)).
		Scan(&out.ID, &out.Name, &out.CategoryID, &out.Category, &out.PayScheme,
			&out.RateSource, &out.UnitID, &out.ArchivedAt)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RestoreActivity brings an archived activity back. Its rate history came back
// with it: the periods were never deleted either.
func RestoreActivity(ctx context.Context, tx pgx.Tx, id string) error {
	tag, err := tx.Exec(ctx, `
		UPDATE activities SET archived_at = NULL WHERE id = $1 AND archived_at IS NOT NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

func ArchiveActivity(ctx context.Context, tx pgx.Tx, id string) error {
	tag, err := tx.Exec(ctx, `
		UPDATE activities SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}
