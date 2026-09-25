package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The MCP endpoint: the API as a set of tools an assistant can call.
//
// ── WHAT IT IS ────────────────────────────────────────────────────────────
//
// A Model Context Protocol server, mounted at POST /mcp on the same process
// that serves /v1. ChatGPT, Claude and the rest connect to it over the
// streamable HTTP transport, list the tools, and call them with the same bearer
// token a browser session carries.
//
// ── WHAT IT IS NOT ────────────────────────────────────────────────────────
//
// It is not a second API. Every tool here is a name, a description an
// assistant can read, and a route in routes.go — nothing else. When a tool is
// called the server builds an ordinary HTTP request against its own router,
// with the caller's Authorization header and client address copied across, and
// hands back whatever the route answered. That inner request walks the whole
// chain in server.go — authenticate, tenant, permission table, RLS — as if it
// had arrived on a socket, so:
//
//   - a weigher asking the assistant for balances gets the same 403 the
//     console would give them, from the same table, and there is no second
//     place a rule could be loosened;
//   - the JSON an assistant sees is exactly the JSON openapi.yaml describes,
//     which is the contract the web is generated from;
//   - a route that gains a field, a filter or a permission gains it here for
//     free, and one that is removed cannot go on being served through a side
//     door.
//
// The price is that a tool can do nothing a route cannot. That is the point.
//
// ── READ-ONLY, FOR NOW ─────────────────────────────────────────────────────
//
// Every tool maps to a GET. An assistant that can read the farm is useful
// today and harmless when it misunderstands; one that can settle a week is the
// double-payment problem in docs/archive/sincronizacion.md wearing a new hat, and it
// waits for the confirmation flow (elicitation) to be worth wiring up. Adding
// a write is one row in the table below, once somebody has decided the answer
// to "and what stops it paying twice".
//
// ── STATELESS ─────────────────────────────────────────────────────────────
//
// The transport runs stateless: no session ids, no server-side stream, one
// request in and one response out. Sessions would pin an assistant to the
// replica that opened them, which the next rollout kills, and nothing here
// needs one — the token is the session.
//
// ── AUTH ──────────────────────────────────────────────────────────────────
//
// The route is in the permission table as ActionMCP: any member with a valid
// token may open the tunnel, and the tool then answers according to that
// member's role. Bearer tokens are what Claude Code, the MCP inspector and any
// programmatic client send. ChatGPT's connector UI runs OAuth 2.1
// (handlers_oauth.go) and then sends the same JWT.

// mcpTool is one row of the table: the name an assistant calls, what it should
// read before calling it, and the route it becomes.
type mcpTool struct {
	Name        string
	Description string
	Method      string
	// Path with {placeholders}, exactly as routes.go spells them.
	Path   string
	Params []mcpParam
}

// mcpParam is one input. Path parameters fill a {placeholder}; the rest go on
// the query string. Types are the JSON Schema words.
type mcpParam struct {
	Name        string
	In          string // "path" or "query"
	Type        string // "string", "integer", "number", "boolean"
	Format      string // "date", "uuid", or ""
	Required    bool
	Enum        []string
	Description string
}

func (p mcpParam) schema() *jsonschema.Schema {
	s := &jsonschema.Schema{Type: p.Type, Description: p.Description}
	if p.Format != "" {
		s.Format = p.Format
	}
	for _, e := range p.Enum {
		s.Enum = append(s.Enum, e)
	}
	return s
}

// Shorthands, so the table reads.
var (
	pID       = mcpParam{Name: "id", In: "path", Type: "string", Format: "uuid", Required: true, Description: "Identificador (UUID)."}
	pQ        = mcpParam{Name: "q", In: "query", Type: "string", Description: "Texto a buscar en el nombre."}
	pStatus   = mcpParam{Name: "status", In: "query", Type: "string", Enum: []string{"active", "inactive", "all"}, Description: "Filtra por estado. Por defecto, activos."}
	pFrom     = mcpParam{Name: "from", In: "query", Type: "string", Format: "date", Description: "Desde esta fecha (YYYY-MM-DD), inclusive."}
	pTo       = mcpParam{Name: "to", In: "query", Type: "string", Format: "date", Description: "Hasta esta fecha (YYYY-MM-DD), inclusive."}
	pLimit    = mcpParam{Name: "limit", In: "query", Type: "integer", Description: "Máximo de filas a devolver."}
	pWorkerID = mcpParam{Name: "workerId", In: "query", Type: "string", Format: "uuid", Description: "Solo este trabajador (UUID)."}
	pDays     = mcpParam{Name: "days", In: "query", Type: "integer", Description: "Ventana en días hacia atrás desde hoy."}
	pWeeks    = mcpParam{Name: "weeks", In: "query", Type: "integer", Description: "Cuántas semanas hacia atrás."}
	pMonday   = mcpParam{Name: "monday", In: "path", Type: "string", Format: "date", Required: true, Description: "El lunes de la semana (YYYY-MM-DD)."}
)

