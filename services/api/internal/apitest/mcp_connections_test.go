package apitest

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// oauthGrant runs the connector's OAuth dance for the farm's owner and returns
// the token response (access_token, refresh_token).
func (h *harness) oauthGrant(t *testing.T, f *farmFixture, clientName string) map[string]any {
	t.Helper()
	redirect := "https://chatgpt.com/connector_platform_oauth_redirect"
	reg := h.mustDo(t, http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name": clientName, "redirect_uris": []string{redirect},
	}, http.StatusCreated)
	clientID := reg.Body["client_id"].(string)
	verifier := pkceVerifier(t)
	sum := sha256.Sum256([]byte(verifier))
	rec := h.oauthPost(t, "/oauth/authorize", url.Values{
		"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"email": {f.OwnerEmail}, "password": {"una-clave-larga-1"},
	})
	if rec.Code != http.StatusFound {
		t.Fatalf("authorize: %d %s", rec.Code, rec.Body.String())
	}
	loc, _ := rec.Result().Location()
	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"authorization_code"}, "code": {loc.Query().Get("code")},
		"redirect_uri": {redirect}, "client_id": {clientID}, "code_verifier": {verifier},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("token: %d %s", rec.Code, rec.Body.String())
	}
	var tok map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &tok)
	tok["client_id"] = clientID
	return tok
}

func connectionItems(t *testing.T, res response) []map[string]any {
	t.Helper()
	raw, _ := res.Body["items"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, it := range raw {
		out = append(out, it.(map[string]any))
	}
	return out
}

// TestMCPConnectionsListAndRevoke: «Conectar con ChatGPT» in Configuración
// shows «Conectado ✓» when the caller has a live OAuth grant on this farm, and
// «Revocar conexión» kills it server-side. A web login is not a connection,
// and one member never sees or closes another's.
func TestMCPConnectionsListAndRevoke(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca Conexiones MCP", 250000)

	// Before any grant: nothing, even though the owner is logged in on the web.
	res := h.mustDo(t, http.MethodGet, "/v1/mcp/connections", f.OwnerToken, nil, http.StatusOK)
	if items := connectionItems(t, res); len(items) != 0 {
		t.Fatalf("a web login was listed as an MCP connection: %s", res.Raw)
	}
	if ep, _ := res.Body["endpoint"].(string); !strings.HasSuffix(ep, "/mcp") {
		t.Fatalf("endpoint should be the /mcp URL: %s", res.Raw)
	}

	tok := h.oauthGrant(t, f, "ChatGPT")
	refresh := tok["refresh_token"].(string)

	// Rotation keeps it ONE connection, still tagged.
	rec := h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {refresh},
		"client_id": {tok["client_id"].(string)},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh: %d %s", rec.Code, rec.Body.String())
	}
	var next map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &next)
	refresh = next["refresh_token"].(string)

	res = h.mustDo(t, http.MethodGet, "/v1/mcp/connections", f.OwnerToken, nil, http.StatusOK)
	items := connectionItems(t, res)
	if len(items) != 1 {
		t.Fatalf("want one connection after grant+refresh, got %s", res.Raw)
	}
	c := items[0]
	if c["clientName"] != "ChatGPT" || c["status"] != "active" || c["createdAt"] == nil {
		t.Fatalf("unexpected connection: %s", res.Raw)
	}
	id := c["id"].(string)

	// The admin of the same farm has none: they are the owner's.
	res = h.mustDo(t, http.MethodGet, "/v1/mcp/connections", f.AdminToken, nil, http.StatusOK)
	if len(connectionItems(t, res)) != 0 {
		t.Fatalf("another member's connection leaked: %s", res.Raw)
	}
	h.mustDo(t, http.MethodDelete, "/v1/mcp/connections/"+id, f.AdminToken, nil, http.StatusNotFound)

	// Revoke: gone from the list, and the refresh token no longer works.
	h.mustDo(t, http.MethodDelete, "/v1/mcp/connections/"+id, f.OwnerToken, nil, http.StatusNoContent)
	res = h.mustDo(t, http.MethodGet, "/v1/mcp/connections", f.OwnerToken, nil, http.StatusOK)
	if len(connectionItems(t, res)) != 0 {
		t.Fatalf("revoked connection still listed: %s", res.Raw)
	}
	rec = h.oauthPost(t, "/oauth/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {refresh},
		"client_id": {tok["client_id"].(string)},
	})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_grant") {
		t.Fatalf("a revoked connection could still refresh: %d %s", rec.Code, rec.Body.String())
	}

	// The owner's web session survived: revoking a connection is not a logout.
	h.mustDo(t, http.MethodGet, "/v1/me", f.OwnerToken, nil, http.StatusOK)

	// A random id is a 404, not a 500.
	h.mustDo(t, http.MethodDelete, "/v1/mcp/connections/00000000-0000-0000-0000-000000000000",
		f.OwnerToken, nil, http.StatusNotFound)
}
