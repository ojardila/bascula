package apitest

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
)

// An invite used to create a GLOBAL, VERIFIED account with the password the
// administrator chose: a farm administrator owned a verified account for
// somebody else's address, and every farm that later invited the same address
// joined it. The invited password is now the farm's, never the account's.

func (h *harness) invite(t *testing.T, token, email string, extra map[string]any) response {
	t.Helper()
	body := map[string]any{"email": email, "name": "Invitado", "role": "weigher"}
	for k, v := range extra {
		body[k] = v
	}
	return h.mustDo(t, http.MethodPost, "/v1/users", token, body, http.StatusCreated)
}

func (h *harness) accountOf(t *testing.T, email string) (hash string, verified bool) {
	t.Helper()
	if err := h.admin.QueryRow(context.Background(),
		`SELECT password_hash, email_verified_at IS NOT NULL FROM users WHERE email = $1`,
		email).Scan(&hash, &verified); err != nil {
		t.Fatalf("read the account: %v", err)
	}
	return hash, verified
}

func TestAnInvitedPasswordOpensThatFarmOnly(t *testing.T) {
	h := requireDB(t)
	a := h.signupFarm(t, "Finca que invita A", 90000)
	b := h.signupFarm(t, "Finca que invita B", 90000)
	email := fmt.Sprintf("pesador-alcance-%s@example.com", uuid.NewString()[:8])

	passA := mustString(t, h.invite(t, a.OwnerToken, email, nil).Body, "temporaryPassword")
	passB := mustString(t, h.invite(t, b.OwnerToken, email, nil).Body, "temporaryPassword")

	t.Run("the account is not verified and its password is nobody's", func(t *testing.T) {
		hash, verified := h.accountOf(t, email)
		if verified {
			t.Fatal("an administrator's invite verified an address it never proved")
		}
		for _, p := range []string{passA, passB} {
			if ok, _ := auth.VerifyPassword(p, hash); ok {
				t.Fatal("the handed-over password is the account's global password")
			}
		}
	})

	t.Run("the invited person signs in to the farm that invited them", func(t *testing.T) {
		login := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": email, "password": passA,
		}, http.StatusOK)
		if login.Body["farmId"] != a.FarmID || login.Body["role"] != "weigher" {
			t.Fatalf("want farm A as weigher (and no farm choice): %s", login.Raw)
		}
		h.mustDo(t, http.MethodGet, "/v1/me", mustString(t, login.Body, "accessToken"),
			nil, http.StatusOK)
	})

	t.Run("and that password opens no other farm", func(t *testing.T) {
		for _, c := range []struct{ pass, farm string }{{passA, b.FarmID}, {passB, a.FarmID}} {
			res := h.doFrom(t, "10.31.0.1", http.MethodPost, "/v1/auth/login", "", map[string]any{
				"email": email, "password": c.pass, "farmId": c.farm,
			})
			if res.Status != http.StatusUnauthorized {
				t.Fatalf("one farm's password opened another farm: %d %s", res.Status, res.Raw)
			}
		}
	})

	t.Run("nor the account's other farms on the main domain", func(t *testing.T) {
		login := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": email, "password": passB,
		}, http.StatusOK)
		if login.Body["farmId"] != b.FarmID {
			t.Fatalf("want only farm B: %s", login.Raw)
		}
	})
}

