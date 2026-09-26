package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// MCPConnection is one refresh-token family an OAuth client (ChatGPT or any
// other MCP connector) holds for one user on one farm. It is what the
// «Conexiones» block in Configuración calls a connection.
type MCPConnection struct {
	ID         string // the family id
	ClientID   string
	ClientName string
	CreatedAt  time.Time // when the grant was first issued
	LastUsedAt time.Time // when the newest token in the family was issued
	ExpiresAt  time.Time // when the newest refresh token stops working
}

// ListMCPConnections returns the caller's OAuth-issued families on this farm
// that have not been revoked, newest first. Expired ones are included: the
// screen says "vencida" rather than pretending they never existed.
func ListMCPConnections(ctx context.Context, tx pgx.Tx, userID, farmID string) ([]MCPConnection, error) {
	rows, err := tx.Query(ctx, `
		WITH latest AS (
		  SELECT DISTINCT ON (t.family_id)
		         t.family_id, t.oauth_client_id, t.issued_at, t.expires_at, t.revoked_at
		    FROM refresh_tokens t
		   WHERE t.user_id = $1 AND t.farm_id = $2 AND t.oauth_client_id IS NOT NULL
		   ORDER BY t.family_id, t.issued_at DESC
		)
		SELECT l.family_id::text, l.oauth_client_id, coalesce(c.name, ''),
		       (SELECT min(f.issued_at) FROM refresh_tokens f WHERE f.family_id = l.family_id),
		       l.issued_at, l.expires_at
		  FROM latest l
		  LEFT JOIN oauth_clients c ON c.id = l.oauth_client_id
		 WHERE l.revoked_at IS NULL
		 ORDER BY l.issued_at DESC`, userID, farmID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MCPConnection{}
	for rows.Next() {
		var c MCPConnection
		if err := rows.Scan(&c.ID, &c.ClientID, &c.ClientName, &c.CreatedAt,
			&c.LastUsedAt, &c.ExpiresAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// RevokeMCPConnection revokes one OAuth-issued family of this user on this
// farm. It reports false when there is no such family — including a web
// login's family, which this door never closes.
func RevokeMCPConnection(ctx context.Context, tx pgx.Tx, userID, farmID, familyID string) (bool, error) {
	var n int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM refresh_tokens
		 WHERE family_id::text = $1 AND user_id = $2 AND farm_id = $3
		   AND oauth_client_id IS NOT NULL`, familyID, userID, farmID).Scan(&n); err != nil {
		return false, err
	}
	if n == 0 {
		return false, nil
	}
	_, err := tx.Exec(ctx, `
		UPDATE refresh_tokens SET revoked_at = now()
		 WHERE family_id::text = $1 AND user_id = $2 AND farm_id = $3
		   AND oauth_client_id IS NOT NULL AND revoked_at IS NULL`, familyID, userID, farmID)
	return err == nil, err
}
