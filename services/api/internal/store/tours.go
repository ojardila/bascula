package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// TourProgress is how far one user got through one guided tour in one farm.
// It lives on the server so the tour resumes on whichever device the person
// picks up next — a farm owner starts on the phone and finishes on the
// computer at home.
type TourProgress struct {
	Tour      string    `json:"tour"`
	Step      int       `json:"step"`
	Status    string    `json:"status"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ListTours reads the caller's own progress; RLS pins it to the caller.
func ListTours(ctx context.Context, tx pgx.Tx) ([]TourProgress, error) {
	rows, err := tx.Query(ctx, `
		SELECT tour, step, status, updated_at FROM user_tours
		 WHERE farm_id = current_farm() AND user_id = current_user_id()
		 ORDER BY tour`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TourProgress{}
	for rows.Next() {
		var t TourProgress
		if err := rows.Scan(&t.Tour, &t.Step, &t.Status, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// SaveTour upserts the caller's progress for one tour.
func SaveTour(ctx context.Context, tx pgx.Tx, tour string, step int, status string) (*TourProgress, error) {
	var t TourProgress
	err := tx.QueryRow(ctx, `
		INSERT INTO user_tours (farm_id, user_id, tour, step, status)
		VALUES (current_farm(), current_user_id(), $1, $2, $3)
		ON CONFLICT (farm_id, user_id, tour) DO UPDATE
		  SET step = EXCLUDED.step, status = EXCLUDED.status, updated_at = now()
		RETURNING tour, step, status, updated_at`, tour, step, status).
		Scan(&t.Tour, &t.Step, &t.Status, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &t, nil
}
