package apitest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var mcpWriteToolNames = map[string]bool{
	"create_worker": true, "update_worker": true, "create_plot": true,
	"register_weighing": true, "register_harvest_week": true,
	"correct_weighing": true, "void_weighing": true,
	"set_kilo_price": true, "register_advance": true, "register_payment": true,
	"create_settlement": true, "void_settlement": true,
}

var mcpMoneyToolNames = map[string]bool{
	"set_kilo_price": true, "register_advance": true, "register_payment": true,
	"create_settlement": true, "void_settlement": true,
}

// structured reads a tool's structured content as a map.
func structured(t *testing.T, res *mcp.CallToolResult) map[string]any {
	t.Helper()
	raw, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatalf("structured content: %v", err)
	}
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return out
}

// mustTool calls a tool that must succeed and returns its structured content.
func mustTool(t *testing.T, sess *mcp.ClientSession, name string, args map[string]any) map[string]any {
	t.Helper()
	res := callTool(t, sess, name, args)
	if res.IsError {
		t.Fatalf("%s failed: %s", name, toolText(res))
	}
	return structured(t, res)
}

// resultOf is the route's own answer inside a write tool's structured content.
func resultOf(t *testing.T, sc map[string]any) map[string]any {
	t.Helper()
	r, _ := sc["result"].(map[string]any)
	if r == nil {
		t.Fatalf("no result in %v", sc)
	}
	return r
}

// previewToken asks a money tool for its preview and returns the token. It
// asserts the first call wrote nothing a client could mistake for success.
func previewToken(t *testing.T, sess *mcp.ClientSession, name string, args map[string]any) (string, map[string]any) {
	t.Helper()
	res := callTool(t, sess, name, args)
	if res.IsError {
		t.Fatalf("%s preview failed: %s", name, toolText(res))
	}
	sc := structured(t, res)
	if sc["status"] != "confirmation_required" {
		t.Fatalf("%s without a token should ask for confirmation, got %v", name, sc)
	}
	tok, _ := sc["confirmationToken"].(string)
	if tok == "" {
		t.Fatalf("%s preview carried no token: %v", name, sc)
	}
	if !strings.Contains(toolText(res), "CONFIRMACIÓN REQUERIDA") {
		t.Errorf("%s preview does not say nothing was written: %s", name, toolText(res))
	}
	return tok, sc
}

func withToken(args map[string]any, tok string) map[string]any {
	out := map[string]any{"confirmationToken": tok}
	for k, v := range args {
		out[k] = v
	}
	return out
}

func ledgerLen(t *testing.T, h *harness, f *farmFixture, workerID string) int {
	t.Helper()
	res := h.mustDo(t, http.MethodGet, "/v1/workers/"+workerID+"/ledger", f.OwnerToken, nil, http.StatusOK)
	items, _ := res.Body["items"].([]any)
	return len(items)
}

func balanceOf(t *testing.T, h *harness, f *farmFixture, workerID string) int64 {
	t.Helper()
	res := h.mustDo(t, http.MethodGet, "/v1/workers/"+workerID+"/balance", f.OwnerToken, nil, http.StatusOK)
	return int64(res.Body["balanceCents"].(float64))
}

