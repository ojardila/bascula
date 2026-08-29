package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// Product is what RSP-019 registers: a name, a category, a storage unit.
//
// There is no `stock` field here and there will not be one. RSP-018 asks the
// list to show "unidades existentes", and it does — as a SUM over stock_moves
// computed at read time. A number cached on this row would be a number that
// eventually disagrees with the movements underneath it, and the day it does,
// nothing in the system can say which of the two is the truth.
type Product struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	CategoryID    *string    `json:"categoryId"`
	Category      *string    `json:"category"`
	StorageUnitID string     `json:"storageUnitId"`
	StorageUnit   string     `json:"storageUnit"`
	Note          *string    `json:"note"`
	CreatedAt     time.Time  `json:"createdAt"`
	DeletedAt     *time.Time `json:"deletedAt"`
	// Stock is the derived total across every warehouse, present on the list
	// and on the single read because that is the number RSP-018 puts on the
	// screen. It is a SUM, never a column.
	Stock float64 `json:"stock"`
}

const productCols = `p.id::text, p.name, p.category_id::text, pc.name,
	p.storage_unit_id::text, su.name, p.note, p.created_at, p.deleted_at,
	coalesce((SELECT sum(m.qty) FROM stock_moves m WHERE m.product_id = p.id), 0)::float8`

const productFrom = `FROM products p
	LEFT JOIN product_categories pc ON pc.id = p.category_id
	JOIN storage_units su ON su.id = p.storage_unit_id`

