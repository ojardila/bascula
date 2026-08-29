package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Catalog is one of the per-farm name catalogues. They exist rather than
// Postgres enums because every use case that mentions them ("con opcion de
// crear una nueva", RSP-001 and RSP-011) says a farm may invent a value, and a
// closed type would make every invented value an ALTER TYPE in production.
//
// What stays an enum is only what the code branches on: ledger_kind,
// pay_method, farm_role, settlement_status, pay_scheme, time_unit.
type Catalog string

const (
	CatalogActivityCategories Catalog = "activity-categories"
	CatalogCropTypes          Catalog = "crop-types"
	CatalogVarieties          Catalog = "varieties"
)

// catalogTables is the allow list. The table name is interpolated into SQL, so
// nothing outside this map ever reaches a query.
var catalogTables = map[Catalog]string{
	CatalogActivityCategories: "activity_categories",
	CatalogCropTypes:          "crop_types",
	CatalogVarieties:          "varieties",
}

// SeedActivityCategories is what a brand new farm starts with. It is a seed,
// not a closed set: anything a farm adds afterwards is exactly as valid.
// Mirrors SEED_ACTIVITY_CATEGORIES in packages/shared/src/enums.ts.
var SeedActivityCategories = []string{"siembra", "mantenimiento", "cosecha"}

type CatalogItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func catalogTable(c Catalog) (string, bool) {
	t, ok := catalogTables[c]
	return t, ok
}

func ListCatalog(ctx context.Context, tx pgx.Tx, c Catalog) ([]CatalogItem, error) {
	table, ok := catalogTable(c)
	if !ok {
		return nil, fmt.Errorf("unknown catalog %q", c)
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, name FROM `+table+` WHERE deleted_at IS NULL ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []CatalogItem{}
	for rows.Next() {
		var i CatalogItem
		if err := rows.Scan(&i.ID, &i.Name); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// EnsureCatalogItem is idempotent by (farm_id, lower(name)): posting a name
// that is already there returns the existing row instead of duplicating it, so
// the autocomplete can never produce two "Cafe" that are different rows.
func EnsureCatalogItem(ctx context.Context, tx pgx.Tx, c Catalog, farmID, id, name string) (*CatalogItem, error) {
	table, ok := catalogTable(c)
	if !ok {
		return nil, fmt.Errorf("unknown catalog %q", c)
	}
	var out CatalogItem
	err := tx.QueryRow(ctx, `
		INSERT INTO `+table+` (id, farm_id, name) VALUES ($1, $2, $3)
		ON CONFLICT (farm_id, lower(name)) DO UPDATE SET name = `+table+`.name
		RETURNING id::text, name`, id, farmID, name).Scan(&out.ID, &out.Name)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// FindCatalogItem looks a name up without creating it.
func FindCatalogItem(ctx context.Context, tx pgx.Tx, c Catalog, name string) (*CatalogItem, error) {
	table, ok := catalogTable(c)
	if !ok {
		return nil, fmt.Errorf("unknown catalog %q", c)
	}
	var out CatalogItem
	err := tx.QueryRow(ctx, `
		SELECT id::text, name FROM `+table+` WHERE lower(name) = lower($1) AND deleted_at IS NULL`,
		name).Scan(&out.ID, &out.Name)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// SeedCatalogs gives a new farm the categories it starts with.
func SeedCatalogs(ctx context.Context, tx pgx.Tx, farmID string, newID func() string) error {
	for _, name := range SeedActivityCategories {
		if _, err := EnsureCatalogItem(ctx, tx, CatalogActivityCategories, farmID, newID(), name); err != nil {
			return err
		}
	}
	return nil
}
