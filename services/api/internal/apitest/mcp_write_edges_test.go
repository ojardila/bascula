// SPDX-License-Identifier: MIT

package apitest

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// toolRefuses calls a tool that must answer with a readable tool error that
// mentions want.
func toolRefuses(t *testing.T, sess *mcp.ClientSession, name string, args map[string]any, want string) {
	t.Helper()
	res := callTool(t, sess, name, args)
	if !res.IsError {
		t.Errorf("%s %v should be refused, got: %s", name, args, toolText(res))
		return
	}
	if !strings.Contains(toolText(res), want) {
		t.Errorf("%s %v: error should mention %q, got: %s", name, args, want, toolText(res))
	}
}

// toolSays calls a tool that must succeed and whose text mentions want.
func toolSays(t *testing.T, sess *mcp.ClientSession, name string, args map[string]any, want string) map[string]any {
	t.Helper()
	res := callTool(t, sess, name, args)
	if res.IsError {
		t.Fatalf("%s failed: %s", name, toolText(res))
	}
	if !strings.Contains(toolText(res), want) {
		t.Errorf("%s: text should mention %q, got: %s", name, want, toolText(res))
	}
	return structured(t, res)
}

// TestMCPWriteToolsRefuseBadArguments walks the argument checks each write
// tool runs before it reaches a route.
func TestMCPWriteToolsRefuseBadArguments(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca MCP bordes", 250000)
	sess := h.mcpClient(t, f.OwnerToken)

	w := resultOf(t, mustTool(t, sess, "create_worker", map[string]any{"name": "Borde", "tag": "B-1"}))
	workerID := w["id"].(string)

	toolRefuses(t, sess, "update_worker", map[string]any{"id": workerID}, "cambio")
	toolRefuses(t, sess, "create_team", map[string]any{"name": "Vacío", "tag": "E-0", "memberIds": []any{}}, "memberIds")
	toolRefuses(t, sess, "create_plot", map[string]any{"name": "L", "cropType": "Café", "crops": []any{}}, "cropType o crops")
	toolRefuses(t, sess, "create_plot", map[string]any{"name": "L", "variety": "Castillo"}, "variety")
	toolRefuses(t, sess, "correct_weighing", map[string]any{"id": uuid.NewString()}, "kg o note")

	week := func(rows ...any) map[string]any {
		return map[string]any{"monday": "2026-08-24", "weighings": rows}
	}
	toolRefuses(t, sess, "register_harvest_week", week(), "weighings")
	toolRefuses(t, sess, "register_harvest_week", week(map[string]any{"workerId": workerID, "date": "2026-08-25"}), "weighings[0]")

	toolRefuses(t, sess, "register_advance", map[string]any{"workerId": workerID, "amountCents": 0}, "positivo")
	toolRefuses(t, sess, "register_payment", map[string]any{"workerId": workerID, "amountCents": -5}, "positivo")
	toolRefuses(t, sess, "set_kilo_price", map[string]any{"scope": "base", "monday": "2026-08-24", "priceCents": 0}, "positivo")
	toolRefuses(t, sess, "set_kilo_price", map[string]any{"scope": "base", "monday": "2026-08-25", "priceCents": 1000}, "lunes")
	toolRefuses(t, sess, "create_settlement", map[string]any{"workerId": workerID, "from": "2026-08-24", "to": "2026-08-30"}, "pendiente")
}

// TestMCPWriteToolsReplayAndVariants covers the idempotent replies and the
// optional shapes of the write tools.
func TestMCPWriteToolsReplayAndVariants(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca MCP variantes", 250000)
	sess := h.mcpClient(t, f.OwnerToken)

	a := resultOf(t, mustTool(t, sess, "create_worker", map[string]any{"name": "Ana", "tag": "V-1"}))
	b := resultOf(t, mustTool(t, sess, "create_worker", map[string]any{"name": "Beto", "tag": "V-2"}))
	aID, bID := a["id"].(string), b["id"].(string)

	toolSays(t, sess, "update_worker", map[string]any{"id": bID, "status": "inactive"}, "")
	toolSays(t, sess, "update_worker", map[string]any{"id": bID, "status": "active"}, "activo")

	teamKey := uuid.NewString()
	team := map[string]any{"id": teamKey, "name": "Ana y Beto", "tag": "V-3", "memberIds": []any{aID, bID}}
	mustTool(t, sess, "create_team", team)
	toolSays(t, sess, "create_team", team, "ya existía")

	plotKey := uuid.NewString()
	plot := map[string]any{"id": plotKey, "name": "Lote variantes", "crops": []any{map[string]any{"cropType": "Café"}}}
	created := resultOf(t, mustTool(t, sess, "create_plot", plot))
	toolSays(t, sess, "create_plot", plot, "ya existía")
	plotID := created["id"].(string)
	var cropID string
	if crops, _ := created["crops"].([]any); len(crops) == 1 {
		cropID, _ = crops[0].(map[string]any)["id"].(string)
	} else {
		t.Fatalf("create_plot with crops: %v", created)
	}

	wKey := uuid.NewString()
	weighing := map[string]any{"id": wKey, "workerId": aID, "kg": 10, "date": "2026-08-24"}
	mustTool(t, sess, "register_weighing", weighing)
	toolSays(t, sess, "register_weighing", weighing, "ya estaba registrada")

	week := map[string]any{"monday": "2026-08-24", "weighings": []any{
		map[string]any{"workerId": aID, "date": "2026-08-25", "kg": 5, "plotId": plotID, "plotCropId": cropID, "note": "con nota"},
	}}
	toolSays(t, sess, "register_harvest_week", week, "Semana registrada")
	toolSays(t, sess, "correct_weighing", map[string]any{"id": resultOf(t, mustTool(t, sess, "register_weighing",
		map[string]any{"workerId": aID, "kg": 3, "date": "2026-08-26"}))["id"], "note": "revisada"}, "corregida")

	// A payment over the balance: the preview warns, with and without the
	// overpayment flag, and carries the date and the note.
	pay := map[string]any{"workerId": aID, "amountCents": 999999999, "date": "2026-08-27", "note": "adelanto"}
	_, pv := previewToken(t, sess, "register_payment", pay)
	if s, _ := pv["summary"].(string); !strings.Contains(s, "allowOverpayment") || !strings.Contains(s, "2026-08-27") || !strings.Contains(s, "adelanto") {
		t.Errorf("payment preview over the balance: %v", pv["summary"])
	}
	pay["allowOverpayment"] = true
	tok, pv := previewToken(t, sess, "register_payment", pay)
	if s, _ := pv["summary"].(string); !strings.Contains(s, "anticipo") {
		t.Errorf("overpayment preview: %v", pv["summary"])
	}
	mustTool(t, sess, "register_payment", withToken(pay, tok))
}
