// SPDX-License-Identifier: MIT

package httpapi

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/ojardila/bascula/services/api/internal/secalert"
)

// The emitters of the security signals of issue #312. Each is one line at the
// place the event already happens; what counts as a page, and the email, are
// internal/secalert's. With no alerter configured (Config.Alerts nil) every
// call here is a no-op. docs/detections.md is the catalog.

// loginRefused reports one refused sign-in — a wrong password or passkey, or
// a refusal by the limiter — keyed by client IP. The limiter answers; this is
// only so that somebody hears about it while it is happening.
func (s *Server) loginRefused(ip, email, door string) {
	detail := "door=" + door
	if email != "" {
		detail += " email=" + email
	}
	s.cfg.Alerts.Observe(secalert.LoginRefusals, ip, detail)
}

// mcpOutcomeSignal reports an assistant's write that did not go through,
// keyed by the user it acts for.
func (s *Server) mcpOutcomeSignal(userID, farmID, tool, outcome string) {
	if outcome == "done" {
		return
	}
	s.cfg.Alerts.Observe(secalert.MCPFailures, userID,
		fmt.Sprintf("tool=%s outcome=%s farm=%s", tool, outcome, farmID))
}

// oauthErrorSignal reports an authorize request sent back with an error.
func (s *Server) oauthErrorSignal(clientID, code string) {
	s.cfg.Alerts.Observe(secalert.OAuthErrors, clientID, "error="+code)
}

// watchServerErrors reports every 5xx on /v1, keyed by Host: on the shared
// platform each farm has its own address, and a dedicated stack is one farm.
// It sits outside Recoverer so a panic's 500 is counted too.
func (s *Server) watchServerErrors(next http.Handler) http.Handler {
	if s.cfg.Alerts == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/v1/") {
			next.ServeHTTP(w, r)
			return
		}
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		defer func() {
			if st := ww.Status(); st >= 500 {
				s.cfg.Alerts.Observe(secalert.ServerErrors, r.Host,
					fmt.Sprintf("%s %s -> %d", r.Method, r.URL.Path, st))
			}
		}()
		next.ServeHTTP(ww, r)
	})
}
