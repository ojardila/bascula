package httpapi

import (
	"crypto/hmac"
	"net/http"
	"strings"
	"time"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

// The public farm lookups, and what keeps them from being a farm directory.
//
// A farm's slug is a DNS label, so "does this exact slug exist?" cannot be a
// secret: the signup form has to say "that address is taken", and the farm's
// own address answers in a browser. What must not exist is a way to LIST the
// farms, count them, or learn anything about a farm beyond "this exact label
// is in use" without being its owner. So:
//
//   - GET /v1/farms/{slug}/provision-status and POST .../ready-email answer
//     only the person who created the farm: they carry the provision ticket the
//     signup (or the console) handed back, or they are a super-admin. Anybody
//     else gets the same 404 as a slug that does not exist, decided before the
//     database is asked, so neither the body nor the time says which it was.
//     Before this, anybody could read any farm's creation time to the second,
//     its certificate state and whether its owner asked for an email.
//   - GET /v1/farm-slugs (the signup availability check) and, on the shared
//     platform, GET /v1/farm-name are metered per client address, so testing
//     a dictionary of likely farm names is slow instead of free.

const (
	provisionTicketPurpose = "provision-status"
	// provisionTicketTTL covers the waiting screen and a return visit the
	// next days; after that the farm is long ready and the owner signs in.
	provisionTicketTTL = 7 * 24 * time.Hour
	// provisionTicketHeader carries the ticket. A query parameter would end up
	// in access logs; ?ticket= is still read for clients that cannot set one.
	provisionTicketHeader = "X-Provision-Ticket"
)

// provisionTicket is what signup and the console hand back with a new farm:
// proof, for a week, that the holder created the farm with this slug.
func (s *Server) provisionTicket(slug string) string {
	if s.signer == nil || slug == "" {
		return ""
	}
	return s.signer.SignTicket(provisionTicketPurpose, slug, provisionTicketTTL)
}

// mayWatchProvision reports whether this request may read or act on the
// provisioning of slug: a valid ticket for exactly that slug, or a
// super-admin session. It never touches the database.
func (s *Server) mayWatchProvision(r *http.Request, slug string) bool {
	if p, ok := auth.PrincipalFrom(r.Context()); ok && p.Superadmin {
		return true
	}
	// provision-status runs outside the auth chain (see buildRouter), so a
	// console session is read here: a valid, non-MCP super-admin token.
	if raw := bearerToken(r); raw != "" && s.signer != nil {
		if c, err := s.signer.Parse(raw); err == nil && c.Superadmin && !c.ForMCPOnly() {
			return true
		}
	}
	raw := strings.TrimSpace(r.Header.Get(provisionTicketHeader))
	if raw == "" {
		raw = strings.TrimSpace(r.URL.Query().Get("ticket"))
	}
	if raw == "" || s.signer == nil {
		return false
	}
	sub, err := s.signer.VerifyTicket(provisionTicketPurpose, raw)
	return err == nil && hmac.Equal([]byte(sub), []byte(slug))
}

// errFarmNotFound is the one answer for "no such farm" and "not yours to
// watch", so the two cannot be told apart.
func errFarmNotFound() error { return domain.NotFound("farm not found") }

// allowFarmLookup meters the public slug lookups per client address. A refused
// lookup is a 429 that names no slug.
func (s *Server) allowFarmLookup(w http.ResponseWriter, r *http.Request) bool {
	if s.farmLookups.allow(clientIP(r), time.Now()) {
		return true
	}
	w.Header().Set("Retry-After", "600")
	writeError(w, r, domain.Coded(http.StatusTooManyRequests, domain.CodeRateLimited,
		"too many lookups from this address, try again later"))
	return false
}

// provisionRunRef names a farm's provision-tenant workflow run without naming
// the farm. The workflow now runs in the private gitops repo, but run titles
// still carry only a keyed ref (defense in depth): this server can find the
// run for a slug while anyone reading the run list learns nothing, not even by
// hashing guesses (they lack the key).
func (s *Server) provisionRunRef(slug string) string {
	if s.signer == nil || slug == "" {
		return ""
	}
	return s.signer.OpaqueRef("provision-run", slug)
}
