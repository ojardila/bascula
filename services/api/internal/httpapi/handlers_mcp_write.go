package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/ojardila/bascula/services/api/internal/auth"
)

// The write tools. Same idea as the reads in handlers_mcp.go — a tool is a
// name, a description and a route, and the route does the work as the caller —
// with two additions a read never needed:
//
//   - the arguments become a JSON body, built per tool, because a body has
//     shape (a week of weighings is an array of objects) a query string does
//     not;
//   - a tool that moves money is two calls. See the note at the top of
//     handlers_mcp.go and mcpWriteHandler below.

// mcpConfirmTTL is how long a preview stays executable. Long enough to read
// a summary aloud and say "sí", short enough that the balance it showed is
// still the balance.
const mcpConfirmTTL = 10 * time.Minute

// mcpConfirmPurpose separates confirmation tokens from anything else the
// signer seals.
const mcpConfirmPurpose = "mcp-confirm"

// mcpConfirmSpace namespaces the row ids derived from a token's nonce.
var mcpConfirmSpace = uuid.MustParse("0d3c3a52-6a3e-4f7e-9d0e-6b8f2a4c9e11")

// mcpCall is one inner request.
type mcpCall struct {
	Method string
	Path   string
	Body   map[string]any
}

// mcpPreview is what a money tool shows before it does anything. Bind is a
// fact that must still hold when the confirmation arrives (the settlement's
// gross and lines); it travels inside the signed token.
type mcpPreview struct {
	Summary string
	Facts   map[string]any
	Bind    string
}

type mcpWriteTool struct {
	Name        string
	Title       string
	Description string
	Params      []mcpParam
	// Method and Pattern name the route whose permission the tool needs. It
	// is checked before anything runs, so a role that may not pay is never
	// shown a preview of a payment, let alone handed a token.
	Method, Pattern string
	Destructive     bool
	Idempotent      bool
	// Money makes the tool two-step: preview + confirmationToken.
	Money bool
	// Build turns the arguments into the inner request. key is the id the
	// write must carry: the confirmation's for a money tool, else "".
	Build func(a mcpArgs, key string) (mcpCall, error)
	// Preview reads, as the caller, what the confirmation will show.
	Preview func(c *mcpCaller, a mcpArgs) (*mcpPreview, error)
	// Execute, when set, replaces the default Build → dispatch.
	Execute func(c *mcpCaller, a mcpArgs, key, bind string) *mcp.CallToolResult
	// Done is the one Spanish sentence that heads a successful answer.
	Done func(status int, body map[string]any, a mcpArgs) string
}

// ── arguments ─────────────────────────────────────────────────────────────

type mcpArgs map[string]any

func (a mcpArgs) str(k string) string {
	v, _ := a[k].(string)
	return strings.TrimSpace(v)
}

func (a mcpArgs) has(k string) bool {
	v, ok := a[k]
	return ok && v != nil
}

// num is a JSON number exactly as the client wrote it, so 12.5 kg stays 12.5
// and never becomes 12.499999.
func (a mcpArgs) num(k string) (json.Number, error) {
	switch v := a[k].(type) {
	case json.Number:
		return v, nil
	case string:
		n := json.Number(strings.TrimSpace(v))
		if _, err := n.Float64(); err != nil {
			return "", fmt.Errorf("%q debe ser un número", k)
		}
		return n, nil
	}
	return "", fmt.Errorf("%q debe ser un número", k)
}

func (a mcpArgs) int(k string) (int64, error) {
	n, err := a.num(k)
	if err != nil {
		return 0, fmt.Errorf("%q debe ser un entero", k)
	}
	i, err := n.Int64()
	if err != nil {
		return 0, fmt.Errorf("%q debe ser un entero (centavos, sin decimales)", k)
	}
	return i, nil
}

// copyStr copies the string arguments that are present onto the body.
func (a mcpArgs) copyStr(body map[string]any, keys ...string) {
	for _, k := range keys {
		if a.has(k) {
			body[k] = a[k]
		}
	}
}

func parseMCPArgs(req *mcp.CallToolRequest, params []mcpParam) (mcpArgs, error) {
	a := mcpArgs{}
	if len(req.Params.Arguments) > 0 {
		dec := json.NewDecoder(bytes.NewReader(req.Params.Arguments))
		dec.UseNumber()
		if err := dec.Decode(&a); err != nil {
			return nil, fmt.Errorf("argumentos inválidos: %v", err)
		}
	}
	declared := map[string]bool{}
	for _, p := range params {
		declared[p.Name] = true
	}
	for k, v := range a {
		if !declared[k] {
			return nil, fmt.Errorf("parámetro desconocido: %q", k)
		}
		if v == nil {
			delete(a, k)
		}
	}
	for _, p := range params {
		if p.Required && !a.has(p.Name) {
			return nil, fmt.Errorf("falta el parámetro obligatorio %q", p.Name)
		}
	}
	return a, nil
}

// ── the caller ────────────────────────────────────────────────────────────

// mcpCaller runs inner requests as the person on the other end of the tool.
type mcpCaller struct {
	s   *Server
	ctx context.Context
	req *mcp.CallToolRequest
}

func (c *mcpCaller) do(method, path string, body map[string]any) (int, []byte) {
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	return c.s.mcpDispatch(c.ctx, c.req, method, path, raw)
}

// get reads one object; a refusal comes back as an error carrying the
// route's own envelope, which is what the assistant should see.
func (c *mcpCaller) get(path string) (map[string]any, error) {
	status, raw := c.do(http.MethodGet, path, nil)
	return decodeInner(status, raw)
}

func (c *mcpCaller) post(path string, body map[string]any) (map[string]any, error) {
	status, raw := c.do(http.MethodPost, path, body)
	return decodeInner(status, raw)
}

type mcpRouteError struct{ raw string }

func (e mcpRouteError) Error() string { return e.raw }

func decodeInner(status int, raw []byte) (map[string]any, error) {
	if status >= 400 {
		return nil, mcpRouteError{raw: string(raw)}
	}
	out := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, fmt.Errorf("respuesta inesperada: %s", raw)
		}
	}
	return out, nil
}

// ── the handler ───────────────────────────────────────────────────────────

func (t mcpWriteTool) params() []mcpParam {
	if !t.Money {
		return t.Params
	}
	return append(append([]mcpParam{}, t.Params...), mcpParam{
		Name: "confirmationToken", Type: "string",
		Description: "Déjelo vacío en la primera llamada: la herramienta devuelve un resumen y un token. " +
			"Solo después de que el usuario confirme explícitamente, vuelva a llamar con los MISMOS argumentos y este token.",
	})
}

func (t mcpWriteTool) definition() *mcp.Tool {
	in := &jsonschema.Schema{
		Type:                 "object",
		Properties:           map[string]*jsonschema.Schema{},
		AdditionalProperties: &jsonschema.Schema{Not: &jsonschema.Schema{}},
	}
	for _, p := range t.params() {
		in.Properties[p.Name] = p.schema()
		if p.Required {
			in.Required = append(in.Required, p.Name)
		}
	}
	sort.Strings(in.Required)
	destructive := t.Destructive
	closed := false
	return &mcp.Tool{
		Name:        t.Name,
		Title:       t.Title,
		Description: t.Description,
		InputSchema: in,
		Annotations: &mcp.ToolAnnotations{
			Title:           t.Title,
			ReadOnlyHint:    false,
			DestructiveHint: &destructive,
			IdempotentHint:  t.Idempotent,
			OpenWorldHint:   &closed,
		},
	}
}

