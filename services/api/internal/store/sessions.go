package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// UserSession is one open sign-in of a person on one farm: a refresh-token
// family opened by the web or a handset, not by an assistant (those are
// MCPConnection). It is what «Sesiones abiertas» lists.
type UserSession struct {
	ID         string // the family id
	Method     string // SignInPassword, SignInPasskey, …; "" before 00043
	UserAgent  string // of the request that last used it; "" when unknown
	CreatedAt  time.Time
	LastUsedAt time.Time // when the newest token in the family was issued
}

// ListUserSessions returns the caller's live sessions on this farm, most
// recently used first. Revoked and expired families are left out, and so are
// the families an assistant holds: they have their own block, and closing
// "every other session" must not disconnect ChatGPT by surprise.
func ListUserSessions(ctx context.Context, tx pgx.Tx, userID, farmID string) ([]UserSession, error) {
	rows, err := tx.Query(ctx, `
		WITH latest AS (
		  SELECT DISTINCT ON (t.family_id)
		         t.family_id, t.issued_at, t.expires_at, t.revoked_at, t.sign_in_method, t.user_agent
		    FROM refresh_tokens t
		   WHERE t.user_id = $1 AND t.farm_id = $2 AND t.oauth_client_id IS NULL
		   ORDER BY t.family_id, t.issued_at DESC
		)
		SELECT l.family_id::text, coalesce(l.sign_in_method, ''), coalesce(l.user_agent, ''),
		       (SELECT min(f.issued_at) FROM refresh_tokens f WHERE f.family_id = l.family_id),
		       l.issued_at
		  FROM latest l
		 WHERE l.revoked_at IS NULL AND l.expires_at > now()
		 ORDER BY l.issued_at DESC`, userID, farmID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UserSession{}
	for rows.Next() {
		var s UserSession
		if err := rows.Scan(&s.ID, &s.Method, &s.UserAgent, &s.CreatedAt, &s.LastUsedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// RevokeUserSession closes one of the caller's own sessions on this farm. It
// reports false when there is no such live session, including an
// assistant's family, which «Conexiones» closes instead.
func RevokeUserSession(ctx context.Context, tx pgx.Tx, userID, farmID, familyID string) (bool, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE refresh_tokens SET revoked_at = now()
		 WHERE family_id::text = $1 AND user_id = $2 AND farm_id = $3
		   AND oauth_client_id IS NULL AND revoked_at IS NULL`, familyID, userID, farmID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// RevokeOtherUserSessions closes every session the caller has on this farm
// except keepFamilyID, and reports how many it closed. Assistants' families
// are left alone, as in ListUserSessions.
func RevokeOtherUserSessions(ctx context.Context, tx pgx.Tx, userID, farmID, keepFamilyID string) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
		WITH closed AS (
		  UPDATE refresh_tokens SET revoked_at = now()
		   WHERE user_id = $1 AND farm_id = $2 AND family_id::text <> $3
		     AND oauth_client_id IS NULL AND revoked_at IS NULL AND expires_at > now()
		  RETURNING family_id
		)
		SELECT count(DISTINCT family_id) FROM closed`, userID, farmID, keepFamilyID).Scan(&n)
	return n, err
}
