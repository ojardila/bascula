package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

type User struct {
	ID              string
	Email           string
	Name            string
	PasswordHash    string
	IsSuperadmin    bool
	EmailVerifiedAt *time.Time
}

type Membership struct {
	FarmID      string
	FarmName    string
	UserID      string
	Role        domain.Role
	SuspendedAt *time.Time
	Timezone    string
	Currency    string
}

func FindUserByEmail(ctx context.Context, tx pgx.Tx, email string) (*User, error) {
	var u User
	err := tx.QueryRow(ctx, `
		SELECT id::text, email, name, password_hash, is_superadmin, email_verified_at
		  FROM users WHERE lower(email) = lower($1)`, email).
		Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.IsSuperadmin, &u.EmailVerifiedAt)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func FindUserByID(ctx context.Context, tx pgx.Tx, id string) (*User, error) {
	var u User
	err := tx.QueryRow(ctx, `
		SELECT id::text, email, name, password_hash, is_superadmin, email_verified_at
		  FROM users WHERE id = $1`, id).
		Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.IsSuperadmin, &u.EmailVerifiedAt)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func CreateUser(ctx context.Context, tx pgx.Tx, u User) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO users (id, email, name, password_hash, is_superadmin)
		VALUES ($1, $2, $3, $4, $5)`, u.ID, u.Email, u.Name, u.PasswordHash, u.IsSuperadmin)
	return err
}

// CountOwnedFarms is the per-email cap on the open signup: the most exposed
// surface in the system needs a ceiling that is not just a rate limit.
func CountOwnedFarms(ctx context.Context, tx pgx.Tx, userID string) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM memberships WHERE user_id = $1 AND role = 'owner'`, userID).Scan(&n)
	return n, err
}

type NewFarm struct {
	ID         string
	Name       string
	Timezone   string
	Currency   string
	PriceMinor int64
}

func CreateFarm(ctx context.Context, tx pgx.Tx, f NewFarm) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO farms (id, name, timezone, currency) VALUES ($1, $2, $3, $4)`,
		f.ID, f.Name, f.Timezone, f.Currency); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO farm_config (farm_id, price_minor) VALUES ($1, $2)`, f.ID, f.PriceMinor)
	return err
}

func CreateMembership(ctx context.Context, tx pgx.Tx, farmID, userID string, role domain.Role) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO memberships (farm_id, user_id, role) VALUES ($1, $2, $3)`, farmID, userID, role)
	return err
}

func ListMemberships(ctx context.Context, tx pgx.Tx, userID string) ([]Membership, error) {
	rows, err := tx.Query(ctx, `
		SELECT m.farm_id::text, f.name, m.user_id::text, m.role, f.suspended_at, f.timezone, f.currency
		  FROM memberships m JOIN farms f ON f.id = m.farm_id
		 WHERE m.user_id = $1
		 ORDER BY f.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Membership
	for rows.Next() {
		var m Membership
		if err := rows.Scan(&m.FarmID, &m.FarmName, &m.UserID, &m.Role,
			&m.SuspendedAt, &m.Timezone, &m.Currency); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func GetMembership(ctx context.Context, tx pgx.Tx, farmID, userID string) (*Membership, error) {
	var m Membership
	err := tx.QueryRow(ctx, `
		SELECT m.farm_id::text, f.name, m.user_id::text, m.role, f.suspended_at, f.timezone, f.currency
		  FROM memberships m JOIN farms f ON f.id = m.farm_id
		 WHERE m.farm_id = $1 AND m.user_id = $2`, farmID, userID).
		Scan(&m.FarmID, &m.FarmName, &m.UserID, &m.Role, &m.SuspendedAt, &m.Timezone, &m.Currency)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// ---------------------------------------------------------------------------
// Refresh tokens: opaque, hashed, rotated on every use.
// ---------------------------------------------------------------------------

type RefreshToken struct {
	ID        string
	FamilyID  string
	UserID    string
	FarmID    string
	DeviceID  *string
	ExpiresAt time.Time
	RotatedAt *time.Time
	RevokedAt *time.Time
}

func InsertRefreshToken(ctx context.Context, tx pgx.Tx, t RefreshToken, hash []byte) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO refresh_tokens (id, family_id, user_id, farm_id, token_hash, device_id, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		t.ID, t.FamilyID, t.UserID, t.FarmID, hash, t.DeviceID, t.ExpiresAt)
	return err
}

func FindRefreshToken(ctx context.Context, tx pgx.Tx, hash []byte) (*RefreshToken, error) {
	var t RefreshToken
	err := tx.QueryRow(ctx, `
		SELECT id::text, family_id::text, user_id::text, farm_id::text, device_id::text,
		       expires_at, rotated_at, revoked_at
		  FROM refresh_tokens WHERE token_hash = $1`, hash).
		Scan(&t.ID, &t.FamilyID, &t.UserID, &t.FarmID, &t.DeviceID,
			&t.ExpiresAt, &t.RotatedAt, &t.RevokedAt)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func MarkRefreshRotated(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, `UPDATE refresh_tokens SET rotated_at = now() WHERE id = $1`, id)
	return err
}

// RevokeFamily kills every token descended from one login. This is the reuse
// response: presenting a token that was already rotated means either a replay
// or a stolen copy, and in both cases the whole family stops working.
func RevokeFamily(ctx context.Context, tx pgx.Tx, familyID string) error {
	_, err := tx.Exec(ctx, `
		UPDATE refresh_tokens SET revoked_at = now()
		 WHERE family_id = $1 AND revoked_at IS NULL`, familyID)
	return err
}

func RevokeRefreshToken(ctx context.Context, tx pgx.Tx, id string) error {
	_, err := tx.Exec(ctx, `
		UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, id)
	return err
}

// ---------------------------------------------------------------------------
// Email verification and signup throttling.
// ---------------------------------------------------------------------------

func InsertEmailVerification(ctx context.Context, tx pgx.Tx, id, userID, farmID string, hash []byte, expires time.Time) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO email_verifications (id, user_id, farm_id, token_hash, expires_at)
		VALUES ($1, $2, $3, $4, $5)`, id, userID, farmID, hash, expires)
	return err
}

// ConsumeEmailVerification marks the token used and verifies the address, in
// one statement so a replay cannot verify twice.
func ConsumeEmailVerification(ctx context.Context, tx pgx.Tx, hash []byte) (string, error) {
	var userID string
	err := tx.QueryRow(ctx, `
		UPDATE email_verifications SET used_at = now()
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		 RETURNING user_id::text`, hash).Scan(&userID)
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `
		UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, userID)
	return userID, err
}

func RecordSignupAttempt(ctx context.Context, tx pgx.Tx, id, ip, email string, ok bool) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO signup_attempts (id, ip, email, succeeded) VALUES ($1, $2::inet, $3, $4)`,
		id, ip, email, ok)
	return err
}

// CountSignupAttempts counts recent attempts from one IP. A floor of rate
// limiting that survives a process restart, unlike an in-memory bucket.
func CountSignupAttempts(ctx context.Context, tx pgx.Tx, ip string, window time.Duration) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM signup_attempts
		 WHERE ip = $1::inet AND at > now() - $2::interval`,
		ip, window.String()).Scan(&n)
	return n, err
}
