package apitest

import (
	"net/http"
	"testing"
)

// TestOAuthRegisterAcceptsFullRFC7591Metadata: ChatGPT registers its
// connector with the whole RFC 7591 client metadata, not just client_name and
// redirect_uris. A server must ignore the fields it does not use; rejecting
// them (a strict decoder did) left «Conectar con ChatGPT» dead at the first
// step, before the sign-in page.
func TestOAuthRegisterAcceptsFullRFC7591Metadata(t *testing.T) {
	h := requireDB(t)
	for _, redirect := range []string{
		"https://chatgpt.com/connector_platform_oauth_redirect",
		"https://chat.openai.com/connector_platform_oauth_redirect",
	} {
		reg := h.mustDo(t, http.MethodPost, "/oauth/register", "", map[string]any{
			"client_name":                "ChatGPT",
			"redirect_uris":              []string{redirect},
			"grant_types":                []string{"authorization_code", "refresh_token"},
			"response_types":             []string{"code"},
			"token_endpoint_auth_method": "none",
			"scope":                      "mcp",
			"application_type":           "web",
			"logo_uri":                   "https://chatgpt.com/favicon.ico",
		}, http.StatusCreated)
		if id, _ := reg.Body["client_id"].(string); id == "" {
			t.Fatalf("%s: no client_id: %s", redirect, reg.Raw)
		}
	}

	// A bad redirect is still refused, in the RFC 7591 error shape.
	bad := h.mustDo(t, http.MethodPost, "/oauth/register", "", map[string]any{
		"client_name":   "x",
		"redirect_uris": []string{"http://evil.example/cb"},
		"grant_types":   []string{"authorization_code"},
	}, http.StatusBadRequest)
	if bad.Body["error"] != "invalid_redirect_uri" {
		t.Fatalf("want invalid_redirect_uri, got %s", bad.Raw)
	}
}
