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

// VerifyUserEmail marks an address proven. It is called on the invite path
// only: there the address is vouched for by a member of the farm with a
// session, which is a different act from the open signup, where the token in
// the mailbox is the ONLY thing standing between a stranger and a farm
// registered against somebody else's address.
func VerifyUserEmail(ctx context.Context, tx pgx.Tx, userID string) error {
	_, err := tx.Exec(ctx, `
		UPDATE users SET email_verified_at = coalesce(email_verified_at, now())
		 WHERE id = $1`, userID)
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
// The people who can log in to a farm (/v1/users)
//
// The membership is the row that matters. A `user` is global — one address, one
// password, possibly several farms — and a `membership` is what gives that
// account a role inside THIS farm. Every function below is scoped by the
// membership for that reason: `users` has no farm_id and therefore no RLS
// policy, so a query that started from users and filtered afterwards would be
// reading across the whole platform and relying on a WHERE clause to be right.
// ---------------------------------------------------------------------------

// FarmUser is one member of the farm as the console lists them.
type FarmUser struct {
	ID              string      `json:"id"`
	Email           string      `json:"email"`
	Name            string      `json:"name"`
	Role            domain.Role `json:"role"`
	EmailVerifiedAt *time.Time  `json:"emailVerifiedAt"`
	CreatedAt       time.Time   `json:"createdAt"`
}

func ListFarmUsers(ctx context.Context, tx pgx.Tx) ([]FarmUser, error) {
	rows, err := tx.Query(ctx, `
		SELECT u.id::text, u.email, u.name, m.role, u.email_verified_at, u.created_at
		  FROM memberships m JOIN users u ON u.id = m.user_id
		 WHERE m.farm_id = current_farm()
		 ORDER BY m.role, lower(u.email)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []FarmUser{}
	for rows.Next() {
		var u FarmUser
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.Role, &u.EmailVerifiedAt,
			&u.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// GetFarmUser is one member OF THIS FARM. It answers pgx.ErrNoRows for a user
// who exists on the platform but not here, which is the whole point: a PATCH
// addressed at somebody else's account must be a 404 and never a role change.
func GetFarmUser(ctx context.Context, tx pgx.Tx, userID string) (*FarmUser, error) {
	var u FarmUser
	err := tx.QueryRow(ctx, `
		SELECT u.id::text, u.email, u.name, m.role, u.email_verified_at, u.created_at
		  FROM memberships m JOIN users u ON u.id = m.user_id
		 WHERE m.farm_id = current_farm() AND m.user_id = $1`, userID).
		Scan(&u.ID, &u.Email, &u.Name, &u.Role, &u.EmailVerifiedAt, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// CountFarmOwners is the farm's floor: it may never reach zero.
//
// It is counted inside the same transaction as the change that would lower it,
// and the row is locked, so two administrators demoting the last two owners at
// the same moment cannot both read "there are two" and both succeed.
func CountFarmOwners(ctx context.Context, tx pgx.Tx) (int, error) {
	var n int
	// The lock is inside the subquery because FOR UPDATE and an aggregate
	// cannot share a SELECT. Counting the locked rows is the same thing and
	// Postgres accepts it.
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM (
			SELECT 1 FROM memberships
			 WHERE farm_id = current_farm() AND role = 'owner'
			 FOR UPDATE) locked`).Scan(&n)
	return n, err
}

func SetMembershipRole(ctx context.Context, tx pgx.Tx, userID string, role domain.Role) error {
	tag, err := tx.Exec(ctx, `
		UPDATE memberships SET role = $2
		 WHERE farm_id = current_farm() AND user_id = $1`, userID, role)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

// DeleteMembership takes the account's access to this farm away. It is a real
// DELETE and the one in this service, and that is not a contradiction of
// "delete never deletes": what is removed is a permission, not a person. The
// user row, their other farms and everything they ever wrote here stay exactly
// where they were — work records and ledger entries point at users(id), which
// is untouched.
func DeleteMembership(ctx context.Context, tx pgx.Tx, userID string) error {
	tag, err := tx.Exec(ctx, `
		DELETE FROM memberships WHERE farm_id = current_farm() AND user_id = $1`, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

// RevokeUserSessions kills every refresh token this account holds on this
// farm. Removing somebody's access while their phone keeps a live refresh
// token would leave them logged in for sixty days after being removed, which
// is not "access removed", it is "access removed eventually".
func RevokeUserSessions(ctx context.Context, tx pgx.Tx, farmID, userID string) error {
	_, err := tx.Exec(ctx, `
		UPDATE refresh_tokens SET revoked_at = now()
		 WHERE farm_id = $1 AND user_id = $2 AND revoked_at IS NULL`, farmID, userID)
	return err
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
//
// It returns the farm as well as the user. Both were on the signup response
// until signup stopped being allowed to say anything that depends on the
// address; here the caller is holding a secret that was mailed to that address,
// which is the proof signup could not ask for, so here they are safe to give.
func ConsumeEmailVerification(ctx context.Context, tx pgx.Tx, hash []byte) (userID, farmID string, err error) {
	err = tx.QueryRow(ctx, `
		UPDATE email_verifications SET used_at = now()
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		 RETURNING user_id::text, farm_id::text`, hash).Scan(&userID, &farmID)
	if err != nil {
		return "", "", err
	}
	_, err = tx.Exec(ctx, `
		UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, userID)
	return userID, farmID, err
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
