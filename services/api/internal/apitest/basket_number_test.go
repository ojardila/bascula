package apitest

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// «Número de canasto» (docs/use-cases/basket-numbers.md): the worker's `tag`
// is required on create, trimmed, unique among the farm's ACTIVE workers and
// teams, and a clash names who has it.

func errDetails(res response) map[string]any {
	e, _ := res.Body["error"].(map[string]any)
	d, _ := e["details"].(map[string]any)
	return d
}

func TestBasketNumberRules(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de los canastos", 80000)

	post := func(body map[string]any) response {
		return h.do(t, http.MethodPost, "/v1/workers", f.OwnerToken, body)
	}

	a3BasketRequired(t, post)

	// Trimmed on the way in.
	yorman := post(map[string]any{"name": "Yorman", "lastName": "Pérez", "tag": " 46 "})
	if yorman.Status != http.StatusCreated || yorman.Body["tag"] != "46" {
		t.Fatalf("create Yorman: %d %s", yorman.Status, yorman.Raw)
	}
	yormanID := yorman.Body["id"].(string)
	sergio := post(map[string]any{"name": "Sergio", "tag": "63"})
	sergioID := sergio.Body["id"].(string)

	// Unique among the active, ignoring case and spaces, naming the holder.
	dup := post(map[string]any{"name": "Otro", "tag": "46"})
	if dup.Status != http.StatusConflict || errCode(dup) != "DUPLICATE_TAG" {
		t.Fatalf("second 46: %d %s", dup.Status, dup.Raw)
	}
	if d := errDetails(dup); d["employeeId"] != yormanID || d["name"] != "Yorman" || d["lastName"] != "Pérez" {
		t.Errorf("DUPLICATE_TAG details should name Yorman: %v", d)
	}
	post(map[string]any{"name": "Ana", "tag": "a7"})
	if res := post(map[string]any{"name": "Beto", "tag": " A7"}); errCode(res) != "DUPLICATE_TAG" {
		t.Errorf("A7 vs a7 should clash: %d %s", res.Status, res.Raw)
	}

	// A team has its own number, which cannot be a member's; members keep theirs.
	if res := post(map[string]any{"name": "Yorman y Sergio", "kind": "equipo", "tag": "46",
		"memberIds": []string{yormanID, sergioID}}); errCode(res) != "DUPLICATE_TAG" {
		t.Errorf("team with a member's number: %d %s", res.Status, res.Raw)
	}
	team := post(map[string]any{"name": "Yorman y Sergio", "kind": "equipo", "tag": "46-63",
		"memberIds": []string{yormanID, sergioID}})
	if team.Status != http.StatusCreated {
		t.Fatalf("team 46-63: %d %s", team.Status, team.Raw)
	}
	y := h.mustDo(t, http.MethodGet, "/v1/workers/"+yormanID, f.OwnerToken, nil, http.StatusOK)
	if y.Body["tag"] != "46" {
		t.Errorf("a member keeps their own number: %v", y.Body["tag"])
	}

	a3BasketPatchRules(t, h, f, sergioID)
	a3BasketLegacyAndInactive(t, h, f, post)
	a3BasketDashboardAndSearch(t, h, f, team)
}

func a3BasketRequired(t *testing.T, post func(map[string]any) response) {
	t.Helper()
	// Required, for a person and a team; blank is missing.
	for _, body := range []map[string]any{
		{"name": "Sin número"},
		{"name": "En blanco", "tag": "   "},
		{"name": "Equipo sin número", "kind": "equipo"},
	} {
		res := post(body)
		if res.Status != http.StatusBadRequest {
			t.Fatalf("create %v without a basket number: %d %s", body["name"], res.Status, res.Raw)
		}
		fields, _ := errDetails(res)["fields"].(map[string]any)
		if fields["tag"] != "Escriba el número de canasto." {
			t.Errorf("field error for the missing number: %s", res.Raw)
		}
	}
}

