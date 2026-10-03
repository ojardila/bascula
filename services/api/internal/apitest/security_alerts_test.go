// SPDX-License-Identifier: MIT

package apitest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ojardila/bascula/services/api/internal/httpapi"
	"github.com/ojardila/bascula/services/api/internal/secalert"
)

// TestTwoHundredPasswordsReplayPagesTheOperatorOnce is the tabletop of issue
// #312 against the docs/audits.md exercise: ~200 wrong passwords at one
// address from one IP. The limiter refuses them (that part is
// login_limits_test.go); what this adds is that exactly one email reaches the
// operator, naming the IP, and that the evidence is in login_failures.
func TestTwoHundredPasswordsReplayPagesTheOperatorOnce(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la alarma", 100000)
	const ip = "10.31.2.1"

	mail := &recordingMailer{}
	srv := h.serverWithConfig(t, func(cfg *httpapi.Config) {
		cfg.Alerts = secalert.New(secalert.Config{
			To: "ops@example.com", Stack: "apitest", Sender: mail,
		})
	})

	refused := 0
	for i := 0; i < 200; i++ {
		raw, _ := json.Marshal(map[string]any{"email": f.OwnerEmail, "password": wrongPassword()})
		req := httptest.NewRequest(http.MethodPost, "/v1/auth/login", strings.NewReader(string(raw)))
		req.RemoteAddr = ip + ":40000"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		if rec.Code == http.StatusUnauthorized || rec.Code == http.StatusTooManyRequests {
			refused++
		}
	}
	if refused != 200 {
		t.Fatalf("refused %d of 200", refused)
	}

	waitForMail(t, mail, 1)
	time.Sleep(100 * time.Millisecond) // a second email would be on its way by now
	if n := mail.count(); n != 1 {
		t.Fatalf("want exactly 1 page for the whole burst, got %d", n)
	}
	m := mail.sent[0]
	if m.To != "ops@example.com" || !strings.Contains(m.Subject, "login_refusals") ||
		!strings.Contains(m.Subject, ip) {
		t.Fatalf("unexpected page: %+v", m)
	}

	var rows int
	if err := h.admin.QueryRow(context.Background(),
		`SELECT count(*) FROM login_failures WHERE ip = $1::inet`, ip).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows == 0 {
		t.Fatal("the burst left no row in login_failures")
	}
}

// TestNoAlerterNoPage: the default configuration has none, and a burst is
// refused exactly as before with nothing sent.
func TestNoAlerterNoPage(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca sin alarma", 100000)
	mail := &recordingMailer{}
	srv := h.serverWithConfig(t, func(cfg *httpapi.Config) { cfg.Mailer = mail })
	for i := 0; i < 40; i++ {
		raw, _ := json.Marshal(map[string]any{"email": f.OwnerEmail, "password": wrongPassword()})
		req := httptest.NewRequest(http.MethodPost, "/v1/auth/login", strings.NewReader(string(raw)))
		req.RemoteAddr = "10.31.2.2:40000"
		req.Header.Set("Content-Type", "application/json")
		srv.ServeHTTP(httptest.NewRecorder(), req)
	}
	time.Sleep(100 * time.Millisecond)
	if mail.count() != 0 {
		t.Fatalf("no alerter configured, yet %d emails", mail.count())
	}
}
