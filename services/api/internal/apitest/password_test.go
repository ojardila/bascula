package apitest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

const newSecret = "otra-clave-larga-2"

// mailServer is the shared harness's server plus a mailer and a public
// address: the two things "olvidé mi clave" needs. Same database, same signing
// key, so fixtures made through h.server work against it.
func mailServer(t *testing.T, h *harness) (http.Handler, *recordingMailer) {
	t.Helper()
	uploads, _ := os.MkdirTemp("", "bascula-pw-uploads-")
	t.Cleanup(func() { _ = os.RemoveAll(uploads) })
	mail := &recordingMailer{}
	cfg := httpapi.DefaultConfig()
	cfg.DevEcho = true
	cfg.UploadDir = uploads
	cfg.Mailer = mail
	cfg.PublicBaseURL = "https://bascula.example.com"
	return httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg), mail
}

// waitForMail: notices go out after the response, in their own goroutine.
func waitForMail(t *testing.T, mail *recordingMailer, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for mail.count() < n {
		if time.Now().After(deadline) {
			t.Fatalf("waited for %d emails, got %d", n, mail.count())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func callFrom(t *testing.T, srv http.Handler, host, method, path, token string, body any) response {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
	req.RemoteAddr = "10.0.7.1:12345"
	req.Host = host
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	out := response{Status: rec.Code, Raw: rec.Body.String()}
	if out.Raw != "" {
		_ = json.Unmarshal([]byte(out.Raw), &out.Body)
	}
	return out
}

// TestChangePasswordNeedsTheCurrentOneAndClosesOtherSessions is issue #145:
// a signed-in person changes their own password. The wrong current password
// is refused, the right one works, the old password stops working, a session
// opened before the change is closed, and the device that made the change
// gets a session of its own back.
func TestChangePasswordNeedsTheCurrentOneAndClosesOtherSessions(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca Clave", 90000)
	other := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": f.OwnerEmail, "password": f.loginSecret(),
	}, http.StatusOK)

	wrong := h.doFrom(t, "10.0.7.2", http.MethodPost, "/v1/me/password", f.OwnerToken, map[string]any{
		"currentPassword": "no-es-la-clave", "newPassword": newSecret,
	})
	if wrong.Status != http.StatusForbidden || wrong.code() != "INVALID_CREDENTIALS" {
		t.Fatalf("wrong current password: %d %s", wrong.Status, wrong.Raw)
	}
	short := h.do(t, http.MethodPost, "/v1/me/password", f.OwnerToken, map[string]any{
		"currentPassword": f.loginSecret(), "newPassword": "corta",
	})
	if short.Status != http.StatusBadRequest {
		t.Fatalf("short new password: %d %s", short.Status, short.Raw)
	}

	ok := h.mustDo(t, http.MethodPost, "/v1/me/password", f.OwnerToken, map[string]any{
		"currentPassword": f.loginSecret(), "newPassword": newSecret,
	}, http.StatusOK)
	fresh := mustString(t, ok.Body, "accessToken")
	refresh := mustString(t, ok.Body, "refreshToken")

	old := h.do(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": f.OwnerEmail, "password": f.loginSecret(),
	})
	if old.Status != http.StatusUnauthorized {
		t.Fatalf("the old password still works: %d %s", old.Status, old.Raw)
	}
	h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": f.OwnerEmail, "password": newSecret,
	}, http.StatusOK)

	stale := h.do(t, http.MethodPost, "/v1/auth/refresh", "", map[string]any{
		"refreshToken": mustString(t, other.Body, "refreshToken"),
	})
	if stale.Status != http.StatusUnauthorized {
		t.Fatalf("a session from before the change still refreshes: %d %s", stale.Status, stale.Raw)
	}
	h.mustDo(t, http.MethodPost, "/v1/auth/refresh", "", map[string]any{"refreshToken": refresh}, http.StatusOK)
	h.mustDo(t, http.MethodGet, "/v1/me", fresh, nil, http.StatusOK)
}

