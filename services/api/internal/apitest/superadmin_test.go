package apitest

import (
	"context"
	"net/http"
	"testing"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

// The platform flag, from both sides.
//
// tenant.setContext re-reads three of the token's claims against the row on
// every request — the farm's suspension, the membership, the role — and the
// fourth, `superadmin`, was believed on sight. It is the claim that waives all
// three of those checks, opens p_farms to every farm on the platform and is the
// whole of what auth.Matrix asks for the console, and it was read from the
// users row at login and at refresh and nowhere else.
//
// The two tests here are the two halves of that: a token that claims a flag the
// row does not have, and a flag the row does have carried into a farm the
// account has been removed from.

// ---------------------------------------------------------------------------
// The flag was taken off the account and the token still carries it
// ---------------------------------------------------------------------------

// TestARevokedPlatformFlagDiesOnTheNextRequest.
//
// The script: a platform administrator is dismissed, or their account turns out
// to be in somebody else's hands, and `UPDATE users SET is_superadmin = false`
// is what the platform does about it. Their access token lives another fifteen
// minutes and every request in that window used to believe the claim — listing
// every farm on the platform, suspending them, and being exempt from suspension
// and from removal all the while. A lever with a quarter of an hour of delay is
// not a lever, which is the sentence the suspension check was written under.
func TestARevokedPlatformFlagDiesOnTheNextRequest(t *testing.T) {
	h := requireDB(t)
	mine := h.signupFarm(t, "Finca del ex administrador", 100000)
	other := h.signupFarm(t, "Finca ajena", 100000)

	// An ordinary owner of one farm: is_superadmin is false on the row, which
	// is what dismissal leaves behind.
	userID, _ := h.addUserWithID(t, mine.FarmID, domain.RoleOwner)
	forged, err := auth.NewSigner([]byte("test-signing-key"), "bascula").
		Issue(userID, mine.FarmID, domain.RoleOwner, "", true)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	t.Run("the console is shut", func(t *testing.T) {
		res := h.do(t, http.MethodGet, "/v1/admin/farms", forged, nil)
		if res.Status != http.StatusUnauthorized ||
			res.code() != string(domain.CodePlatformRoleChanged) {
			t.Fatalf("a token claiming a flag the row does not have listed the "+
				"platform: got %d %s, want 401 PLATFORM_ROLE_CHANGED", res.Status, res.Raw)
		}
		if _, leaked := res.Body["items"]; leaked {
			t.Fatalf("the refusal still carried the farm list: %s", res.Raw)
		}
	})

	t.Run("and so is the suspend button", func(t *testing.T) {
		res := h.do(t, http.MethodPatch, "/v1/admin/farms/"+other.FarmID, forged,
			map[string]any{"status": "suspended"})
		if res.Status != http.StatusUnauthorized ||
			res.code() != string(domain.CodePlatformRoleChanged) {
			t.Fatalf("a dismissed administrator suspended somebody else's farm: "+
				"got %d %s, want 401 PLATFORM_ROLE_CHANGED", res.Status, res.Raw)
		}
		// And the row, because a 4xx that still wrote would be the worse bug.
		var suspended *string
		if err := h.admin.QueryRow(context.Background(),
			`SELECT suspended_at::text FROM farms WHERE id = $1`, other.FarmID).
			Scan(&suspended); err != nil {
			t.Fatalf("read the farm back: %v", err)
		}
		if suspended != nil {
			t.Fatalf("the farm was suspended anyway, at %s", *suspended)
		}
	})

	t.Run("nor does the claim still buy an exemption", func(t *testing.T) {
		// The flag exempts its holder from FARM_SUSPENDED, and a claim nobody
		// checked was therefore a way to go on working through a suspension.
		if _, err := h.admin.Exec(context.Background(),
			`UPDATE farms SET suspended_at = now() WHERE id = $1`, mine.FarmID); err != nil {
			t.Fatalf("suspend the farm: %v", err)
		}
		res := h.do(t, http.MethodGet, "/v1/workers", forged, nil)
		if res.Status != http.StatusUnauthorized ||
			res.code() != string(domain.CodePlatformRoleChanged) {
			t.Fatalf("the claim carried its holder through a suspension: "+
				"got %d %s, want 401 PLATFORM_ROLE_CHANGED", res.Status, res.Raw)
		}
		if _, err := h.admin.Exec(context.Background(),
			`UPDATE farms SET suspended_at = NULL WHERE id = $1`, mine.FarmID); err != nil {
			t.Fatalf("bring the farm back: %v", err)
		}
	})

	t.Run("the token without the claim goes on working", func(t *testing.T) {
		// The account is not in trouble: it is an owner of this farm and the
		// refusal above was about one stale claim, which is why it is a 401.
		// This is the token a refresh hands back.
		honest, err := auth.NewSigner([]byte("test-signing-key"), "bascula").
			Issue(userID, mine.FarmID, domain.RoleOwner, "", false)
		if err != nil {
			t.Fatalf("issue token: %v", err)
		}
		h.mustDo(t, http.MethodGet, "/v1/workers", honest, nil, http.StatusOK)
		res := h.do(t, http.MethodGet, "/v1/admin/farms", honest, nil)
		if res.Status != http.StatusForbidden {
			t.Fatalf("the console answered a farm owner: got %d %s, want 403",
				res.Status, res.Raw)
		}
	})

	t.Run("a real platform administrator is untouched", func(t *testing.T) {
		// The check reads the row, so the row is what it has to keep working.
		real := h.superadminToken(t, mine.FarmID)
		h.mustDo(t, http.MethodGet, "/v1/admin/farms", real, nil, http.StatusOK)
	})
}

// ---------------------------------------------------------------------------
// The flag is real and the membership is gone
// ---------------------------------------------------------------------------

// TestAPlatformAdministratorRemovedFromAFarmStaysOutsideIt.
//
// auth.Rule says what the flag means in one line: "a super-admin administers
// farms from the outside and cannot read inside one". Only the first half was
// true. The membership check exempts the platform administrator on purpose — a
// farm that removed them must not be able to lock the lever holder out of the
// room the lever is in — and the role check stands aside when there is no
// membership row, so the token's `role` claim reached app.role with nothing
// left to contradict it. A platform administrator taken off farm X went on
// being its owner for the rest of the token: the payroll, the ledger, the
// private notes.
func TestAPlatformAdministratorRemovedFromAFarmStaysOutsideIt(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca que expulsa", 100000)
	elsewhere := h.signupFarm(t, "Finca vecina", 100000)
	worker := h.createWorker(t, f, "Nomina Visible", "8010010011")

	token := h.superadminToken(t, f.FarmID)
	claims, err := auth.NewSigner([]byte("test-signing-key"), "bascula").Parse(token)
	if err != nil {
		t.Fatalf("parse token: %v", err)
	}

	// While the membership is there, this is an owner of the farm like any
	// other, and everything below has to be about its removal and nothing else.
	h.mustDo(t, http.MethodGet, "/v1/workers", token, nil, http.StatusOK)
	h.mustDo(t, http.MethodGet, "/v1/balances", token, nil, http.StatusOK)

	// What DELETE /v1/users/{id} does to the membership, done to the platform
	// administrator: the account keeps its flag and loses this farm.
	if _, err := h.admin.Exec(context.Background(),
		`DELETE FROM memberships WHERE farm_id = $1 AND user_id = $2`,
		f.FarmID, claims.Subject); err != nil {
		t.Fatalf("remove the membership: %v", err)
	}

	t.Run("the farm is closed to them", func(t *testing.T) {
		for _, path := range []string{
			"/v1/workers", "/v1/workers/" + worker, "/v1/balances",
			"/v1/settlements", "/v1/me",
		} {
			res := h.do(t, http.MethodGet, path, token, nil)
			if res.Status != http.StatusForbidden ||
				res.code() != string(domain.CodeMembershipRevoked) {
				t.Errorf("GET %s from outside the farm: got %d %s, want 403 "+
					"MEMBERSHIP_REVOKED", path, res.Status, res.Raw)
			}
		}
		// The writing half, which is the one that moves money.
		pay := h.do(t, http.MethodPost, "/v1/payments", token, map[string]any{
			"id":       "0f8c2b8e-0000-4000-8000-000000000001",
			"workerId": worker, "amountCents": 1000,
		})
		if pay.code() != string(domain.CodeMembershipRevoked) {
			t.Fatalf("a payment from outside the farm: got %d %s", pay.Status, pay.Raw)
		}
	})

	t.Run("the console stays in their hands", func(t *testing.T) {
		// This is the whole reason the membership check exempts them: a farm
		// that removes the platform administrator must not take the lever with
		// it. What they lose is the farm, not the console.
		res := h.mustDo(t, http.MethodGet, "/v1/admin/farms", token, nil, http.StatusOK)
		if _, leaked := res.Body["items"]; !leaked {
			t.Fatalf("the console answered without a farm list: %s", res.Raw)
		}
		h.mustDo(t, http.MethodPatch, "/v1/admin/farms/"+elsewhere.FarmID, token,
			map[string]any{"status": "suspended"}, http.StatusOK)
		h.mustDo(t, http.MethodPatch, "/v1/admin/farms/"+elsewhere.FarmID, token,
			map[string]any{"status": "active"}, http.StatusOK)
	})
}
