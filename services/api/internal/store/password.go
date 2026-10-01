package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---------------------------------------------------------------------------
// Changing a password: with the current one (signed in), or with a secret
// mailed to the address (password_resets, migration 00042).
// ---------------------------------------------------------------------------

// FarmOwnerCredentialHash is the farm's own owner password for this user, if
// the farm has one (farm_owner_credentials, 00032). ok is false when the farm
// opens with the account's password, which is every farm but the ones
// registered with an address that already had an account.
func FarmOwnerCredentialHash(ctx context.Context, tx pgx.Tx, farmID, userID string) (hash string, ok bool, err error) {
	err = tx.QueryRow(ctx, `
		SELECT password_hash FROM farm_owner_credentials
		 WHERE farm_id = $1 AND user_id = $2`, farmID, userID).Scan(&hash)
	if err == pgx.ErrNoRows {
		return "", false, nil
	}
	return hash, err == nil, err
}

// SetFarmOwnerCredentialHash replaces the farm's own owner password. The row
// policy only lets it be written from inside that farm.
func SetFarmOwnerCredentialHash(ctx context.Context, tx pgx.Tx, farmID, userID, hash string) error {
	tag, err := tx.Exec(ctx, `
		UPDATE farm_owner_credentials SET password_hash = $3
		 WHERE farm_id = $1 AND user_id = $2`, farmID, userID, hash)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

// SetUserPasswordHash replaces the account's password.
func SetUserPasswordHash(ctx context.Context, tx pgx.Tx, userID, hash string) error {
	tag, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1`, userID, hash)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

// DropFarmOwnerCredentials forgets every farm-specific owner password the
// user has. It is for the email reset only: those rows exist because signup
// could not prove the address (see farmsUnlockedBy), and a reset is exactly
// that proof. Afterwards one password, the new one, opens all of the user's
// farms. The caller must have pinned the user with tenant.SetUser; the row
// policy lets a person delete only their own.
func DropFarmOwnerCredentials(ctx context.Context, tx pgx.Tx, userID string) error {
	_, err := tx.Exec(ctx, `DELETE FROM farm_owner_credentials WHERE user_id = $1`, userID)
	return err
}

// RevokeAllUserSessions kills every refresh token the account holds, on every
// farm, except the family named by keepFamilyID ("" keeps none). A changed
// password that left a stolen session alive would not have changed much. The
// request must run with no farm pinned (the row policy reaches every farm
// only then) or the caller accepts that only this farm's are revoked.
func RevokeAllUserSessions(ctx context.Context, tx pgx.Tx, userID, keepFamilyID string) error {
	_, err := tx.Exec(ctx, `
		UPDATE refresh_tokens SET revoked_at = now()
		 WHERE user_id = $1 AND revoked_at IS NULL
		   AND ($2 = '' OR family_id::text <> $2)`, userID, keepFamilyID)
	return err
}

// InsertPasswordReset records a new reset secret and spends every older one
// the user still had, in that order, so only the newest email works.
func InsertPasswordReset(ctx context.Context, tx pgx.Tx, id, userID string, hash []byte, expires time.Time) error {
	if _, err := tx.Exec(ctx, `
		UPDATE password_resets SET used_at = now()
		 WHERE user_id = $1 AND used_at IS NULL`, userID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO password_resets (id, user_id, token_hash, expires_at)
		VALUES ($1, $2, $3, $4)`, id, userID, hash, expires)
	return err
}

// ConsumePasswordReset spends a reset secret and returns its user, in one
// statement so two requests with the same link cannot both succeed. Expired,
// spent and unknown secrets are all pgx.ErrNoRows.
func ConsumePasswordReset(ctx context.Context, tx pgx.Tx, hash []byte) (string, error) {
	var userID string
	err := tx.QueryRow(ctx, `
		UPDATE password_resets SET used_at = now()
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		 RETURNING user_id::text`, hash).Scan(&userID)
	return userID, err
}

// FarmOwnerEmails is who hears about a change of hands on this farm: every
// owner except the one who made it.
func FarmOwnerEmails(ctx context.Context, tx pgx.Tx, exceptUserID string) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
		 WHERE m.farm_id = current_farm() AND m.role = 'owner' AND m.user_id <> $1
		 ORDER BY lower(u.email)`, exceptUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