// TestChangePasswordSharesTheLoginLimit: a session left open is not a place
// to guess the password at full speed.
func TestChangePasswordSharesTheLoginLimit(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca Limite Clave", 90000)
	ip := "10.0.7.3"
	for i := 0; i < h.loginFailuresPerPair; i++ {
		res := h.doFrom(t, ip, http.MethodPost, "/v1/me/password", f.WeigherToken, map[string]any{
			"currentPassword": "adivinando-" + string(rune('a'+i)), "newPassword": newSecret,
		})
		if res.Status != http.StatusForbidden {
			t.Fatalf("guess %d: %d %s", i, res.Status, res.Raw)
		}
	}
	res := h.doFrom(t, ip, http.MethodPost, "/v1/me/password", f.WeigherToken, map[string]any{
		"currentPassword": "una-mas-de-la-cuenta", "newPassword": newSecret,
	})
	if res.Status != http.StatusTooManyRequests {
		t.Fatalf("past the limit: %d %s", res.Status, res.Raw)
	}
}

// TestPasswordResetIsNotOfferedWithoutAMailer: the shared harness has none.
func TestPasswordResetIsNotOfferedWithoutAMailer(t *testing.T) {
	h := requireDB(t)
	info := h.mustDo(t, http.MethodGet, "/v1/auth/password-reset", "", nil, http.StatusOK)
	if info.Body["available"] != false {
		t.Fatalf("available without a mailer: %s", info.Raw)
	}
	res := h.do(t, http.MethodPost, "/v1/auth/password-reset/request", "", map[string]any{"email": "a@example.com"})
	if res.Status != http.StatusNotFound {
		t.Fatalf("request without a mailer: %d %s", res.Status, res.Raw)
	}
}

// TestPasswordResetByEmail walks the whole door: ask, the email carries a
// link on this deployment's address, spending it sets the password, closes
// the sessions, and the link does not work twice.
func TestPasswordResetByEmail(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca Olvido", 90000)
	srv, mail := mailServer(t, h)

	info := call(t, srv, http.MethodGet, "/v1/auth/password-reset", "", nil)
	if info.Body["available"] != true {
		t.Fatalf("not available with a mailer: %s", info.Raw)
	}

	// An address with no account looks exactly the same and mails nothing.
	nobody := call(t, srv, http.MethodPost, "/v1/auth/password-reset/request", "",
		map[string]any{"email": "nadie-" + f.FarmID[:8] + "@example.com"})
	if nobody.Status != http.StatusAccepted || nobody.Body["resetToken"] != nil {
		t.Fatalf("unknown address: %d %s", nobody.Status, nobody.Raw)
	}

	// The first link is spent by the second request.
	first := call(t, srv, http.MethodPost, "/v1/auth/password-reset/request", "",
		map[string]any{"email": strings.ToUpper(f.OwnerEmail)})
	firstToken := mustString(t, first.Body, "resetToken")
	asked := call(t, srv, http.MethodPost, "/v1/auth/password-reset/request", "",
		map[string]any{"email": f.OwnerEmail})
	if asked.Status != http.StatusAccepted {
		t.Fatalf("request: %d %s", asked.Status, asked.Raw)
	}
	token := mustString(t, asked.Body, "resetToken")
	waitForMail(t, mail, 2)
	mail.mu.Lock()
	msg := mail.sent[len(mail.sent)-1]
	mail.mu.Unlock()
	if msg.To != f.OwnerEmail || !strings.Contains(msg.Body, "https://bascula.example.com/restablecer-clave#"+token) {
		t.Fatalf("reset email: to=%s body=%s", msg.To, msg.Body)
	}

	session := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": f.OwnerEmail, "password": f.loginSecret(),
	}, http.StatusOK)

	spent := call(t, srv, http.MethodPost, "/v1/auth/password-reset", "",
		map[string]any{"token": firstToken, "password": newSecret})
	if spent.Status != http.StatusBadRequest {
		t.Fatalf("an older link still works: %d %s", spent.Status, spent.Raw)
	}
	res := call(t, srv, http.MethodPost, "/v1/auth/password-reset", "",
		map[string]any{"token": token, "password": newSecret})
	if res.Status != http.StatusNoContent {
		t.Fatalf("reset: %d %s", res.Status, res.Raw)
	}
	again := call(t, srv, http.MethodPost, "/v1/auth/password-reset", "",
		map[string]any{"token": token, "password": "una-tercera-clave"})
	if again.Status != http.StatusBadRequest {
		t.Fatalf("the link worked twice: %d %s", again.Status, again.Raw)
	}

	h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": f.OwnerEmail, "password": newSecret,
	}, http.StatusOK)
	stale := h.do(t, http.MethodPost, "/v1/auth/refresh", "", map[string]any{
		"refreshToken": mustString(t, session.Body, "refreshToken"),
	})
	if stale.Status != http.StatusUnauthorized {
		t.Fatalf("a session from before the reset still refreshes: %d %s", stale.Status, stale.Raw)
	}
	waitForMail(t, mail, 3)
}