func (s *Server) mcpWriteHandler(t mcpWriteTool) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		if msg := s.mcpThrottle(req, true); msg != "" {
			return mcpFailure(msg), nil
		}
		a, err := parseMCPArgs(req, t.params())
		if err != nil {
			return mcpFailure(err.Error()), nil
		}
		p, err := s.mcpPrincipal(req)
		if err != nil {
			return mcpFailure(`{"error":{"code":"UNAUTHORIZED","message":"authentication required"}}`), nil
		}
		if p.ReadOnly {
			// The person granted this assistant consultation only. The
			// read-only token is served a tool list without writes; this
			// is the same rule for a client that calls one anyway.
			res := mcpFailure(`{"error":{"code":"FORBIDDEN","message":"this connection was granted read-only access"}}` +
				"\nEsta conexión se autorizó solo para consultar. Para registrar, desconecte el asistente y vuelva a conectarlo eligiendo «Consultar y registrar».")
			s.mcpAudit(ctx, p, t.Name, "refused", res, a)
			return res, nil
		}
		action, known := s.mcpActions[t.Method+" "+t.Pattern]
		if !known || !auth.AllowedFor(p.Role, p.Superadmin, action) {
			res := mcpFailure(fmt.Sprintf(
				`{"error":{"code":"FORBIDDEN","message":"your role may not perform this action"}}`+
					"\nSu rol (%s) no puede usar %s.", p.Role, t.Name))
			s.mcpAudit(ctx, p, t.Name, "refused", res, a)
			return res, nil
		}
		c := &mcpCaller{s: s, ctx: ctx, req: req}

		if !t.Money {
			res := t.run(c, a, "", "")
			s.mcpAudit(ctx, p, t.Name, mcpOutcome(res), res, a)
			return res, nil
		}

		token := a.str("confirmationToken")
		delete(a, "confirmationToken")
		if token == "" {
			return s.mcpIssuePreview(c, t, p, a), nil
		}
		claim, msg := s.mcpOpenConfirmation(token, t.Name, p, a)
		if claim == nil {
			return mcpFailure(msg), nil
		}
		key := uuid.NewSHA1(mcpConfirmSpace, []byte(claim.Nonce)).String()
		res := t.run(c, a, key, claim.Bind)
		s.mcpAudit(ctx, p, t.Name, mcpOutcome(res), res, a)
		return res, nil
	}
}

func mcpOutcome(res *mcp.CallToolResult) string {
	if res == nil || res.IsError {
		return "failed"
	}
	return "done"
}

// run executes the write. It is the only place a write tool writes.
func (t mcpWriteTool) run(c *mcpCaller, a mcpArgs, key, bind string) *mcp.CallToolResult {
	if t.Execute != nil {
		return t.Execute(c, a, key, bind)
	}
	call, err := t.Build(a, key)
	if err != nil {
		return mcpFailure(err.Error())
	}
	status, raw := c.do(call.Method, call.Path, call.Body)
	return t.result(status, raw, a)
}

func (t mcpWriteTool) result(status int, raw []byte, a mcpArgs) *mcp.CallToolResult {
	if status >= 400 {
		return mcpFailure(string(raw))
	}
	body := map[string]any{}
	_ = json.Unmarshal(raw, &body)
	msg := "Listo."
	if t.Done != nil {
		msg = t.Done(status, body, a)
	}
	// For the creating money routes 201 is "written now" and 200 is "that id
	// was already there": a confirmation used twice. Say so, so nobody counts
	// the cash out a second time. (A void or a price answers 200 always.)
	if status == http.StatusOK && t.Money && t.Method == http.MethodPost && !strings.HasSuffix(t.Pattern, "/void") {
		msg += " (Si esto ya se había ejecutado con este mismo token, no se duplicó: es el mismo registro.)"
	}
	text := msg
	if len(raw) > 0 {
		text += "\n\n" + string(raw)
	}
	structured := map[string]any{"message": msg, "status": status}
	if len(body) > 0 {
		structured["result"] = body
	}
	return &mcp.CallToolResult{
		Content:           []mcp.Content{&mcp.TextContent{Text: text}},
		StructuredContent: structured,
	}
}

// mcpPrincipal reads the caller from the bearer the outer request carried.
// The outer request already passed authentication; this is the same parse,
// done again because the SDK hands the tool headers, not the request.
func (s *Server) mcpPrincipal(req *mcp.CallToolRequest) (*auth.Principal, error) {
	if req.Extra == nil || req.Extra.Header == nil {
		return nil, fmt.Errorf("no headers")
	}
	raw := bearerFromHeader(req.Extra.Header.Get("Authorization"))
	if raw == "" {
		return nil, fmt.Errorf("no bearer")
	}
	claims, err := s.signer.Parse(raw)
	if err != nil {
		return nil, err
	}
	return &auth.Principal{UserID: claims.Subject, FarmID: claims.FarmID,
		Role: claims.Role, DeviceID: claims.DeviceID, Superadmin: claims.Superadmin,
		ClientID: claims.ClientID, MCPOnly: claims.ForMCPOnly(),
		ReadOnly: claims.ForMCPOnly() && claims.ReadOnly()}, nil
}

// ── confirmation ──────────────────────────────────────────────────────────

type mcpConfirmation struct {
	V     int    `json:"v"`
	Tool  string `json:"t"`
	User  string `json:"u"`
	Farm  string `json:"f"`
	Args  string `json:"h"`
	Exp   int64  `json:"e"`
	Nonce string `json:"n"`
	Bind  string `json:"b,omitempty"`
}

// mcpArgsHash is the fingerprint of the arguments a token was issued for.
// encoding/json writes map keys sorted, and numbers were kept as the client
// wrote them, so the same arguments always give the same hash.
func mcpArgsHash(a mcpArgs) string {
	raw, _ := json.Marshal(a)
	sum := sha256.Sum256(raw)
	return base64.RawURLEncoding.EncodeToString(sum[:18])
}

func (s *Server) mcpIssuePreview(c *mcpCaller, t mcpWriteTool, p *auth.Principal, a mcpArgs) *mcp.CallToolResult {
	pv, err := t.Preview(c, a)
	if err != nil {
		return mcpFailure(err.Error())
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return mcpFailure("no se pudo generar el token de confirmación")
	}
	exp := time.Now().Add(mcpConfirmTTL)
	claim := mcpConfirmation{V: 1, Tool: t.Name, User: p.UserID, Farm: p.FarmID,
		Args: mcpArgsHash(a), Exp: exp.Unix(), Nonce: hex.EncodeToString(nonce), Bind: pv.Bind}
	payload, _ := json.Marshal(claim)
	token := s.signer.Seal(mcpConfirmPurpose, payload)

	text := "CONFIRMACIÓN REQUERIDA — todavía no se ha registrado nada.\n\n" + pv.Summary +
		"\n\nMuéstrele este resumen al usuario. Solo si el usuario confirma explícitamente, llame otra vez a `" +
		t.Name + "` con los MISMOS argumentos y confirmationToken=\"" + token + "\". " +
		"El token vence en 10 minutos y solo sirve para esta operación; usarlo dos veces no la duplica."
	facts := pv.Facts
	if facts == nil {
		facts = map[string]any{}
	}
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: text}},
		StructuredContent: map[string]any{
			"status":            "confirmation_required",
			"summary":           pv.Summary,
			"preview":           facts,
			"confirmationToken": token,
			"expiresAt":         exp.UTC().Format(time.RFC3339),
		},
	}
}

// mcpOpenConfirmation checks a token against everything it was bound to. The
// messages are for the assistant, in Spanish, and say what to do next.
func (s *Server) mcpOpenConfirmation(token, tool string, p *auth.Principal, a mcpArgs) (*mcpConfirmation, string) {
	payload, err := s.signer.Open(mcpConfirmPurpose, token)
	if err != nil {
		return nil, "El confirmationToken no es válido. Llame sin token para obtener un resumen nuevo."
	}
	var claim mcpConfirmation
	if json.Unmarshal(payload, &claim) != nil || claim.V != 1 {
		return nil, "El confirmationToken no es válido. Llame sin token para obtener un resumen nuevo."
	}
	switch {
	case claim.Tool != tool:
		return nil, "Ese confirmationToken es de otra operación (" + claim.Tool + "), no de " + tool + "."
	case claim.User != p.UserID || claim.Farm != p.FarmID:
		return nil, "Ese confirmationToken fue emitido para otro usuario o para otra finca."
	case time.Now().Unix() > claim.Exp:
		return nil, "El confirmationToken venció. Llame sin token para obtener un resumen nuevo y vuelva a confirmar con el usuario."
	case claim.Args != mcpArgsHash(a):
		return nil, "Los argumentos no son los mismos que se confirmaron. Llame sin token con los argumentos correctos para obtener un resumen nuevo."
	}
	return &claim, ""
}

