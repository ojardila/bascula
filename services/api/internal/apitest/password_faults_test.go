package apitest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// replayedOn runs the fault replay over one JSON request on srv and then
// serves it for real.
func replayedOn(t *testing.T, srv http.Handler, path string, body any) response {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	newReq := func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(raw)))
		req.RemoteAddr = "10.75.0.1:12345"
		req.Header.Set("Content-Type", "application/json")
		return req
	}
	if faultReplayOn() {
		replayAllOn(srv, newReq(), string(raw))
	}
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, newReq())
	out := response{Status: rec.Code, Raw: rec.Body.String()}
	if out.Raw != "" {
		_ = json.Unmarshal([]byte(out.Raw), &out.Body)
	}
	return out
}

// TestPasswordResetSurvivesFaults walks the fault replay over asking for a
// reset link and over spending one. Every failed twin rolls back, so the
// real request after it behaves as if the replay never happened.
func TestPasswordResetSurvivesFaults(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca reset fallas", 90000)
	srv, _ := mailServer(t, h)

	// Every twin counts against the address's request limit, so the replayed
	// request is made for one owner and the link is asked for another.
	replayedOn(t, srv, "/v1/auth/password-reset/request", map[string]any{"email": f.OwnerEmail})
	g := h.signupFarm(t, "Finca reset fallas dos", 90000)
	asked := callFrom(t, srv, "", http.MethodPost, "/v1/auth/password-reset/request", "", map[string]any{"email": g.OwnerEmail})
	if asked.Status != http.StatusAccepted {
		t.Fatalf("request: %d %s", asked.Status, asked.Raw)
	}
	token := mustString(t, asked.Body, "resetToken")

	// Whichever run spends the link first, the twin that got through or the
	// real request, the new password is the one that signs in afterwards.
	spent := replayedOn(t, srv, "/v1/auth/password-reset", map[string]any{"token": token, "password": newSecret})
	if spent.Status != http.StatusNoContent && spent.Status != http.StatusBadRequest {
		t.Fatalf("reset after the replay: %d %s", spent.Status, spent.Raw)
	}
	h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": g.OwnerEmail, "password": newSecret,
	}, http.StatusOK)
}
