package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Note is an anotacion: what the farm wrote down about one of its people.
//
// It is append-only and it is born private. Decision 1 in docs/decisiones.md
// is explicit that these never leave the farm, and the schema is the defence
// rather than a policy somebody could relax: employee_notes has no visibility
// value other than 'private', no flag and no score, and no route here writes
// one either. The registry service cannot read this table at all.
type Note struct {
	ID         string    `json:"id"`
	EmployeeID string    `json:"workerId"`
	NotedOn    time.Time `json:"date"`
	Body       string    `json:"text"`
	CreatedBy  *string   `json:"createdBy"`
	CreatedAt  time.Time `json:"createdAt"`
}

const noteCols = `id::text, employee_id::text, noted_on, body, created_by::text, created_at`

// ListNotes returns a worker's notes, newest first.
func ListNotes(ctx context.Context, tx pgx.Tx, employeeID string, limit int) ([]Note, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := tx.Query(ctx, `
		SELECT `+noteCols+` FROM employee_notes
		 WHERE employee_id = $1
		 ORDER BY noted_on DESC, created_at DESC
		 LIMIT $2`, employeeID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Note{}
	for rows.Next() {
		var n Note
		if err := rows.Scan(&n.ID, &n.EmployeeID, &n.NotedOn, &n.Body,
			&n.CreatedBy, &n.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

type NewNote struct {
	ID         string
	EmployeeID string
	Body       string
	NotedOn    *time.Time
	CreatedBy  string
}

// CreateNote appends one. There is no update and no delete: a note that can be
// rewritten after the fact is not a record of anything.
func CreateNote(ctx context.Context, tx pgx.Tx, farmID string, n NewNote) (*Note, error) {
	day, err := dayOrToday(ctx, tx, n.NotedOn)
	if err != nil {
		return nil, err
	}
	// ON CONFLICT DO NOTHING for the same reason the ledger has it: the
	// contract promises every write is idempotent by (farm_id, id), and a
	// note resent after a timeout must not be a primary key violation dressed
	// up as a 500. Notes are append-only too, so there is nothing to update —
	// the row already there is the answer.
	var out Note
	err = tx.QueryRow(ctx, `
		INSERT INTO employee_notes (id, farm_id, employee_id, noted_on, body, created_by)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO NOTHING
		RETURNING `+noteCols,
		n.ID, farmID, n.EmployeeID, day, n.Body, n.CreatedBy).
		Scan(&out.ID, &out.EmployeeID, &out.NotedOn, &out.Body, &out.CreatedBy, &out.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return GetNote(ctx, tx, n.ID)
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// GetNote reads one note back, which is what an idempotent retry answers with.
func GetNote(ctx context.Context, tx pgx.Tx, id string) (*Note, error) {
	var out Note
	err := tx.QueryRow(ctx, `SELECT `+noteCols+` FROM employee_notes WHERE id = $1`, id).
		Scan(&out.ID, &out.EmployeeID, &out.NotedOn, &out.Body, &out.CreatedBy, &out.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &out, nil
}
