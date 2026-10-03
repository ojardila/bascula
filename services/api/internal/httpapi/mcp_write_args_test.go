package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/ojardila/bascula/services/api/internal/auth"
)

// The MCP SDK validates arguments against each tool's input schema before a
// handler runs, so the checks below are the second line: they are what keeps a
// client that slips past the schema (or a schema that drifts from the code)
// from sending a malformed inner request. They are exercised here directly.

func writeTool(t *testing.T, name string) mcpWriteTool {
	t.Helper()
	for _, tl := range mcpWriteTools {
		if tl.Name == name {
			return tl
		}
	}
	t.Fatalf("no write tool named %q", name)
	return mcpWriteTool{}
}

func wantErr(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected an error mentioning %q, got none", want)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("error %q should mention %q", err, want)
	}
}

func TestMCPArgsNumbers(t *testing.T) {
	a := mcpArgs{
		"kg":      json.Number("12.5"),
		"text":    " 7.25 ",
		"word":    "doce",
		"flag":    true,
		"cents":   json.Number("1500"),
		"decimal": json.Number("15.5"),
	}

	if n, err := a.num("kg"); err != nil || n != "12.5" {
		t.Errorf("num(kg) = %q, %v; want the number exactly as written", n, err)
	}
	if n, err := a.num("text"); err != nil || n != "7.25" {
		t.Errorf("num(text) = %q, %v; a numeric string is accepted, trimmed", n, err)
	}
	_, err := a.num("word")
	wantErr(t, err, `"word" debe ser un número`)
	_, err = a.num("flag")
	wantErr(t, err, `"flag" debe ser un número`)

	if i, err := a.int("cents"); err != nil || i != 1500 {
		t.Errorf("int(cents) = %d, %v", i, err)
	}
	_, err = a.int("decimal")
	wantErr(t, err, "sin decimales")
	_, err = a.int("word")
	wantErr(t, err, `"word" debe ser un entero`)
}

func TestParseMCPArgs(t *testing.T) {
	params := []mcpParam{
		{Name: "workerId", Required: true},
		{Name: "note"},
	}
	req := func(raw string) *mcp.CallToolRequest {
		return &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{Arguments: json.RawMessage(raw)}}
	}

	a, err := parseMCPArgs(req(`{"workerId":"w-1","note":null}`), params)
	if err != nil {
		t.Fatalf("valid arguments refused: %v", err)
	}
	if _, present := a["note"]; present {
		t.Error("a null argument should be dropped, as if it had not been sent")
	}

	_, err = parseMCPArgs(req(`{"workerId":`), params)
	wantErr(t, err, "argumentos inválidos")
	_, err = parseMCPArgs(req(`{"workerId":"w-1","amount":5}`), params)
	wantErr(t, err, `parámetro desconocido: "amount"`)
	_, err = parseMCPArgs(req(`{"note":"x"}`), params)
	wantErr(t, err, `falta el parámetro obligatorio "workerId"`)
	_, err = parseMCPArgs(req(``), params)
	wantErr(t, err, "workerId")
}

func TestMCPArgsUUIDList(t *testing.T) {
	a := mcpArgs{
		"ok":    []any{" a ", "b"},
		"blank": []any{"a", "  "},
		"num":   []any{"a", 3.0},
		"str":   "a,b",
	}
	got, err := a.uuidList("ok")
	if err != nil || len(got) != 2 || got[0] != "a" {
		t.Errorf("uuidList(ok) = %v, %v; want trimmed ids", got, err)
	}
	if got, err := a.uuidList("missing"); err != nil || got == nil || len(got) != 0 {
		t.Errorf("an absent list reads as empty, not nil: %v, %v", got, err)
	}
	_, err = a.uuidList("blank")
	wantErr(t, err, "blank[1] debe ser un UUID")
	_, err = a.uuidList("num")
	wantErr(t, err, "num[1] debe ser un UUID")
	_, err = a.uuidList("str")
	wantErr(t, err, `"str" debe ser una lista de UUID`)
}

