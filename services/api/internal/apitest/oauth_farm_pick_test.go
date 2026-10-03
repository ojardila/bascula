package apitest

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
)

// ofpWith copies base and sets each key/value pair in kv on the copy.
func ofpWith(base url.Values, kv ...string) url.Values {
	v := url.Values{}
	for k, vs := range base {
		v[k] = vs
	}
	for i := 0; i+1 < len(kv); i += 2 {
		v.Set(kv[i], kv[i+1])
	}
	return v
}

// ofpPostAuthorize posts form to /oauth/authorize, on host when it is set.
func ofpPostAuthorize(h *harness, host string, form url.Values) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/oauth/authorize", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = "10.0.0.1:12345"
	if host != "" {
		req.Host = host
	}
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	return rec
}

// ofpPickListTicket checks the farm pick step that follows the password on
// the main host — both farms offered as radio buttons, no UUID prompt, no
// password carried — and returns its ticket.
func ofpPickListTicket(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	body := rec.Body.String()
	if rec.Code != http.StatusOK || !strings.Contains(body, "Finca Uno Selector") ||
		!strings.Contains(body, "Finca Dos Selector") || !strings.Contains(body, `type="radio"`) {
		t.Fatalf("no farm list after the password: %d %s", rec.Code, body)
	}
	if strings.Contains(body, "UUID") || strings.Contains(body, "una-clave-larga-1") {
		t.Fatalf("pick step shows a UUID prompt or carries the password: %s", body)
	}
	m := regexp.MustCompile(`name="ticket" value="([^"]+)"`).FindStringSubmatch(body)
	if m == nil {
		t.Fatalf("pick step has no ticket: %s", body)
	}
	return m[1]
}

// TestOAuthSignInNeverAsksForAFarmUUID: the connector sign-in page used to
// have a «Finca (UUID, si tiene más de una)» box. On a farm host the farm is
// the host's; on the main host an account with several farms picks one by
// name in a second step, after the password.
func TestOAuthSignInNeverAsksForAFarmUUID(t *testing.T) {
	h := requireDB(t)
	ctx := context.Background()
	f1 := h.signupFarm(t, "Finca Uno Selector", 250000)
	f2 := h.signupFarm(t, "Finca Dos Selector", 250000)
	if _, err := h.admin.Exec(ctx,
		`INSERT INTO memberships (farm_id, user_id, role) VALUES ($1, $2, 'admin')`,
		f2.FarmID, f1.OwnerUserID); err != nil {
		t.Fatalf("second membership: %v", err)
	}
	var slug2 string
	if err := h.admin.QueryRow(ctx, `SELECT slug FROM farms WHERE id = $1`, f2.FarmID).Scan(&slug2); err != nil || slug2 == "" {
		t.Fatalf("slug of farm 2: %v %q", err, slug2)
	}

	redirect := "https://chatgpt.com/connector_platform_oauth_redirect"
	reg := h.mustDo(t, http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name": "ChatGPT", "redirect_uris": []string{redirect},
	}, http.StatusCreated)
	clientID := reg.Body["client_id"].(string)
	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	base := url.Values{
		"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"state": {"s1"}, "scope": {"mcp offline_access"},
	}
	with := func(kv ...string) url.Values {
		return ofpWith(base, kv...)
	}
	post := func(host string, form url.Values) *httptest.ResponseRecorder {
		return ofpPostAuthorize(h, host, form)
	}

	// The first page has no farm box, on any host.
	get := httptest.NewRequest(http.MethodGet, "/oauth/authorize?"+base.Encode(), nil)
	get.RemoteAddr = "10.0.0.1:12345"
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, get)
	if body := rec.Body.String(); strings.Contains(body, "UUID") || strings.Contains(body, `name="farm_id"`) {
		t.Fatalf("sign-in page still asks for a farm: %s", body)
	}

	// Main host, two farms: the password step answers with a pick list.
	rec = post("", with("email", f1.OwnerEmail, "password", "una-clave-larga-1"))
	ticket := ofpPickListTicket(t, rec)

	// A forged ticket is refused.
	if rec := post("", with("ticket", ticket+"x", "farm_id", f2.FarmID)); rec.Code != http.StatusOK ||
		!strings.Contains(rec.Body.String(), "Entre de nuevo") {
		t.Fatalf("forged ticket: %d %s", rec.Code, rec.Body.String())
	}
	// A farm the account does not belong to is refused.
	other := h.signupFarm(t, "Finca Ajena Selector", 250000)
	if rec := post("", with("ticket", ticket, "farm_id", other.FarmID)); rec.Code != http.StatusOK {
		t.Fatalf("foreign farm: %d %s", rec.Code, rec.Body.String())
	}

	// Picking farm 2 finishes the sign-in, with the code for farm 2.
	rec = post("", with("ticket", ticket, "farm_id", f2.FarmID))
	if rec.Code != http.StatusFound {
		t.Fatalf("pick: %d %s", rec.Code, rec.Body.String())
	}
	loc, _ := rec.Result().Location()
	if loc.Query().Get("code") == "" {
		t.Fatalf("no code after picking: %s", loc)
	}
	tok := h.oauthPost(t, "/oauth/token", url.Values{"grant_type": {"authorization_code"},
		"code": {loc.Query().Get("code")}, "redirect_uri": {redirect}, "client_id": {clientID},
		"code_verifier": {verifier}})
	if tok.Code != http.StatusOK {
		t.Fatalf("token: %d %s", tok.Code, tok.Body.String())
	}

	// Farm host: the host names the farm, no second step.
	rec = post(slug2+".bascula.engp.io", with("email", f1.OwnerEmail, "password", "una-clave-larga-1"))
	if rec.Code != http.StatusFound {
		t.Fatalf("farm host sign-in: %d %s", rec.Code, rec.Body.String())
	}
}