func a3BasketPatchRules(t *testing.T, h *harness, f *farmFixture, sergioID string) {
	t.Helper()
	// PATCH: change yes, steal no, remove no.
	if res := h.do(t, http.MethodPatch, "/v1/workers/"+sergioID, f.OwnerToken,
		map[string]any{"tag": "46"}); errCode(res) != "DUPLICATE_TAG" {
		t.Errorf("PATCH to a taken number: %d %s", res.Status, res.Raw)
	}
	if res := h.do(t, http.MethodPatch, "/v1/workers/"+sergioID, f.OwnerToken,
		map[string]any{"tag": nil}); res.Status != http.StatusBadRequest {
		t.Errorf("PATCH removing the number: %d %s", res.Status, res.Raw)
	}
	if res := h.do(t, http.MethodPatch, "/v1/workers/"+sergioID, f.OwnerToken,
		map[string]any{"tag": "  "}); res.Status != http.StatusBadRequest {
		t.Errorf("PATCH blanking the number: %d %s", res.Status, res.Raw)
	}
	h.mustDo(t, http.MethodPatch, "/v1/workers/"+sergioID, f.OwnerToken, map[string]any{"tag": "64"}, http.StatusOK)
	// Saving a worker with their own number is not a clash with themselves.
	h.mustDo(t, http.MethodPatch, "/v1/workers/"+sergioID, f.OwnerToken, map[string]any{"tag": "64", "phone": "3001112233"}, http.StatusOK)
}

func a3BasketLegacyAndInactive(t *testing.T, h *harness, f *farmFixture, post func(map[string]any) response) {
	t.Helper()
	// A worker from before the rule, without a number, is not broken: other
	// fields still save, and an explicit null on them is a no-op.
	legacy := h.createWorker(t, f, "Mauricio", "61000001")
	if _, err := h.admin.Exec(context.Background(), `UPDATE employees SET tag = NULL WHERE id = $1`, legacy); err != nil {
		t.Fatal(err)
	}
	h.mustDo(t, http.MethodPatch, "/v1/workers/"+legacy, f.OwnerToken, map[string]any{"phone": "3005556677", "tag": nil}, http.StatusOK)
	l := h.mustDo(t, http.MethodPatch, "/v1/workers/"+legacy, f.OwnerToken, map[string]any{"tag": "12"}, http.StatusOK)
	if l.Body["tag"] != "12" {
		t.Errorf("giving the legacy worker a number: %v", l.Body["tag"])
	}

	// Only the ACTIVE count: an inactive worker's number can be reused, and
	// coming back with it is refused naming who has it now.
	h.mustDo(t, http.MethodPatch, "/v1/workers/"+legacy, f.OwnerToken, map[string]any{"status": "inactive"}, http.StatusOK)
	newcomer := post(map[string]any{"name": "Tatiana", "tag": "12"})
	if newcomer.Status != http.StatusCreated {
		t.Fatalf("reusing an inactive worker's number: %d %s", newcomer.Status, newcomer.Raw)
	}
	back := h.do(t, http.MethodPatch, "/v1/workers/"+legacy, f.OwnerToken, map[string]any{"status": "active"})
	if errCode(back) != "DUPLICATE_TAG" || errDetails(back)["name"] != "Tatiana" {
		t.Errorf("reactivating onto a taken number: %d %s", back.Status, back.Raw)
	}
	back = h.do(t, http.MethodPatch, "/v1/workers/"+legacy, f.OwnerToken, map[string]any{"status": "active", "tag": "13"})
	if back.Status != http.StatusOK || back.Body["tag"] != "13" || back.Body["deletedAt"] != nil {
		t.Errorf("reactivating with a new number: %d %s", back.Status, back.Raw)
	}
}

