// SPDX-License-Identifier: MIT

package apitest

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// The operator console's farm creation, on the requests the console never
// sends, plus the replays and account cases it does.
func TestAdminFarmCreateEdges(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del operador", 80000)
	token := h.superadminToken(t, f.FarmID)
	create := func(body map[string]any) response {
		return h.do(t, http.MethodPost, "/v1/admin/farms", token, body)
	}
	farm := func(email string, extra map[string]any) map[string]any {
		b := map[string]any{"name": "Finca de consola", "priceCents": 90000,
			"owner": map[string]any{"email": email, "name": "Dueña"}}
		for k, v := range extra {
			b[k] = v
		}
		return b
	}
	email := func() string { return fmt.Sprintf("consola-%s@example.com", uuid.NewString()[:8]) }

	expectStatus(t, "no name", create(farm(email(), map[string]any{"name": " "})), http.StatusBadRequest)
	expectStatus(t, "no price", create(farm(email(), map[string]any{"priceCents": 0})), http.StatusBadRequest)
	expectStatus(t, "no email", create(farm("sin-arroba", nil)), http.StatusBadRequest)
	expectStatus(t, "short password", create(farm(email(), map[string]any{
		"owner": map[string]any{"email": email(), "password": "corta"}})), http.StatusBadRequest)
	expectStatus(t, "long password", create(farm(email(), map[string]any{
		"owner": map[string]any{"email": email(), "password": strings.Repeat("x", 300)}})), http.StatusBadRequest)
	expectStatus(t, "unknown timezone", create(farm(email(), map[string]any{"timezone": "Marte/Olimpo"})), http.StatusBadRequest)

	id := uuid.NewString()
	first := create(farm(email(), map[string]any{"id": id}))
	expectStatus(t, "a minted password", first, http.StatusCreated)
	expectStatus(t, "the same id again", create(farm(email(), map[string]any{"id": id})), http.StatusOK)

	// An account that exists and never verified is vouched for by the operator.
	pending := email()
	if _, err := h.admin.Exec(context.Background(),
		`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, 'Pendiente', 'x')`,
		uuid.NewString(), pending); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, "an unverified account as owner", create(farm(pending, nil)), http.StatusCreated)
	var verified bool
	if err := h.admin.QueryRow(context.Background(),
		`SELECT email_verified_at IS NOT NULL FROM users WHERE email = $1`, pending).Scan(&verified); err != nil || !verified {
		t.Fatalf("the operator's owner is still unverified: %v %v", verified, err)
	}

	expectStatus(t, "a status nobody knows", h.do(t, http.MethodPatch, "/v1/admin/farms/"+id, token,
		map[string]any{"status": "dormida"}), http.StatusBadRequest)
}

func TestFarmSettingsRefusals(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de ajustes", 80000)
	put := func(body map[string]any) response { return h.do(t, http.MethodPut, "/v1/farm", f.OwnerToken, body) }
	expectStatus(t, "zero price", put(map[string]any{"priceCents": 0}), http.StatusBadRequest)
	expectStatus(t, "area too precise", put(map[string]any{"areaHa": 1.23456}), http.StatusBadRequest)
	expectStatus(t, "unknown timezone", put(map[string]any{"timezone": "Marte/Olimpo"}), http.StatusBadRequest)
	expectStatus(t, "a good area", put(map[string]any{"areaHa": 12.5}), http.StatusOK)
}