// TestMCPWriteToolsEndToEnd walks every write tool once, as the owner, the
// way an assistant would: create, record, correct, price, pay, settle, undo.
func TestMCPWriteToolsEndToEnd(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca MCP escritura", 250000)
	sess := h.mcpClient(t, f.OwnerToken)

	// Workers.
	w := resultOf(t, mustTool(t, sess, "create_worker", map[string]any{
		"name": "Prueba", "lastName": "MCP", "documentType": "CC", "docId": "900000001", "tag": "77",
	}))
	workerID := w["id"].(string)
	up := resultOf(t, mustTool(t, sess, "update_worker", map[string]any{"id": workerID, "phone": "3000000000"}))
	if up["phone"] != "3000000000" {
		t.Errorf("update_worker did not change the phone: %v", up)
	}
	// Idempotent by id.
	key := uuid.NewString()
	a := mustTool(t, sess, "create_worker", map[string]any{"name": "Otra", "id": key})
	b := mustTool(t, sess, "create_worker", map[string]any{"name": "Otra", "id": key})
	if a["status"].(float64) != 201 || b["status"].(float64) != 200 {
		t.Errorf("create_worker with the same id twice: %v then %v", a["status"], b["status"])
	}

	// Plot with its crop.
	plot := resultOf(t, mustTool(t, sess, "create_plot", map[string]any{
		"name": "Lote MCP", "areaHa": 1.5, "cropType": "Café", "variety": "Castillo",
	}))
	crops, _ := plot["crops"].([]any)
	if len(crops) != 1 {
		t.Fatalf("create_plot did not create the crop: %v", plot)
	}
	plotID := plot["id"].(string)
	cropID := crops[0].(map[string]any)["id"].(string)

	// One weighing.
	wr := resultOf(t, mustTool(t, sess, "register_weighing", map[string]any{
		"workerId": workerID, "kg": 12.5, "date": "2026-08-24", "plotId": plotID, "plotCropId": cropID,
	}))
	weighingID := wr["id"].(string)
	if q := fmt.Sprint(wr["quantity"]); q != "12.5" && q != "12.500" {
		t.Errorf("register_weighing quantity: %v", wr["quantity"])
	}

	// A week, atomic and idempotent by batch id.
	batch := uuid.NewString()
	week := map[string]any{
		"monday": "2026-08-24", "id": batch,
		"weighings": []any{
			map[string]any{"workerId": workerID, "date": "2026-08-25", "kg": 40},
			map[string]any{"workerId": workerID, "date": "2026-08-26", "kg": 47.5, "plotId": plotID},
		},
	}
	first := resultOf(t, mustTool(t, sess, "register_harvest_week", week))
	if first["created"].(float64) != 2 {
		t.Fatalf("register_harvest_week created %v, want 2", first["created"])
	}
	again := resultOf(t, mustTool(t, sess, "register_harvest_week", week))
	if again["created"].(float64) != 0 || again["existing"].(float64) != 2 {
		t.Errorf("resending the same week wrote again: %v", again)
	}

	// Correct, then void.
	fixed := resultOf(t, mustTool(t, sess, "correct_weighing", map[string]any{"id": weighingID, "kg": 13}))
	if !strings.HasPrefix(fmt.Sprint(fixed["quantity"]), "13") {
		t.Errorf("correct_weighing: %v", fixed["quantity"])
	}
	mustTool(t, sess, "void_weighing", map[string]any{"id": weighingID})
	got := h.mustDo(t, http.MethodGet, "/v1/work-records/"+weighingID, f.OwnerToken, nil, http.StatusOK)
	if got.Body["deletedAt"] == nil {
		t.Errorf("void_weighing left the record live: %s", got.Raw)
	}

	// Week price: preview, confirm.
	priceArgs := map[string]any{"scope": "week", "monday": "2026-08-24", "priceCents": 300000}
	tok, pv := previewToken(t, sess, "set_kilo_price", priceArgs)
	if p := h.mustDo(t, http.MethodGet, "/v1/prices/weeks/2026-08-24", f.OwnerToken, nil, http.StatusOK); p.Body["priceCents"].(float64) != 250000 {
		t.Fatalf("the price preview changed the price: %s", p.Raw)
	}
	if !strings.Contains(pv["summary"].(string), "$2.500") || !strings.Contains(pv["summary"].(string), "$3.000") {
		t.Errorf("price preview should show old and new price: %v", pv["summary"])
	}
	mustTool(t, sess, "set_kilo_price", withToken(priceArgs, tok))
	if p := h.mustDo(t, http.MethodGet, "/v1/prices/weeks/2026-08-24", f.OwnerToken, nil, http.StatusOK); p.Body["priceCents"].(float64) != 300000 {
		t.Fatalf("set_kilo_price did not set it: %s", p.Raw)
	}
	// Base price too.
	baseArgs := map[string]any{"scope": "base", "monday": "2026-08-31", "priceCents": 260000}
	tok, _ = previewToken(t, sess, "set_kilo_price", baseArgs)
	mustTool(t, sess, "set_kilo_price", withToken(baseArgs, tok))

	// Advance: preview writes nothing; the token used twice writes once.
	before := ledgerLen(t, h, f, workerID)
	advArgs := map[string]any{"workerId": workerID, "amountCents": 1000000, "method": "efectivo"}
	tok, _ = previewToken(t, sess, "register_advance", advArgs)
	if ledgerLen(t, h, f, workerID) != before {
		t.Fatal("the advance preview wrote to the ledger")
	}
	adv1 := mustTool(t, sess, "register_advance", withToken(advArgs, tok))
	adv2 := mustTool(t, sess, "register_advance", withToken(advArgs, tok))
	if resultOf(t, adv1)["id"] != resultOf(t, adv2)["id"] {
		t.Errorf("the same confirmation wrote two advances: %v / %v", adv1, adv2)
	}
	if ledgerLen(t, h, f, workerID) != before+1 {
		t.Fatalf("one confirmation, used twice, should write exactly one movement")
	}

	// Settlement: 87.5 kg at $3.000 = $262.500.
	setArgs := map[string]any{"workerId": workerID, "from": "2026-08-24", "to": "2026-08-30"}
	tok, pv = previewToken(t, sess, "create_settlement", setArgs)
	facts := pv["preview"].(map[string]any)
	if facts["grossCents"].(float64) != 26250000 {
		t.Errorf("settlement preview gross: %v", facts["grossCents"])
	}
	st := resultOf(t, mustTool(t, sess, "create_settlement", withToken(setArgs, tok)))
	settlementID := st["id"].(string)
	// Used again: the same settlement, not a NOTHING_TO_SETTLE.
	st2 := resultOf(t, mustTool(t, sess, "create_settlement", withToken(setArgs, tok)))
	if st2["id"] != settlementID {
		t.Errorf("re-using the settlement token gave another settlement: %v", st2["id"])
	}

	// Payment against the balance (262.500 − 10.000 = 252.500).
	if bal := balanceOf(t, h, f, workerID); bal != 25250000 {
		t.Fatalf("balance before paying: %d", bal)
	}
	payArgs := map[string]any{"workerId": workerID, "amountCents": 20000000, "method": "transferencia"}
	tok, _ = previewToken(t, sess, "register_payment", payArgs)
	mustTool(t, sess, "register_payment", withToken(payArgs, tok))
	mustTool(t, sess, "register_payment", withToken(payArgs, tok))
	if bal := balanceOf(t, h, f, workerID); bal != 5250000 {
		t.Fatalf("balance after one confirmed payment used twice: %d, want 5250000", bal)
	}

	// Void the settlement.
	voidArgs := map[string]any{"id": settlementID}
	tok, _ = previewToken(t, sess, "void_settlement", voidArgs)
	mustTool(t, sess, "void_settlement", withToken(voidArgs, tok))
	mustTool(t, sess, "void_settlement", withToken(voidArgs, tok)) // a retry is harmless
	vs := h.mustDo(t, http.MethodGet, "/v1/settlements/"+settlementID, f.OwnerToken, nil, http.StatusOK)
	if vs.Body["status"] != "void" {
		t.Fatalf("void_settlement did not void: %s", vs.Raw)
	}
	res := callTool(t, sess, "void_settlement", voidArgs)
	if !res.IsError || !strings.Contains(toolText(res), "ya está anulada") {
		t.Errorf("previewing the void of a void settlement should refuse: %s", toolText(res))
	}

	// Deactivate.
	mustTool(t, sess, "update_worker", map[string]any{"id": workerID, "status": "inactive"})
	gw := h.mustDo(t, http.MethodGet, "/v1/workers/"+workerID, f.OwnerToken, nil, http.StatusOK)
	if gw.Body["deletedAt"] == nil {
		t.Errorf("update_worker status=inactive did not deactivate: %s", gw.Raw)
	}
}

