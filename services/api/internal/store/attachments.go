package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// MaxUploadBytes is the 5 MB of RSP-004 ("Foto — archivo, hasta 5 MB"), and
// the same number appears as a CHECK on attachments in migration 00011.
//
// It is written in both places on purpose. The constant is what produces a
// clean 413 with a message a form can show; the CHECK is what makes the limit
// true regardless of which code path wrote the row. Neither is redundant: the
// first is the user experience, the second is the guarantee.
const MaxUploadBytes int64 = 5 * 1024 * 1024

// Attachment is a pointer into object storage — never bytes in Postgres.
//
// It has two states and the second is reached by the server counting, not by
// the client claiming. `pending` is a row created when the client asked where
// to put the file; `ready` is a row whose bytes have arrived and been
// measured. Nothing can be hung on a pending attachment: a trigger in 00011
// refuses it on employees.photo_id, sales.receipt_id and expenses.receipt_id,
// so a sale cannot point at a photo that never uploaded.
type Attachment struct {
	ID           string     `json:"id"`
	Status       string     `json:"status"`
	Purpose      *string    `json:"purpose"`
	OriginalName *string    `json:"originalName"`
	Mime         *string    `json:"contentType"`
	Bytes        *int64     `json:"bytes"`
	SHA256       *string    `json:"sha256"`
	CreatedAt    time.Time  `json:"createdAt"`
	ConfirmedAt  *time.Time `json:"confirmedAt"`
	// ObjectKey never leaves the store package's callers in a response body;
	// it is where the bytes live and that is the blob package's business.
	ObjectKey string `json:"-"`
}

const attachmentCols = `id::text, status, purpose, original_name, mime, bytes,
	encode(sha256, 'hex'), created_at, confirmed_at, object_key`

func scanAttachment(row pgx.Row) (*Attachment, error) {
	var a Attachment
	err := row.Scan(&a.ID, &a.Status, &a.Purpose, &a.OriginalName, &a.Mime, &a.Bytes,
		&a.SHA256, &a.CreatedAt, &a.ConfirmedAt, &a.ObjectKey)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// CreatePendingAttachment reserves the row and the object key. No size is
// recorded here even if the client offered one, because a size the client
// declares is a size the client can lie about, and the only number that ends
// up in the row is the one the server counted.
func CreatePendingAttachment(ctx context.Context, tx pgx.Tx, farmID, id, objectKey string,
	purpose, originalName, createdBy string) (*Attachment, error) {
	return scanAttachment(tx.QueryRow(ctx, `
		INSERT INTO attachments (id, farm_id, object_key, status, purpose, original_name, created_by)
		VALUES ($1, $2, $3, 'pending', $4, $5, $6)
		RETURNING `+attachmentCols,
		id, farmID, objectKey, nilIfEmpty(purpose), nilIfEmpty(originalName), nilIfEmpty(createdBy)))
}

func GetAttachment(ctx context.Context, tx pgx.Tx, id string) (*Attachment, error) {
	return scanAttachment(tx.QueryRow(ctx,
		`SELECT `+attachmentCols+` FROM attachments WHERE id = $1`, id))
}

// ConfirmAttachment writes what the server measured. The size CHECK on the
// table fires here if it is over the limit, which is the second of the two
// places the 5 MB is enforced and the one that does not depend on any handler
// remembering to look.
func ConfirmAttachment(ctx context.Context, tx pgx.Tx, id, mime string, bytes int64, sha []byte) (*Attachment, error) {
	return scanAttachment(tx.QueryRow(ctx, `
		UPDATE attachments
		   SET status = 'ready', mime = $2, bytes = $3, sha256 = $4, confirmed_at = now()
		 WHERE id = $1
		 RETURNING `+attachmentCols, id, mime, bytes, sha))
}

// DeleteAttachment removes a row whose bytes never arrived, or whose upload
// was refused. It only ever touches a pending one: a ready attachment may be
// referenced by an employee or a sale, and the foreign keys would refuse
// anyway — loudly, which is right.
func DeleteAttachment(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, `DELETE FROM attachments WHERE id = $1 AND status = 'pending'`, id)
	return err
}