const moneyNote = " Los valores de dinero vienen en centavos enteros."

// mcpTools is the whole surface, in the order an assistant will list it.
var mcpTools = []mcpTool{
	{Name: "me", Method: http.MethodGet, Path: "/v1/me",
		Description: "Quién soy: el usuario autenticado, su rol y la finca a la que apunta el token. Llámala primero para saber qué finca se está consultando."},
	{Name: "farm", Method: http.MethodGet, Path: "/v1/farm",
		Description: "La finca actual: nombre, zona horaria, moneda y el precio vigente del kilo (el pesador no lo ve)."},

	{Name: "list_workers", Method: http.MethodGet, Path: "/v1/workers",
		Description: "Lista los trabajadores (recolectores) de la finca. Sirve para encontrar el UUID de una persona por nombre.",
		Params:      []mcpParam{pQ, pStatus}},
	{Name: "get_worker", Method: http.MethodGet, Path: "/v1/workers/{id}",
		Description: "Un trabajador por su UUID.", Params: []mcpParam{pID}},
	{Name: "worker_balance", Method: http.MethodGet, Path: "/v1/workers/{id}/balance",
		Description: "Cuánto se le debe (o cuánto debe) a un trabajador hoy: saldo, anticipos y pendiente por liquidar." + moneyNote,
		Params:      []mcpParam{pID}},
	{Name: "worker_ledger", Method: http.MethodGet, Path: "/v1/workers/{id}/ledger",
		Description: "Los movimientos de dinero de un trabajador, del más reciente al más antiguo: liquidaciones, pagos, anticipos, descuentos y ajustes." + moneyNote,
		Params:      []mcpParam{pID, pLimit}},
	{Name: "worker_payables", Method: http.MethodGet, Path: "/v1/workers/{id}/payables",
		Description: "Lo que se le puede pagar a un trabajador en un rango de fechas: labores sin liquidar, semana por semana." + moneyNote,
		Params:      []mcpParam{pID, pFrom, pTo}},

	{Name: "list_plots", Method: http.MethodGet, Path: "/v1/plots",
		Description: "Los lotes de la finca con sus cultivos (plotCrop). El UUID del cultivo es el que piden los reportes por cultivo.",
		Params:      []mcpParam{pQ, pStatus}},
	{Name: "list_activities", Method: http.MethodGet, Path: "/v1/activities",
		Description: "El catálogo de labores de la finca (recolección, poda, fertilización…) con su tarifa vigente si el rol lo permite.",
		Params: []mcpParam{pQ, pStatus,
			{Name: "category", In: "query", Type: "string", Description: "Solo esta categoría."},
			{Name: "on", In: "query", Type: "string", Format: "date", Description: "La tarifa vigente en esta fecha (YYYY-MM-DD)."}}},

	{Name: "list_work_records", Method: http.MethodGet, Path: "/v1/work-records",
		Description: "Las labores registradas (pesadas y jornales): quién, qué, cuánto, en qué lote y qué día. Filtra por trabajador, labor, lote o rango de fechas.",
		Params: []mcpParam{pWorkerID,
			{Name: "activityId", In: "query", Type: "string", Format: "uuid", Description: "Solo esta labor (UUID)."},
			{Name: "plotId", In: "query", Type: "string", Format: "uuid", Description: "Solo este lote (UUID)."},
			{Name: "plotCropId", In: "query", Type: "string", Format: "uuid", Description: "Solo este cultivo (UUID)."},
			pFrom, pTo, pQ, pStatus}},

	{Name: "pending", Method: http.MethodGet, Path: "/v1/pending",
		Description: "Lo que un trabajador ha trabajado y todavía no se le ha pagado, en un rango de fechas. Los tres parámetros son obligatorios." + moneyNote,
		Params: []mcpParam{
			{Name: "workerId", In: "query", Type: "string", Format: "uuid", Required: true, Description: "El trabajador (UUID)."},
			{Name: "from", In: "query", Type: "string", Format: "date", Required: true, Description: "Desde (YYYY-MM-DD)."},
			{Name: "to", In: "query", Type: "string", Format: "date", Required: true, Description: "Hasta (YYYY-MM-DD)."}}},
	{Name: "list_balances", Method: http.MethodGet, Path: "/v1/balances",
		Description: "El saldo de todos los trabajadores de la finca: a quién se le debe y cuánto." + moneyNote},
	{Name: "list_settlements", Method: http.MethodGet, Path: "/v1/settlements",
		Description: "Las liquidaciones hechas (una liquidación cierra la cuenta de un trabajador por un periodo)." + moneyNote,
		Params: []mcpParam{pWorkerID,
			{Name: "status", In: "query", Type: "string", Enum: []string{"open", "void", "all"}, Description: "Vigentes, anuladas o todas."},
			pFrom, pTo, pLimit,
			{Name: "offset", In: "query", Type: "integer", Description: "Cuántas saltar, para paginar."}}},
	{Name: "get_settlement", Method: http.MethodGet, Path: "/v1/settlements/{id}",
		Description: "Una liquidación con sus líneas." + moneyNote, Params: []mcpParam{pID}},
	{Name: "get_payment", Method: http.MethodGet, Path: "/v1/payments/{id}",
		Description: "Recibo de un pago, discriminado: semana actual, saldo anterior, descuentos por concepto, lo pagado y lo que queda. El id es el del movimiento de tipo pago (ver worker_ledger)." + moneyNote,
		Params:      []mcpParam{pID}},
	{Name: "week_price", Method: http.MethodGet, Path: "/v1/prices/weeks/{monday}",
		Description: "El precio del kilo para una semana." + moneyNote, Params: []mcpParam{pMonday}},

	{Name: "report_weeks", Method: http.MethodGet, Path: "/v1/reports/weeks",
		Description: "Reporte por semanas: kilos recogidos y su valor, semana a semana." + moneyNote,
		Params:      []mcpParam{pFrom, pTo, pLimit}},
	{Name: "report_week", Method: http.MethodGet, Path: "/v1/reports/weeks/{monday}",
		Description: "Una semana en detalle: cada trabajador por día y por cultivo." + moneyNote,
		Params:      []mcpParam{pMonday}},
	{Name: "report_crop", Method: http.MethodGet, Path: "/v1/reports/crops/{plotCropId}",
		Description: "Un cultivo: kilos, valor, personas, días y sus semanas." + moneyNote,
		Params: []mcpParam{
			{Name: "plotCropId", In: "path", Type: "string", Format: "uuid", Required: true, Description: "El cultivo (UUID, ver list_plots)."},
			pWeeks}},
	{Name: "report_performance", Method: http.MethodGet, Path: "/v1/reports/performance",
		Description: "Rendimiento comparativo: cada recolector frente a los que trabajaron a su lado los mismos días. Es el índice que usa la finca para decidir a quién volver a contratar.",
		Params:      []mcpParam{pDays}},
	{Name: "report_anomalies", Method: http.MethodGet, Path: "/v1/reports/anomalies",
		Description: "Pesadas que merecen una segunda mirada: valores fuera de lo normal para esa persona, ese lote o ese día.",
		Params: []mcpParam{pDays,
			{Name: "maxKg", In: "query", Type: "number", Description: "Umbral de kilos por pesada a partir del cual se marca."},
			pLimit}},
	{Name: "report_harvest_curve", Method: http.MethodGet, Path: "/v1/reports/harvest-curve",
		Description: "La curva de cosecha: dónde estuvo el pico y si la temporada está terminando.",
		Params: []mcpParam{
			{Name: "plotCropId", In: "query", Type: "string", Format: "uuid", Description: "Solo este cultivo (UUID)."},
			pWeeks}},

	{Name: "list_stock", Method: http.MethodGet, Path: "/v1/stock",
		Description: "Existencias por producto y bodega.",
		Params: []mcpParam{
			{Name: "productId", In: "query", Type: "string", Format: "uuid", Description: "Solo este producto (UUID)."},
			{Name: "warehouseId", In: "query", Type: "string", Format: "uuid", Description: "Solo esta bodega (UUID)."}}},
	{Name: "list_products", Method: http.MethodGet, Path: "/v1/products",
		Description: "Los productos (insumos y producto terminado) con sus existencias.",
		Params:      []mcpParam{pQ, pStatus}},
	{Name: "list_sales", Method: http.MethodGet, Path: "/v1/sales",
		Description: "Las ventas de la finca." + moneyNote,
		Params: []mcpParam{pQ, pStatus, pFrom, pTo,
			{Name: "productId", In: "query", Type: "string", Format: "uuid", Description: "Solo este producto (UUID)."},
			{Name: "customerId", In: "query", Type: "string", Format: "uuid", Description: "Solo este cliente (UUID)."}}},
	{Name: "list_expenses", Method: http.MethodGet, Path: "/v1/expenses",
		Description: "Los gastos de la finca." + moneyNote,
		Params: []mcpParam{pQ, pStatus, pFrom, pTo,
			{Name: "activityId", In: "query", Type: "string", Format: "uuid", Description: "Solo los de esta labor (UUID)."},
			{Name: "plotId", In: "query", Type: "string", Format: "uuid", Description: "Solo los de este lote (UUID)."}}},
	{Name: "list_customers", Method: http.MethodGet, Path: "/v1/customers",
		Description: "Los clientes a los que la finca vende.", Params: []mcpParam{pQ, pStatus}},
}

