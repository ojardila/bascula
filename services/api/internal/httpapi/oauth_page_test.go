package httpapi

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/ojardila/bascula/services/api/internal/store"
)

const xssProbe = `"><script>alert(1)</script>`

func renderOAuthPage(t *testing.T, q url.Values, notice string, pick *oauthPick, client *store.OAuthClient) string {
	t.Helper()
	s := &Server{}
	r := httptest.NewRequest("GET", "/oauth/authorize?"+q.Encode(), nil)
	w := httptest.NewRecorder()
	s.oauthForm(w, r, q, notice, pick, client)
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Fatalf("content type %q", ct)
	}
	return w.Body.String()
}

func TestOAuthPageEscapesEveryRequestValue(t *testing.T) {
	q := url.Values{}
	for _, k := range []string{"client_id", "redirect_uri", "state", "code_challenge",
		"code_challenge_method", "resource", "scope", "response_type", "email"} {
		q.Set(k, xssProbe)
	}
	q.Set("access", "read")
	client := &store.OAuthClient{Name: xssProbe}
	body := renderOAuthPage(t, q, xssProbe, nil, client)
	if strings.Contains(body, "<script>alert") {
		t.Fatalf("unescaped value on the sign-in page:\n%s", body)
	}
	if got := strings.Count(body, "<script"); got != 1 {
		t.Fatalf("want only the passkey script, got %d script tags", got)
	}
	for _, want := range []string{
		`name="client_id" value="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"`,
		`<p class="err">&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>`,
		`value="read" checked>`,
		`id="passkey"`,
		oauthPasskeyScript,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("page lacks %q:\n%s", want, body)
		}
	}
	// The access choice is the form's own radio, not a hidden copy.
	if strings.Contains(body, `name="access" value="read"`) && strings.Contains(body, `type="hidden" name="access"`) {
		t.Error("hidden access field on the sign-in form")
	}
}

func TestOAuthPageFarmPickEscapes(t *testing.T) {
	q := url.Values{"client_id": {"c1"}, "access": {"write"}}
	pick := &oauthPick{Ticket: xssProbe, Farms: []store.Membership{
		{FarmID: xssProbe, FarmName: xssProbe, FarmSlug: xssProbe},
		{FarmID: "f2", FarmSlug: "dos"},
	}}
	body := renderOAuthPage(t, q, "", pick, nil)
	if strings.Contains(body, "<script") {
		t.Fatalf("script on the farm pick:\n%s", body)
	}
	for _, want := range []string{
		`<input type="hidden" name="client_id" value="c1"><input type="hidden" name="access" value="write">`,
		`name="ticket" value="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"`,
		`value="f2"><span>dos<span class="slug">dos.bascula.engp.io</span>`,
		` checked><span>&#34;&gt;&lt;script&gt;`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("page lacks %q:\n%s", want, body)
		}
	}
}