// ── money in words ────────────────────────────────────────────────────────

// pesos writes centavos the way the farm reads them: $1.234.567, and the
// centavos only when there are any.
func pesos(cents int64) string {
	neg := cents < 0
	if neg {
		cents = -cents
	}
	whole, frac := cents/100, cents%100
	digits := fmt.Sprintf("%d", whole)
	var b strings.Builder
	for i, ch := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(ch)
	}
	out := "$" + b.String()
	if frac != 0 {
		out += fmt.Sprintf(",%02d", frac)
	}
	if neg {
		out = "-" + out
	}
	return out
}

func numField(m map[string]any, k string) int64 {
	switch v := m[k].(type) {
	case float64:
		return int64(v)
	case json.Number:
		i, _ := v.Int64()
		return i
	}
	return 0
}

func strField(m map[string]any, k string) string {
	v, _ := m[k].(string)
	return v
}

func workerName(w map[string]any) string {
	n := strings.TrimSpace(strField(w, "name") + " " + strField(w, "lastName"))
	if n == "" {
		return "el trabajador"
	}
	return n
}

func pathID(v string) string { return url.PathEscape(v) }

// ── schemas shared by the table ───────────────────────────────────────────

var (
	wID       = mcpParam{Name: "id", Type: "string", Format: "uuid", Description: "Opcional: un UUID propio como clave de idempotencia. Reenviar la misma llamada con el mismo id no crea un duplicado."}
	wWorkerID = mcpParam{Name: "workerId", Type: "string", Format: "uuid", Required: true, Description: "El trabajador (UUID; búsquelo con list_workers)."}
	wAmount   = mcpParam{Name: "amountCents", Type: "integer", Required: true, Description: "El valor en CENTAVOS, positivo. $50.000 son 5000000."}
	wMethod   = mcpParam{Name: "method", Type: "string", Enum: []string{"efectivo", "transferencia", "otro"}, Description: "Cómo se entregó el dinero."}
	wNote     = mcpParam{Name: "note", Type: "string", Description: "Nota libre."}
	wDate     = mcpParam{Name: "date", Type: "string", Format: "date", Description: "Fecha (YYYY-MM-DD). Por defecto, hoy en la zona de la finca."}
	// wReceivedBy is «¿Quién recibe la plata?» on money handed to a team.
	wReceivedBy = mcpParam{Name: "receivedBy", Type: "string", Format: "uuid", Description: "Solo para un equipo, opcional: el integrante (UUID, ver members en list_workers) que recibió la plata. Queda en el recibo; el saldo sigue siendo del equipo."}
)

// uuidList reads an array of strings argument.
func (a mcpArgs) uuidList(k string) ([]string, error) {
	raw, ok := a[k].([]any)
	if !ok {
		if a[k] == nil {
			return []string{}, nil
		}
		return nil, fmt.Errorf("%q debe ser una lista de UUID", k)
	}
	out := make([]string, 0, len(raw))
	for i, v := range raw {
		s, ok := v.(string)
		if !ok || strings.TrimSpace(s) == "" {
			return nil, fmt.Errorf("%s[%d] debe ser un UUID", k, i)
		}
		out = append(out, strings.TrimSpace(s))
	}
	return out, nil
}

func jsonschemaInt(n int) *int { return &n }