// buildMCP assembles the server once, at construction time. The tools are
// closures over s, so the handler can dispatch into the router that was built
// a moment earlier.
func (s *Server) buildMCP() http.Handler {
	srv := mcp.NewServer(&mcp.Implementation{
		Name:    "bascula",
		Title:   "Báscula",
		Version: "1",
	}, &mcp.ServerOptions{
		Instructions: "Báscula lleva el control de cosecha y la nómina de una finca: " +
			"quién recogió cuántos kilos, en qué lote, a qué precio, y a quién se le debe. " +
			"Empiece con `me` para saber qué finca y qué rol tiene el token. " +
			"Todos los valores de dinero son centavos enteros de la moneda de la finca; " +
			"las fechas son YYYY-MM-DD en la zona horaria de la finca. " +
			"Las herramientas son de solo lectura.",
	})

	for _, t := range mcpTools {
		srv.AddTool(t.definition(), s.mcpToolHandler(t))
	}

	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv },
		&mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
}

// definition renders the row as the protocol spells it.
func (t mcpTool) definition() *mcp.Tool {
	in := &jsonschema.Schema{
		Type:                 "object",
		Properties:           map[string]*jsonschema.Schema{},
		AdditionalProperties: &jsonschema.Schema{Not: &jsonschema.Schema{}},
	}
	for _, p := range t.Params {
		in.Properties[p.Name] = p.schema()
		if p.Required {
			in.Required = append(in.Required, p.Name)
		}
	}
	sort.Strings(in.Required)
	readOnly := true
	return &mcp.Tool{
		Name:        t.Name,
		Description: t.Description,
		InputSchema: in,
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:   readOnly,
			IdempotentHint: true,
		},
	}
}