func TestMCPWorkerNames(t *testing.T) {
	if got := workerName(map[string]any{}); got != "el trabajador" {
		t.Errorf("a nameless worker reads %q", got)
	}
	member := func(n string) any { return map[string]any{"name": n} }
	cases := []struct {
		members []any
		want    string
	}{
		{nil, "ningún integrante"},
		{[]any{member("Ana")}, "Ana"},
		{[]any{member("Ana"), member("Luis"), member("Rosa")}, "Ana, Luis y Rosa"},
	}
	for _, c := range cases {
		if got := memberNames(map[string]any{"members": c.members}); got != c.want {
			t.Errorf("memberNames(%v) = %q, want %q", c.members, got, c.want)
		}
	}
	if got := numField(map[string]any{"n": json.Number("42")}, "n"); got != 42 {
		t.Errorf("numField(json.Number) = %d", got)
	}
	if got := numField(map[string]any{"n": "42"}, "n"); got != 0 {
		t.Errorf("numField(string) = %d, want 0", got)
	}
}

func TestMCPHarvestWeekBuild(t *testing.T) {
	build := writeTool(t, "register_harvest_week").Build
	row := func(extra map[string]any) map[string]any {
		r := map[string]any{"workerId": "w-1", "date": "2026-08-25", "kg": json.Number("10")}
		for k, v := range extra {
			r[k] = v
		}
		return r
	}
	refuse := []struct {
		name      string
		weighings any
		want      string
	}{
		{"not a list", "x", "al menos una pesada"},
		{"empty", []any{}, "al menos una pesada"},
		{"row not an object", []any{"x"}, "weighings[0] debe ser un objeto"},
		{"unknown key", []any{row(map[string]any{"price": 1})}, `weighings[0]: parámetro desconocido "price"`},
		{"missing kg", []any{map[string]any{"workerId": "w-1", "date": "2026-08-25"}}, "necesita workerId, date y kg"},
		{"kg not a number", []any{row(nil), row(map[string]any{"kg": "diez"})}, "weighings[1]:"},
	}
	for _, c := range refuse {
		t.Run(c.name, func(t *testing.T) {
			_, err := build(mcpArgs{"monday": "2026-08-24", "weighings": c.weighings}, "")
			wantErr(t, err, c.want)
		})
	}

	call, err := build(mcpArgs{
		"monday": "2026-08-24", "activityId": "act", "id": "batch-1",
		"weighings": []any{row(map[string]any{"plotId": "p", "plotCropId": "c", "note": "lluvia"})},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if call.Path != "/v1/work-records/batch" || call.Body["activityId"] != "act" || call.Body["id"] != "batch-1" {
		t.Fatalf("unexpected call %+v", call)
	}
	it := call.Body["items"].([]any)[0].(map[string]any)
	if it["quantity"] != json.Number("10") || it["dateFrom"] != "2026-08-25" ||
		it["plotIds"].([]any)[0] != "p" || it["plotCropIds"].([]any)[0] != "c" || it["note"] != "lluvia" {
		t.Errorf("a weighing row maps onto the batch item wrongly: %v", it)
	}
}

func TestMCPMoneyBuilders(t *testing.T) {
	payment := buildLedger("/v1/payments", true)
	_, err := payment(mcpArgs{"amountCents": "mucho"}, "")
	wantErr(t, err, "amountCents")
	_, err = payment(mcpArgs{"amountCents": json.Number("0")}, "")
	wantErr(t, err, "positivo")
	call, err := payment(mcpArgs{"workerId": "w", "amountCents": json.Number("500"), "allowOverpayment": true, "note": "x"}, "key-1")
	if err != nil {
		t.Fatal(err)
	}
	if call.Body["id"] != "key-1" || call.Body["allowOverpayment"] != true || call.Body["amountCents"] != int64(500) {
		t.Errorf("payment body %v: the confirmation key must become the id", call.Body)
	}
	advance := buildLedger("/v1/advances", false)
	call, _ = advance(mcpArgs{"workerId": "w", "amountCents": json.Number("500"), "allowOverpayment": true}, "")
	if _, ok := call.Body["allowOverpayment"]; ok {
		t.Error("allowOverpayment belongs to payments only")
	}
	if _, ok := call.Body["id"]; ok {
		t.Error("no key, no id")
	}

	_, err = buildPrice(mcpArgs{"priceCents": json.Number("1.5")}, "")
	wantErr(t, err, "sin decimales")
	_, err = buildPrice(mcpArgs{"priceCents": json.Number("-1")}, "")
	wantErr(t, err, "positivo")
	call, _ = buildPrice(mcpArgs{"scope": "week", "monday": "2026-08-24", "priceCents": json.Number("90000")}, "")
	if call.Path != pathPriceWeeksSlash+"2026-08-24" {
		t.Errorf("a week price goes to the week route, got %s", call.Path)
	}
	if got := donePrice(0, nil, mcpArgs{"scope": "week", "monday": "2026-08-24", "priceCents": json.Number("90000")}); !strings.Contains(got, "semana del 2026-08-24") {
		t.Errorf("donePrice(week) = %q", got)
	}

	in := settlementInput(mcpArgs{"workerId": "w", "from": "a", "to": "b", "payableIds": []any{"p"}})
	if _, ok := in["payableIds"]; !ok {
		t.Error("named payables reach the preview")
	}
	b1, ids, gross := settlementBind(map[string]any{"grossCents": 100.0, "items": []any{
		map[string]any{"payableId": "z"}, map[string]any{"payableId": "a"}, map[string]any{},
	}})
	b2, _, _ := settlementBind(map[string]any{"grossCents": 100.0, "items": []any{
		map[string]any{"payableId": "a"}, map[string]any{"payableId": "z"},
	}})
	if b1 != b2 || gross != 100 || len(ids) != 2 || ids[0] != "a" {
		t.Errorf("the bind must not depend on line order: %q vs %q, ids %v", b1, b2, ids)
	}
}

func TestMCPOpenConfirmation(t *testing.T) {
	s := &Server{signer: auth.NewSigner([]byte("test-signing-key"), "bascula")}
	p := &auth.Principal{UserID: "u-1", FarmID: "f-1"}
	a := mcpArgs{"workerId": "w-1", "amountCents": json.Number("500")}
	seal := func(c mcpConfirmation) string {
		raw, _ := json.Marshal(c)
		return s.signer.Seal(mcpConfirmPurpose, raw)
	}
	good := mcpConfirmation{V: 1, Tool: "register_payment", User: "u-1", Farm: "f-1",
		Args: mcpArgsHash(a), Exp: time.Now().Add(time.Minute).Unix()}

	if claim, msg := s.mcpOpenConfirmation(seal(good), "register_payment", p, a); claim == nil || msg != "" {
		t.Fatalf("a fresh token for the same call should open: %q", msg)
	}

	expired := good
	expired.Exp = time.Now().Add(-time.Minute).Unix()
	wrongVersion := good
	wrongVersion.V = 2
	otherFarm := good
	otherFarm.Farm = "f-2"
	cases := []struct {
		name, token, tool string
		args              mcpArgs
		want              string
	}{
		{"not a token", "garbage", "register_payment", a, "no es válido"},
		{"sealed for another purpose", s.signer.Seal("other", []byte(`{"v":1}`)), "register_payment", a, "no es válido"},
		{"unknown version", seal(wrongVersion), "register_payment", a, "no es válido"},
		{"another tool", seal(good), "register_advance", a, "de otra operación (register_payment)"},
		{"another farm", seal(otherFarm), "register_payment", a, "otra finca"},
		{"expired", seal(expired), "register_payment", a, "venció"},
		{"other arguments", seal(good), "register_payment", mcpArgs{"workerId": "w-1", "amountCents": json.Number("501")}, "no son los mismos"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			claim, msg := s.mcpOpenConfirmation(c.token, c.tool, p, c.args)
			if claim != nil || !strings.Contains(msg, c.want) {
				t.Errorf("got claim=%v msg=%q, want refusal mentioning %q", claim, msg, c.want)
			}
		})
	}
}

func TestMCPInnerReplies(t *testing.T) {
	if _, err := decodeInner(200, []byte("<html>")); err == nil || !strings.Contains(err.Error(), "respuesta inesperada") {
		t.Errorf("a non-JSON 200 must not pass as an empty object: %v", err)
	}
	if out, err := decodeInner(204, nil); err != nil || len(out) != 0 {
		t.Errorf("an empty reply reads as an empty object: %v, %v", out, err)
	}
	if _, err := decodeInner(409, []byte(`{"error":{}}`)); err == nil || err.Error() != `{"error":{}}` {
		t.Errorf("a refusal carries the route's own envelope: %v", err)
	}

	done := writeTool(t, "update_worker").Done
	w := map[string]any{"name": "Yorman", "lastName": "y Sergio"}
	if got := done(200, w, mcpArgs{"kind": "equipo"}); !strings.Contains(got, "Ahora es un equipo: Yorman y Sergio") ||
		!strings.Contains(got, "set_team_members") {
		t.Errorf("turning a worker into a team should point at set_team_members: %q", got)
	}
	if got := done(200, w, mcpArgs{"phone": "300"}); got != "Trabajador actualizado: Yorman y Sergio." {
		t.Errorf("plain update reads %q", got)
	}
}
