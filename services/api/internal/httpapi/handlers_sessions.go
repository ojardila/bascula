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

// «Sesiones abiertas».
//
// A session is a refresh-token family: one sign-in on one browser or phone,
// kept alive by rotation for up to sixty days. A person sees their own on
// this farm, which one they are using now, and can close one or every other.
// Closing stops the refresh token at once; an access token already handed
// out lives out its short TTL (auth.AccessTTL).
//
// Assistants' families (ChatGPT, Claude) are not sessions here: they have
// «Conexiones», and "close every other session" must not disconnect them.

// sessionView is one entry of GET /v1/me/sessions.
type sessionView struct {
	ID string `json:"id"`
	// Method is how the person got in: password, passkey, or unknown for a
	// session opened before methods were recorded.
	Method     string    `json:"method"`
	UserAgent  string    `json:"userAgent"`
	CreatedAt  time.Time `json:"createdAt"`
	LastUsedAt time.Time `json:"lastUsedAt"`
	// Current marks the session the request itself belongs to.
	Current bool `json:"current"`
}

// GET /v1/me/sessions
func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.PrincipalFrom(r.Context())
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	list, err := store.ListUserSessions(r.Context(), tx, p.UserID, p.FarmID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	out := make([]sessionView, 0, len(list))
	for _, x := range list {
		method := x.Method
		if method == "" {
			method = "unknown"
		}
		out = append(out, sessionView{
			ID: x.ID, Method: method, UserAgent: x.UserAgent,
			CreatedAt: x.CreatedAt, LastUsedAt: x.LastUsedAt,
			Current: p.SessionID != "" && x.ID == p.SessionID,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// DELETE /v1/me/sessions/{id}
func (s *Server) handleCloseSession(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.PrincipalFrom(r.Context())
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	ok, err := store.RevokeUserSession(r.Context(), tx, p.UserID, p.FarmID, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	if !ok {
		writeError(w, r, domain.NotFound("no open session with that id"))
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

// POST /v1/me/sessions/close-others
//
// Needs to know which session is the caller's, which only a token with the
// "sid" claim says. A token from before the claim is at most AccessTTL old;
// the client refreshes and asks again rather than closing its own session.
func (s *Server) handleCloseOtherSessions(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.PrincipalFrom(r.Context())
	if p.SessionID == "" {
		writeError(w, r, domain.Coded(http.StatusUnauthorized, domain.CodeTokenExpired,
			"this access token does not name its session; refresh it and try again"))
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	n, err := store.RevokeOtherUserSessions(r.Context(), tx, p.UserID, p.FarmID, p.SessionID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"closed": n})
}
