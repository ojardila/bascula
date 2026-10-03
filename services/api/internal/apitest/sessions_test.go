package apitest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/ojardila/bascula/services/api/internal/auth"
)

// doUA is do with a User-Agent, the way a browser or a phone sends one.
func (h *harness) doUA(t *testing.T, ua, method, path, token string, body any) response {
	t.Helper()
	raw := ""
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		raw = string(b)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(raw))
	req.RemoteAddr = "10.0.0.1:12345"
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("User-Agent", ua)
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	out := response{Status: rec.Code, Raw: rec.Body.String()}
	if out.Raw != "" {
		_ = json.Unmarshal([]byte(out.Raw), &out.Body)
	}
	return out
}

func sessionItems(t *testing.T, res response) map[string]map[string]any {
	t.Helper()
	if res.Status != http.StatusOK {
		t.Fatalf("list sessions: %d %s", res.Status, res.Raw)
	}
	raw, _ := res.Body["items"].([]any)
	out := map[string]map[string]any{}
	for _, it := range raw {
		m := it.(map[string]any)
		out[m["id"].(string)] = m
	}
	return out
}

// sidOf reads the session id out of an access token the server issued.
func sidOf(t *testing.T, access string) string {
	t.Helper()
	c, err := auth.NewSigner([]byte("test-signing-key"), "bascula").Parse(access)
	if err != nil {
		t.Fatalf("parse access token: %v", err)
	}
	if c.SessionID == "" {
		t.Fatalf("a session token without sid")
	}
	return c.SessionID
}

