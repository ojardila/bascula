// SPDX-License-Identifier: MIT

package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// The MCP audit trail: one record per write-tool execution (previews write
// nothing and are not recorded), with who, through which OAuth client, which
// tool, the outcome and the arguments. The owner and the administrator read
// it in «Conexiones» (GET /v1/mcp/activity).

const (
	mcpAuditMaxArgs    = 8 << 10
	mcpAuditMaxSummary = 300
	mcpAuditListLimit  = 100
)

// mcpAudit records one write-tool call. It runs after the tool's inner
// request has returned its connection, and the /mcp request released its own
// (handleMCP), so it takes one connection of its own. A failure to record is
// logged, never turned into a failure of the write the person asked for.
func (s *Server) mcpAudit(ctx context.Context, p *auth.Principal, tool, outcome string, res *mcp.CallToolResult, args mcpArgs) {
	if p != nil {
		s.mcpOutcomeSignal(p.UserID, p.FarmID, tool, outcome)
	}
	if s.pool == nil || p == nil || p.FarmID == "" {
		return
	}
	summary := ""
	if res != nil {
		summary = strings.TrimSpace(toolResultText(res))
		if i := strings.IndexByte(summary, '\n'); i >= 0 {
			summary = summary[:i]
		}
	}
	summary = truncateRunes(summary, mcpAuditMaxSummary)
	clean := mcpArgs{}
	for k, v := range args {
		if k == "confirmationToken" {
			continue
		}
		clean[k] = v
	}
	raw, _ := json.Marshal(clean)
	if len(raw) > mcpAuditMaxArgs {
		keys := make([]string, 0, len(clean))
		for k := range clean {
			keys = append(keys, k)
		}
		raw, _ = json.Marshal(map[string]any{"truncated": true, "keys": keys})
	}
	var client *string
	if p.ClientID != "" {
		c := p.ClientID
		client = &c
	}
	err := tenant.RunAs(context.WithoutCancel(ctx), s.pool, p, func(ctx context.Context, tx pgx.Tx) error {
		return store.InsertMCPAudit(ctx, tx, p.FarmID, store.MCPAuditEntry{
			ID: newID(), UserID: p.UserID, ClientID: client,
			Tool: tool, Outcome: outcome, Summary: summary, Args: raw,
		})
	})
	if err != nil {
		slog.Error("mcp audit", "tool", tool, "err", err)
	}
}

func toolResultText(res *mcp.CallToolResult) string {
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	return sb.String()
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

// handleListMCPActivity is GET /v1/mcp/activity: the farm's newest MCP write
// records. RLS limits the rows to the owner and the administrator as well.
func (s *Server) handleListMCPActivity(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	items, err := store.ListMCPAudit(r.Context(), tx, limitParamMax(r, 50, mcpAuditListLimit))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func limitParamMax(r *http.Request, def, max int) int {
	n := limitParam(r, def)
	if n > max {
		return max
	}
	return n
}
