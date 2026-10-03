// SPDX-License-Identifier: MIT

package apitest

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

// TestWorkRecordRefusals walks the checks on creating, listing and editing a
// work record that the main flows never trip.
func TestWorkRecordRefusals(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca registros bordes", 250000)
	worker := h.createWorker(t, f, "Rita", "71000001")
	harvest := h.harvestActivityID(t, f)
	contract := mustString(t, h.mustDo(t, http.MethodPost, "/v1/activities", f.OwnerToken, map[string]any{
		"name": "Guadaña bordes", "payScheme": "contrato", "category": "Labores",
		"rate": map[string]any{"rateCents": 200000},
	}, http.StatusCreated).Body, "id")

	rec := func(extra map[string]any) map[string]any {
		b := map[string]any{"activityId": harvest, "workerId": worker, "quantity": 10, "dateFrom": "2026-08-24"}
		for k, v := range extra {
			b[k] = v
		}
		return b
	}
	for name, c := range map[string]struct {
		token string
		body  map[string]any
		want  int
	}{
		"no date":          {f.OwnerToken, rec(map[string]any{"dateFrom": ""}), http.StatusBadRequest},
		"bad date":         {f.OwnerToken, rec(map[string]any{"dateFrom": "24/08/2026"}), http.StatusBadRequest},
		"bad end":          {f.OwnerToken, rec(map[string]any{"dateTo": "mañana"}), http.StatusBadRequest},
		"end before start": {f.OwnerToken, rec(map[string]any{"dateTo": "2026-08-20"}), http.StatusBadRequest},
		"zero quantity":    {f.OwnerToken, rec(map[string]any{"quantity": 0}), http.StatusBadRequest},
		"zero rate":        {f.OwnerToken, rec(map[string]any{"rateCents": 0}), http.StatusBadRequest},
		"weigher rate":     {f.WeigherToken, rec(map[string]any{"rateCents": 100}), http.StatusForbidden},
		"weigher contract": {f.WeigherToken, rec(map[string]any{"activityId": contract}), http.StatusForbidden},
	} {
		t.Run(name, func(t *testing.T) {
			h.mustDo(t, http.MethodPost, "/v1/work-records", c.token, c.body, c.want)
		})
	}

	// A contract is one thing done once, whatever quantity was sent; a device
	// id marks the work as coming from a phone. The rate is named so the test
	// does not depend on which day the activity's rate starts.
	device := uuid.NewString()
	done := h.mustDo(t, http.MethodPost, "/v1/work-records", f.OwnerToken,
		rec(map[string]any{"activityId": contract, "quantity": 7, "rateCents": 150000, "deviceId": device}), http.StatusCreated)
	id := mustString(t, done.Body, "id")

	for _, q := range []string{"payScheme=nada", "from=ayer", "to=hoy"} {
		h.mustDo(t, http.MethodGet, "/v1/work-records?"+q, f.OwnerToken, nil, http.StatusBadRequest)
	}
	h.mustDo(t, http.MethodGet, "/v1/work-records?payScheme=contrato&from=2026-08-01&to=2026-08-31", f.OwnerToken, nil, http.StatusOK)

	path := "/v1/work-records/" + id
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"status": "borrado"}, http.StatusBadRequest)
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"quantity": -1}, http.StatusBadRequest)
	gone := h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"status": "inactive"}, http.StatusOK)
	if gone.Body["deletedAt"] == nil {
		t.Errorf("status inactive left the record live: %s", gone.Raw)
	}
	back := h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"status": "active"}, http.StatusOK)
	if back.Body["deletedAt"] != nil {
		t.Errorf("status active did not restore the record: %s", back.Raw)
	}
}

// TestUserMembershipEdges covers invite refusals, a no-op role change and
// removing one of two owners.
func TestUserMembershipEdges(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca usuarios bordes", 250000)

	h.mustDo(t, http.MethodPost, "/v1/users", f.AdminToken,
		map[string]any{"email": "nuevo-dueno@example.com", "role": "owner"}, http.StatusForbidden)
	h.mustDo(t, http.MethodPost, "/v1/users", f.OwnerToken,
		map[string]any{"email": "corta@example.com", "role": "weigher", "password": "corta"}, http.StatusBadRequest)

	same := h.mustDo(t, http.MethodPatch, "/v1/users/"+f.WeigherID, f.OwnerToken,
		map[string]any{"role": "weigher"}, http.StatusOK)
	if same.Body["role"] != "weigher" {
		t.Errorf("a no-op role change: %s", same.Raw)
	}

	second, _ := h.addUserWithID(t, f.FarmID, domain.RoleOwner)
	h.mustDo(t, http.MethodDelete, "/v1/users/"+second, f.OwnerToken, nil, http.StatusNoContent)
}

// TestExpenseRefusals covers the expense checks the main flows skip.
func TestExpenseRefusals(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca gastos bordes", 250000)
	plot := h.createPlot(t, f, "Lote gastos")

	h.mustDo(t, http.MethodGet, "/v1/expenses?from=ayer", f.OwnerToken, nil, http.StatusBadRequest)
	h.mustDo(t, http.MethodGet, "/v1/expenses?to=hoy", f.OwnerToken, nil, http.StatusBadRequest)
	h.mustDo(t, http.MethodPost, "/v1/expenses", f.OwnerToken,
		map[string]any{"concept": "Nada", "amountCents": 0, "plotId": plot}, http.StatusBadRequest)

	key := uuid.NewString()
	body := map[string]any{"id": key, "concept": "Abono", "amountCents": 120000, "plotId": plot}
	h.mustDo(t, http.MethodPost, "/v1/expenses", f.OwnerToken, body, http.StatusCreated)
	h.mustDo(t, http.MethodPost, "/v1/expenses", f.OwnerToken, body, http.StatusOK)
	h.mustDo(t, http.MethodGet, "/v1/expenses/"+key, f.OwnerToken, nil, http.StatusOK)

	path := "/v1/expenses/" + key
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"status": "borrado"}, http.StatusBadRequest)
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"amountCents": -1}, http.StatusBadRequest)
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"plotId": ""}, http.StatusBadRequest)
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"status": "inactive"}, http.StatusOK)
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"status": "active"}, http.StatusOK)
}
