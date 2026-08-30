package apitest

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

// Sprint 12: rule 2 was only ever written uphill.
//
// handlers_users.go says nobody grants a role above their own, and mayGrant
// enforced exactly that sentence and no more: it read the role being handed
// out and never the person it was being taken from. So the administrator who
// could not MAKE an owner could unmake every owner the farm had — PATCH to
// weigher grants nothing above his own role, DELETE grants nothing at all —
// and DELETE takes the refresh tokens with the membership, so the demotion
// arrived with the sessions already cut.
//
// The tests below are written against that script.

// ---------------------------------------------------------------------------
// The rank check, on both doors
// ---------------------------------------------------------------------------

func TestNobodyUnmakesSomebodyAboveTheirOwnRole(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de los rangos", 90000)

	// A SECOND owner, so that nothing below is refused by rule 1 by accident.
	// Every refusal in this test has to be the rank check itself, and with two
	// owners on the farm the owner count never comes into it.
	secondEmail := fmt.Sprintf("duena2-%s@example.com", uuid.NewString()[:8])
	second := h.mustDo(t, http.MethodPost, "/v1/users", f.OwnerToken, map[string]any{
		"email": secondEmail, "name": "Segunda duena", "role": "owner",
	}, http.StatusCreated)
	secondOwnerID := mustString(t, second.Body, "id")

	t.Run("an administrator cannot demote an owner", func(t *testing.T) {
		res := h.do(t, http.MethodPatch, "/v1/users/"+secondOwnerID, f.AdminToken,
			map[string]any{"role": "weigher"})
		if res.Status != http.StatusForbidden {
			t.Fatalf("an administrator demoted an owner (%d); the grant rule only "+
				"ever looked at the role being handed out: %s", res.Status, res.Raw)
		}
		if role := h.membershipRole(t, f.FarmID, secondOwnerID); role != string(domain.RoleOwner) {
			t.Fatalf("the owner is now %q in the database; the refusal was a "+
				"status code with a write behind it", role)
		}
	})

	t.Run("nor take an owner's access away", func(t *testing.T) {
		res := h.do(t, http.MethodDelete, "/v1/users/"+secondOwnerID, f.AdminToken, nil)
		if res.Status != http.StatusForbidden {
			t.Fatalf("an administrator removed an owner (%d); that deletes the "+
				"membership AND revokes the sessions in the same transaction: %s",
				res.Status, res.Raw)
		}
		if role := h.membershipRole(t, f.FarmID, secondOwnerID); role != string(domain.RoleOwner) {
			t.Fatalf("the owner's membership is %q; want it untouched", role)
		}
	})

	t.Run("an owner still demotes an administrator", func(t *testing.T) {
		// The legitimate direction, which must keep working: this is how a
		// farm takes the money away from somebody who no longer handles it.
		email := fmt.Sprintf("admin-baja-%s@example.com", uuid.NewString()[:8])
		created := h.mustDo(t, http.MethodPost, "/v1/users", f.OwnerToken, map[string]any{
			"email": email, "name": "Administrador", "role": "admin",
		}, http.StatusCreated)
		id := mustString(t, created.Body, "id")

		res := h.mustDo(t, http.MethodPatch, "/v1/users/"+id, f.OwnerToken,
			map[string]any{"role": "weigher"}, http.StatusOK)
		if res.Body["role"] != "weigher" {
			t.Fatalf("role is %v, want weigher: %s", res.Body["role"], res.Raw)
		}
	})

	t.Run("an administrator still manages a weigher", func(t *testing.T) {
		email := fmt.Sprintf("pesador-rango-%s@example.com", uuid.NewString()[:8])
		created := h.mustDo(t, http.MethodPost, "/v1/users", f.OwnerToken, map[string]any{
			"email": email, "name": "Pesador", "role": "weigher",
		}, http.StatusCreated)
		id := mustString(t, created.Body, "id")

		up := h.mustDo(t, http.MethodPatch, "/v1/users/"+id, f.AdminToken,
			map[string]any{"role": "admin"}, http.StatusOK)
		if up.Body["role"] != "admin" {
			t.Fatalf("role is %v, want admin: %s", up.Body["role"], up.Raw)
		}

		// And now the same person is a PEER, which is allowed on purpose: the
		// self-checks in handlers_users.go answer "another administrator does
		// that", and that remedy has to exist. An administrator out of reach
		// of every other administrator would also put rule 1 out of reach,
		// since nothing outranks an owner.
		h.mustDo(t, http.MethodDelete, "/v1/users/"+id, f.AdminToken, nil,
			http.StatusNoContent)
		if role := h.membershipRole(t, f.FarmID, id); role != "" {
			t.Fatalf("the peer is still a %q here; peers are meant to reach "+
				"each other", role)
		}
	})
}

