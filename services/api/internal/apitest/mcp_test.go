package apitest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// mcpClient opens a real MCP session against the server, over HTTP, as the
// given token. It is the official client talking to the official transport:
// what ChatGPT or Claude would do, minus the network.
func (h *harness) mcpClient(t *testing.T, token string) *mcp.ClientSession {
	t.Helper()
	ts := httptest.NewServer(h.server)
	t.Cleanup(ts.Close)

	transport := &mcp.StreamableClientTransport{
		Endpoint:   ts.URL + "/mcp",
		HTTPClient: &http.Client{Transport: bearerTransport{token: token, next: http.DefaultTransport}},
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	sess, err := client.Connect(context.Background(), transport, nil)
	if err != nil {
		t.Fatalf("mcp connect: %v", err)
	}
	t.Cleanup(func() { _ = sess.Close() })
	return sess
}

type bearerTransport struct {
	token string
	next  http.RoundTripper
}

func (b bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if b.token != "" {
		r.Header.Set("Authorization", "Bearer "+b.token)
	}
	return b.next.RoundTrip(r)
}

func callTool(t *testing.T, sess *mcp.ClientSession, name string, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	res, err := sess.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("call %s: %v", name, err)
	}
	return res
}

func toolText(res *mcp.CallToolResult) string {
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	return sb.String()
}

// TestMCPListsToolsAndAnswersAsTheCaller is the round trip: the tunnel opens
// with a token, the tools are there, and a call comes back with the same JSON
// the route itself would have given.
func TestMCPListsToolsAndAnswersAsTheCaller(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca MCP", 250000)
	sess := h.mcpClient(t, f.OwnerToken)

	tools, err := sess.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	names := map[string]bool{}
	for _, tool := range tools.Tools {
		names[tool.Name] = true
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			t.Errorf("tool %q is not marked read-only; every tool in this release is", tool.Name)
		}
	}
	for _, want := range []string{"me", "farm", "list_workers", "list_balances", "report_weeks"} {
		if !names[want] {
			t.Errorf("tool %q is missing from tools/list", want)
		}
	}

	// `me` through the tunnel and `me` on the wire are the same answer.
	viaMCP := callTool(t, sess, "me", nil)
	if viaMCP.IsError {
		t.Fatalf("me via mcp errored: %s", toolText(viaMCP))
	}
	direct := h.mustDo(t, http.MethodGet, "/v1/me", f.OwnerToken, nil, http.StatusOK)
	var got map[string]any
	if err := json.Unmarshal([]byte(toolText(viaMCP)), &got); err != nil {
		t.Fatalf("tool text is not JSON: %v\n%s", err, toolText(viaMCP))
	}
	if mustString(t, got, "id") != mustString(t, direct.Body, "id") {
		t.Errorf("mcp says id %v, the route says %v", got["id"], direct.Body["id"])
	}
	if viaMCP.StructuredContent == nil {
		t.Error("structured content is missing; an object answer should carry it")
	}

	// A filter reaches the route: a worker created, then found by name.
	h.createWorker(t, f, "Rosa Tulcán", "1094000001")
	res := callTool(t, sess, "list_workers", map[string]any{"q": "Tulcán"})
	if res.IsError {
		t.Fatalf("list_workers errored: %s", toolText(res))
	}
	if !strings.Contains(toolText(res), "Tulcán") {
		t.Errorf("list_workers q=Tulcán did not find the worker:\n%s", toolText(res))
	}
}

// TestMCPKeepsThePermissionTable: the tunnel is not a way around the table.
// The weigher asking for balances gets the 403 the route gives, as a tool
// error carrying the same code, and the money never leaves the server.
func TestMCPKeepsThePermissionTable(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca MCP permisos", 250000)
	sess := h.mcpClient(t, f.WeigherToken)

	res := callTool(t, sess, "list_balances", nil)
	if !res.IsError {
		t.Fatalf("the weigher read balances through mcp:\n%s", toolText(res))
	}
	if !strings.Contains(toolText(res), "FORBIDDEN") {
		t.Errorf("expected the route's FORBIDDEN envelope, got:\n%s", toolText(res))
	}

	// What the weigher may read, he still reads.
	ok := callTool(t, sess, "list_workers", nil)
	if ok.IsError {
		t.Errorf("the weigher may list workers on the wire, and was refused via mcp: %s", toolText(ok))
	}
}

// TestMCPRefusesWithoutAToken: no token, no tunnel — the transport itself is
// behind the permission table, not only the tools.
func TestMCPRefusesWithoutAToken(t *testing.T) {
	h := requireDB(t)
	res := h.mustDo(t, http.MethodPost, "/mcp", "", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/list",
	}, http.StatusUnauthorized)
	if res.code() != "UNAUTHORIZED" {
		t.Errorf("want UNAUTHORIZED, got %s", res.Raw)
	}
}

// TestMCPValidatesArguments: a required parameter the assistant forgot is a
// tool error it can read and fix, not a 400 from somewhere inside.
func TestMCPValidatesArguments(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca MCP args", 250000)
	sess := h.mcpClient(t, f.OwnerToken)

	res := callTool(t, sess, "pending", map[string]any{"workerId": "not-even-a-uuid"})
	if !res.IsError {
		t.Fatalf("pending without from/to succeeded:\n%s", toolText(res))
	}
	if !strings.Contains(toolText(res), "from") {
		t.Errorf("the error should name what is missing, got: %s", toolText(res))
	}

	// An argument the table never declared is refused by name, not dropped.
	res = callTool(t, sess, "farm", map[string]any{"secret": true})
	if !res.IsError || !strings.Contains(toolText(res), "secret") {
		t.Errorf("an undeclared argument should be refused by name, got: %s", toolText(res))
	}
}
