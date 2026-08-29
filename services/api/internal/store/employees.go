package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Employee is a worker. The table is `employees` and the route is
// /v1/workers: docs/modelo-datos.md names the table, docs/arquitectura-api.md
// names the route, and neither was going to be renamed to match the other.
type Employee struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	LastName     *string    `json:"lastName"`
	DocumentType *string    `json:"documentType"`
	DocID        *string    `json:"docId"`
	Tag          *string    `json:"tag"`
	Phone        *string    `json:"phone"`
	Address      *string    `json:"address"`
	City         *string    `json:"city"`
	Municipality *string    `json:"municipality"`
	Country      *string    `json:"country"`
	PhotoID      *string    `json:"photoId"`
	CreatedAt    time.Time  `json:"createdAt"`
	DeletedAt    *time.Time `json:"deletedAt"`
}

const employeeCols = `id::text, name, last_name, document_type, doc_id, tag, phone, address,
	city, municipality, country, photo_id::text, created_at, deleted_at`

func scanEmployee(row pgx.Row) (*Employee, error) {
	var e Employee
	err := row.Scan(&e.ID, &e.Name, &e.LastName, &e.DocumentType, &e.DocID, &e.Tag,
		&e.Phone, &e.Address, &e.City, &e.Municipality, &e.Country, &e.PhotoID,
		&e.CreatedAt, &e.DeletedAt)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// ListEmployees searches on the columns a person is actually looked up by:
// the name, the document and the tag on their basket. It searches the document
// for everybody, including the weigher, whose projection then drops it — he
// can find a person by the number on their card without the number coming back
// on the wire, which is the useful half of the restriction without the
// annoying half.
func ListEmployees(ctx context.Context, tx pgx.Tx, f Filter) ([]Employee, error) {
	rows, err := tx.Query(ctx, `
		SELECT `+employeeCols+` FROM employees
		 WHERE ($1 OR deleted_at IS NULL)
		   AND (NOT $2 OR deleted_at IS NOT NULL)
		   AND ($3::text IS NULL
		        OR (name || ' ' || coalesce(last_name, '')) ILIKE '%' || $3 || '%'
		        OR coalesce(doc_id, '') ILIKE '%' || $3 || '%'
		        OR coalesce(tag, '')    ILIKE '%' || $3 || '%')
		 ORDER BY name, coalesce(last_name, '')`,
		f.includeDeleted(), f.onlyDeleted(), nilIfEmpty(f.Q))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Employee{}
	for rows.Next() {
		e, err := scanEmployee(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

func GetEmployee(ctx context.Context, tx pgx.Tx, id string) (*Employee, error) {
	return scanEmployee(tx.QueryRow(ctx,
		`SELECT `+employeeCols+` FROM employees WHERE id = $1`, id))
}

func CreateEmployee(ctx context.Context, tx pgx.Tx, farmID string, e Employee) (*Employee, error) {
	return scanEmployee(tx.QueryRow(ctx, `
		INSERT INTO employees (id, farm_id, name, last_name, document_type, doc_id, tag,
		                       phone, address, city, municipality, country, photo_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12, 'CO'), $13)
		RETURNING `+employeeCols,
		e.ID, farmID, e.Name, e.LastName, e.DocumentType, e.DocID, e.Tag,
		e.Phone, e.Address, e.City, e.Municipality, e.Country, e.PhotoID))
}

// UpdateEmployee patches with COALESCE, so a field absent from the body keeps
// its value rather than being nulled.
func UpdateEmployee(ctx context.Context, tx pgx.Tx, id string, e Employee) (*Employee, error) {
	return scanEmployee(tx.QueryRow(ctx, `
		UPDATE employees SET
			name          = coalesce($2, name),
			last_name     = coalesce($3, last_name),
			document_type = coalesce($4, document_type),
			doc_id        = coalesce($5, doc_id),
			tag           = coalesce($6, tag),
			phone         = coalesce($7, phone),
			address       = coalesce($8, address),
			city          = coalesce($9, city),
			municipality  = coalesce($10, municipality),
			country       = coalesce($11, country),
			photo_id      = coalesce($12, photo_id)
		 WHERE id = $1 AND deleted_at IS NULL
		 RETURNING `+employeeCols,
		id, nilIfEmpty(e.Name), e.LastName, e.DocumentType, e.DocID, e.Tag,
		e.Phone, e.Address, e.City, e.Municipality, e.Country, e.PhotoID))
}

// SoftDeleteEmployee is the only kind of delete this service performs. The
// financial history has to stay readable after somebody leaves.
func SoftDeleteEmployee(ctx context.Context, tx pgx.Tx, id string) error {
	tag, err := tx.Exec(ctx, `
		UPDATE employees SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

// RestoreEmployee is the other half of the logical delete: "Eliminar nunca
// borra" means the row is still there, so bringing somebody back on for the
// next harvest is a PATCH and not a re-registration under a second id.
func RestoreEmployee(ctx context.Context, tx pgx.Tx, id string) (*Employee, error) {
	return scanEmployee(tx.QueryRow(ctx, `
		UPDATE employees SET deleted_at = NULL WHERE id = $1
		 RETURNING `+employeeCols, id))
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