// ---------------------------------------------------------------------------
// The account the farm must not be able to end
// ---------------------------------------------------------------------------

// TestAFarmCannotDeleteThePlatformAdministrator.
//
// The rank check above does not cover this one and cannot: the platform
// administrator holds an ordinary membership with an ordinary role, and an
// owner outranks it. What is at stake is not this farm — it is the console.
// tenant.setContext exempts the flag from the revocation cut, which saves the
// access token in their hand for fifteen minutes; login then answers "that
// account belongs to no farm", and there is no second membership to fall back
// to. The farm holding the only one can end the platform administrator for
// good, and the fix is somebody with database access.
func TestAFarmCannotDeleteThePlatformAdministrator(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca con la plataforma dentro", 90000)

	// Seeded as an administrator, deliberately: the owner asking to remove
	// them is NOT refused by rank, so the only thing that can refuse is the
	// rule under test.
	platformID := h.seedPlatformMember(t, f.FarmID, domain.RoleAdmin)

	res := h.do(t, http.MethodDelete, "/v1/users/"+platformID, f.OwnerToken, nil)
	if res.Status != http.StatusConflict || res.code() != string(domain.CodeConflict) {
		t.Fatalf("removing the platform account: got %d %s, want 409 CONFLICT: %s",
			res.Status, res.code(), res.Raw)
	}
	if role := h.membershipRole(t, f.FarmID, platformID); role != string(domain.RoleAdmin) {
		t.Fatalf("the platform membership is %q; the console is reached through "+
			"that row", role)
	}

	// The role, on the other hand, is the farm's business. auth.Matrix opens
	// the console to every farm role once the flag is present, so a demotion
	// costs the platform administrator a fresh token and nothing else.
	demoted := h.mustDo(t, http.MethodPatch, "/v1/users/"+platformID, f.OwnerToken,
		map[string]any{"role": "weigher"}, http.StatusOK)
	if demoted.Body["role"] != "weigher" {
		t.Fatalf("role is %v, want weigher: %s", demoted.Body["role"], demoted.Raw)
	}

	// And the flag stays out of the member list, where the console has no
	// column for it and no business showing one.
	list := h.mustDo(t, http.MethodGet, "/v1/users", f.OwnerToken, nil, http.StatusOK)
	for _, item := range list.Body["items"].([]any) {
		if _, ok := item.(map[string]any)["isSuperadmin"]; ok {
			t.Fatalf("the platform flag is being published to the farm: %s", list.Raw)
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// membershipRole reads the role straight out of the table, bypassing the API
// entirely. A handler that answered 403 and wrote anyway would still look
// correct from the outside, and that is precisely the shape of this bug.
// An empty string means there is no membership row at all.
func (h *harness) membershipRole(t *testing.T, farmID, userID string) string {
	t.Helper()
	var role string
	err := h.admin.QueryRow(context.Background(),
		`SELECT role::text FROM memberships WHERE farm_id = $1 AND user_id = $2`,
		farmID, userID).Scan(&role)
	if err != nil {
		return ""
	}
	return role
}

// seedPlatformMember puts an account carrying the platform flag on a farm with
// an ordinary role, and hands back its id. It is the shape sprint 2's
// superadminToken already seeds — a flag and a membership, deliberately
// separate — with the role left to the caller.
func (h *harness) seedPlatformMember(t *testing.T, farmID string, role domain.Role) string {
	t.Helper()
	ctx := context.Background()
	userID := uuid.NewString()
	emailSeq++
	email := fmt.Sprintf("plataforma%d-%s@example.com", emailSeq, uuid.NewString()[:8])

	hash, err := auth.HashPassword("una-clave-larga-1")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if _, err := h.admin.Exec(ctx, `
		INSERT INTO users (id, email, name, password_hash, email_verified_at, is_superadmin)
		VALUES ($1, $2, 'Plataforma', $3, now(), true)`, userID, email, hash); err != nil {
		t.Fatalf("seed platform account: %v", err)
	}
	if _, err := h.admin.Exec(ctx,
		`INSERT INTO memberships (farm_id, user_id, role) VALUES ($1, $2, $3)`,
		farmID, userID, role); err != nil {
		t.Fatalf("seed membership: %v", err)
	}
	return userID
}
