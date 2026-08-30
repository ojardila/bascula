package store

import (
	"context"
	"errors"
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

// LockEmployeeForMoney serialises every decision taken FROM one person's
// balance, per person, for the rest of the transaction.
//
// It is not a nicety and it is not a rare race. The balance is derived — there
// is no stored total anywhere, deliberately — so "read the balance, decide,
// write the movement" is three steps, and two requests that interleave them
// both read the same balance and both pass. Two browser tabs do it. A foreman
// double-clicking "Pagar" does it. It is not probabilistic: with N concurrent
// payments of the whole balance, all N were accepted and the farm paid the same
// debt N times.
//
// The lock is on the employee row rather than on the ledger, for two reasons
// that both matter. The ledger is append-only and the app role has no UPDATE on
// it, so `SELECT ... FOR UPDATE` there is not available. And the row that has
// to be serialised is the PERSON: what must not interleave is two decisions
// about one worker's money, whichever movements they end up writing.
//
// It must be taken BEFORE the balance is derived — a lock taken afterwards
// serialises nothing — and AFTER the idempotency check, which must keep
// answering a resent full payment with the payment that already exists rather
// than with AMOUNT_EXCEEDS_BALANCE.
//
// It returns NoRows for a worker this farm cannot see, so a caller that has not
// already confirmed the tenant still cannot lock its way into another farm.
func LockEmployeeForMoney(ctx context.Context, tx pgx.Tx, id string) error {
	var one int
	err := tx.QueryRow(ctx,
		`SELECT 1 FROM employees WHERE id = $1 FOR UPDATE`, id).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return NoRows
	}
	return err
}

