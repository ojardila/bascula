// SPDX-License-Identifier: MIT

package apitest

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestAPIAnswersCannotBeFramedOrSniffed: every API answer, success or error,
// carries nosniff and refuses framing.
func TestAPIAnswersCannotBeFramedOrSniffed(t *testing.T) {
	h := requireDB(t)
	for _, path := range []string{"/health", "/v1/me", "/.well-known/oauth-authorization-server"} {
		req, rec := httptest.NewRequest(http.MethodGet, path, nil), httptest.NewRecorder()
		h.server.ServeHTTP(rec, req)
		got := rec.Header()
		if got.Get("X-Content-Type-Options") != "nosniff" || got.Get("X-Frame-Options") != "DENY" ||
			got.Get("Content-Security-Policy") != "frame-ancestors 'none'" {
			t.Errorf("%s (%d): missing security headers: %v", path, rec.Code, got)
		}
	}
}
