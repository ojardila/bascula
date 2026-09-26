package apitest

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestMCPToolsJSONMatchesToolsList is the promise of /mcp/docs: the public
// catalogue and what an authenticated client gets from tools/list are the
// same tools, with the same names, titles, descriptions, input schemas and
// annotations. If a tool is ever registered without going through the
// catalogue, or the catalogue invents one, this fails.
func TestMCPToolsJSONMatchesToolsList(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca MCP docs", 250000)
	sess := h.mcpClient(t, f.OwnerToken)

	listed, err := sess.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}

	ts := httptest.NewServer(h.server)
	t.Cleanup(ts.Close)
	resp, err := http.Get(ts.URL + "/mcp/tools.json") // no token: public
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /mcp/tools.json = %d: %s", resp.StatusCode, raw)
	}
	var doc struct {
		Tools []map[string]any `json:"tools"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("tools.json: %v", err)
	}
	catalog := map[string]map[string]any{}
	for _, tl := range doc.Tools {
		catalog[tl["name"].(string)] = tl
	}
	if len(catalog) != len(listed.Tools) {
		t.Errorf("tools.json has %d tools, tools/list has %d", len(catalog), len(listed.Tools))
	}
	for _, tool := range listed.Tools {
		got, ok := catalog[tool.Name]
		if !ok {
			t.Errorf("tools/list serves %q but tools.json does not list it", tool.Name)
			continue
		}
		b, _ := json.Marshal(tool)
		var want map[string]any
		_ = json.Unmarshal(b, &want)
		for _, k := range []string{"name", "title", "description", "inputSchema", "annotations"} {
			if canon(want[k]) != canon(got[k]) {
				t.Errorf("%s: %s differs\n tools/list: %s\n tools.json: %s", tool.Name, k, canon(want[k]), canon(got[k]))
			}
		}
		roles, _ := got["roles"].([]any)
		if len(roles) == 0 {
			t.Errorf("%s: tools.json lists no roles", tool.Name)
		}
	}
}

// TestMCPDocsPageIsPublic: the reference page answers without a token and
// without touching the tenant machinery, and a tool run from it still goes
// through /mcp and its permission table (the weigher gets FORBIDDEN on money).
func TestMCPDocsPageIsPublic(t *testing.T) {
	h := requireDB(t)
	ts := httptest.NewServer(h.server)
	t.Cleanup(ts.Close)
	resp, err := http.Get(ts.URL + "/mcp/docs")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "Báscula MCP tools") {
		t.Fatalf("GET /mcp/docs = %d", resp.StatusCode)
	}

	f := h.signupFarm(t, "Finca MCP docs permisos", 250000)
	sess := h.mcpClient(t, f.WeigherToken)
	res := callTool(t, sess, "list_balances", nil)
	if !res.IsError || !strings.Contains(toolText(res), "FORBIDDEN") {
		t.Errorf("the weigher read balances: %s", toolText(res))
	}
}

func canon(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
