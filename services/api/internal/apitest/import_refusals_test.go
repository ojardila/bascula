// SPDX-License-Identifier: MIT

package apitest

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// TestSeasonImportRefusesBadRows sends one bad row per case. Each is refused
// with a 400 that names it, before the reconciliation runs.
func TestSeasonImportRefusesBadRows(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca import bordes", 80000)
	w := uuid.NewString()
	id := uuid.NewString

	settlement := func(extra map[string]any) []map[string]any {
		s := map[string]any{"id": id(), "workerId": w, "periodStart": "2026-08-24", "periodEnd": "2026-08-30", "grossCents": 1}
		for k, v := range extra {
			s[k] = v
		}
		return []map[string]any{s}
	}
	item := func(extra map[string]any) []map[string]any {
		it := map[string]any{"payableId": id(), "weekStart": "2026-08-24", "quantity": 1, "priceCents": 1, "amountCents": 1}
		for k, v := range extra {
			it[k] = v
		}
		return []map[string]any{it}
	}
	ledger := func(extra map[string]any) []map[string]any {
		l := map[string]any{"id": id(), "workerId": w, "kind": "anticipo", "amountCents": -100, "date": "2026-08-26"}
		for k, v := range extra {
			l[k] = v
		}
		return []map[string]any{l}
	}

	cases := map[string]map[string]any{
		"worker without a name": {"workers": []map[string]any{{"id": w}}},
		"worker id not a uuid":  {"workers": []map[string]any{{"id": "ana", "name": "Ana"}}},
		"plot without a crop":   {"plots": []map[string]any{{"name": "Lote"}}},
		"plot area too precise": {"plots": []map[string]any{{"cropId": id(), "name": "Lote", "areaHa": 1.23456}}},

		"week price date":     {"weekPrices": []map[string]any{{"weekStart": "24/08/2026", "priceCents": 1}}},
		"week price tuesday":  {"weekPrices": []map[string]any{{"weekStart": "2026-08-25", "priceCents": 1}}},
		"week price zero":     {"weekPrices": []map[string]any{{"weekStart": "2026-08-24", "priceCents": 0}}},
		"week price too old":  {"weekPrices": []map[string]any{{"weekStart": "2010-01-04", "priceCents": 1}}},
		"weighing no worker":  {"workRecords": []map[string]any{{"id": id(), "quantity": 1, "occurredAt": "2026-08-25T14:00:00-05:00"}}},
		"weighing no time":    {"workRecords": []map[string]any{{"id": id(), "workerId": w, "quantity": 1}}},
		"weighing id":         {"workRecords": []map[string]any{{"id": "p-1", "workerId": w, "quantity": 1, "occurredAt": "2026-08-25T14:00:00-05:00"}}},
		"weighing too old":    {"workRecords": []map[string]any{{"id": id(), "workerId": w, "quantity": 1, "occurredAt": "2010-08-25T14:00:00-05:00"}}},
		"settlement worker":   {"settlements": settlement(map[string]any{"workerId": ""})},
		"settlement start":    {"settlements": settlement(map[string]any{"periodStart": "ayer"})},
		"settlement end":      {"settlements": settlement(map[string]any{"periodEnd": "hoy"})},
		"settlement status":   {"settlements": settlement(map[string]any{"status": "pagada"})},
		"settlement void":     {"settlements": settlement(map[string]any{"status": "void"})},
		"settlement id":       {"settlements": settlement(map[string]any{"id": "s-1"})},
		"settlement too old":  {"settlements": settlement(map[string]any{"periodStart": "2010-08-24"})},
		"settlement too new":  {"settlements": settlement(map[string]any{"periodEnd": "2099-08-30"})},
		"settlement reversed": {"settlements": settlement(map[string]any{"periodEnd": "2026-08-20"})},
		"line payable id":     {"settlements": settlement(map[string]any{"items": item(map[string]any{"payableId": "p-1"})})},
		"line quantity":       {"settlements": settlement(map[string]any{"items": item(map[string]any{"quantity": 1.23456})})},
		"line week":           {"settlements": settlement(map[string]any{"items": item(map[string]any{"weekStart": "semana"})})},
		"movement worker":     {"ledger": ledger(map[string]any{"workerId": ""})},
		"movement zero":       {"ledger": ledger(map[string]any{"amountCents": 0})},
		"movement id":         {"ledger": ledger(map[string]any{"id": "m-1"})},
		"movement date":       {"ledger": ledger(map[string]any{"date": "26/08/2026"})},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			body["deviceId"] = id()
			if _, ok := body["workers"]; !ok {
				body["workers"] = []map[string]any{{"id": w, "name": "Ana"}}
			}
			body["balances"] = []map[string]any{{"workerId": w, "balanceCents": 0}}
			h.mustDo(t, http.MethodPost, "/v1/import/season", f.OwnerToken, body, http.StatusBadRequest)
		})
	}
}

// TestSeasonImportDefaultsTheCropType: a plot from an old handset carries no
// crop type and is imported as coffee.
func TestSeasonImportDefaultsTheCropType(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca import cultivo", 80000)
	w := uuid.NewString()
	h.mustDo(t, http.MethodPost, "/v1/import/season", f.OwnerToken, map[string]any{
		"deviceId": uuid.NewString(),
		"workers":  []map[string]any{{"id": w, "name": "Lía"}},
		"plots":    []map[string]any{{"cropId": uuid.NewString(), "name": "Lote viejo"}},
		"balances": []map[string]any{{"workerId": w, "balanceCents": 0}},
	}, http.StatusOK)
	res := h.mustDo(t, http.MethodGet, "/v1/plots?q=viejo", f.OwnerToken, nil, http.StatusOK)
	items, _ := res.Body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("the imported plot: %s", res.Raw)
	}
	crops, _ := items[0].(map[string]any)["crops"].([]any)
	if len(crops) != 1 || crops[0].(map[string]any)["cropType"] != "Cafe" {
		t.Errorf("a plot without a crop type should be coffee: %s", res.Raw)
	}
}
