// SPDX-License-Identifier: MIT

package apitest

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

// TestSignupRefusesWeakInput covers the field checks signup runs before it
// spends a password hash.
func TestSignupRefusesWeakInput(t *testing.T) {
	h := requireDB(t)
	farm := map[string]any{"name": "Finca corta", "timezone": "America/Bogota", "currency": "COP"}
	owner := func(pw string) map[string]any {
		return map[string]any{"email": "corto-" + uuid.NewString()[:8] + "@example.com", "name": "O", "password": pw}
	}

	res := h.do(t, http.MethodPost, "/v1/signup", "", map[string]any{"farm": farm, "owner": owner("corta")})
	if res.Status != http.StatusBadRequest {
		t.Errorf("a nine-character password: got %d %s, want 400", res.Status, res.Raw)
	}
	res = h.do(t, http.MethodPost, "/v1/signup", "", map[string]any{
		"farm": map[string]any{"name": "   "}, "owner": owner("una-clave-larga-1"),
	})
	if res.Status != http.StatusBadRequest {
		t.Errorf("a blank farm name: got %d %s, want 400", res.Status, res.Raw)
	}
}

// TestLoginRefusals walks the refusals a correct password can still meet.
func TestLoginRefusals(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca puerta", 80000)

	t.Run("an unverified address opens no session", func(t *testing.T) { loginUnverified(t, h, f) })
	t.Run("an account that belongs to no farm", func(t *testing.T) { loginWithoutFarm(t, h, f.loginSecret()) })
	t.Run("a farm id the account is not a member of", func(t *testing.T) {
		res := h.loginOwner(t, f, "", map[string]any{"farmId": uuid.NewString()})
		if res.Status != http.StatusForbidden {
			t.Fatalf("got %d %s, want 403", res.Status, res.Raw)
		}
	})
	t.Run("a farmSlug that contradicts the host", func(t *testing.T) { loginSlugAgainstHost(t, h, f) })
	t.Run("a suspended farm", func(t *testing.T) { loginSuspendedFarm(t, h) })
}

// adminExec runs setup SQL as the superuser and stops the test if it fails.
func adminExec(t *testing.T, h *harness, sql string, args ...any) {
	t.Helper()
	if _, err := h.admin.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func loginUnverified(t *testing.T, h *harness, f *farmFixture) {
	adminExec(t, h, `UPDATE users SET email_verified_at = NULL WHERE id = $1`, f.OwnerUserID)
	defer adminExec(t, h, `UPDATE users SET email_verified_at = now() WHERE id = $1`, f.OwnerUserID)
	res := h.loginOwner(t, f, "", nil)
	if res.Status != http.StatusForbidden || res.code() != string(domain.CodeEmailNotVerified) {
		t.Fatalf("got %d %s, want 403 EMAIL_NOT_VERIFIED", res.Status, res.Raw)
	}
}

func loginWithoutFarm(t *testing.T, h *harness, pw string) {
	email := "sin-finca-" + uuid.NewString()[:8] + "@example.com"
	hash, err := auth.HashPassword(pw)
	if err != nil {
		t.Fatal(err)
	}
	adminExec(t, h, `INSERT INTO users (id, email, name, password_hash, email_verified_at)
		VALUES ($1, $2, 'Nadie', $3, now())`, uuid.NewString(), email, hash)
	res := h.do(t, http.MethodPost, "/v1/auth/login", "", map[string]any{"email": email, "password": pw})
	if res.Status != http.StatusForbidden {
		t.Fatalf("got %d %s, want 403: the password is right, there is just nothing to open", res.Status, res.Raw)
	}
}

func loginSlugAgainstHost(t *testing.T, h *harness, f *farmFixture) {
	other := h.signupFarm(t, "Finca segunda puerta", 80000)
	h.addOwner(t, other.FarmID, f.OwnerUserID)
	mine, theirs := h.farmSlug(t, f.FarmID), h.farmSlug(t, other.FarmID)
	res := h.loginOwner(t, f, mine+".bascula.engp.io", map[string]any{"farmSlug": theirs})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("got %d %s, want 400", res.Status, res.Raw)
	}
	// Agreeing pins open the farm they name, though the account has two.
	res = h.loginOwner(t, f, theirs+".bascula.engp.io", map[string]any{"farmSlug": theirs})
	if res.Status != http.StatusOK {
		t.Fatalf("matching host and slug: got %d %s, want 200", res.Status, res.Raw)
	}
}

func loginSuspendedFarm(t *testing.T, h *harness) {
	g := h.signupFarm(t, "Finca suspendida", 80000)
	adminExec(t, h, `UPDATE farms SET suspended_at = now() WHERE id = $1`, g.FarmID)
	res := h.loginOwner(t, g, "", nil)
	if res.Status != http.StatusForbidden || res.code() != string(domain.CodeFarmSuspended) {
		t.Fatalf("got %d %s, want 403 FARM_SUSPENDED", res.Status, res.Raw)
	}
}

// TestRefreshRefusalsAndDevice covers what a refresh token can no longer buy,
// and that a refresh keeps the device its session was opened on.
func TestRefreshRefusalsAndDevice(t *testing.T) {
	h := requireDB(t)
	ctx := context.Background()
	f := h.signupFarm(t, "Finca renovada", 80000)
	device := uuid.NewString()

	login := h.loginOwner(t, f, "", map[string]any{"deviceId": device})
	if login.Status != http.StatusOK {
		t.Fatalf("login: %d %s", login.Status, login.Raw)
	}
	refreshed := h.mustDo(t, http.MethodPost, "/v1/auth/refresh", "",
		map[string]any{"refreshToken": login.Body["refreshToken"]}, http.StatusOK)
	var onDevice int
	if err := h.admin.QueryRow(ctx, `SELECT count(*) FROM refresh_tokens WHERE user_id = $1 AND device_id = $2`,
		f.OwnerUserID, device).Scan(&onDevice); err != nil {
		t.Fatal(err)
	}
	if onDevice != 2 {
		t.Errorf("%d refresh tokens on the device, want 2: a refresh that names no device keeps the session's", onDevice)
	}

	t.Run("an expired token", func(t *testing.T) {
		if _, err := h.admin.Exec(ctx, `UPDATE refresh_tokens SET expires_at = now() - interval '1 minute'
			WHERE user_id = $1 AND rotated_at IS NULL`, f.OwnerUserID); err != nil {
			t.Fatal(err)
		}
		res := h.do(t, http.MethodPost, "/v1/auth/refresh", "", map[string]any{"refreshToken": refreshed.Body["refreshToken"]})
		if res.Status != http.StatusUnauthorized || res.code() != string(domain.CodeTokenExpired) {
			t.Fatalf("got %d %s, want 401 TOKEN_EXPIRED", res.Status, res.Raw)
		}
	})

	t.Run("a farm suspended since the session opened", func(t *testing.T) {
		g := h.signupFarm(t, "Finca renovada suspendida", 80000)
		l := h.loginOwner(t, g, "", nil)
		if _, err := h.admin.Exec(ctx, `UPDATE farms SET suspended_at = now() WHERE id = $1`, g.FarmID); err != nil {
			t.Fatal(err)
		}
		res := h.do(t, http.MethodPost, "/v1/auth/refresh", "", map[string]any{"refreshToken": l.Body["refreshToken"]})
		if res.Status != http.StatusForbidden || res.code() != string(domain.CodeFarmSuspended) {
			t.Fatalf("got %d %s, want 403 FARM_SUSPENDED", res.Status, res.Raw)
		}
	})
}
