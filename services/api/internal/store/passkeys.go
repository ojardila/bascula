// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Passkey is one row of passkeys (migration 00041). Record is the WebAuthn
// library's credential as JSON; the handler owns its shape.
type Passkey struct {
	ID           string
	UserID       string
	RPID         string
	CredentialID []byte
	OnlyFarmID   *string
	Name         string
	Record       []byte
	CreatedAt    time.Time
	LastUsedAt   *time.Time
}

const passkeyColumns = `id::text, user_id::text, rp_id, credential_id, only_farm_id::text,
	name, record, created_at, last_used_at`

func scanPasskey(row pgx.Row) (*Passkey, error) {
	var p Passkey
	if err := row.Scan(&p.ID, &p.UserID, &p.RPID, &p.CredentialID, &p.OnlyFarmID,
		&p.Name, &p.Record, &p.CreatedAt, &p.LastUsedAt); err != nil {
		return nil, err
	}
	return &p, nil
}

// InsertPasskey stores a new credential. A credential id that already exists
// fails on ux_passkeys_credential; the caller maps that to a conflict.
func InsertPasskey(ctx context.Context, tx pgx.Tx, p Passkey) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO passkeys (id, user_id, rp_id, credential_id, only_farm_id, name, record)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		p.ID, p.UserID, p.RPID, p.CredentialID, p.OnlyFarmID, p.Name, p.Record)
	return err
}

// ListPasskeys returns the user's passkeys for one relying party, oldest first.
func ListPasskeys(ctx context.Context, tx pgx.Tx, userID, rpID string) ([]Passkey, error) {
	return listPasskeys(ctx, tx, `
		SELECT `+passkeyColumns+` FROM passkeys
		 WHERE user_id = $1 AND rp_id = $2
		 ORDER BY created_at, id`, userID, rpID)
}

// ListAllPasskeys is every passkey on the account, whatever address it was
// made on: what the owner must be able to see and remove.
func ListAllPasskeys(ctx context.Context, tx pgx.Tx, userID string) ([]Passkey, error) {
	return listPasskeys(ctx, tx, `
		SELECT `+passkeyColumns+` FROM passkeys
		 WHERE user_id = $1
		 ORDER BY created_at, id`, userID)
}

// DeleteAllPasskeys removes every passkey on the account and says how many
// there were.
func DeleteAllPasskeys(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	tag, err := tx.Exec(ctx, `DELETE FROM passkeys WHERE user_id = $1`, userID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func listPasskeys(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]Passkey, error) {
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Passkey{}
	for rows.Next() {
		p, err := scanPasskey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// FindPasskeyByCredential is the sign-in lookup: the credential id is all the
// caller has before there is a session.
func FindPasskeyByCredential(ctx context.Context, tx pgx.Tx, credentialID []byte) (*Passkey, error) {
	return scanPasskey(tx.QueryRow(ctx, `
		SELECT `+passkeyColumns+` FROM passkeys WHERE credential_id = $1`, credentialID))
}

// TouchPasskey records a successful sign-in: the updated credential record
// (its sign count and backup flags move) and when it happened.
func TouchPasskey(ctx context.Context, tx pgx.Tx, id string, record []byte) error {
	_, err := tx.Exec(ctx, `
		UPDATE passkeys SET record = $2, last_used_at = now() WHERE id = $1`, id, record)
	return err
}

// DeletePasskey removes one of the user's own passkeys and reports whether
// there was one to remove.
func DeletePasskey(ctx context.Context, tx pgx.Tx, userID, id string) (bool, error) {
	tag, err := tx.Exec(ctx, `DELETE FROM passkeys WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// ConsumePasskeyChallenge marks a sign-in challenge as answered and reports
// whether this was the first time. The primary key is what makes a challenge
// single-use: two concurrent sign-ins with the same one cannot both insert.
func ConsumePasskeyChallenge(ctx context.Context, tx pgx.Tx, hash []byte, expiresAt time.Time) (bool, error) {
	tag, err := tx.Exec(ctx, `
		INSERT INTO passkey_used_challenges (challenge_hash, expires_at) VALUES ($1, $2)
		ON CONFLICT DO NOTHING`, hash, expiresAt)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}