// memberNames lists a team's members («Yorman y Sergio») from a worker body.
func memberNames(w map[string]any) string {
	members, _ := w["members"].([]any)
	names := make([]string, 0, len(members))
	for _, raw := range members {
		m, _ := raw.(map[string]any)
		names = append(names, workerName(m))
	}
	switch len(names) {
	case 0:
		return "ningún integrante"
	case 1:
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " y " + names[len(names)-1]
}

// looksLikeTeamName says a worker's name reads like several people: «Yorman y
// Sergio», «Ana / Luis», «Pedro & Juan», «Ana, Luis». A hint, never a refusal.
func looksLikeTeamName(name string) bool {
	n := " " + strings.ToLower(strings.TrimSpace(name)) + " "
	for _, sep := range []string{" y ", " e ", "/", "&", " + ", ","} {
		if strings.Contains(n, sep) {
			return true
		}
	}
	return false
}

var weighingItemSchema = &jsonschema.Schema{
	Type: "object",
	Properties: map[string]*jsonschema.Schema{
		"workerId":   {Type: "string", Format: "uuid", Description: "El recolector (UUID)."},
		"date":       {Type: "string", Format: "date", Description: "El día (YYYY-MM-DD), dentro de la semana."},
		"kg":         {Type: "number", Description: "Kilos, positivo, máximo tres decimales."},
		"plotId":     {Type: "string", Format: "uuid", Description: "Opcional: el lote."},
		"plotCropId": {Type: "string", Format: "uuid", Description: "Opcional: el cultivo del lote."},
		"note":       {Type: "string", Description: "Opcional."},
	},
	Required:             []string{"date", "kg", "workerId"},
	AdditionalProperties: &jsonschema.Schema{Not: &jsonschema.Schema{}},
}

var cropItemSchema = &jsonschema.Schema{
	Type: "object",
	Properties: map[string]*jsonschema.Schema{
		"cropType": {Type: "string", Description: "El cultivo por nombre (p. ej. Café). Si no existe en el catálogo se crea."},
		"variety":  {Type: "string", Description: "Opcional: la variedad (p. ej. Castillo)."},
		"areaHa":   {Type: "number", Description: "Opcional: hectáreas de este cultivo."},
	},
	Required:             []string{"cropType"},
	AdditionalProperties: &jsonschema.Schema{Not: &jsonschema.Schema{}},
}

// ── the table ─────────────────────────────────────────────────────────────

var mcpWriteTools = []mcpWriteTool{
	{
		Name: "create_worker", Title: "Crear trabajador",
		Description: "Registra UNA persona (recolector) nueva en la finca. Son obligatorios el nombre y el número de canasto (tag), " +
			"que no puede tenerlo otro trabajador o equipo activo de la finca (DUPLICATE_TAG dice quién lo tiene: pida otro número al usuario, no invente uno). " +
			"Si ya existe uno desactivado con el mismo documento, la finca responde EMPLOYEE_EXISTS_DELETED: reactívelo con update_worker status=active en vez de crear otro. " +
			"IMPORTANTE: si son dos o más personas que recogen juntas y cobran juntas (p. ej. «Yorman y Sergio», «Ana / Luis», «Pedro & Juan»), " +
			"NO cree un solo trabajador con los dos nombres: cree cada persona con create_worker y después el equipo con create_team. " +
			"El equipo es el que se pesa, se liquida y se paga; los promedios se dividen entre sus integrantes.",
		Method: http.MethodPost, Pattern: "/v1/workers",
		Params: []mcpParam{
			{Name: "name", Type: "string", Required: true, Description: "Nombre(s)."},
			{Name: "lastName", Type: "string", Description: "Apellidos."},
			{Name: "tag", Type: "string", Required: true, Description: "Número de canasto (obligatorio), p. ej. 46. Único entre los trabajadores y equipos activos de la finca."},
			{Name: "documentType", Type: "string", Description: "Tipo de documento (CC, CE, TI, PPT…)."},
			{Name: "docId", Type: "string", Description: "Número de documento."},
			{Name: "phone", Type: "string", Description: "Teléfono."},
			{Name: "city", Type: "string", Description: "Ciudad."},
			{Name: "municipality", Type: "string", Description: "Municipio."},
			wID,
		},
		Idempotent: true,
		Build: func(a mcpArgs, _ string) (mcpCall, error) {
			b := map[string]any{}
			a.copyStr(b, "name", "lastName", "tag", "documentType", "docId", "phone", "city", "municipality", "id")
			return mcpCall{http.MethodPost, "/v1/workers", b}, nil
		},
		Done: func(status int, b map[string]any, _ mcpArgs) string {
			if status == http.StatusOK {
				return "Ese id ya existía: no se creó otro trabajador (" + workerName(b) + ")."
			}
			msg := "Trabajador creado: " + workerName(b) + ", canasto " + strField(b, "tag") + " (id " + strField(b, "id") + ")."
			if looksLikeTeamName(workerName(b)) {
				msg += " Atención: el nombre parece de VARIAS personas. Si recogen y cobran juntas, " +
					"conviértalo en equipo (update_worker kind=equipo) y agregue cada persona con create_worker y set_team_members."
			}
			return msg
		},
	},
	{
		Name: "update_worker", Title: "Actualizar o desactivar trabajador o equipo",
		Description: "Cambia los datos de un trabajador o de un equipo, o lo desactiva (status=inactive) o reactiva (status=active). " +
			"Desactivar no borra nada: su historia y su saldo se conservan. Solo se cambian los campos que envíe. " +
			"tag es el número de canasto: se puede cambiar pero no quitar, y no puede repetir el de otro activo (DUPLICATE_TAG). " +
			"Úselo para ponerle canasto a quien aparece con tag null («Sin canasto»). Para reactivar a alguien cuyo número ya tiene otro, envíe status=active con un tag nuevo. " +
			"kind=equipo convierte un registro que en realidad es de varias personas (p. ej. «Yorman y Sergio») en un equipo, " +
			"conservando su id, sus pesadas y su saldo; luego cree cada persona y agréguelas con set_team_members.",
		Method: http.MethodPatch, Pattern: "/v1/workers/{id}",
		Params: []mcpParam{
			{Name: "id", Type: "string", Format: "uuid", Required: true, Description: "El trabajador (UUID)."},
			{Name: "name", Type: "string", Description: "Nombre(s)."},
			{Name: "lastName", Type: "string", Description: "Apellidos."},
			{Name: "tag", Type: "string", Description: "Número de canasto nuevo. Único entre los activos; no se puede dejar vacío."},
			{Name: "documentType", Type: "string", Description: "Tipo de documento."},
			{Name: "docId", Type: "string", Description: "Número de documento."},
			{Name: "phone", Type: "string", Description: "Teléfono."},
			{Name: "city", Type: "string", Description: "Ciudad."},
			{Name: "municipality", Type: "string", Description: "Municipio."},
			{Name: "status", Type: "string", Enum: []string{"active", "inactive"}, Description: "inactive lo saca de la nómina; active lo reactiva."},
			{Name: "kind", Type: "string", Enum: []string{"persona", "equipo"}, Description: "persona o equipo. Un equipo con integrantes no puede volver a persona, ni una persona que está en un equipo volverse equipo."},
		},
		Destructive: true, Idempotent: true,
		Build: func(a mcpArgs, _ string) (mcpCall, error) {
			b := map[string]any{}
			a.copyStr(b, "name", "lastName", "tag", "documentType", "docId", "phone", "city", "municipality", "status", "kind")
			if len(b) == 0 {
				return mcpCall{}, fmt.Errorf("no envió ningún cambio")
			}
			return mcpCall{http.MethodPatch, "/v1/workers/" + pathID(a.str("id")), b}, nil
		},
		Done: func(_ int, b map[string]any, a mcpArgs) string {
			switch a.str("status") {
			case "inactive":
				return "Trabajador desactivado: " + workerName(b) + "."
			case "active":
				return "Trabajador activo: " + workerName(b) + "."
			}
			if a.str("kind") == "equipo" {
				return "Ahora es un equipo: " + workerName(b) + ". Agregue sus integrantes con set_team_members."
			}
			return "Trabajador actualizado: " + workerName(b) + "."
		},
	},
	{
		Name: "create_team", Title: "Crear equipo",
		Description: "Crea un EQUIPO: dos o más personas que recogen juntas (un solo bulto) y cobran juntas, p. ej. Yorman y Sergio. " +
			"El equipo es una sola cuenta: se pesa al equipo (register_weighing / register_harvest_week con el id del equipo), " +
			"se liquida y se paga al equipo, y su saldo es uno solo. Para los promedios y el ranking, sus kilos se dividen entre los integrantes. " +
			"Cada integrante debe existir antes como persona (create_worker) y no puede estar en otro equipo. " +
			"El equipo necesita SU PROPIO número de canasto (tag, obligatorio; p. ej. 46-63 o el número del canasto que comparten), distinto del de cualquier otro activo; " +
			"sus integrantes conservan el suyo. " +
			"Mientras esté en el equipo, a un integrante no se le registran pesadas, anticipos ni descuentos propios (WORKER_IN_TEAM).",
		Method: http.MethodPost, Pattern: "/v1/workers",
		Params: []mcpParam{
			{Name: "name", Type: "string", Required: true, Description: "Nombre del equipo, p. ej. «Yorman y Sergio»."},
			{Name: "tag", Type: "string", Required: true, Description: "Número de canasto del equipo (obligatorio), p. ej. 46-63. Único entre los activos de la finca."},
			{Name: "memberIds", Required: true, Schema: &jsonschema.Schema{Type: "array", Items: &jsonschema.Schema{Type: "string", Format: "uuid"},
				MinItems: jsonschemaInt(1), Description: "Los integrantes (UUID de personas, ver list_workers)."}},
			{Name: "membersFrom", Type: "string", Format: "date", Description: "Desde qué día son equipo (YYYY-MM-DD). Por defecto, hoy."},
			wID,
		},
		Idempotent: true,
		Build: func(a mcpArgs, _ string) (mcpCall, error) {
			ids, err := a.uuidList("memberIds")
			if err != nil {
				return mcpCall{}, err
			}
			if len(ids) == 0 {
				return mcpCall{}, fmt.Errorf("memberIds necesita al menos un integrante")
			}
			b := map[string]any{"kind": "equipo", "memberIds": ids}
			a.copyStr(b, "name", "tag", "membersFrom", "id")
			return mcpCall{http.MethodPost, "/v1/workers", b}, nil
		},
		Done: func(status int, b map[string]any, _ mcpArgs) string {
			if status == http.StatusOK {
				return "Ese id ya existía: no se creó otro equipo (" + workerName(b) + ")."
			}
			return "Equipo creado: " + workerName(b) + ", canasto " + strField(b, "tag") + ", con " + memberNames(b) + " (id " + strField(b, "id") + ")."
		},
	},
	{
		Name: "set_team_members", Title: "Cambiar los integrantes de un equipo",
		Description: "Deja como integrantes de un equipo exactamente las personas de memberIds, desde el día `from` (por defecto hoy): " +
			"quien no esté en la lista sale del equipo el día anterior, y quien no estaba entra ese día. La historia anterior no cambia. " +
			"Para convertir un registro combinado (p. ej. «Yorman y Sergio») primero use update_worker kind=equipo.",
		Method: http.MethodPatch, Pattern: "/v1/workers/{id}",
		Params: []mcpParam{
			{Name: "teamId", Type: "string", Format: "uuid", Required: true, Description: "El equipo (UUID, ver list_workers: kind=equipo)."},
			{Name: "memberIds", Required: true, Schema: &jsonschema.Schema{Type: "array", Items: &jsonschema.Schema{Type: "string", Format: "uuid"},
				Description: "Todos los integrantes desde `from` (UUID de personas). Una lista vacía deja el equipo sin integrantes."}},
			{Name: "from", Type: "string", Format: "date", Description: "Desde qué día (YYYY-MM-DD). Por defecto, hoy."},
		},
		Destructive: true, Idempotent: true,
		Build: func(a mcpArgs, _ string) (mcpCall, error) {
			ids, err := a.uuidList("memberIds")
			if err != nil {
				return mcpCall{}, err
			}
			b := map[string]any{"memberIds": ids}
			if a.has("from") {
				b["membersFrom"] = a["from"]
			}
			return mcpCall{http.MethodPatch, "/v1/workers/" + pathID(a.str("teamId")), b}, nil
		},
		Done: func(_ int, b map[string]any, _ mcpArgs) string {
			return "Integrantes de " + workerName(b) + ": " + memberNames(b) + "."
		},
	},
	{
		Name: "create_plot", Title: "Crear lote",
		Description: "Crea un lote de la finca, con su cultivo. Dé el cultivo con cropType (y variety) o, si el lote tiene varios, con crops. " +
			"El cultivo es el que luego se elige al registrar pesadas por lote.",
		Method: http.MethodPost, Pattern: "/v1/plots",
		Params: []mcpParam{
			{Name: "name", Type: "string", Required: true, Description: "Nombre del lote."},
			{Name: "areaHa", Type: "number", Description: "Área declarada en hectáreas (máximo tres decimales)."},
			{Name: "department", Type: "string", Description: "Departamento."},
			{Name: "municipality", Type: "string", Description: "Municipio."},
			{Name: "cropType", Type: "string", Description: "El cultivo del lote por nombre (p. ej. Café)."},
			{Name: "variety", Type: "string", Description: "La variedad del cultivo (p. ej. Castillo)."},
			{Name: "crops", Schema: &jsonschema.Schema{Type: "array", Items: cropItemSchema,
				Description: "Varios cultivos en el mismo lote. Úselo en vez de cropType/variety."}},
			wID,
		},
		Idempotent: true,
		Build: func(a mcpArgs, _ string) (mcpCall, error) {
			b := map[string]any{}
			a.copyStr(b, "name", "department", "municipality", "id")
			if a.has("areaHa") {
				n, err := a.num("areaHa")
				if err != nil {
					return mcpCall{}, err
				}
				b["areaHa"] = n
			}
			switch {
			case a.has("crops") && a.has("cropType"):
				return mcpCall{}, fmt.Errorf("envíe cropType o crops, no los dos")
			case a.has("crops"):
				b["crops"] = a["crops"]
			case a.has("cropType"):
				crop := map[string]any{"cropType": a["cropType"]}
				if a.has("variety") {
					crop["variety"] = a["variety"]
				}
				b["crops"] = []any{crop}
			case a.has("variety"):
				return mcpCall{}, fmt.Errorf("variety necesita cropType")
			}
			return mcpCall{http.MethodPost, "/v1/plots", b}, nil
		},
		Done: func(status int, b map[string]any, _ mcpArgs) string {
			if status == http.StatusOK {
				return "Ese id ya existía: no se creó otro lote."
			}
			return "Lote creado: " + strField(b, "name") + " (id " + strField(b, "id") + ")."
		},
	},
	{
		Name: "register_weighing", Title: "Registrar una pesada",
		Description: "Registra UNA pesada: cuántos kilos recogió un trabajador o un EQUIPO un día. Se paga al precio de la semana cuando se liquide. " +
			"Si la persona está en un equipo, pese al equipo (workerId del equipo, ver list_workers): a un integrante no se le registran pesadas propias (WORKER_IN_TEAM). " +
			"Aunque ese día venga un solo integrante, se pesa al equipo. Si el usuario dice un número de canasto (p. ej. «el 46 trajo 30 kg»), " +
			"búsquelo con list_workers q=46 (tag es el canasto) y confirme el nombre antes de registrar. Para una semana completa de varias personas use register_harvest_week.",
		Method: http.MethodPost, Pattern: "/v1/pickups",
		Params: []mcpParam{
			wWorkerID,
			{Name: "kg", Type: "number", Required: true, Description: "Kilos, positivo, máximo tres decimales."},
			{Name: "date", Type: "string", Format: "date", Required: true, Description: "El día de la pesada (YYYY-MM-DD)."},
			{Name: "plotId", Type: "string", Format: "uuid", Description: "Opcional: el lote (list_plots)."},
			{Name: "plotCropId", Type: "string", Format: "uuid", Description: "Opcional: el cultivo del lote (list_plots)."},
			{Name: "activityId", Type: "string", Format: "uuid", Description: "Opcional: la labor. Por defecto, la recolección de la finca."},
			wNote, wID,
		},
		Idempotent: true,
		Build: func(a mcpArgs, _ string) (mcpCall, error) {
			kg, err := a.num("kg")
			if err != nil {
				return mcpCall{}, err
			}
			b := map[string]any{"workerId": a["workerId"], "weight": kg, "date": a["date"]}
			a.copyStr(b, "plotId", "activityId", "note", "id")
			if a.has("plotCropId") {
				b["cropId"] = a["plotCropId"]
			}
			return mcpCall{http.MethodPost, "/v1/pickups", b}, nil
		},
		Done: func(status int, b map[string]any, _ mcpArgs) string {
			if status == http.StatusOK {
				return "Esa pesada ya estaba registrada con ese id: no se duplicó."
			}
			return fmt.Sprintf("Pesada registrada: %v kg el %s (id %s).", b["quantity"], strings.TrimSuffix(strField(b, "dateFrom"), "T00:00:00Z"), strField(b, "id"))
		},
	},
	{
		Name: "register_harvest_week", Title: "Registrar la cosecha de una semana",
		Description: "Registra de una sola vez todas las pesadas de una semana (varias personas, varios días). Es atómico: si una línea falla, " +
			"no se guarda ninguna y el error dice cuál línea (details.line, desde 0). Todas las fechas deben caer en la semana del lunes indicado. " +
			"Un equipo (kind=equipo en list_workers) es una sola fila: use el workerId del equipo, nunca el de sus integrantes (WORKER_IN_TEAM). " +
			"Si la planilla trae números de canasto en vez de nombres, tradúzcalos con list_workers (tag = canasto). " +
			"Envíe un id (UUID) propio para poder reintentar sin duplicar.",
		Method: http.MethodPost, Pattern: "/v1/work-records/batch",
		Params: []mcpParam{
			{Name: "monday", Type: "string", Format: "date", Required: true, Description: "El lunes de la semana (YYYY-MM-DD)."},
			{Name: "weighings", Required: true, Schema: &jsonschema.Schema{Type: "array", Items: weighingItemSchema,
				Description: "Una fila por pesada: trabajador, día y kilos."}},
			{Name: "activityId", Type: "string", Format: "uuid", Description: "Opcional: la labor. Por defecto, la recolección de la finca."},
			{Name: "id", Type: "string", Format: "uuid", Description: "Opcional pero recomendado: UUID del lote de pesadas. Reenviar con el mismo id no duplica nada."},
		},
		Idempotent: true,
		Build: func(a mcpArgs, _ string) (mcpCall, error) {
			rows, ok := a["weighings"].([]any)
			if !ok || len(rows) == 0 {
				return mcpCall{}, fmt.Errorf("weighings debe ser una lista con al menos una pesada")
			}
			items := make([]any, 0, len(rows))
			for i, raw := range rows {
				row, ok := raw.(map[string]any)
				if !ok {
					return mcpCall{}, fmt.Errorf("weighings[%d] debe ser un objeto", i)
				}
				ra := mcpArgs(row)
				for k := range row {
					if _, ok := weighingItemSchema.Properties[k]; !ok {
						return mcpCall{}, fmt.Errorf("weighings[%d]: parámetro desconocido %q", i, k)
					}
				}
				if ra.str("workerId") == "" || ra.str("date") == "" || !ra.has("kg") {
					return mcpCall{}, fmt.Errorf("weighings[%d] necesita workerId, date y kg", i)
				}
				kg, err := ra.num("kg")
				if err != nil {
					return mcpCall{}, fmt.Errorf("weighings[%d]: %v", i, err)
				}
				it := map[string]any{"workerId": row["workerId"], "quantity": kg, "dateFrom": row["date"]}
				if ra.has("plotId") {
					it["plotIds"] = []any{row["plotId"]}
				}
				if ra.has("plotCropId") {
					it["plotCropIds"] = []any{row["plotCropId"]}
				}
				if ra.has("note") {
					it["note"] = row["note"]
				}
				items = append(items, it)
			}
			b := map[string]any{"weekStart": a["monday"], "items": items}
			a.copyStr(b, "activityId", "id")
			return mcpCall{http.MethodPost, "/v1/work-records/batch", b}, nil
		},
		Done: func(status int, b map[string]any, _ mcpArgs) string {
			created, existing := numField(b, "created"), numField(b, "existing")
			if status == http.StatusOK {
				return fmt.Sprintf("Esas %d pesadas ya estaban registradas con ese id: no se duplicó nada.", existing)
			}
			return fmt.Sprintf("Semana registrada: %d pesadas nuevas (%d ya existían).", created, existing)
		},
	},
	{
		Name: "correct_weighing", Title: "Corregir una pesada",
		Description: "Corrige los kilos o la nota de una pesada que todavía no se ha liquidado (id de list_work_records). " +
			"Una pesada ya liquidada no se puede corregir: primero hay que anular su liquidación. " +
			"El trabajador, la labor y la fecha no se cambian: anule la pesada y registre la correcta.",
		Method: http.MethodPatch, Pattern: "/v1/work-records/{id}",
		Params: []mcpParam{
			{Name: "id", Type: "string", Format: "uuid", Required: true, Description: "La pesada (UUID)."},
			{Name: "kg", Type: "number", Description: "Los kilos correctos."},
			wNote,
		},
		Destructive: true, Idempotent: true,
		Build: func(a mcpArgs, _ string) (mcpCall, error) {
			b := map[string]any{}
			if a.has("kg") {
				kg, err := a.num("kg")
				if err != nil {
					return mcpCall{}, err
				}
				b["quantity"] = kg
			}
			a.copyStr(b, "note")
			if len(b) == 0 {
				return mcpCall{}, fmt.Errorf("envíe kg o note")
			}
			return mcpCall{http.MethodPatch, "/v1/work-records/" + pathID(a.str("id")), b}, nil
		},
		Done: func(_ int, b map[string]any, _ mcpArgs) string {
			return fmt.Sprintf("Pesada corregida: ahora %v kg.", b["quantity"])
		},
	},
	{
		Name: "void_weighing", Title: "Anular una pesada",
		Description: "Anula una pesada que todavía no se ha liquidado. No se borra: queda anulada en la historia y deja de contar para el pago. " +
			"Una pesada ya liquidada no se puede anular: primero hay que anular su liquidación.",
		Method: http.MethodDelete, Pattern: "/v1/work-records/{id}",
		Params: []mcpParam{
			{Name: "id", Type: "string", Format: "uuid", Required: true, Description: "La pesada (UUID)."},
		},
		Destructive: true, Idempotent: true,
		Build: func(a mcpArgs, _ string) (mcpCall, error) {
			return mcpCall{http.MethodDelete, "/v1/work-records/" + pathID(a.str("id")), nil}, nil
		},
		Done: func(int, map[string]any, mcpArgs) string { return "Pesada anulada." },
	},
	{
		Name: "set_kilo_price", Title: "Cambiar el precio del kilo",
		Description: "Cambia el precio del kilo. scope=base: el precio base de la finca desde ese lunes en adelante (hasta el siguiente cambio). " +
			"scope=week: el precio solo de esa semana. Las pesadas ya liquidadas conservan su precio; las pendientes toman el nuevo. " +
			"Mueve dinero: la primera llamada devuelve un resumen y un confirmationToken; ejecútelo solo si el usuario confirma. Solo el dueño.",
		Method: http.MethodPut, Pattern: "/v1/prices/base/{monday}",
		Params: []mcpParam{
			{Name: "scope", Type: "string", Required: true, Enum: []string{"base", "week"}, Description: "base = desde ese lunes en adelante; week = solo esa semana."},
			{Name: "monday", Type: "string", Format: "date", Required: true, Description: "Un lunes (YYYY-MM-DD)."},
			{Name: "priceCents", Type: "integer", Required: true, Description: "El precio de un kilo en CENTAVOS. $800 son 80000."},
		},
		Destructive: true, Idempotent: true, Money: true,
		Build:   buildPrice,
		Preview: previewPrice,
		Execute: executePrice,
		Done:    donePrice,
	},
	{
		Name: "register_advance", Title: "Registrar un anticipo",
		Description: "Registra un anticipo: dinero entregado a un trabajador o a un equipo antes de liquidar su trabajo (puede dejarlo debiendo). " +
			"A un integrante de un equipo no se le dan anticipos propios: se le dan al equipo, y receivedBy dice qué integrante recibió la plata. " +
			"Mueve dinero: la primera llamada devuelve un resumen y un confirmationToken; ejecútelo solo si el usuario confirma.",
		Method: http.MethodPost, Pattern: "/v1/advances",
		Params:     []mcpParam{wWorkerID, wAmount, wMethod, wNote, wDate, wReceivedBy},
		Idempotent: true, Money: true,
		Build:   buildLedger("/v1/advances", false),
		Preview: previewLedger("ANTICIPO"),
		Done: func(_ int, b map[string]any, _ mcpArgs) string {
			return "Anticipo registrado por " + pesos(-numField(b, "amountCents")) + " (id " + strField(b, "id") + ")."
		},
	},
	{
		Name: "register_payment", Title: "Registrar un pago",
		Description: "Registra un pago a un trabajador o a un equipo contra su saldo. El saldo de un equipo es uno solo: se le paga al equipo, " +
			"y receivedBy (opcional) dice qué integrante recibió la plata («¿Quién recibe la plata?»; queda en el recibo). " +
			"Si supera el saldo, la finca lo rechaza (AMOUNT_EXCEEDS_BALANCE) salvo allowOverpayment=true, " +
			"y el exceso queda como anticipo. Mueve dinero: la primera llamada devuelve un resumen y un confirmationToken; ejecútelo solo si el usuario confirma.",
		Method: http.MethodPost, Pattern: "/v1/payments",
		Params: []mcpParam{wWorkerID, wAmount, wMethod, wNote, wDate, wReceivedBy,
			{Name: "allowOverpayment", Type: "boolean", Description: "Pagar más que el saldo a propósito; el exceso queda como anticipo."}},
		Idempotent: true, Money: true,
		Build:   buildLedger("/v1/payments", true),
		Preview: previewLedger("PAGO"),
		Done: func(_ int, b map[string]any, _ mcpArgs) string {
			return "Pago registrado por " + pesos(-numField(b, "amountCents")) + " (id " + strField(b, "id") + "; el recibo está en get_payment)."
		},
	},
	{
		Name: "create_settlement", Title: "Liquidar a un trabajador o equipo",
		Description: "Crea una liquidación: toma el trabajo pendiente de un trabajador o de un EQUIPO en un rango de fechas, lo valora al precio vigente y lo suma a su saldo (devengo). " +
			"Un equipo se liquida como una sola cuenta (workerId del equipo). " +
			"Después se registra el pago con register_payment. Mueve dinero: la primera llamada devuelve el resumen (labores y bruto) y un confirmationToken; " +
			"ejecútelo solo si el usuario confirma. Si algo cambió entre el resumen y la confirmación, no liquida y pide un resumen nuevo.",
		Method: http.MethodPost, Pattern: "/v1/settlements",
		Params: []mcpParam{wWorkerID,
			{Name: "from", Type: "string", Format: "date", Required: true, Description: "Desde (YYYY-MM-DD)."},
			{Name: "to", Type: "string", Format: "date", Required: true, Description: "Hasta (YYYY-MM-DD)."},
			{Name: "payableIds", Schema: &jsonschema.Schema{Type: "array", Items: &jsonschema.Schema{Type: "string", Format: "uuid"},
				Description: "Opcional: solo estas labores (ids de worker_payables o pending). Sin esto, todo lo pendiente del rango."}},
			wNote},
		Money: true, Idempotent: true,
		Preview: previewSettlement,
		Execute: executeSettlement,
	},
	{
		Name: "void_settlement", Title: "Anular una liquidación",
		Description: "Anula una liquidación: su devengo se reversa en el saldo y sus pesadas vuelven a quedar pendientes. Nada se borra. " +
			"Mueve dinero: la primera llamada devuelve un resumen y un confirmationToken; ejecútelo solo si el usuario confirma.",
		Method: http.MethodPost, Pattern: "/v1/settlements/{id}/void",
		Params: []mcpParam{
			{Name: "id", Type: "string", Format: "uuid", Required: true, Description: "La liquidación (UUID, ver list_settlements)."},
		},
		Destructive: true, Idempotent: true, Money: true,
		Build: func(a mcpArgs, key string) (mcpCall, error) {
			return mcpCall{http.MethodPost, "/v1/settlements/" + pathID(a.str("id")) + "/void", map[string]any{"id": key}}, nil
		},
		Preview: previewVoidSettlement,
		Done: func(_ int, b map[string]any, _ mcpArgs) string {
			return "Liquidación anulada (" + pesos(numField(b, "grossCents")) + "): el devengo quedó reversado y sus labores vuelven a estar pendientes."
		},
	},
}

// ── the money tools' pieces ───────────────────────────────────────────────

func buildLedger(path string, payment bool) func(a mcpArgs, key string) (mcpCall, error) {
	return func(a mcpArgs, key string) (mcpCall, error) {
		amount, err := a.int("amountCents")
		if err != nil {
			return mcpCall{}, err
		}
		if amount <= 0 {
			return mcpCall{}, fmt.Errorf("amountCents debe ser positivo")
		}
		b := map[string]any{"workerId": a["workerId"], "amountCents": amount}
		a.copyStr(b, "method", "note", "date", "receivedBy")
		if payment {
			if v, ok := a["allowOverpayment"].(bool); ok {
				b["allowOverpayment"] = v
			}
		}
		if key != "" {
			b["id"] = key
		}
		return mcpCall{http.MethodPost, path, b}, nil
	}
}

func previewLedger(kind string) func(c *mcpCaller, a mcpArgs) (*mcpPreview, error) {
	return func(c *mcpCaller, a mcpArgs) (*mcpPreview, error) {
		amount, err := a.int("amountCents")
		if err != nil {
			return nil, err
		}
		if amount <= 0 {
			return nil, fmt.Errorf("amountCents debe ser positivo")
		}
		id := pathID(a.str("workerId"))
		w, err := c.get("/v1/workers/" + id)
		if err != nil {
			return nil, err
		}
		bal, err := c.get("/v1/workers/" + id + "/balance")
		if err != nil {
			return nil, err
		}
		before := numField(bal, "balanceCents")
		after := before - amount
		var sb strings.Builder
		fmt.Fprintf(&sb, "%s de %s a %s", kind, pesos(amount), workerName(w))
		if strField(w, "kind") == "equipo" {
			fmt.Fprintf(&sb, " (equipo: %s)", memberNames(w))
		}
		if m := a.str("method"); m != "" {
			fmt.Fprintf(&sb, " (%s)", m)
		}
		if rb := a.str("receivedBy"); rb != "" {
			who := rb
			if members, ok := w["members"].([]any); ok {
				for _, raw := range members {
					m, _ := raw.(map[string]any)
					if strField(m, "id") == rb {
						who = workerName(m)
					}
				}
			}
			fmt.Fprintf(&sb, ", recibe %s", who)
		}
		if d := a.str("date"); d != "" {
			fmt.Fprintf(&sb, ", fecha %s", d)
		}
		sb.WriteString(".\n")
		fmt.Fprintf(&sb, "Saldo actual a favor del trabajador: %s. Después quedaría: %s.", pesos(before), pesos(after))
		if kind == "PAGO" && after < 0 {
			if v, _ := a["allowOverpayment"].(bool); v {
				fmt.Fprintf(&sb, "\nAtención: paga %s más que el saldo; el exceso queda como anticipo.", pesos(-after))
			} else {
				fmt.Fprintf(&sb, "\nAtención: supera el saldo en %s; la finca lo rechazará salvo que se llame con allowOverpayment=true.", pesos(-after))
			}
		}
		if n := a.str("note"); n != "" {
			fmt.Fprintf(&sb, "\nNota: %s", n)
		}
		return &mcpPreview{Summary: sb.String(), Facts: map[string]any{
			"kind": strings.ToLower(kind), "worker": workerName(w), "workerId": a.str("workerId"),
			"amountCents": amount, "balanceBeforeCents": before, "balanceAfterCents": after,
		}}, nil
	}
}

func previewPrice(c *mcpCaller, a mcpArgs) (*mcpPreview, error) {
	price, err := a.int("priceCents")
	if err != nil {
		return nil, err
	}
	if price <= 0 {
		return nil, fmt.Errorf("priceCents debe ser positivo")
	}
	monday := a.str("monday")
	d, err := time.Parse("2006-01-02", monday)
	if err != nil || d.Weekday() != time.Monday {
		return nil, fmt.Errorf("monday debe ser un lunes, YYYY-MM-DD")
	}
	facts := map[string]any{"scope": a.str("scope"), "monday": monday, "newPriceCents": price}
	var sb strings.Builder
	if a.str("scope") == "week" {
		wk, err := c.get("/v1/prices/weeks/" + pathID(monday))
		if err != nil {
			return nil, err
		}
		cur := numField(wk, "priceCents")
		facts["currentPriceCents"] = cur
		fmt.Fprintf(&sb, "CAMBIO DE PRECIO solo para la semana del lunes %s: de %s a %s por kilo.\n", monday, pesos(cur), pesos(price))
		sb.WriteString("Las pesadas de esa semana que no estén liquidadas se pagarán al nuevo precio; las liquidadas conservan el suyo.")
	} else {
		base, err := c.get("/v1/prices/base")
		if err != nil {
			return nil, err
		}
		cur := numField(base, "currentCents")
		if hist, ok := base["history"].([]any); ok {
			// Newest first: the first row that starts on or before the Monday
			// is the one in force there.
			for _, raw := range hist {
				row, _ := raw.(map[string]any)
				if vf := strField(row, "validFrom"); vf != "" && vf[:10] <= monday {
					cur = numField(row, "priceCents")
					break
				}
			}
		}
		facts["currentPriceCents"] = cur
		fmt.Fprintf(&sb, "CAMBIO DEL PRECIO BASE desde el lunes %s: de %s a %s por kilo.\n", monday, pesos(cur), pesos(price))
		if imp, err := c.get("/v1/prices/base/" + pathID(monday) + "/impact"); err == nil {
			un, se, own := numField(imp, "unsettledRecords"), numField(imp, "settledRecords"), numField(imp, "weeksWithOwnPrice")
			facts["impact"] = imp
			fmt.Fprintf(&sb, "Pesadas sin liquidar que tomarían el nuevo precio: %d. Liquidadas que conservan su precio: %d. Semanas con precio propio que no cambian: %d.", un, se, own)
		}
	}
	// The price the preview showed as current is what the confirmation
	// promises to change. A price PUT is an upsert, not idempotent by id, so
	// without this a confirmation replayed later (by the assistant, or by
	// anything holding the transcript) silently put an old price back.
	return &mcpPreview{Summary: sb.String(), Facts: facts, Bind: strconv.FormatInt(facts["currentPriceCents"].(int64), 10)}, nil
}

// currentPriceAt reads the price in force for the arguments' scope and Monday,
// as the preview shows it.
func currentPriceAt(c *mcpCaller, a mcpArgs) (int64, error) {
	monday := a.str("monday")
	if a.str("scope") == "week" {
		wk, err := c.get("/v1/prices/weeks/" + pathID(monday))
		if err != nil {
			return 0, err
		}
		return numField(wk, "priceCents"), nil
	}
	base, err := c.get("/v1/prices/base")
	if err != nil {
		return 0, err
	}
	cur := numField(base, "currentCents")
	if hist, ok := base["history"].([]any); ok {
		for _, raw := range hist {
			row, _ := raw.(map[string]any)
			if vf := strField(row, "validFrom"); vf != "" && vf[:10] <= monday {
				return numField(row, "priceCents"), nil
			}
		}
	}
	return cur, nil
}

// executePrice applies a confirmed price change only if the price is still
// the one the confirmation was shown.
func executePrice(c *mcpCaller, a mcpArgs, key, bind string) *mcp.CallToolResult {
	t := mcpWriteTool{Name: "set_kilo_price", Money: true, Method: http.MethodPut,
		Pattern: "/v1/prices/base/{monday}", Done: donePrice}
	want, _ := a.int("priceCents")
	cur, err := currentPriceAt(c, a)
	if err != nil {
		return mcpFailure(err.Error())
	}
	if strconv.FormatInt(cur, 10) != bind {
		if cur == want {
			// A retry of a confirmation that already went through.
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{
				Text: donePrice(http.StatusOK, nil, a) + " (Ya estaba aplicado; no se cambió nada.)"}}}
		}
		return mcpFailure(fmt.Sprintf("El precio cambió desde el resumen (ahora es %s). No se cambió nada: "+
			"llame sin token para ver el resumen nuevo y confírmelo otra vez con el usuario.", pesos(cur)))
	}
	call, err := buildPrice(a, key)
	if err != nil {
		return mcpFailure(err.Error())
	}
	status, raw := c.do(call.Method, call.Path, call.Body)
	return t.result(status, raw, a)
}

