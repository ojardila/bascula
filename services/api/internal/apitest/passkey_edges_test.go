// SPDX-License-Identifier: MIT

package apitest

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// passkeyLogin asks for a fresh challenge from ip and answers it with key,
// adding extra to the body (farmId, farmSlug).
func (h *harness) passkeyLogin(t *testing.T, ip string, key *softPasskey, extra map[string]any) response {
	t.Helper()
	opts := h.passkeyOptions(t, ip)
	body := map[string]any{"challenge": opts["challenge"], "credential": key.get(t, opts, passkeyOrigin)}
	for k, v := range extra {
		body[k] = v
	}
	return h.doOrigin(t, ip, passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", body)
}

func expectStatus(t *testing.T, what string, res response, want int) {
	t.Helper()
	if res.Status != want {
		t.Fatalf("%s: got %d want %d: %s", what, res.Status, want, res.Raw)
	}
}

func (h *harness) farmSlug(t *testing.T, farmID string) string {
	t.Helper()
	var slug string
	if err := h.admin.QueryRow(context.Background(), `SELECT slug FROM farms WHERE id = $1`, farmID).Scan(&slug); err != nil {
		t.Fatalf("farm slug: %v", err)
	}
	return slug
}

// The registration corners: a name too long, no name at all, a challenge
// that is not one of ours, a credential that is not a credential.
func TestPasskeyRegistrationEdges(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de llaves raras", 80000)
	opts := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, "/v1/me/passkeys/options", f.OwnerToken, reauth)
	expectStatus(t, "options", opts, http.StatusOK)
	key := newSoftPasskey(t)
	register := func(body map[string]any) response {
		return h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, "/v1/me/passkeys", f.OwnerToken, body)
	}

	expectStatus(t, "a long name", register(map[string]any{
		"challenge": opts.Body["challenge"], "credential": key.create(t, opts.Body, passkeyOrigin),
		"name": strings.Repeat("n", 200),
	}), http.StatusBadRequest)
	expectStatus(t, "a forged challenge", register(map[string]any{
		"challenge": "no-es-nuestro", "credential": key.create(t, opts.Body, passkeyOrigin),
	}), http.StatusBadRequest)
	expectStatus(t, "a credential that is not one", register(map[string]any{
		"challenge": opts.Body["challenge"], "credential": map[string]any{"id": "x"},
	}), http.StatusBadRequest)
	expectStatus(t, "options without the password", h.doOrigin(t, "10.0.0.1", passkeyOrigin,
		http.MethodPost, "/v1/me/passkeys/options", f.OwnerToken, map[string]any{}), http.StatusBadRequest)

	res := register(map[string]any{
		"challenge": opts.Body["challenge"], "credential": key.create(t, opts.Body, passkeyOrigin), "name": "   ",
	})
	expectStatus(t, "no name", res, http.StatusCreated)
	if res.Body["name"] != "Llave de acceso" {
		t.Fatalf("a blank name should get the default: %s", res.Raw)
	}
}

func TestPasskeyDeleteAndHostEdges(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca sin llave", 80000)
	del := func(id string) response {
		return h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodDelete, "/v1/me/passkeys/"+id, f.OwnerToken, nil)
	}
	expectStatus(t, "a malformed id", del("no-es-uuid"), http.StatusNotFound)
	expectStatus(t, "an unknown id", del("6f1c3a52-6a0e-4c43-9b51-0d2f3f3c1e11"), http.StatusNotFound)
	expectStatus(t, "a bare IP host", h.doAt(t, "127.0.0.1:8080", http.MethodGet, "/v1/me/passkeys", f.OwnerToken, nil),
		http.StatusBadRequest)
	expectStatus(t, "a farm subdomain of localhost", h.doAt(t, "finca.localhost:5173", http.MethodGet, "/v1/me/passkeys",
		f.OwnerToken, nil), http.StatusOK)
	expectStatus(t, "a garbage answer", h.doOrigin(t, "10.72.0.1", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "",
		map[string]any{"challenge": h.passkeyOptions(t, "10.72.0.1")["challenge"], "credential": map[string]any{"id": "x"}}),
		http.StatusUnauthorized)
}

// An owner of two farms who signs in with a passkey has to say which farm,
// and gets only farms the passkey opens.
func TestPasskeyLoginChoosesAFarm(t *testing.T) {
	h := requireDB(t)
	a := h.signupFarm(t, "Finca uno de la llave", 80000)
	b := h.signupFarm(t, "Finca dos de la llave", 80000)
	other := h.signupFarm(t, "Finca ajena a la llave", 80000)
	h.addOwner(t, b.FarmID, a.OwnerUserID)
	key := newSoftPasskey(t)
	h.registerPasskey(t, a.OwnerToken, key)

	res := h.passkeyLogin(t, "10.71.0.1", key, nil)
	expectStatus(t, "no farm named", res, http.StatusBadRequest)
	if !strings.Contains(res.Raw, b.FarmID) || !strings.Contains(res.Raw, a.FarmID) {
		t.Fatalf("the choice should list both farms: %s", res.Raw)
	}
	res = h.passkeyLogin(t, "10.71.0.2", key, map[string]any{"farmId": b.FarmID})
	expectStatus(t, "farm b by id", res, http.StatusOK)
	if res.Body["farmId"] != b.FarmID {
		t.Fatalf("signed into the wrong farm: %s", res.Raw)
	}
	res = h.passkeyLogin(t, "10.71.0.3", key, map[string]any{"farmSlug": h.farmSlug(t, a.FarmID)})
	expectStatus(t, "farm a by slug", res, http.StatusOK)
	expectStatus(t, "a farm it does not belong to", h.passkeyLogin(t, "10.71.0.4", key,
		map[string]any{"farmId": other.FarmID}), http.StatusForbidden)
	expectStatus(t, "slug and id that disagree", h.passkeyLogin(t, "10.71.0.5", key,
		map[string]any{"farmId": b.FarmID, "farmSlug": h.farmSlug(t, a.FarmID)}), http.StatusBadRequest)

	if _, err := h.admin.Exec(context.Background(), `UPDATE farms SET suspended_at = now() WHERE id = $1`, b.FarmID); err != nil {
		t.Fatal(err)
	}
	res = h.passkeyLogin(t, "10.71.0.6", key, map[string]any{"farmId": b.FarmID})
	expectStatus(t, "a suspended farm", res, http.StatusForbidden)
	if res.code() != "FARM_SUSPENDED" {
		t.Fatalf("expected FARM_SUSPENDED: %s", res.Raw)
	}
}

// A passkey whose account lost every membership opens nothing.
func TestPasskeyWithoutMembershipsOpensNothing(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca que se queda sin dueño", 80000)
	key := newSoftPasskey(t)
	h.registerPasskey(t, f.OwnerToken, key)
	if _, err := h.admin.Exec(context.Background(), `DELETE FROM memberships WHERE user_id = $1`, f.OwnerUserID); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, "no farm left", h.passkeyLogin(t, "10.73.0.1", key, nil), http.StatusForbidden)
}
