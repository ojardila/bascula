package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

// MCPAuditEntry is one write an assistant made (or tried to make) through the
// MCP tools. See migration 00038.
type MCPAuditEntry struct {
	ID         string          `json:"id"`
	UserID     string          `json:"userId"`
	UserName   string          `json:"userName"`
	ClientID   *string         `json:"clientId"`
	ClientName string          `json:"clientName"`
	Tool       string          `json:"tool"`
	Outcome    string          `json:"outcome"`
	Summary    string          `json:"summary"`
	Args       json.RawMessage `json:"args"`
	CreatedAt  time.Time       `json:"createdAt"`
}

// InsertMCPAudit writes one record in the caller's farm (RLS checks the farm
// and that the user is the one pinned on the transaction).
func InsertMCPAudit(ctx context.Context, tx pgx.Tx, id, farmID, userID string, clientID *string,
	tool, outcome, summary string, args []byte) error {
	if len(args) == 0 {
		args = []byte("{}")
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO mcp_audit (id, farm_id, user_id, client_id, tool, outcome, summary, args)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		id, farmID, userID, clientID, tool, outcome, summary, args)
	return err
}

// ListMCPAudit returns the farm's newest records first. RLS limits it to the
// owner and the administrator.
func ListMCPAudit(ctx context.Context, tx pgx.Tx, limit int) ([]MCPAuditEntry, error) {
	rows, err := tx.Query(ctx, `
		SELECT a.id::text, a.user_id::text,
		       coalesce(nullif(trim(u.name), ''), u.email, ''),
		       a.client_id, coalesce(c.name, ''), a.tool, a.outcome, a.summary, a.args, a.created_at
		  FROM mcp_audit a
		  LEFT JOIN users u ON u.id = a.user_id
		  LEFT JOIN oauth_clients c ON c.id = a.client_id
		 ORDER BY a.created_at DESC
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MCPAuditEntry{}
	for rows.Next() {
		var e MCPAuditEntry
		if err := rows.Scan(&e.ID, &e.UserID, &e.UserName, &e.ClientID, &e.ClientName,
			&e.Tool, &e.Outcome, &e.Summary, &e.Args, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