// TestPasswordResetLinkIgnoresAForeignHost: the link is built from
// PUBLIC_BASE_URL, or from the request's host only when that host is this
// deployment's own. A caller who sets Host: evil.example cannot get the
// owner's link addressed to their site.
func TestPasswordResetLinkIgnoresAForeignHost(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca Host", 90000)
	srv, mail := mailServer(t, h)

	evil := callFrom(t, srv, "evil.example", http.MethodPost, "/v1/auth/password-reset/request", "",
		map[string]any{"email": f.OwnerEmail})
	if evil.Status != http.StatusAccepted {
		t.Fatalf("request: %d %s", evil.Status, evil.Raw)
	}
	farm := callFrom(t, srv, "la-finca.bascula.example.com", http.MethodPost,
		"/v1/auth/password-reset/request", "", map[string]any{"email": f.OwnerEmail})
	if farm.Status != http.StatusAccepted {
		t.Fatalf("request: %d %s", farm.Status, farm.Raw)
	}
	waitForMail(t, mail, 2)
	mail.mu.Lock()
	defer mail.mu.Unlock()
	var bodies string
	for _, m := range mail.sent {
		bodies += m.Body
	}
	if strings.Contains(bodies, "evil.example") {
		t.Fatalf("a link went to a foreign host: %s", bodies)
	}
	if !strings.Contains(bodies, "https://bascula.example.com/restablecer-clave#") ||
		!strings.Contains(bodies, "https://la-finca.bascula.example.com/restablecer-clave#") {
		t.Fatalf("links: %s", bodies)
	}
}

// TestRaisingSomebodyToAdminTellsTheOtherOwners: a new administrator sees the
// payroll and can add people, so the farm's other owners hear about it.
func TestRaisingSomebodyToAdminTellsTheOtherOwners(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca Aviso", 90000)
	srv, mail := mailServer(t, h)

	// A second owner, who did not make the change and is the one to tell.
	coOwner, _ := h.addUserWithID(t, f.FarmID, "weigher")
	if _, err := h.admin.Exec(context.Background(),
		`UPDATE memberships SET role = 'owner' WHERE farm_id = $1 AND user_id = $2`, f.FarmID, coOwner); err != nil {
		t.Fatalf("co-owner: %v", err)
	}
	var coOwnerEmail string
	if err := h.admin.QueryRow(context.Background(),
		`SELECT email FROM users WHERE id = $1`, coOwner).Scan(&coOwnerEmail); err != nil {
		t.Fatalf("co-owner email: %v", err)
	}

	res := call(t, srv, http.MethodPatch, "/v1/users/"+f.WeigherID, f.OwnerToken, map[string]any{"role": "admin"})
	if res.Status != http.StatusOK {
		t.Fatalf("raise: %d %s", res.Status, res.Raw)
	}
	waitForMail(t, mail, 1)
	time.Sleep(100 * time.Millisecond)
	mail.mu.Lock()
	defer mail.mu.Unlock()
	if len(mail.sent) != 1 || mail.sent[0].To != coOwnerEmail ||
		!strings.Contains(mail.sent[0].Body, "administrador de la finca Finca Aviso") {
		t.Fatalf("notices: %+v", mail.sent)
	}
}
