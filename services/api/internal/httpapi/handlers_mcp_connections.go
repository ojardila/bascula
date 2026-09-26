package httpapi

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// mcpConnectionView is one entry of GET /v1/mcp/connections.
type mcpConnectionView struct {
	ID         string    `json:"id"`
	ClientName string    `json:"clientName"`
	Status     string    `json:"status"` // active | expired
	CreatedAt  time.Time `json:"createdAt"`
	LastUsedAt time.Time `json:"lastUsedAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

// handleListMCPConnections lists the caller's own MCP connections on this
// farm: sessions an OAuth client (ChatGPT, …) obtained through /oauth/token
// and that nobody has revoked. Only the caller's, never another member's.
func (s *Server) handleListMCPConnections(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.PrincipalFrom(r.Context())
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	list, err := store.ListMCPConnections(r.Context(), tx, p.UserID, p.FarmID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	now := time.Now()
	out := make([]mcpConnectionView, 0, len(list))
	for _, c := range list {
		status := "active"
		if now.After(c.ExpiresAt) {
			status = "expired"
		}
		name := c.ClientName
		if name == "" {
			name = "Asistente"
		}
		out = append(out, mcpConnectionView{
			ID: c.ID, ClientName: name, Status: status,
			CreatedAt: c.CreatedAt, LastUsedAt: c.LastUsedAt, ExpiresAt: c.ExpiresAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":    out,
		"endpoint": s.mcpResource(r),
	})
}

// handleRevokeMCPConnection closes one of the caller's MCP connections. The
// refresh token stops working at once; an access token already handed out
// lives out its short TTL (auth.AccessTTL).
func (s *Server) handleRevokeMCPConnection(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.PrincipalFrom(r.Context())
	id := chi.URLParam(r, "id")
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	ok, err := store.RevokeMCPConnection(r.Context(), tx, p.UserID, p.FarmID, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if !ok {
		writeError(w, r, domain.NotFound("no MCP connection with that id"))
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}
