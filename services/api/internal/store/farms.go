package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Farm is the farm's own record: what the configuration screen edits, plus the
// standing collection price that lives in farm_config.
//
// PriceMinor is here and not in a separate object because it is one number the
// owner thinks of as part of the farm's settings. The HTTP layer is what drops
// it for the weigher; see §6 of docs/arquitectura-api.md, which says GET
// /v1/config reaches him without costPerUnitCents.
type Farm struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Timezone    string     `json:"timezone"`
	Currency    string     `json:"currency"`
	MinorUnit   int        `json:"minorUnit"`
	Phone       *string    `json:"phone"`
	Country     *string    `json:"country"`
	City        *string    `json:"city"`
	Address     *string    `json:"address"`
	AreaHa      *float64   `json:"areaHa"`
	SuspendedAt *time.Time `json:"suspendedAt"`
	CreatedAt   time.Time  `json:"createdAt"`
	// MoneyReadOnly is the phase 4 switch of docs/sincronizacion.md: for the
	// hour the season import runs, the handsets may record weighings and may
	// not settle, pay or void. It is a pointer so a PUT that does not mention
	// it leaves it alone, like every other field on this record.
	MoneyReadOnly *bool `json:"moneyReadOnly"`
	// PriceMinor is a pointer so the weigher's projection can omit it
	// entirely rather than send a zero, which would read as "free".
	PriceMinor *int64 `json:"priceCents,omitempty"`
}

const farmCols = `f.id::text, f.name, f.timezone, f.currency, f.minor_unit, f.phone,
	f.country, f.city, f.address, f.area_ha::float8, f.suspended_at, f.created_at,
	f.money_read_only`