// TestMCPMoneyRequiresConfirmation: no token, no movement; and a token only
// opens the exact operation it was issued for, to the person it was issued to.
func TestMCPMoneyRequiresConfirmation(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca MCP confirmación", 250000)
	workerID := h.createWorker(t, f, "Pago Confirmado", "900000002")
	activity := h.harvestActivityID(t, f)
	h.createWorkRecord(t, f, f.OwnerToken, workerID, activity, "2026-08-25", 10)
	sess := h.mcpClient(t, f.OwnerToken)

	args := map[string]any{"workerId": workerID, "amountCents": 500000}
	for i := 0; i < 3; i++ {
		previewToken(t, sess, "register_advance", args)
	}
	if n := ledgerLen(t, h, f, workerID); n != 0 {
		t.Fatalf("previews wrote %d movements", n)
	}

	tok, _ := previewToken(t, sess, "register_advance", args)
	cases := map[string]map[string]any{
		"other amount": withToken(map[string]any{"workerId": workerID, "amountCents": 900000}, tok),
		"garbage":      withToken(args, "not-a-token"),
		"tampered":     withToken(args, tok[:len(tok)-2]+"xx"),
	}
	for name, a := range cases {
		res := callTool(t, sess, "register_advance", a)
		if !res.IsError {
			t.Errorf("%s: an advance was accepted with a token that does not match: %s", name, toolText(res))
		}
	}
	// Another tool.
	res := callTool(t, sess, "register_payment", withToken(args, tok))
	if !res.IsError || !strings.Contains(toolText(res), "otra operación") {
		t.Errorf("a register_advance token opened register_payment: %s", toolText(res))
	}
	// Another person: the administrator of the same farm.
	admin := h.mcpClient(t, f.AdminToken)
	res = callTool(t, admin, "register_advance", withToken(args, tok))
	if !res.IsError || !strings.Contains(toolText(res), "otro usuario") {
		t.Errorf("the owner's token worked for the administrator: %s", toolText(res))
	}
	if n := ledgerLen(t, h, f, workerID); n != 0 {
		t.Fatalf("refused confirmations wrote %d movements", n)
	}
	mustTool(t, sess, "register_advance", withToken(args, tok))
	if n := ledgerLen(t, h, f, workerID); n != 1 {
		t.Fatalf("the right token wrote %d movements, want 1", n)
	}

	// A settlement confirmation stops being good when the work under it moves.
	setArgs := map[string]any{"workerId": workerID, "from": "2026-08-24", "to": "2026-08-30"}
	stok, _ := previewToken(t, sess, "create_settlement", setArgs)
	h.createWorkRecord(t, f, f.OwnerToken, workerID, activity, "2026-08-26", 5)
	res = callTool(t, sess, "create_settlement", withToken(setArgs, stok))
	if !res.IsError || !strings.Contains(toolText(res), "cambió") {
		t.Errorf("a settlement confirmed before a late weighing went through: %s", toolText(res))
	}
	list := h.mustDo(t, http.MethodGet, "/v1/settlements?workerId="+workerID, f.OwnerToken, nil, http.StatusOK)
	if list.Body["total"].(float64) != 0 {
		t.Errorf("a stale confirmation created a settlement: %s", list.Raw)
	}
}