// FindDeletedByDocument answers §5.6's real danger, which is not the weighing
// that arrives for somebody who was taken off the payroll — that one enters,
// the balance stays right, and nothing is lost. It is the SECOND file.
//
// ux_employees_doc is partial on `deleted_at IS NULL`, so once Juan is
// deactivated the same cédula is free again and a well-meaning administrator
// creates a second Juan. From then on the phone points at one file and the web
// writes to the other, one person's balance is split in two, and nothing
// anywhere says so. It is the only conflict in the whole protocol with no
// automatic repair: merging two ledgers afterwards is manual surgery.
//
// One SELECT on a create is the entire price of never having to do that.
func FindDeletedByDocument(ctx context.Context, tx pgx.Tx, documentType, docID *string) (*Employee, error) {
	if documentType == nil || docID == nil || *docID == "" {
		return nil, nil
	}
	e, err := scanEmployee(tx.QueryRow(ctx, `
		SELECT `+employeeCols+` FROM employees
		 WHERE deleted_at IS NOT NULL
		   AND doc_id = $2
		   AND document_type IS NOT DISTINCT FROM $1
		 ORDER BY deleted_at DESC
		 LIMIT 1`, documentType, docID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return e, nil
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
//
// `by` is the user who took the decision, and it is stored. It is what makes
// the audit of decision 8 worth reading: an automatic reactivation exists so
// the person who deactivated can see that it was undone, and that sentence has
// no subject unless the deactivation carries one. An empty string writes NULL,
// which happens on the paths where there is no session to name.
func SoftDeleteEmployee(ctx context.Context, tx pgx.Tx, id, by string) error {
	tag, err := tx.Exec(ctx, `
		UPDATE employees SET deleted_at = now(), deleted_by = $2
		 WHERE id = $1 AND deleted_at IS NULL`, id, nilUUID(by))
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
		UPDATE employees SET deleted_at = NULL, deleted_by = NULL WHERE id = $1
		 RETURNING `+employeeCols, id))
}

// ---------------------------------------------------------------------------
// Decision 8: the automatic reactivation, and the record of it
// ---------------------------------------------------------------------------

// Reactivation is one automatic reactivation, with everything needed to answer
// "who undid my decision, and why".
type Reactivation struct {
	ID            string    `json:"id"`
	EmployeeID    string    `json:"workerId"`
	WorkRecordID  string    `json:"workRecordId"`
	DeviceID      *string   `json:"deviceId"`
	Source        string    `json:"source"`
	DeactivatedAt time.Time `json:"deactivatedAt"`
	DeactivatedBy *string   `json:"deactivatedBy"`
	ReactivatedBy *string   `json:"reactivatedBy"`
	At            time.Time `json:"at"`
}

// NewReactivation is what the caller knows about the work that provoked one.
type NewReactivation struct {
	ID           string
	EmployeeID   string
	WorkRecordID string
	// WorkedAt is when the work HAPPENED, not when the row arrived. The
	// difference is the whole rule below.
	WorkedAt time.Time
	DeviceID *string
	Source   string
	By       string
}

// ReactivateForWork is decision 8 of docs/decisiones.md, with the boundary the
// team of 2026-08-29 drew around it.
//
// The decision: somebody taken off the payroll who turns up with new work is
// back on the payroll, because if he is working he is still on the farm.
//
// The boundary: "the removal wins". A deactivation decided by a person, AFTER the
// work happened, is not undone by an automatism. That is why the comparison is
// against `started_at` — when the work was performed — and never against when
// the row reached the server. The concrete case is the ordinary one: a handset
// spends the afternoon without signal, the web deactivates Juan at midday, and
// at six o'clock the handset pushes a weighing it took at eight in the morning.
// That weighing is older than the decision; it enters, Juan stays inactive, and
// the phone shows it as a conflict for somebody to look at. A weighing taken at
// two o'clock, after the decision, is new work: Juan comes back on.
//
// It returns false when there was nothing to undo — the ordinary case, where
// the worker was active all along — so a caller can ignore the result without a
// branch. The failure is never worth swallowing, though: an unrecorded
// reactivation is precisely the silent undo the owner's condition forbids.
func ReactivateForWork(ctx context.Context, tx pgx.Tx, farmID string, n NewReactivation) (bool, error) {
	var deletedAt time.Time
	var deletedBy *string
	err := tx.QueryRow(ctx, `
		SELECT deleted_at, deleted_by::text FROM employees
		 WHERE id = $1 AND deleted_at IS NOT NULL
		 FOR UPDATE`, n.EmployeeID).Scan(&deletedAt, &deletedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // active already, which is almost always the answer
	}
	if err != nil {
		return false, err
	}
	if !n.WorkedAt.After(deletedAt) {
		// The work predates the decision. Leave the decision standing.
		return false, nil
	}

	if _, err := tx.Exec(ctx, `
		UPDATE employees SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`,
		n.EmployeeID); err != nil {
		return false, err
	}

	// No RETURNING, and that is not an oversight. The reactivation is written
	// inside the WEIGHER's transaction — his handset is what pushed the work —
	// and the read policy on employee_reactivations is administrator-only,
	// because the row names who took somebody off the payroll. A RETURNING
	// would ask him to read back what he just wrote and fail the SELECT policy,
	// which is exactly the narrowing working as intended.
	if _, err := tx.Exec(ctx, `
		INSERT INTO employee_reactivations
			(id, farm_id, employee_id, work_record_id, device_id, source,
			 deactivated_at, deactivated_by, reactivated_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		n.ID, farmID, n.EmployeeID, n.WorkRecordID, nilUUID(deref(n.DeviceID)),
		n.Source, deletedAt, nilUUID(deref(deletedBy)), nilUUID(n.By)); err != nil {
		return false, err
	}
	return true, nil
}

// ListReactivations is the audit, newest first. An empty employeeID means the
// whole farm, which is the screen the person who deactivated somebody actually
// opens: they are not looking for a worker, they are looking for what changed.
func ListReactivations(ctx context.Context, tx pgx.Tx, employeeID string, limit int) ([]Reactivation, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, employee_id::text, work_record_id::text, device_id::text,
		       source, deactivated_at, deactivated_by::text, reactivated_by::text, at
		  FROM employee_reactivations
		 WHERE ($1::uuid IS NULL OR employee_id = $1)
		 ORDER BY at DESC, id DESC
		 LIMIT $2`, nilUUID(employeeID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Reactivation{}
	for rows.Next() {
		var r Reactivation
		if err := rows.Scan(&r.ID, &r.EmployeeID, &r.WorkRecordID, &r.DeviceID, &r.Source,
			&r.DeactivatedAt, &r.DeactivatedBy, &r.ReactivatedBy, &r.At); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