func buildPrice(a mcpArgs, _ string) (mcpCall, error) {
	price, err := a.int("priceCents")
	if err != nil {
		return mcpCall{}, err
	}
	if price <= 0 {
		return mcpCall{}, fmt.Errorf("priceCents debe ser positivo")
	}
	path := "/v1/prices/base/" + pathID(a.str("monday"))
	if a.str("scope") == "week" {
		path = "/v1/prices/weeks/" + pathID(a.str("monday"))
	}
	return mcpCall{http.MethodPut, path, map[string]any{"priceCents": price}}, nil
}

func donePrice(_ int, _ map[string]any, a mcpArgs) string {
	p, _ := a.int("priceCents")
	if a.str("scope") == "week" {
		return "Precio de la semana del " + a.str("monday") + " fijado en " + pesos(p) + " por kilo."
	}
	return "Precio base desde el " + a.str("monday") + " fijado en " + pesos(p) + " por kilo."
}

// settlementInput is the part of the arguments the preview route reads.
func settlementInput(a mcpArgs) map[string]any {
	b := map[string]any{"workerId": a["workerId"], "from": a["from"], "to": a["to"]}
	if a.has("payableIds") {
		b["payableIds"] = a["payableIds"]
	}
	return b
}

// settlementBind is what a settlement confirmation promises: this gross, and
// exactly these lines. A late weighing or a reprice changes it, and the
// confirmation stops being good.
func settlementBind(pv map[string]any) (string, []string, int64) {
	gross := numField(pv, "grossCents")
	var ids []string
	if items, ok := pv["items"].([]any); ok {
		for _, raw := range items {
			row, _ := raw.(map[string]any)
			if id := strField(row, "payableId"); id != "" {
				ids = append(ids, id)
			}
		}
	}
	sort.Strings(ids)
	sum := sha256.Sum256([]byte(strings.Join(ids, ",")))
	return fmt.Sprintf("%d:%s", gross, base64.RawURLEncoding.EncodeToString(sum[:12])), ids, gross
}