// TestMCPWriteToolsKeepThePermissionTable: the weigher records weighings and
// cannot pay, advance, settle or price — not even to the preview. The
// administrator cannot set the price, which is the owner's.
func TestMCPWriteToolsKeepThePermissionTable(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca MCP roles", 250000)
	workerID := h.createWorker(t, f, "Rol Pesador", "900000003")
	weigher := h.mcpClient(t, f.WeigherToken)

	for name, args := range map[string]map[string]any{
		"register_payment":  {"workerId": workerID, "amountCents": 1000},
		"register_advance":  {"workerId": workerID, "amountCents": 1000},
		"create_settlement": {"workerId": workerID, "from": "2026-08-24", "to": "2026-08-30"},
		"void_settlement":   {"id": uuid.NewString()},
		"set_kilo_price":    {"scope": "week", "monday": "2026-08-24", "priceCents": 1},
		"create_worker":     {"name": "No"},
		"correct_weighing":  {"id": uuid.NewString(), "kg": 1},
	} {
		res := callTool(t, weigher, name, args)
		if !res.IsError || !strings.Contains(toolText(res), "FORBIDDEN") {
			t.Errorf("the weigher reached %s: %s", name, toolText(res))
		}
		if strings.Contains(toolText(res), "confirmationToken") {
			t.Errorf("the weigher was handed a confirmation token for %s", name)
		}
	}
	if n := ledgerLen(t, h, f, workerID); n != 0 {
		t.Fatalf("the weigher moved money: %d movements", n)
	}

	// What the weigher does all day, he does here too.
	res := callTool(t, weigher, "register_weighing", map[string]any{"workerId": workerID, "kg": 20, "date": "2026-08-25"})
	if res.IsError {
		t.Errorf("the weigher could not record a weighing: %s", toolText(res))
	}
	if strings.Contains(toolText(res), "amountCents") || strings.Contains(toolText(res), "estimatedAmountCents") {
		t.Errorf("the weigher's weighing came back with money in it: %s", toolText(res))
	}

	admin := h.mcpClient(t, f.AdminToken)
	res = callTool(t, admin, "set_kilo_price", map[string]any{"scope": "base", "monday": "2026-08-24", "priceCents": 1})
	if !res.IsError || !strings.Contains(toolText(res), "FORBIDDEN") {
		t.Errorf("the administrator reached set_kilo_price: %s", toolText(res))
	}
}

