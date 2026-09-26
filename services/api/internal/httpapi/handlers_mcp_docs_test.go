package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ojardila/bascula/services/api/internal/auth"
)

// docsServer builds a server with no database: the tool reference must answer
// without one, like /health.
func docsServer(t *testing.T) *Server {
	t.Helper()
	return New(nil, nil, Config{UploadDir: t.TempDir()})
}

func getCatalog(t *testing.T, s *Server) mcpCatalogDoc {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/mcp/tools.json", nil)
	req.Host = "san-jose.bascula.engp.io"
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /mcp/tools.json = %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	var doc mcpCatalogDoc
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("tools.json is not JSON: %v", err)
	}
	return doc
}

// TestMCPToolsJSONMatchesTheRegistry: tools.json lists every tool the MCP
// server registers — the reads of handlers_mcp.go and the writes of
// handlers_mcp_write.go — once each, with the same name, description and
// input schema the SDK was given, and a route and roles taken from the
// router and auth.Matrix.
func TestMCPToolsJSONMatchesTheRegistry(t *testing.T) {
	s := docsServer(t)
	doc := getCatalog(t, s)

	if doc.Endpoint != "https://san-jose.bascula.engp.io/mcp" {
		t.Errorf("endpoint = %q; it must be this host's /mcp", doc.Endpoint)
	}
	if doc.Docs != "https://san-jose.bascula.engp.io/mcp/docs" {
		t.Errorf("docs = %q", doc.Docs)
	}
	if doc.Instructions != mcpInstructions || doc.Server.Name != mcpServerName {
		t.Errorf("server identity or instructions differ from what the MCP server announces")
	}

	type want struct {
		desc, method, path string
		schema             []byte
		kind               string
		twoStep            bool
	}
	expected := map[string]want{}
	var order []string
	for _, tl := range mcpTools {
		raw, _ := json.Marshal(tl.definition().InputSchema)
		expected[tl.Name] = want{tl.Description, tl.Method, tl.Path, raw, "read", false}
		order = append(order, tl.Name)
	}
	for _, tl := range mcpWriteTools {
		raw, _ := json.Marshal(tl.definition().InputSchema)
		expected[tl.Name] = want{tl.Description, tl.Method, tl.Pattern, raw, "write", tl.Money}
		order = append(order, tl.Name)
	}

	if len(doc.Tools) != len(expected) {
		t.Fatalf("tools.json lists %d tools, the registry has %d", len(doc.Tools), len(expected))
	}
	routes := map[string]auth.Action{}
	for _, rt := range s.Routes() {
		routes[rt.Method+" "+rt.Pattern] = rt.Action
	}
	for i, got := range doc.Tools {
		w, ok := expected[got.Name]
		if !ok {
			t.Errorf("tools.json lists %q, which the MCP server does not register", got.Name)
			continue
		}
		if order[i] != got.Name {
			t.Errorf("tools.json[%d] = %q, want %q (registration order)", i, got.Name, order[i])
		}
		if got.Description != w.desc {
			t.Errorf("%s: description differs from the registry", got.Name)
		}
		raw, _ := json.Marshal(got.InputSchema)
		if !jsonEqual(t, raw, w.schema) {
			t.Errorf("%s: inputSchema differs from the registry:\n got %s\nwant %s", got.Name, raw, w.schema)
		}
		if got.Kind != w.kind || got.TwoStep != w.twoStep {
			t.Errorf("%s: kind=%s twoStep=%v, want %s/%v", got.Name, got.Kind, got.TwoStep, w.kind, w.twoStep)
		}
		if got.Route.Method != w.method || got.Route.Path != w.path {
			t.Errorf("%s: route %s %s, want %s %s", got.Name, got.Route.Method, got.Route.Path, w.method, w.path)
		}
		action, mounted := routes[w.method+" "+w.path]
		if !mounted {
			t.Errorf("%s maps to %s %s, which is not a route", got.Name, w.method, w.path)
			continue
		}
		if got.Action != string(action) {
			t.Errorf("%s: action %q, the route declares %q", got.Name, got.Action, action)
		}
		var roles []string
		for _, r := range mcpCatalogRoles {
			if auth.Allowed(r, action) {
				roles = append(roles, string(r))
			}
		}
		if strings.Join(got.Roles, ",") != strings.Join(roles, ",") {
			t.Errorf("%s: roles %v, auth.Matrix says %v", got.Name, got.Roles, roles)
		}
		if len(got.Roles) == 0 {
			t.Errorf("%s: no farm role may call it", got.Name)
		}
	}
}

// TestMCPToolsJSONKeepsTheMoneyRule: the weigher is never listed on a tool
// whose route is on the money deny list.
func TestMCPToolsJSONKeepsTheMoneyRule(t *testing.T) {
	doc := getCatalog(t, docsServer(t))
	for _, tl := range doc.Tools {
		if auth.Matrix[auth.Action(tl.Action)].Money {
			for _, r := range tl.Roles {
				if r == "weigher" {
					t.Errorf("%s is a money route but lists the weigher", tl.Name)
				}
			}
		}
	}
}

// TestMCPDocsPage: the page is HTML, public, not cached, carries the
// catalogue inline, and posts to this host's /mcp.
func TestMCPDocsPage(t *testing.T) {
	s := docsServer(t)
	req := httptest.NewRequest(http.MethodGet, "/mcp/docs", nil)
	req.Host = "bascula.engp.io"
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /mcp/docs = %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	body := rec.Body.String()
	if strings.Contains(body, mcpDocsDataMarker) {
		t.Fatal("the catalogue placeholder was not replaced")
	}
	for _, want := range []string{`"name":"list_workers"`, `"name":"register_payment"`, "http://bascula.engp.io/mcp", "tools/call"} {
		if !strings.Contains(body, want) {
			t.Errorf("the page does not contain %q", want)
		}
	}
	start := strings.Index(body, `<script id="catalog" type="application/json">`)
	end := strings.Index(body[start:], "</script>")
	inline := body[start+len(`<script id="catalog" type="application/json">`) : start+end]
	var doc mcpCatalogDoc
	if err := json.Unmarshal([]byte(inline), &doc); err != nil {
		t.Fatalf("inline catalogue is not JSON: %v", err)
	}
	if len(doc.Tools) != len(mcpTools)+len(mcpWriteTools) {
		t.Errorf("inline catalogue has %d tools", len(doc.Tools))
	}
}

func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &y); err != nil {
		t.Fatal(err)
	}
	ax, _ := json.Marshal(x)
	by, _ := json.Marshal(y)
	return string(ax) == string(by)
}
