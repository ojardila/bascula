// SPDX-License-Identifier: MIT

package httpapi

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// coaServer is a server with no database: what the OAuth endpoints do before,
// or without, a request transaction.
func coaServer(t *testing.T) *Server {
	t.Helper()
	t.Setenv("APP_ENV", "development")
	cfg := DefaultConfig()
	cfg.UploadDir = t.TempDir()
	return New(nil, nil, cfg)
}

func coaOAuthError(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("not a JSON error body: %d %s", rec.Code, rec.Body.String())
	}
	return body["error"]
}

// TestCoaOAuthIssuerFollowsTheConnection: with no configured base URL the
// issuer and the accepted MCP audience follow how the request arrived (TLS or
// the proxy's X-Forwarded-Proto), and a resource that is not a plain absolute
// URI never names this server.
func TestCoaOAuthIssuerFollowsTheConnection(t *testing.T) {
	s := coaServer(t)
	s.cfg.PublicBaseURL = ""

	tlsReq := httptest.NewRequest(http.MethodGet, "/", nil)
	tlsReq.Host = "api.example"
	tlsReq.TLS = &tls.ConnectionState{}
	if got := s.publicBase(tlsReq); got != "https://api.example" {
		t.Fatalf("publicBase over TLS = %q", got)
	}
	if got := requestOrigin(tlsReq); got != "https://api.example" {
		t.Fatalf("requestOrigin over TLS = %q", got)
	}

	proxied := httptest.NewRequest(http.MethodGet, "/", nil)
	proxied.Host = "finca.example"
	proxied.Header.Set("X-Forwarded-Proto", "https, http")
	if got := requestOrigin(proxied); got != "https://finca.example" {
		t.Fatalf("requestOrigin behind a proxy = %q", got)
	}
	if !s.resourceIsThisServer(proxied, "https://FINCA.example/mcp/") {
		t.Fatal("this server's own MCP endpoint was not recognised")
	}
	for _, res := range []string{
		"", "not a url", "/mcp", "https://finca.example/mcp?x=1", "https://finca.example/mcp#f",
		"https://u:p@finca.example/mcp", "https://other.example/mcp", "%zz",
	} {
		if s.resourceIsThisServer(proxied, res) {
			t.Errorf("resource %q was accepted as this server", res)
		}
	}
}

// TestCoaOAuthEndpointsRefuseMalformedForms: a form body that does not parse
// is invalid_request (token, revoke) or a 400 (authorize), never a sign-in.
func TestCoaOAuthEndpointsRefuseMalformedForms(t *testing.T) {
	s := coaServer(t)
	post := func(h http.HandlerFunc, path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader("client_id=%zz&x"))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec
	}
	for path, h := range map[string]http.HandlerFunc{"/oauth/token": s.handleOAuthToken, "/oauth/revoke": s.handleOAuthRevoke} {
		rec := post(h, path)
		if rec.Code != http.StatusBadRequest || coaOAuthError(t, rec) != "invalid_request" {
			t.Errorf("%s malformed form: %d %s", path, rec.Code, rec.Body.String())
		}
	}
	rec := post(s.handleOAuthAuthorize, "/oauth/authorize")
	if rec.Code != http.StatusBadRequest || rec.Header().Get("Location") != "" {
		t.Errorf("authorize malformed form: %d %s", rec.Code, rec.Body.String())
	}
}

// TestCoaOAuthWithoutATransaction: with no request transaction the register
// and authorize endpoints fail closed (5xx, no client, no redirect), and the
// platform-wide registration budget, which cannot count, lets the request on
// to that failure instead of panicking.
func TestCoaOAuthWithoutATransaction(t *testing.T) {
	s := coaServer(t)
	if s.cfg.OAuthRegistrationsPerHour <= 0 {
		t.Fatal("the default config should cap registrations")
	}
	req := httptest.NewRequest(http.MethodPost, "/oauth/register",
		strings.NewReader(`{"client_name":"x","redirect_uris":["https://chatgpt.com/cb"]}`))
	if !s.oauthRegistrationBudgetLeft(req) {
		t.Fatal("budget with no transaction should not refuse")
	}
	rec := httptest.NewRecorder()
	s.handleOAuthRegister(rec, req)
	if rec.Code < 500 || strings.Contains(rec.Body.String(), "client_id") {
		t.Fatalf("register without a transaction: %d %s", rec.Code, rec.Body.String())
	}

	q := url.Values{"client_id": {"c"}, "redirect_uri": {"https://chatgpt.com/cb"}}
	rec = httptest.NewRecorder()
	s.handleOAuthAuthorize(rec, httptest.NewRequest(http.MethodGet, "/oauth/authorize?"+q.Encode(), nil))
	if rec.Code < 500 || rec.Header().Get("Location") != "" {
		t.Fatalf("authorize without a transaction: %d %s", rec.Code, rec.Body.String())
	}
}

type coaFailingWriter struct{ *httptest.ResponseRecorder }

func (coaFailingWriter) Write([]byte) (int, error) { return 0, errors.New("client went away") }

// TestCoaOAuthFormEdges: a farm host with no database names the farm by its
// slug, and a page whose client hung up mid-write is logged, not a panic.
func TestCoaOAuthFormEdges(t *testing.T) {
	s := coaServer(t)
	req := httptest.NewRequest(http.MethodGet, "/oauth/authorize", nil)
	req.Host = "lapalma.bascula.engp.io"
	if got := s.oauthFormFarmName(req, "lapalma"); got != "lapalma" {
		t.Fatalf("farm name without a pool = %q", got)
	}
	rec := httptest.NewRecorder()
	s.oauthForm(rec, req, url.Values{}, "", nil, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "lapalma") {
		t.Fatalf("farm host page: %d", rec.Code)
	}
	if rec.Header().Get("X-Frame-Options") != "DENY" {
		t.Fatal("sign-in page can be framed")
	}

	w := coaFailingWriter{httptest.NewRecorder()}
	s.oauthForm(w, req, url.Values{}, "aviso", nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status before the failed write: %d", w.Code)
	}
}
