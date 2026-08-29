package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// Expense is RSP-031: a value, and what it is charged to.
//
// READ THIS BEFORE ADDING A FIELD. There is no EmployeeID here, and there is
// no code path from this file to `ledger`. The use case document uses the word
// "gasto" for two different things — RSP-030 means the cost of a spraying,
// RSP-007 means what an employee owes the farm — and wiring them together
// would make recording the cost of the spraying take money out of somebody's
// wages. An expense is the farm's own accounting. A debt is
// POST /v1/deductions and nothing else. A test in internal/apitest fixes it
// from the other side, so this comment cannot quietly stop being true.
type Expense struct {
	ID          string    `json:"id"`
	Concept     string    `json:"concept"`
	AmountMinor int64     `json:"amountCents"`
	LocalDay    time.Time `json:"localDay"`
	// Exactly one of ActivityID or PlotID is set. The database says so
	// (`expense_target`), not a convention: an expense charged to nothing
	// appears in the total and in no breakdown, and the difference between the
	// two is what nobody can explain in March.
	ActivityID *string    `json:"activityId"`
	Activity   *string    `json:"activity"`
	PlotID     *string    `json:"plotId"`
	Plot       *string    `json:"plot"`
	PlotCropID *string    `json:"plotCropId"`
	Crop       *string    `json:"crop"`
	ReceiptID  *string    `json:"receiptId"`
	Note       *string    `json:"note"`
	CreatedBy  *string    `json:"createdBy"`
	CreatedAt  time.Time  `json:"createdAt"`
	DeletedAt  *time.Time `json:"deletedAt"`
	// Target is "activity" or "plot", derived from which column is set, so a
	// form can round-trip RSP-031's "Tipo de gasto" select without the client
	// having to work it out.
	Target string `json:"target"`
}

const expenseCols = `e.id::text, e.concept, e.amount_minor, e.local_day,
	e.activity_id::text, a.name, e.plot_id::text, pl.name, e.plot_crop_id::text, ct.name,
	e.receipt_id::text, e.note, e.created_by::text, e.created_at, e.deleted_at`

const expenseFrom = `FROM expenses e
	LEFT JOIN activities a ON a.id = e.activity_id
	LEFT JOIN plots pl     ON pl.id = e.plot_id
	LEFT JOIN plot_crops pc ON pc.id = e.plot_crop_id
	LEFT JOIN crop_types ct ON ct.id = pc.crop_type_id`

func scanExpense(row pgx.Row) (*Expense, error) {
	var e Expense
	err := row.Scan(&e.ID, &e.Concept, &e.AmountMinor, &e.LocalDay,
		&e.ActivityID, &e.Activity, &e.PlotID, &e.Plot, &e.PlotCropID, &e.Crop,
		&e.ReceiptID, &e.Note, &e.CreatedBy, &e.CreatedAt, &e.DeletedAt)
	if err != nil {
		return nil, err
	}
	e.Target = "plot"
	if e.ActivityID != nil {
		e.Target = "activity"
	}
	return &e, nil
}

type ExpenseFilter struct {
	Filter
	ActivityID string
	PlotID     string
	From       *time.Time
	To         *time.Time
}

// ExpenseTotals is the one number the gastos screen puts at the bottom. It is
// a SUM over the live rows and is computed on the way out, never stored.
type ExpenseTotals struct {
	Count int64 `json:"count"`
	Minor int64 `json:"totalCents"`
}

func ListExpenses(ctx context.Context, tx pgx.Tx, f ExpenseFilter) ([]Expense, ExpenseTotals, error) {
	rows, err := tx.Query(ctx, `
		SELECT `+expenseCols+` `+expenseFrom+`
		 WHERE ($1 OR e.deleted_at IS NULL)
		   AND (NOT $2 OR e.deleted_at IS NOT NULL)
		   AND ($3::text IS NULL OR e.concept ILIKE '%' || $3 || '%')
		   AND ($4::uuid IS NULL OR e.activity_id = $4)
		   AND ($5::uuid IS NULL OR e.plot_id = $5)
		   AND ($6::date IS NULL OR e.local_day >= $6)
		   AND ($7::date IS NULL OR e.local_day <= $7)
		 ORDER BY e.local_day DESC, e.created_at DESC`,
		f.includeDeleted(), f.onlyDeleted(), nilIfEmpty(f.Q),
		nilIfEmpty(f.ActivityID), nilIfEmpty(f.PlotID), f.From, f.To)
	if err != nil {
		return nil, ExpenseTotals{}, err
	}
	defer rows.Close()

	out := []Expense{}
	var totals ExpenseTotals
	for rows.Next() {
		e, err := scanExpense(rows)
		if err != nil {
			return nil, ExpenseTotals{}, err
		}
		out = append(out, *e)
		if e.DeletedAt == nil {
			totals.Count++
			totals.Minor += e.AmountMinor
		}
	}
	return out, totals, rows.Err()
}