func previewSettlement(c *mcpCaller, a mcpArgs) (*mcpPreview, error) {
	w, err := c.get("/v1/workers/" + pathID(a.str("workerId")))
	if err != nil {
		return nil, err
	}
	pv, err := c.post("/v1/settlements/preview", settlementInput(a))
	if err != nil {
		return nil, err
	}
	bind, ids, gross := settlementBind(pv)
	if len(ids) == 0 || gross <= 0 {
		return nil, fmt.Errorf("No hay nada pendiente por liquidar para %s entre %s y %s.", workerName(w), a.str("from"), a.str("to"))
	}
	balance := int64(0)
	if b, ok := pv["balance"].(map[string]any); ok {
		balance = numField(b, "balanceCents")
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "LIQUIDACIÓN de %s del %s al %s: %d labores por un bruto de %s.\n", workerName(w), a.str("from"), a.str("to"), len(ids), pesos(gross))
	fmt.Fprintf(&sb, "Saldo actual: %s. Después de liquidar quedaría a su favor: %s (el pago se registra aparte con register_payment).", pesos(balance), pesos(balance+gross))
	return &mcpPreview{Summary: sb.String(), Bind: bind, Facts: map[string]any{
		"worker": workerName(w), "workerId": a.str("workerId"), "from": a.str("from"), "to": a.str("to"),
		"lines": len(ids), "grossCents": gross, "balanceBeforeCents": balance, "balanceAfterCents": balance + gross,
		"items": pv["items"],
	}}, nil
}