// mcpToolHandler turns one row into a call: arguments become a URL, the URL
// becomes an inner request, and the inner request's answer becomes the tool
// result.
func (s *Server) mcpToolHandler(t mcpTool) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var args map[string]any
		if len(req.Params.Arguments) > 0 {
			if err := json.Unmarshal(req.Params.Arguments, &args); err != nil {
				return mcpFailure(fmt.Sprintf("argumentos inválidos: %v", err)), nil
			}
		}
		target, err := t.resolve(args)
		if err != nil {
			return mcpFailure(err.Error()), nil
		}

		// The inner request. The bearer and the client address are the two
		// things the chain in server.go reads from the outside world, and
		// they are copied verbatim so the tool is the caller, not the server.
		//
		// chi stores its routing context on the request context and reuses
		// it if it finds one, so the inner request must not inherit the outer
		// one's — that would route with the outer request's path and params.
		// Clearing the key gives the mux a fresh context while keeping the
		// caller's cancellation.
		inner, err := http.NewRequestWithContext(
			context.WithValue(ctx, chi.RouteCtxKey, nil), t.Method, target, nil)
		if err != nil {
			return nil, err
		}
		inner.Header.Set("Accept", "application/json")
		if req.Extra != nil && req.Extra.Header != nil {
			if a := req.Extra.Header.Get("Authorization"); a != "" {
				inner.Header.Set("Authorization", a)
			}
			if fwd := req.Extra.Header.Get("X-Forwarded-For"); fwd != "" {
				inner.Header.Set("X-Forwarded-For", fwd)
			}
		}
		if addr, ok := ctx.Value(mcpRemoteAddrKey{}).(string); ok {
			inner.RemoteAddr = addr
		}

		rec := &mcpRecorder{header: http.Header{}, status: http.StatusOK}
		s.router.ServeHTTP(rec, inner)

		body := rec.body.String()
		if rec.status >= 400 {
			// The route's own error envelope, unchanged: it carries the code
			// the clients already know how to read (FORBIDDEN, NOT_FOUND…).
			return mcpFailure(body), nil
		}
		res := &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: body}},
		}
		// Structured content is the same JSON, parsed, for clients that
		// prefer it to a string. Only an object qualifies; a bare array is
		// wrapped in text alone, which every client accepts.
		var structured map[string]any
		if json.Unmarshal(rec.body.Bytes(), &structured) == nil {
			res.StructuredContent = structured
		}
		return res, nil
	}
}

