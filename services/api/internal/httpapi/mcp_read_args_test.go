package httpapi

import (
	"strings"
	"testing"
)

// TestMCPArgString: how a read tool's argument becomes a query value. An
// integer that came as 7.0 is "7"; one that came as 7.5 is refused, never
// truncated, and a value of the wrong JSON type is named rather than guessed.
func TestMCPArgString(t *testing.T) {
	cases := []struct {
		param   mcpParam
		raw     any
		want    string
		wantErr string
	}{
		{mcpParam{Name: "q", Type: "string"}, nil, "", ""},
		{mcpParam{Name: "q", Type: "string"}, "Ana", "Ana", ""},
		{mcpParam{Name: "all", Type: "boolean"}, true, "true", ""},
		{mcpParam{Name: "all", Type: "boolean"}, false, "false", ""},
		{mcpParam{Name: "q", Type: "string"}, true, "", `"q" debe ser string`},
		{mcpParam{Name: "limit", Type: "integer"}, 7.0, "7", ""},
		{mcpParam{Name: "limit", Type: "integer"}, 7.5, "", `"limit" debe ser un entero`},
		{mcpParam{Name: "kg", Type: "number"}, 12.5, "12.5", ""},
		{mcpParam{Name: "q", Type: "string"}, 3.0, "", `"q" debe ser string`},
		{mcpParam{Name: "ids", Type: "string"}, []any{"a"}, "", "tipo que no se esperaba"},
	}
	for _, c := range cases {
		got, err := mcpArgString(c.param, c.raw)
		if c.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("%s=%v: got %q, %v; want an error mentioning %q", c.param.Name, c.raw, got, err, c.wantErr)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%s=%v: got %q, %v; want %q", c.param.Name, c.raw, got, err, c.want)
		}
	}
}

func TestMCPToolResolve(t *testing.T) {
	tool := mcpTool{Name: "get_worker", Path: "/v1/workers/{id}", Params: []mcpParam{
		{Name: "id", Type: "string", In: "path", Required: true},
		{Name: "from", Type: "string"},
		{Name: "limit", Type: "integer"},
	}}

	path, err := tool.resolve(map[string]any{"id": "a b", "from": "2026-08-24", "limit": 10.0})
	if err != nil || path != "/v1/workers/a%20b?from=2026-08-24&limit=10" {
		t.Fatalf("got %q, %v", path, err)
	}
	if path, err := tool.resolve(map[string]any{"id": "w", "from": nil}); err != nil || path != "/v1/workers/w" {
		t.Errorf("an empty optional argument is left out: %q, %v", path, err)
	}
	if _, err := tool.resolve(map[string]any{"id": "w", "sort": "name"}); err == nil ||
		!strings.Contains(err.Error(), `parámetro desconocido: "sort"`) {
		t.Errorf("an undeclared argument: %v", err)
	}
	if _, err := tool.resolve(map[string]any{"id": "w", "limit": 1.5}); err == nil {
		t.Error("a fractional limit must be refused")
	}
	if _, err := tool.resolve(map[string]any{"from": "2026-08-24"}); err == nil ||
		!strings.Contains(err.Error(), `falta el parámetro obligatorio "id"`) {
		t.Errorf("a missing required argument: %v", err)
	}
	// A path parameter that is declared optional but left out still cannot
	// produce a URL with a hole in it.
	loose := mcpTool{Path: "/v1/plots/{id}/crops", Params: []mcpParam{{Name: "id", Type: "string", In: "path"}}}
	if _, err := loose.resolve(map[string]any{}); err == nil || !strings.Contains(err.Error(), "falta un parámetro de ruta") {
		t.Errorf("an unfilled placeholder: %v", err)
	}
}