func executeSettlement(c *mcpCaller, a mcpArgs, key, bind string) *mcp.CallToolResult {
	t := mcpWriteTool{Name: "create_settlement", Money: true, Method: http.MethodPost, Pattern: "/v1/settlements", Done: func(status int, b map[string]any, _ mcpArgs) string {
		items, _ := b["items"].([]any)
		return fmt.Sprintf("Liquidación creada por %s (%d labores, id %s). Ahora puede registrar el pago con register_payment.",
			pesos(numField(b, "grossCents")), len(items), strField(b, "id"))
	}}
	// A retry of a confirmation that already went through: the settlement
	// exists under the id the token names. Answer it rather than re-preview,
	// because by now its lines are claimed and the preview would say zero.
	if status, raw := c.do(http.MethodGet, "/v1/settlements/"+key, nil); status == http.StatusOK {
		return t.result(http.StatusOK, raw, a)
	}
	pv, err := c.post("/v1/settlements/preview", settlementInput(a))
	if err != nil {
		return mcpFailure(err.Error())
	}
	now, ids, gross := settlementBind(pv)
	if now != bind {
		return mcpFailure(fmt.Sprintf("La liquidación cambió desde el resumen (ahora %d labores por %s). No se liquidó nada: "+
			"llame sin token para ver el resumen nuevo y confírmelo otra vez con el usuario.", len(ids), pesos(gross)))
	}
	body := settlementInput(a)
	body["id"] = key
	body["payableIds"] = ids
	body["expectedGrossCents"] = gross
	a.copyStr(body, "note")
	status, raw := c.do(http.MethodPost, "/v1/settlements", body)
	return t.result(status, raw, a)
}