// TestOpenSessions: «Sesiones abiertas» lists a person's own sign-ins on this
// farm with how they signed in and on what, marks the current one, and closes
// one or every other. Assistants' connections are not sessions here.
func TestOpenSessions(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca Sesiones Abiertas", 250000)
	creds := map[string]any{"email": f.OwnerEmail, "password": f.loginSecret()}

	phone := h.doUA(t, "Mozilla/5.0 (Linux; Android 14) Chrome/129 Mobile", http.MethodPost, "/v1/auth/login", "", creds)
	desk := h.doUA(t, "Mozilla/5.0 (Windows NT 10.0) Chrome/129", http.MethodPost, "/v1/auth/login", "", creds)
	if phone.Status != http.StatusOK || desk.Status != http.StatusOK {
		t.Fatalf("login: %d %s / %d %s", phone.Status, phone.Raw, desk.Status, desk.Raw)
	}
	phoneSID := sidOf(t, mustString(t, phone.Body, "accessToken"))
	deskToken := mustString(t, desk.Body, "accessToken")
	deskSID := sidOf(t, deskToken)

	items := sessionItems(t, h.do(t, http.MethodGet, "/v1/me/sessions", deskToken, nil))
	if len(items) < 3 {
		t.Fatalf("want the fixture's login plus two, got %d", len(items))
	}
	d := items[deskSID]
	if d == nil || d["current"] != true || d["method"] != "password" ||
		!strings.Contains(d["userAgent"].(string), "Windows") || d["createdAt"] == nil || d["lastUsedAt"] == nil {
		t.Fatalf("desktop session: %v", d)
	}
	if items[phoneSID]["current"] != false {
		t.Fatalf("the phone was marked current from the desktop: %v", items[phoneSID])
	}

	t.Run("a refresh keeps one session, its method, and the latest browser", func(t *testing.T) {
		res := h.doUA(t, "Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile", http.MethodPost, "/v1/auth/refresh", "",
			map[string]any{"refreshToken": mustString(t, phone.Body, "refreshToken")})
		if res.Status != http.StatusOK {
			t.Fatalf("refresh: %d %s", res.Status, res.Raw)
		}
		if sidOf(t, mustString(t, res.Body, "accessToken")) != phoneSID {
			t.Fatalf("a refresh changed the session id")
		}
		phone = res
		after := sessionItems(t, h.do(t, http.MethodGet, "/v1/me/sessions", deskToken, nil))
		if len(after) != len(items) {
			t.Fatalf("a refresh changed the number of sessions: %d -> %d", len(items), len(after))
		}
		p := after[phoneSID]
		if p["method"] != "password" || !strings.Contains(p["userAgent"].(string), "Android 15") {
			t.Fatalf("refreshed phone session: %v", p)
		}
	})

	t.Run("another member sees none of them and closes none", func(t *testing.T) {
		mine := sessionItems(t, h.do(t, http.MethodGet, "/v1/me/sessions", f.AdminToken, nil))
		if mine[phoneSID] != nil || mine[deskSID] != nil {
			t.Fatalf("the owner's sessions leaked to the admin")
		}
		h.mustDo(t, http.MethodDelete, "/v1/me/sessions/"+phoneSID, f.AdminToken, nil, http.StatusNotFound)
	})

	t.Run("closing one stops its refresh token", func(t *testing.T) {
		h.mustDo(t, http.MethodDelete, "/v1/me/sessions/"+phoneSID, deskToken, nil, http.StatusNoContent)
		h.mustDo(t, http.MethodDelete, "/v1/me/sessions/"+phoneSID, deskToken, nil, http.StatusNotFound)
		h.mustDo(t, http.MethodDelete, "/v1/me/sessions/not-a-uuid", deskToken, nil, http.StatusNotFound)
		res := h.do(t, http.MethodPost, "/v1/auth/refresh", "",
			map[string]any{"refreshToken": mustString(t, phone.Body, "refreshToken")})
		if res.Status != http.StatusUnauthorized {
			t.Fatalf("a closed session refreshed: %d %s", res.Status, res.Raw)
		}
		if sessionItems(t, h.do(t, http.MethodGet, "/v1/me/sessions", deskToken, nil))[phoneSID] != nil {
			t.Fatalf("a closed session is still listed")
		}
	})

	t.Run("closing every other keeps this one and the assistant", func(t *testing.T) {
		tok := h.oauthGrant(t, f, "ChatGPT")
		listed := sessionItems(t, h.do(t, http.MethodGet, "/v1/me/sessions", deskToken, nil))
		for _, it := range listed {
			if it["method"] == "oauth" {
				t.Fatalf("an assistant's connection was listed as a session: %v", it)
			}
		}

		res := h.mustDo(t, http.MethodPost, "/v1/me/sessions/close-others", deskToken, nil, http.StatusOK)
		if n, _ := res.Body["closed"].(float64); n < 1 {
			t.Fatalf("closed nothing: %s", res.Raw)
		}
		left := sessionItems(t, h.do(t, http.MethodGet, "/v1/me/sessions", deskToken, nil))
		if len(left) != 1 || left[deskSID] == nil {
			t.Fatalf("want only this session left, got %v", left)
		}
		if res := h.do(t, http.MethodPost, "/v1/auth/refresh", "",
			map[string]any{"refreshToken": mustString(t, desk.Body, "refreshToken")}); res.Status != http.StatusOK {
			t.Fatalf("this session stopped working: %d %s", res.Status, res.Raw)
		}
		rec := h.oauthPost(t, "/oauth/token", url.Values{
			"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)},
			"client_id": {tok["client_id"].(string)},
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("closing the other sessions disconnected the assistant: %d %s", rec.Code, rec.Body.String())
		}
		var method string
		if err := h.admin.QueryRow(t.Context(), `
			SELECT sign_in_method FROM refresh_tokens WHERE oauth_client_id = $1 LIMIT 1`,
			tok["client_id"]).Scan(&method); err != nil || method != "oauth" {
			t.Fatalf("assistant family method: %q %v", method, err)
		}
	})

	t.Run("a token from before sid cannot close the others", func(t *testing.T) {
		legacy, err := auth.NewSigner([]byte("test-signing-key"), "bascula").
			Issue(f.OwnerUserID, f.FarmID, "owner", "", false)
		if err != nil {
			t.Fatal(err)
		}
		res := h.do(t, http.MethodPost, "/v1/me/sessions/close-others", legacy, nil)
		if res.Status != http.StatusUnauthorized || res.code() != "TOKEN_EXPIRED" {
			t.Fatalf("legacy close-others: %d %s", res.Status, res.Raw)
		}
		for _, it := range sessionItems(t, h.do(t, http.MethodGet, "/v1/me/sessions", legacy, nil)) {
			if it["current"] == true {
				t.Fatalf("a token without sid was matched to a session")
			}
		}
	})
}

// TestPasskeySessionSaysPasskey: a passkey sign-in is recorded as one.
func TestPasskeySessionSaysPasskey(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca Sesion con Llave", 80000)
	key := newSoftPasskey(t)
	h.registerPasskey(t, f.OwnerToken, key)
	opts := h.passkeyOptions(t, "10.7.1.1")
	res := h.doOrigin(t, "10.7.1.1", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", map[string]any{
		"challenge": opts["challenge"], "credential": key.get(t, opts, passkeyOrigin),
	})
	if res.Status != http.StatusOK {
		t.Fatalf("passkey sign-in: %d %s", res.Status, res.Raw)
	}
	token := mustString(t, res.Body, "accessToken")
	items := sessionItems(t, h.do(t, http.MethodGet, "/v1/me/sessions", token, nil))
	s := items[sidOf(t, token)]
	if s == nil || s["method"] != "passkey" || s["current"] != true {
		t.Fatalf("passkey session: %v", s)
	}
}