func a3BasketDashboardAndSearch(t *testing.T, h *harness, f *farmFixture, team response) {
	t.Helper()
	// The harvest dashboard (Modo cosecha, MCP report_harvest_dashboard)
	// carries the number on each row.
	teamID := team.Body["id"].(string)
	if res := pickup(t, h, f, teamID, daysAgo(0), 80); res.Status != http.StatusCreated {
		t.Fatalf("pickup for the team: %d %s", res.Status, res.Raw)
	}
	dash := h.mustDo(t, http.MethodGet, "/v1/reports/harvest-dashboard", f.OwnerToken, nil, http.StatusOK)
	rows, _ := dash.Body["people"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["tag"] != "46-63" {
		t.Errorf("dashboard people should carry the team's basket number: %v", dash.Body["people"])
	}

	// Searchable by number.
	list := h.mustDo(t, http.MethodGet, "/v1/workers?q=46", f.OwnerToken, nil, http.StatusOK)
	items, _ := list.Body["items"].([]any)
	found := map[string]bool{}
	for _, raw := range items {
		w, _ := raw.(map[string]any)
		found[w["name"].(string)] = true
	}
	if !found["Yorman"] || !found["Yorman y Sergio"] {
		t.Errorf("q=46 should find Yorman and the team 46-63: %v", found)
	}
}

func TestBasketNumberMCP(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca MCP canastos", 80000)
	sess := h.mcpClient(t, f.OwnerToken)

	// The schema requires it on create_worker and create_team.
	for _, name := range []string{"create_worker", "create_team"} {
		a3CheckBasketToolSchema(t, sess, name)
	}
	res, err := sess.CallTool(context.Background(), &mcp.CallToolParams{Name: "create_worker",
		Arguments: map[string]any{"name": "Sin canasto"}})
	if err == nil && !res.IsError {
		t.Errorf("create_worker without tag should fail: %s", toolText(res))
	}

	w := resultOf(t, mustTool(t, sess, "create_worker", map[string]any{"name": "Yorman", "tag": "46"}))
	dup := callTool(t, sess, "create_worker", map[string]any{"name": "Otro", "tag": "46"})
	if !dup.IsError || !strings.Contains(toolText(dup), "DUPLICATE_TAG") || !strings.Contains(toolText(dup), "Yorman") {
		t.Errorf("duplicate basket via MCP should name Yorman: %s", toolText(dup))
	}
	s := resultOf(t, mustTool(t, sess, "create_worker", map[string]any{"name": "Sergio", "tag": "63"}))
	team := callTool(t, sess, "create_team", map[string]any{"name": "Yorman y Sergio", "tag": "63",
		"memberIds": []string{w["id"].(string), s["id"].(string)}})
	if !team.IsError || !strings.Contains(toolText(team), "DUPLICATE_TAG") {
		t.Errorf("team with a member's basket: %s", toolText(team))
	}
	mustTool(t, sess, "create_team", map[string]any{"name": "Yorman y Sergio", "tag": "46-63",
		"memberIds": []string{w["id"].(string), s["id"].(string)}})
	if up := callTool(t, sess, "update_worker", map[string]any{"id": s["id"], "tag": "46"}); !up.IsError ||
		!strings.Contains(toolText(up), "DUPLICATE_TAG") {
		t.Errorf("update_worker to a taken basket: %s", toolText(up))
	}

	list := toolText(callTool(t, sess, "list_workers", map[string]any{"q": "46"}))
	if !strings.Contains(list, `"tag":"46"`) || !strings.Contains(list, `"tag":"46-63"`) {
		t.Errorf("list_workers q=46 should show tags 46 and 46-63: %s", list)
	}
}

func a3CheckBasketToolSchema(t *testing.T, sess *mcp.ClientSession, name string) {
	t.Helper()
	var tool *mcp.Tool
	tools, err := sess.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tl := range tools.Tools {
		if tl.Name == name {
			tool = tl
		}
	}
	if tool == nil {
		t.Fatalf("%s not listed", name)
	}
	raw := toJSON(t, tool.InputSchema)
	if !strings.Contains(raw, `"tag"`) || !strings.Contains(raw, `"required"`) {
		t.Fatalf("%s schema: %s", name, raw)
	}
	if !strings.Contains(tool.Description, "canasto") {
		t.Errorf("%s description should talk about the basket number", name)
	}
	var sch struct{ Required []string }
	fromJSON(t, raw, &sch)
	if !contains(sch.Required, "tag") {
		t.Errorf("%s: tag should be required, got %v", name, sch.Required)
	}
}

func toJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func fromJSON(t *testing.T, raw string, v any) {
	t.Helper()
	if err := json.Unmarshal([]byte(raw), v); err != nil {
		t.Fatal(err)
	}
}
