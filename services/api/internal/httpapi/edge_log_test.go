package httpapi

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestConnectorTrafficLogNamesStepsNotSecrets(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	defer slog.SetDefault(prev)

	var gotBody string
	h := logConnectorTraffic(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/mcp" {
			b, _ := io.ReadAll(r.Body)
			gotBody = string(b)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = r.ParseForm()
		http.Redirect(w, r, "https://chatgpt.com/connector/oauth/abc?code=SECRETCODE&state=s", http.StatusFound)
	}))

	body := `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"cursor":"x"}}`
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer SECRETTOKEN")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if gotBody != body {
		t.Fatalf("the handler must still get the whole body, got %q", gotBody)
	}

	form := url.Values{"client_id": {"cid1"}, "redirect_uri": {"https://chatgpt.com/connector/oauth/abc"},
		"password": {"SECRETPASSWORD"}, "email": {"a@b.c"}, "code_challenge": {"SECRETCHALLENGE"}, "code_challenge_method": {"S256"}}
	req = httptest.NewRequest(http.MethodPost, "/oauth/authorize", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	h.ServeHTTP(httptest.NewRecorder(), req)

	req = httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	h.ServeHTTP(httptest.NewRecorder(), req)

	out := buf.String()
	for _, want := range []string{`"rpc":"tools/list"`, `"status":401`, `"bearer":true`, `"client_id":"cid1"`,
		`"redirect_has_code":true`, `"redirect_to":"https://chatgpt.com/connector/oauth/abc"`, `"pkce":"S256"`} {
		if !strings.Contains(out, want) {
			t.Errorf("log lacks %s:\n%s", want, out)
		}
	}
	for _, secret := range []string{"SECRET", "a@b.c"} {
		if strings.Contains(out, secret) {
			t.Errorf("log leaks %s:\n%s", secret, out)
		}
	}
	if strings.Contains(out, "/v1/me") {
		t.Errorf("only connector surfaces are logged:\n%s", out)
	}
}