func TestInviteAnswersTheSameWhoeverOwnsTheAddress(t *testing.T) {
	h := requireDB(t)
	elsewhere := h.signupFarm(t, "Finca del dueño de antes", 90000)
	f := h.signupFarm(t, "Finca que pregunta", 90000)
	fresh := fmt.Sprintf("nuevo-%s@example.com", uuid.NewString()[:8])

	fromNew := h.invite(t, f.OwnerToken, fresh, map[string]any{"name": "Pedro"})
	fromOld := h.invite(t, f.OwnerToken, elsewhere.OwnerEmail, map[string]any{"name": "Pedro"})

	keys := func(r response) string {
		ks := make([]string, 0, len(r.Body))
		for k := range r.Body {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		return strings.Join(ks, ",")
	}
	if keys(fromNew) != keys(fromOld) {
		t.Fatalf("the two answers differ in shape:\nnew: %s\nold: %s", fromNew.Raw, fromOld.Raw)
	}
	for _, r := range []response{fromNew, fromOld} {
		if r.Body["emailVerifiedAt"] != nil || r.Body["name"] != "Pedro" ||
			r.Body["temporaryPassword"] == nil {
			t.Fatalf("an answer says something about the account: %s", r.Raw)
		}
	}

	t.Run("nor does the member list", func(t *testing.T) {
		list := h.mustDo(t, http.MethodGet, "/v1/users", f.OwnerToken, nil, http.StatusOK)
		items, _ := list.Body["items"].([]any)
		seen := 0
		for _, it := range items {
			m, _ := it.(map[string]any)
			if m["email"] == fresh || m["email"] == elsewhere.OwnerEmail {
				seen++
				if m["emailVerifiedAt"] != nil || m["name"] != "Pedro" {
					t.Fatalf("the list tells the accounts apart: %v", m)
				}
			}
		}
		if seen != 2 {
			t.Fatalf("want both invitees listed: %s", list.Raw)
		}
	})

	t.Run("an existing member is a retry with the same status, and no new password", func(t *testing.T) {
		again := h.invite(t, f.OwnerToken, elsewhere.OwnerEmail, map[string]any{"role": "admin"})
		if again.Body["id"] != fromOld.Body["id"] || again.Body["role"] != "weigher" {
			t.Fatalf("a repeated invite changed the membership: %s", again.Raw)
		}
		if again.Body["temporaryPassword"] != nil {
			t.Fatalf("a repeated invite minted a password for an existing member: %s", again.Raw)
		}
		// The minted password from the first invite still works: nothing was
		// replaced.
		h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": elsewhere.OwnerEmail, "password": fromOld.Body["temporaryPassword"],
			"farmId": f.FarmID,
		}, http.StatusOK)
	})

	t.Run("the existing account keeps its own password and its own farm", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": elsewhere.OwnerEmail, "password": elsewhere.loginSecret(),
			"farmId": elsewhere.FarmID,
		}, http.StatusOK)
		// ...which does not open the farm that invited it: that farm opens
		// with the password its administrator handed over.
		res := h.doFrom(t, "10.31.0.2", http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": elsewhere.OwnerEmail, "password": elsewhere.loginSecret(),
			"farmId": f.FarmID,
		})
		if res.Status != http.StatusUnauthorized {
			t.Fatalf("the global password opened the inviting farm: %d %s", res.Status, res.Raw)
		}
	})
}

// TestTheMailboxOwnerTakesTheInvitedAccount: a reset proves the address; it
// sets the global password, verifies the account and drops the farm
// passwords, so the inviting farm then opens with the new password and the
// handed-over one stops working. With a mailer, the invite itself sends a
// notice that carries no secret.
func TestTheMailboxOwnerTakesTheInvitedAccount(t *testing.T) {
	h := requireDB(t)
	srv, mail := mailServer(t, h)
	f := h.signupFarm(t, "Finca Aviso Invitado", 90000)
	email := fmt.Sprintf("buzon-%s@example.com", uuid.NewString()[:8])

	before := mail.count()
	res := call(t, srv, http.MethodPost, "/v1/users", f.OwnerToken, map[string]any{
		"email": email, "name": "Lucía", "role": "weigher",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("invite: %d %s", res.Status, res.Raw)
	}
	handed := mustString(t, res.Body, "temporaryPassword")
	waitForMail(t, mail, before+1)
	mail.mu.Lock()
	var notice string
	for _, m := range mail.sent[before:] {
		if m.To == email {
			notice = m.Body
		}
	}
	mail.mu.Unlock()
	if !strings.Contains(notice, "Finca Aviso Invitado") || strings.Contains(notice, handed) {
		t.Fatalf("the invitee's notice (must name the farm and carry no password): %q", notice)
	}

	asked := call(t, srv, http.MethodPost, "/v1/auth/password-reset/request", "",
		map[string]any{"email": email})
	token := mustString(t, asked.Body, "resetToken")
	spent := call(t, srv, http.MethodPost, "/v1/auth/password-reset", "",
		map[string]any{"token": token, "password": newSecret})
	if spent.Status != http.StatusNoContent {
		t.Fatalf("reset: %d %s", spent.Status, spent.Raw)
	}
	if _, verified := h.accountOf(t, email); !verified {
		t.Fatal("the reset proved the mailbox and the account is still unverified")
	}
	login := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": email, "password": newSecret,
	}, http.StatusOK)
	if login.Body["farmId"] != f.FarmID {
		t.Fatalf("the mailbox owner's password does not open the farm the address was given: %s", login.Raw)
	}
	old := h.doFrom(t, "10.31.0.3", http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": email, "password": handed,
	})
	if old.Status != http.StatusUnauthorized {
		t.Fatalf("the handed-over password outlived the reset: %d %s", old.Status, old.Raw)
	}
}