func GetExpense(ctx context.Context, tx pgx.Tx, id string) (*Expense, error) {
	return scanExpense(tx.QueryRow(ctx, `SELECT `+expenseCols+` `+expenseFrom+` WHERE e.id = $1`, id))
}

type NewExpense struct {
	ID          string      `json:"id"`
	Concept     string      `json:"concept"`
	AmountMinor int64       `json:"amountCents"`
	LocalDay    *domain.Day `json:"localDay"`
	ActivityID  *string     `json:"activityId"`
	PlotID      *string     `json:"plotId"`
	PlotCropID  *string     `json:"plotCropId"`
	ReceiptID   *string     `json:"receiptId"`
	Note        *string     `json:"note"`
	CreatedBy   string      `json:"-"`
}

func CreateExpense(ctx context.Context, tx pgx.Tx, farmID string, n NewExpense) (*Expense, error) {
	var id string
	err := tx.QueryRow(ctx, `
		INSERT INTO expenses (id, farm_id, concept, amount_minor, local_day,
		                      activity_id, plot_id, plot_crop_id, receipt_id, note, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id::text`,
		n.ID, farmID, n.Concept, n.AmountMinor, n.LocalDay.Ptr(),
		n.ActivityID, n.PlotID, n.PlotCropID, n.ReceiptID, n.Note,
		nilIfEmpty(n.CreatedBy)).Scan(&id)
	if err != nil {
		return nil, TranslateExpenseError(err)
	}
	return GetExpense(ctx, tx, id)
}

// TranslateExpenseError gives the database's refusals the names the contract
// uses. expense_target is the one worth a code of its own: it is the rule the
// form is built around, and "BAD_REQUEST" would not tell the form which half
// of it to highlight.
func TranslateExpenseError(err error) error {
	switch {
	case IsCheckViolation(err, "expense_target"):
		return domain.Coded(400, domain.CodeExpenseTargetInvalid,
			"an expense is charged to an activity or to a plot/crop, not to both and not to neither")
	case IsCheckViolation(err, "expense_crop_needs_plot"):
		return domain.Coded(400, domain.CodeExpenseTargetInvalid,
			"plotCropId needs the plotId it is planted in")
	}
	return err
}

// UpdateExpense is RSP-032. The imputation can move — from an activity to a
// plot, say — so it is patched as a triple rather than field by field:
// COALESCE would make "charge this to the plot instead" impossible to express,
// because the old activity_id would survive and expense_target would refuse
// the result, correctly and unhelpfully.
func UpdateExpense(ctx context.Context, tx pgx.Tx, id string, n NewExpense, retarget bool) (*Expense, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE expenses SET
			concept      = coalesce($2, concept),
			amount_minor = coalesce($3, amount_minor),
			local_day    = coalesce($4, local_day),
			activity_id  = CASE WHEN $5 THEN $6::uuid  ELSE activity_id  END,
			plot_id      = CASE WHEN $5 THEN $7::uuid  ELSE plot_id      END,
			plot_crop_id = CASE WHEN $5 THEN $8::uuid  ELSE plot_crop_id END,
			receipt_id   = coalesce($9, receipt_id),
			note         = coalesce($10, note)
		 WHERE id = $1`,
		id, nilIfEmpty(n.Concept), nilIfZero(n.AmountMinor), n.LocalDay.Ptr(),
		retarget, n.ActivityID, n.PlotID, n.PlotCropID, n.ReceiptID, n.Note)
	if err != nil {
		return nil, TranslateExpenseError(err)
	}
	if tag.RowsAffected() == 0 {
		return nil, NoRows
	}
	return GetExpense(ctx, tx, id)
}

func SoftDeleteExpense(ctx context.Context, tx pgx.Tx, id string) error {
	tag, err := tx.Exec(ctx,
		`UPDATE expenses SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

// RestoreExpense brings a logically deleted expense back. Unlike a voided sale
// this is safe and therefore offered: an expense carries no stock movement, so
// there is nothing that would have to be un-reversed.
func RestoreExpense(ctx context.Context, tx pgx.Tx, id string) error {
	tag, err := tx.Exec(ctx, `UPDATE expenses SET deleted_at = NULL WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

func nilIfZero(n int64) *int64 {
	if n == 0 {
		return nil
	}
	return &n
}
