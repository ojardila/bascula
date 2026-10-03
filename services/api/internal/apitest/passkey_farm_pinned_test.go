// SPDX-License-Identifier: MIT

package apitest

import (
	"net/http"
	"testing"

	"github.com/ojardila/bascula/services/api/internal/auth"
)

const claveDeLaFinca = "clave-propia-de-la-finca-9"

// TestPasskeyMadeInAFarmPasswordSessionOpensOnlyThatFarm: a session opened
// with a farm's own owner password proved that password and nothing else, so
// the passkey it adds is pinned to that farm, it sees only the passkeys
// pinned there, and the pinned passkey opens that farm alone.
func TestPasskeyMadeInAFarmPasswordSessionOpensOnlyThatFarm(t *testing.T) {
	h := requireDB(t)
	home := h.signupFarm(t, "Finca de la cuenta", 80000)
	locked := h.signupFarm(t, "Finca de clave propia", 80000)
	adminExec(t, h, `INSERT INTO memberships (farm_id, user_id, role) VALUES ($1, $2, 'admin')`,
		locked.FarmID, home.OwnerUserID)
	hash, err := auth.HashPassword(claveDeLaFinca)
	if err != nil {
		t.Fatal(err)
	}
	adminExec(t, h, `INSERT INTO farm_owner_credentials (farm_id, user_id, name, phone, password_hash)
		VALUES ($1, $2, 'Dueña', '', $3)`, locked.FarmID, home.OwnerUserID, hash)

	// The account's own passkey, made from the account password's session.
	accountKey := mustString(t, h.registerPasskey(t, home.OwnerToken, newSoftPasskey(t)), "id")

	login := h.do(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": home.OwnerEmail, "password": claveDeLaFinca, "farmId": locked.FarmID,
	})
	expectStatus(t, "sign-in with the farm's own password", login, http.StatusOK)
	scoped := mustString(t, login.Body, "accessToken")

	pinned := newSoftPasskey(t)
	opts := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, "/v1/me/passkeys/options", scoped,
		map[string]any{"currentPassword": claveDeLaFinca})
	expectStatus(t, "passkey options in the farm session", opts, http.StatusOK)
	made := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, "/v1/me/passkeys", scoped, map[string]any{
		"challenge": opts.Body["challenge"], "credential": pinned.create(t, opts.Body, passkeyOrigin), "name": "Tableta de la finca",
	})
	expectStatus(t, "passkey made in the farm session", made, http.StatusCreated)

	// The farm session reaches only what such a session made.
	list := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodGet, "/v1/me/passkeys", scoped, nil)
	expectStatus(t, "list from the farm session", list, http.StatusOK)
	if items, _ := list.Body["items"].([]any); len(items) != 1 {
		t.Fatalf("the farm session sees %d passkeys, want only the one pinned here: %s", len(items), list.Raw)
	}
	expectStatus(t, "the farm session removing the account's passkey",
		h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodDelete, "/v1/me/passkeys/"+accountKey, scoped, nil),
		http.StatusNotFound)
	all := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodGet, "/v1/me/passkeys", home.OwnerToken, nil)
	if items, _ := all.Body["items"].([]any); len(items) != 2 {
		t.Fatalf("the account session sees %d passkeys, want both: %s", len(items), all.Raw)
	}

	// The pinned passkey opens the farm it was made in, and not the account's.
	res := h.passkeyLogin(t, "10.7.3.1", pinned, nil)
	if res.Status != http.StatusOK || res.Body["farmId"] != locked.FarmID {
		t.Fatalf("the pinned passkey should open its farm: %d %s", res.Status, res.Raw)
	}
	expectStatus(t, "the pinned passkey on the account's farm",
		h.passkeyLogin(t, "10.7.3.2", pinned, map[string]any{"farmId": home.FarmID}), http.StatusForbidden)
}