func scanFarm(row pgx.Row) (*Farm, error) {
	var f Farm
	err := row.Scan(&f.ID, &f.Name, &f.Timezone, &f.Currency, &f.MinorUnit, &f.Phone,
		&f.Country, &f.City, &f.Address, &f.AreaHa, &f.SuspendedAt, &f.CreatedAt,
		&f.MoneyReadOnly)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// GetFarm reads the farm this request is pinned to. It never takes an id: the
// tenant travels in the token, and a farm id in a path invites somebody to
// trust it.
func GetFarm(ctx context.Context, tx pgx.Tx) (*Farm, error) {
	f, err := scanFarm(tx.QueryRow(ctx,
		`SELECT `+farmCols+` FROM farms f WHERE f.id = current_farm()`))
	if err != nil {
		return nil, err
	}
	var price int64
	err = tx.QueryRow(ctx,
		`SELECT price_minor FROM farm_config WHERE farm_id = current_farm()`).Scan(&price)
	if err != nil {
		return nil, err
	}
	f.PriceMinor = &price
	return f, nil
}

// IsKnownTimezone asks Postgres whether it recognises an IANA name, using the
// same catalogue the AT TIME ZONE operator consults. Go's own tzdata is not
// asked: the database is what computes every local_day in this system, so the
// database is the only opinion that matters.
func IsKnownTimezone(ctx context.Context, tx pgx.Tx, name string) (bool, error) {
	var ok bool
	err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1)`, name).Scan(&ok)
	return ok, err
}

// UpdateFarm patches with COALESCE, so a field absent from the body keeps its
// value. The timezone is deliberately patchable and deliberately validated by
// the farms_tz_valid CHECK: a bad IANA name would silently shift every
// business day the farm has ever recorded.
//
// cleared names the fields sent as an explicit null, which is a different
// request from not mentioning them. Same reason as UpdateEmployee: the console
// sends null for an emptied box, so without this a farm could replace a wrong
// address with another one and never remove it.
//
// name, timezone and currency have no CASE and are not clearable. A farm
// without a timezone has no week boundaries, and a settlement week is a local
// date -- so the field that looks like a formality decides which day a
// weighing belongs to, and an empty one would move somebody's pay.
func UpdateFarm(ctx context.Context, tx pgx.Tx, f Farm, cleared map[string]bool) (*Farm, error) {
	clear := make([]string, 0, len(cleared))
	for k := range cleared {
		clear = append(clear, k)
	}
	out, err := scanFarm(tx.QueryRow(ctx, `
		UPDATE farms f SET
			name     = coalesce($1, f.name),
			timezone = coalesce($2, f.timezone),
			currency = coalesce($3, f.currency),
			phone    = CASE WHEN 'phone'   = ANY($10) THEN NULL ELSE coalesce($4, f.phone) END,
			country  = CASE WHEN 'country' = ANY($10) THEN NULL ELSE coalesce($5, f.country) END,
			city     = CASE WHEN 'city'    = ANY($10) THEN NULL ELSE coalesce($6, f.city) END,
			address  = CASE WHEN 'address' = ANY($10) THEN NULL ELSE coalesce($7, f.address) END,
			area_ha  = CASE WHEN 'areaHa'  = ANY($10) THEN NULL ELSE coalesce($8, f.area_ha) END,
			money_read_only = coalesce($9, f.money_read_only)
		 WHERE f.id = current_farm()
		 RETURNING `+farmCols,
		nilIfEmpty(f.Name), nilIfEmpty(f.Timezone), nilIfEmpty(f.Currency),
		f.Phone, f.Country, f.City, f.Address, f.AreaHa, f.MoneyReadOnly, clear))
	if err != nil {
		return nil, err
	}
	if f.PriceMinor != nil {
		if _, err := tx.Exec(ctx,
			`UPDATE farm_config SET price_minor = $1 WHERE farm_id = current_farm()`,
			*f.PriceMinor); err != nil {
			return nil, err
		}
	}
	var price int64
	if err := tx.QueryRow(ctx,
		`SELECT price_minor FROM farm_config WHERE farm_id = current_farm()`).Scan(&price); err != nil {
		return nil, err
	}
	out.PriceMinor = &price
	return out, nil
}

// ---------------------------------------------------------------------------
// The super-admin console
// ---------------------------------------------------------------------------

// AdminFarm is every column the platform administrator is allowed to see about
// a farm, and the list is short on purpose. Decision 2 shrank the console to
// "see the farms, suspend one, and nothing else": no employee, no work record
// and no peso of anybody's money appears here, and none of these columns is a
// way to infer one.
type AdminFarm struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Timezone    string     `json:"timezone"`
	Currency    string     `json:"currency"`
	Country     *string    `json:"country"`
	City        *string    `json:"city"`
	Status      string     `json:"status"`
	SuspendedAt *time.Time `json:"suspendedAt"`
	CreatedAt   time.Time  `json:"createdAt"`
}

func farmStatus(suspended *time.Time) string {
	if suspended != nil {
		return "suspended"
	}
	return "active"
}

// ListAdminFarms lists every farm on the platform. The visibility comes from
// the p_farms RLS policy, which opens up when app.superadmin is 'on' — the
// middleware sets that from the users row on every request, and from nowhere
// else. Not from the token: the claim is fifteen minutes old and this is the
// setting that opens every farm on the platform at once.
func ListAdminFarms(ctx context.Context, tx pgx.Tx, q, status string) ([]AdminFarm, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, name, timezone, currency, country, city, suspended_at, created_at
		  FROM farms
		 WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%')
		   AND ($2::text IS NULL
		        OR ($2 = 'active'    AND suspended_at IS NULL)
		        OR ($2 = 'suspended' AND suspended_at IS NOT NULL))
		 ORDER BY name`, nilIfEmpty(q), nilIfEmpty(status))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []AdminFarm{}
	for rows.Next() {
		var f AdminFarm
		if err := rows.Scan(&f.ID, &f.Name, &f.Timezone, &f.Currency, &f.Country,
			&f.City, &f.SuspendedAt, &f.CreatedAt); err != nil {
			return nil, err
		}
		f.Status = farmStatus(f.SuspendedAt)
		out = append(out, f)
	}
	return out, rows.Err()
}

// SetFarmStatus suspends a farm or brings it back. Suspension is not a delete:
// the rows stay, the sessions stop. Login and refresh refuse a suspended farm,
// and so does tenant.setContext on every authenticated request — which is what
// closed the quarter of an hour a live access token used to buy a farm that had
// just been suspended.
func SetFarmStatus(ctx context.Context, tx pgx.Tx, farmID, status string) (*AdminFarm, error) {
	var f AdminFarm
	err := tx.QueryRow(ctx, `
		UPDATE farms SET suspended_at = CASE WHEN $2 = 'suspended'
		                                     THEN coalesce(suspended_at, now())
		                                     ELSE NULL END
		 WHERE id = $1
		 RETURNING id::text, name, timezone, currency, country, city, suspended_at, created_at`,
		farmID, status).
		Scan(&f.ID, &f.Name, &f.Timezone, &f.Currency, &f.Country, &f.City,
			&f.SuspendedAt, &f.CreatedAt)
	if err != nil {
		return nil, err
	}
	f.Status = farmStatus(f.SuspendedAt)
	return &f, nil
}