// TestHarvestWeekIsAllOrNothing: one bad line and no line is written.
func TestHarvestWeekIsAllOrNothing(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca MCP semana", 250000)
	workerID := h.createWorker(t, f, "Semana Atómica", "900000004")
	sess := h.mcpClient(t, f.OwnerToken)

	res := callTool(t, sess, "register_harvest_week", map[string]any{
		"monday": "2026-08-24",
		"weighings": []any{
			map[string]any{"workerId": workerID, "date": "2026-08-25", "kg": 10},
			map[string]any{"workerId": workerID, "date": "2026-09-02", "kg": 10}, // next week
		},
	})
	if !res.IsError || !strings.Contains(toolText(res), "line 1") {
		t.Fatalf("a week with a date outside it was accepted: %s", toolText(res))
	}
	res = callTool(t, sess, "register_harvest_week", map[string]any{
		"monday": "2026-08-24",
		"weighings": []any{
			map[string]any{"workerId": workerID, "date": "2026-08-25", "kg": 10},
			map[string]any{"workerId": uuid.NewString(), "date": "2026-08-26", "kg": 10},
		},
	})
	if !res.IsError {
		t.Fatalf("a week with an unknown worker was accepted: %s", toolText(res))
	}
	list := h.mustDo(t, http.MethodGet, "/v1/work-records?workerId="+workerID, f.OwnerToken, nil, http.StatusOK)
	if items, _ := list.Body["items"].([]any); len(items) != 0 {
		t.Fatalf("a refused week left %d records behind", len(items))
	}
}

// TestMCPBrowserGetExplainsItself: a person opening /mcp gets a page; an MCP
// client still gets the 401 and its challenge.
func TestMCPBrowserGetExplainsItself(t *testing.T) {
	h := requireDB(t)
	req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	req.Host = "cafin3.bascula.engp.io"
	req.RemoteAddr = "10.0.0.1:12345"
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Conector de Báscula") {
		t.Fatalf("browser GET /mcp: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "cafin3.bascula.engp.io/mcp") {
		t.Errorf("the page should show this host's connector address")
	}

	req = httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.Header.Set("Accept", "text/event-stream")
	req.RemoteAddr = "10.0.0.1:12345"
	rec = httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Header().Get("WWW-Authenticate"), "resource_metadata") {
		t.Fatalf("an MCP client's GET lost its challenge: %d %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
}