func previewVoidSettlement(c *mcpCaller, a mcpArgs) (*mcpPreview, error) {
	st, err := c.get("/v1/settlements/" + pathID(a.str("id")))
	if err != nil {
		return nil, err
	}
	if strField(st, "status") == "void" {
		return nil, fmt.Errorf("Esa liquidación ya está anulada.")
	}
	name := "el trabajador"
	if w, err := c.get("/v1/workers/" + pathID(strField(st, "workerId"))); err == nil {
		name = workerName(w)
	}
	items, _ := st["items"].([]any)
	gross := numField(st, "grossCents")
	day := func(s string) string {
		if len(s) >= 10 {
			return s[:10]
		}
		return s
	}
	summary := fmt.Sprintf("ANULAR LIQUIDACIÓN de %s, periodo %s a %s, por %s (%d labores).\n"+
		"Se reversa el devengo (el saldo del trabajador baja %s) y sus labores vuelven a quedar pendientes. "+
		"Los pagos ya registrados NO se reversan.",
		name, day(strField(st, "periodStart")), day(strField(st, "periodEnd")), pesos(gross), len(items), pesos(gross))
	return &mcpPreview{Summary: summary, Facts: map[string]any{
		"settlementId": a.str("id"), "worker": name, "grossCents": gross, "lines": len(items),
	}}, nil
}
