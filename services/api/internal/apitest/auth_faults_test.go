package apitest

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// The automatic fault replay skips the sign-in, signup and OAuth routes,
// because tests elsewhere count what those routes do (hash calls, limiter
// rows, mails) and the replayed twins would add to the count. This file walks
// the replay on one request of each kind, on purpose and nowhere else, so the
// "if err != nil" after each of their database calls is reached too.

// serveReplayed serves req once after the fault replay has run over it.
func (h *harness) serveReplayed(req *http.Request, raw string) *httptest.ResponseRecorder {
	if faultReplayOn() {
		h.replayAll(req, raw)
	}
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	return rec
}

func (h *harness) jsonReplayed(t *testing.T, ip, path, token string, body any, want int) map[string]any {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(raw)))
	req.RemoteAddr = ip + ":12345"
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := h.serveReplayed(req, string(raw))
	if rec.Code != want {
		t.Fatalf("%s: got %d want %d: %s", path, rec.Code, want, rec.Body.String())
	}
	out := map[string]any{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}

func (h *harness) formReplayed(t *testing.T, path string, form url.Values, want int) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = "10.0.0.1:12345"
	rec := h.serveReplayed(req, form.Encode())
	if rec.Code != want {
		t.Fatalf("%s: got %d want %d: %s", path, rec.Code, want, rec.Body.String())
	}
	return rec
}

func TestSignupAndSessionSurviveFaults(t *testing.T) {
	h := requireDB(t)
	email := fmt.Sprintf("fallas-%s@example.com", uuid.NewString()[:8])
	signup := h.jsonReplayed(t, "10.74.0.1", "/v1/signup", "", map[string]any{
		"farm":  map[string]any{"name": "Finca de las fallas", "timezone": "America/Bogota", "currency": "COP", "priceCents": 90000},
		"owner": map[string]any{"email": email, "name": "Owner", "password": "una-clave-larga-1", "phone": "3001234567"},
	}, http.StatusCreated)
	h.jsonReplayed(t, "10.74.0.1", "/v1/auth/verify-email", "",
		map[string]any{"token": signup["verificationToken"]}, http.StatusOK)

	login := h.jsonReplayed(t, "10.74.0.2", "/v1/auth/login", "", map[string]any{
		"email": email, "password": "una-clave-larga-1",
	}, http.StatusOK)
	refreshed := h.jsonReplayed(t, "10.74.0.2", "/v1/auth/refresh", "",
		map[string]any{"refreshToken": login["refreshToken"]}, http.StatusOK)
	h.jsonReplayed(t, "10.74.0.2", "/v1/auth/logout", mustString(t, refreshed, "accessToken"),
		map[string]any{"refreshToken": refreshed["refreshToken"]}, http.StatusNoContent)
}

func TestOAuthFlowSurvivesFaults(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca OAuth con fallas", 90000)
	redirect := "https://chatgpt.com/connector_platform_oauth_redirect"
	reg := h.jsonReplayed(t, "10.0.0.1", "/oauth/register", "", map[string]any{
		"client_name": "Asistente", "redirect_uris": []string{redirect},
	}, http.StatusCreated)
	clientID := mustString(t, reg, "client_id")

	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	rec := h.formReplayed(t, "/oauth/authorize", url.Values{
		"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"state": {"st"}, "email": {f.OwnerEmail}, "password": {"una-clave-larga-1"},
	}, http.StatusFound)
	loc, err := rec.Result().Location()
	if err != nil {
		t.Fatalf("location: %v", err)
	}

	tok := h.formReplayed(t, "/oauth/token", url.Values{
		"grant_type": {"authorization_code"}, "code": {loc.Query().Get("code")},
		"redirect_uri": {redirect}, "client_id": {clientID}, "code_verifier": {verifier},
	}, http.StatusOK)
	var issued map[string]any
	if err := json.Unmarshal(tok.Body.Bytes(), &issued); err != nil {
		t.Fatal(err)
	}
	refresh := h.formReplayed(t, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {mustString(t, issued, "refresh_token")},
		"client_id": {clientID},
	}, http.StatusOK)
	var again map[string]any
	if err := json.Unmarshal(refresh.Body.Bytes(), &again); err != nil {
		t.Fatal(err)
	}
	h.formReplayed(t, "/oauth/revoke", url.Values{
		"token": {mustString(t, again, "refresh_token")}, "client_id": {clientID},
	}, http.StatusOK)
}