// resolve fills the path and builds the query from the arguments, refusing
// anything the table did not declare. The schema already forbids unknown keys
// and a client that validates will never send one; a client that does not is
// told rather than silently ignored.
func (t mcpTool) resolve(args map[string]any) (string, error) {
	declared := map[string]mcpParam{}
	for _, p := range t.Params {
		declared[p.Name] = p
	}
	path := t.Path
	query := url.Values{}
	for name, raw := range args {
		p, ok := declared[name]
		if !ok {
			return "", fmt.Errorf("parámetro desconocido: %q", name)
		}
		val, err := mcpArgString(p, raw)
		if err != nil {
			return "", err
		}
		if val == "" {
			continue
		}
		switch p.In {
		case "path":
			path = strings.ReplaceAll(path, "{"+name+"}", url.PathEscape(val))
		default:
			query.Set(name, val)
		}
	}
	for _, p := range t.Params {
		if p.Required {
			if _, ok := args[p.Name]; !ok {
				return "", fmt.Errorf("falta el parámetro obligatorio %q", p.Name)
			}
		}
	}
	if strings.Contains(path, "{") {
		return "", fmt.Errorf("falta un parámetro de ruta en %s", path)
	}
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	return path, nil
}

// mcpArgString renders one argument the way the query string expects it. JSON
// numbers arrive as float64; an integer parameter that came as 7.0 is "7", and
// one that came as 7.5 is refused rather than truncated.
func mcpArgString(p mcpParam, raw any) (string, error) {
	switch v := raw.(type) {
	case nil:
		return "", nil
	case string:
		return v, nil
	case bool:
		if p.Type != "boolean" {
			return "", fmt.Errorf("%q debe ser %s", p.Name, p.Type)
		}
		if v {
			return "true", nil
		}
		return "false", nil
	case float64:
		switch p.Type {
		case "integer":
			if v != float64(int64(v)) {
				return "", fmt.Errorf("%q debe ser un entero", p.Name)
			}
			return fmt.Sprintf("%d", int64(v)), nil
		case "number":
			return fmt.Sprintf("%g", v), nil
		}
		return "", fmt.Errorf("%q debe ser %s", p.Name, p.Type)
	}
	return "", fmt.Errorf("%q tiene un tipo que no se esperaba", p.Name)
}

func mcpFailure(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{&mcp.TextContent{Text: msg}},
	}
}

// mcpRemoteAddrKey carries the outer request's peer into the tool handler,
// where the SDK gives us headers but not the connection.
type mcpRemoteAddrKey struct{}

// handleMCP is the route. It stashes what the inner request will need and
// lets the SDK's handler do the protocol.
func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	ctx := context.WithValue(r.Context(), mcpRemoteAddrKey{}, r.RemoteAddr)
	s.mcp.ServeHTTP(w, r.WithContext(ctx))
}

// mcpRecorder is the smallest ResponseWriter that captures a JSON answer.
// net/http/httptest has one, but a test package has no business in a serving
// binary, and this is twenty lines.
type mcpRecorder struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (r *mcpRecorder) Header() http.Header         { return r.header }
func (r *mcpRecorder) WriteHeader(code int)        { r.status = code }
func (r *mcpRecorder) Write(b []byte) (int, error) { return r.body.Write(b) }

var _ io.Writer = (*mcpRecorder)(nil)
