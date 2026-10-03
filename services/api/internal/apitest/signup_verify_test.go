package apitest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// signupOn registers a farm on srv from its own client address, so the
// per-IP signup cap of one test does not leak into another.
func signupOn(t *testing.T, srv http.Handler, ip, email, password, farm string) response {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{
		"farm":  map[string]any{"name": farm, "timezone": "America/Bogota", "currency": "COP", "priceCents": 90000},
		"owner": map[string]any{"email": email, "name": "Dueña", "password": password},
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/signup", strings.NewReader(string(raw)))
	req.RemoteAddr = ip + ":1"
	req.Host = "bascula.example.com"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	out := response{Status: rec.Code, Raw: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &out.Body)
	return out
}

func lastMail(t *testing.T, mail *recordingMailer, n int) string {
	t.Helper()
	waitForMail(t, mail, n)
	mail.mu.Lock()
	defer mail.mu.Unlock()
	return mail.sent[n-1].Body
}

func linkToken(t *testing.T, body string) string {
	t.Helper()
	i := strings.Index(body, "/confirmar-correo#")
	if i < 0 {
		t.Fatalf("no confirmation link in: %s", body)
	}
	return strings.Fields(body[i+len("/confirmar-correo#"):])[0]
}

func provisionStatusOf(t *testing.T, srv http.Handler, slug, ticket string) response {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/farms/"+slug+"/provision-status", nil)
	req.Header.Set("X-Provision-Ticket", ticket)
	req.RemoteAddr = "10.0.9.9:1"
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return response{Status: rec.Code, Raw: rec.Body.String()}
}

// TestSignupWaitsForTheMailedLink: with a mailer, signup proves the address
// before anything opens or is built for it.
func TestSignupWaitsForTheMailedLink(t *testing.T) {
	h := requireDB(t)
	srv, mail := mailServer(t, h)
	email := "verifica-" + uuid.NewString()[:8] + "@example.com"
	const password = "clave-de-la-duena-1"

	res := signupOn(t, srv, "10.0.9.1", email, password, "Finca por confirmar")
	if res.Status != http.StatusCreated || res.Body["verificationRequired"] != true {
		t.Fatalf("signup: %d %s", res.Status, res.Raw)
	}
	token := linkToken(t, lastMail(t, mail, 1))

	if r := callFrom(t, srv, "bascula.example.com", http.MethodPost, "/v1/auth/login", "",
		map[string]any{"email": email, "password": password}); r.Status != http.StatusForbidden ||
		!strings.Contains(r.Raw, "EMAIL_NOT_VERIFIED") {
		t.Fatalf("an unconfirmed address signed in: %d %s", r.Status, r.Raw)
	}

	var slug string
	if err := h.admin.QueryRow(t.Context(), `
		SELECT f.slug FROM farms f JOIN memberships m ON m.farm_id = f.id JOIN users u ON u.id = m.user_id
		 WHERE lower(u.email) = lower($1)`, email).Scan(&slug); err != nil {
		t.Fatalf("slug: %v", err)
	}
	st := provisionStatusOf(t, srv, slug, mustString(t, res.Body, "provisionTicket"))
	if st.Status != http.StatusOK || !strings.Contains(st.Raw, `"awaitingVerification":true`) {
		t.Fatalf("the waiting screen does not say it is waiting for the email: %d %s", st.Status, st.Raw)
	}

	if r := callFrom(t, srv, "bascula.example.com", http.MethodPost, "/v1/auth/verify-email", "",
		map[string]any{"token": token, "password": "otra-clave-cualquiera"}); r.Status != http.StatusUnauthorized {
		t.Fatalf("the link verified with the wrong password: %d %s", r.Status, r.Raw)
	}
	ok := callFrom(t, srv, "bascula.example.com", http.MethodPost, "/v1/auth/verify-email", "",
		map[string]any{"token": token, "password": password})
	if ok.Status != http.StatusOK || ok.Body["slug"] != slug {
		t.Fatalf("verify: %d %s", ok.Status, ok.Raw)
	}
	if r := callFrom(t, srv, "bascula.example.com", http.MethodPost, "/v1/auth/login", "",
		map[string]any{"email": email, "password": password}); r.Status != http.StatusOK {
		t.Fatalf("login after confirming: %d %s", r.Status, r.Raw)
	}
	st = provisionStatusOf(t, srv, slug, mustString(t, res.Body, "provisionTicket"))
	if strings.Contains(st.Raw, `"awaitingVerification":true`) {
		t.Fatalf("still waiting after the link: %s", st.Raw)
	}
}

// TestAnUnconfirmedClaimBelongsToTheMailbox: whoever registers an address
// first without proving it does not keep it.
func TestAnUnconfirmedClaimBelongsToTheMailbox(t *testing.T) {
	h := requireDB(t)
	srv, mail := mailServer(t, h)
	victim := "reclamo-" + uuid.NewString()[:8] + "@example.com"
	const attacker, owner = "clave-del-atacante-1", "clave-de-la-duena-2"

	signupOn(t, srv, "10.0.9.2", victim, attacker, "Finca cebo")
	first := linkToken(t, lastMail(t, mail, 1))
	signupOn(t, srv, "10.0.9.3", victim, owner, "Finca real")
	second := linkToken(t, lastMail(t, mail, 2))

	// The first claimant's link died with the claim, even with its password.
	if r := callFrom(t, srv, "bascula.example.com", http.MethodPost, "/v1/auth/verify-email", "",
		map[string]any{"token": first, "password": attacker}); r.Status != http.StatusBadRequest {
		t.Fatalf("a replaced claim's link still works: %d %s", r.Status, r.Raw)
	}
	// The mailbox's owner confirms with their own password.
	if r := callFrom(t, srv, "bascula.example.com", http.MethodPost, "/v1/auth/verify-email", "",
		map[string]any{"token": second, "password": owner}); r.Status != http.StatusOK {
		t.Fatalf("the owner could not confirm: %d %s", r.Status, r.Raw)
	}
	if r := callFrom(t, srv, "bascula.example.com", http.MethodPost, "/v1/auth/login", "",
		map[string]any{"email": victim, "password": attacker}); r.Status == http.StatusOK || r.Status == http.StatusBadRequest {
		t.Fatalf("the first claimant's password still opens the account: %d %s", r.Status, r.Raw)
	}
}

// TestAVerifiedAddressGetsANoticeNotALink: a farm registered with an address
// that is already proved needs no link; its owner is told, and the answer is
// the same as for any other address.
func TestAVerifiedAddressGetsANoticeNotALink(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca ya verificada", 90000)
	srv, mail := mailServer(t, h)

	res := signupOn(t, srv, "10.0.9.4", f.OwnerEmail, "clave-de-la-segunda", "Finca segunda")
	if res.Status != http.StatusCreated || res.Body["verificationRequired"] != true {
		t.Fatalf("signup: %d %s", res.Status, res.Raw)
	}
	body := lastMail(t, mail, 1)
	if strings.Contains(body, "/confirmar-correo#") || !strings.Contains(body, "Finca segunda") {
		t.Fatalf("a verified address got a link instead of a notice: %s", body)
	}
}