func scanProduct(row pgx.Row) (*Product, error) {
	var p Product
	err := row.Scan(&p.ID, &p.Name, &p.CategoryID, &p.Category, &p.StorageUnitID,
		&p.StorageUnit, &p.Note, &p.CreatedAt, &p.DeletedAt, &p.Stock)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func ListProducts(ctx context.Context, tx pgx.Tx, f Filter, categoryID string) ([]Product, error) {
	rows, err := tx.Query(ctx, `
		SELECT `+productCols+` `+productFrom+`
		 WHERE ($1 OR p.deleted_at IS NULL)
		   AND (NOT $2 OR p.deleted_at IS NOT NULL)
		   AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%')
		   AND ($4::uuid IS NULL OR p.category_id = $4)
		 ORDER BY coalesce(pc.name, ''), p.name`,
		f.includeDeleted(), f.onlyDeleted(), nilIfEmpty(f.Q), nilIfEmpty(categoryID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Product{}
	for rows.Next() {
		p, err := scanProduct(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

func GetProduct(ctx context.Context, tx pgx.Tx, id string) (*Product, error) {
	return scanProduct(tx.QueryRow(ctx,
		`SELECT `+productCols+` `+productFrom+` WHERE p.id = $1`, id))
}

// NewProduct is the write shape. Category and StorageUnit are the names, so a
// caller can send a value that is not in the catalogue yet and get it created
// rather than rejected — the "con opción de crear" of RSP-019.
type NewProduct struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	CategoryID    *string `json:"categoryId"`
	Category      string  `json:"category"`
	StorageUnitID *string `json:"storageUnitId"`
	StorageUnit   string  `json:"storageUnit"`
	Note          *string `json:"note"`
}

func CreateProduct(ctx context.Context, tx pgx.Tx, farmID string, n NewProduct, newID func() string) (*Product, error) {
	categoryID, err := resolveCatalog(ctx, tx, CatalogProductCategories, farmID, n.CategoryID, n.Category, newID)
	if err != nil {
		return nil, err
	}
	unitID, err := resolveCatalog(ctx, tx, CatalogStorageUnits, farmID, n.StorageUnitID, n.StorageUnit, newID)
	if err != nil {
		return nil, err
	}
	if unitID == nil {
		return nil, domain.BadRequest("storageUnitId or storageUnit is required")
	}
	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO products (id, farm_id, name, category_id, storage_unit_id, note)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
		n.ID, farmID, n.Name, categoryID, unitID, n.Note).Scan(&id)
	if err != nil {
		return nil, err
	}
	return GetProduct(ctx, tx, id)
}

// resolveCatalog turns "either an id or a name" into an id, creating the
// catalogue row when only a name arrived. Returns nil when neither was sent,
// which the caller decides how to treat: a category is optional, a storage
// unit is not.
func resolveCatalog(ctx context.Context, tx pgx.Tx, c Catalog, farmID string,
	id *string, name string, newID func() string) (*string, error) {
	if id != nil && *id != "" {
		return id, nil
	}
	if name == "" {
		return nil, nil
	}
	item, err := EnsureCatalogItem(ctx, tx, c, farmID, newID(), name)
	if err != nil {
		return nil, err
	}
	return &item.ID, nil
}

func UpdateProduct(ctx context.Context, tx pgx.Tx, farmID, id string, n NewProduct, newID func() string) (*Product, error) {
	categoryID, err := resolveCatalog(ctx, tx, CatalogProductCategories, farmID, n.CategoryID, n.Category, newID)
	if err != nil {
		return nil, err
	}
	unitID, err := resolveCatalog(ctx, tx, CatalogStorageUnits, farmID, n.StorageUnitID, n.StorageUnit, newID)
	if err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE products SET
			name            = coalesce($2, name),
			category_id     = coalesce($3, category_id),
			storage_unit_id = coalesce($4, storage_unit_id),
			note            = coalesce($5, note)
		 WHERE id = $1`,
		id, nilIfEmpty(n.Name), categoryID, unitID, n.Note)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, NoRows
	}
	return GetProduct(ctx, tx, id)
}

// SoftDeleteProduct is RSP-021: eliminar deja el producto inactivo. The
// movements it already has stay exactly where they are — they are facts, and a
// product going out of the catalogue does not un-harvest last week's coffee.
func SoftDeleteProduct(ctx context.Context, tx pgx.Tx, id string) error {
	tag, err := tx.Exec(ctx,
		`UPDATE products SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

func RestoreProduct(ctx context.Context, tx pgx.Tx, id string) error {
	tag, err := tx.Exec(ctx, `UPDATE products SET deleted_at = NULL WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

// ---------------------------------------------------------------------------
// Customers (RSP-027)
// ---------------------------------------------------------------------------

type Customer struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	DocumentType *string    `json:"documentType"`
	DocID        *string    `json:"docId"`
	Phone        *string    `json:"phone"`
	CreatedAt    time.Time  `json:"createdAt"`
	DeletedAt    *time.Time `json:"deletedAt"`
}

const customerCols = `id::text, name, document_type, doc_id, phone, created_at, deleted_at`

func scanCustomer(row pgx.Row) (*Customer, error) {
	var c Customer
	err := row.Scan(&c.ID, &c.Name, &c.DocumentType, &c.DocID, &c.Phone, &c.CreatedAt, &c.DeletedAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func ListCustomers(ctx context.Context, tx pgx.Tx, f Filter) ([]Customer, error) {
	rows, err := tx.Query(ctx, `
		SELECT `+customerCols+` FROM customers
		 WHERE ($1 OR deleted_at IS NULL)
		   AND (NOT $2 OR deleted_at IS NOT NULL)
		   AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%'
		        OR coalesce(doc_id, '') ILIKE '%' || $3 || '%')
		 ORDER BY name`, f.includeDeleted(), f.onlyDeleted(), nilIfEmpty(f.Q))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Customer{}
	for rows.Next() {
		c, err := scanCustomer(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// EnsureCustomer is idempotent by (farm_id, lower(name)) like every other
// picker in this service: the sales screen must not be able to produce two
// "Cooperativa" that are different rows.
func EnsureCustomer(ctx context.Context, tx pgx.Tx, farmID string, c Customer) (*Customer, error) {
	return scanCustomer(tx.QueryRow(ctx, `
		INSERT INTO customers (id, farm_id, name, document_type, doc_id, phone)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (farm_id, lower(name)) WHERE deleted_at IS NULL DO UPDATE SET
			document_type = coalesce(EXCLUDED.document_type, customers.document_type),
			doc_id        = coalesce(EXCLUDED.doc_id, customers.doc_id),
			phone         = coalesce(EXCLUDED.phone, customers.phone)
		RETURNING `+customerCols,
		c.ID, farmID, c.Name, c.DocumentType, c.DocID, c.Phone))
}
