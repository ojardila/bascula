package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNoStore(t *testing.T) {
	h := noStore(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/uploads/x" {
			w.Header().Set("Cache-Control", "private, max-age=300")
		}
	}))
	cases := map[string]string{
		"/v1/farms/x/provision-status": "no-store",
		"/v1":                          "no-store",
		"/health":                      "no-store",
		"/oauth/token":                 "no-store",
		"/mcp":                         "no-store",
		"/.well-known/oauth-authorization-server": "no-store",
		"/v1/uploads/x":  "private, max-age=300",
		"/assets/app.js": "",
		"/v10":           "",
	}
	for path, want := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if got := rec.Header().Get("Cache-Control"); got != want {
			t.Errorf("%s: Cache-Control = %q, want %q", path, got, want)
		}
	}
}
