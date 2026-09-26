package httpapi

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

// The MCP tool reference: a Swagger-like page at GET /mcp/docs and the same
// catalogue as JSON at GET /mcp/tools.json.
//
// Nothing here is written by hand. buildMCP keeps every *mcp.Tool it hands to
// the SDK (s.mcpCatalog), so the name, title, description, input schema and
// annotations below are the very values tools/list serves. What the page adds
// is what tools/list cannot say: the route each tool becomes, and the roles
// the permission table (auth.Matrix) allows on that route. A tool that gains a
// parameter, or a route that changes who may call it, changes here on the
// next deploy with no one editing a document.
//
// Both answers are public and carry no farm data: a tool's name and schema
// are the same for every farm. The page's «Try it» panel does not run
// anything itself; it posts JSON-RPC to /mcp with the token the reader
// pastes, so a call from the page is refused or answered exactly as the same
// call from ChatGPT or Claude would be.

// mcpCatalogTool is one tool as tools.json describes it.
type mcpCatalogTool struct {
	Name        string               `json:"name"`
	Title       string               `json:"title,omitempty"`
	Description string               `json:"description"`
	InputSchema any                  `json:"inputSchema"`
	Annotations *mcp.ToolAnnotations `json:"annotations,omitempty"`

	// Kind is "read" or "write".
	Kind string `json:"kind"`
	// TwoStep marks the money tools: the first call only previews and
	// returns a confirmationToken; a second call with it executes.
	TwoStep bool            `json:"twoStep"`
	Route   mcpCatalogRoute `json:"route"`
	// Action is the permission the route declares (auth.Matrix).
	Action string `json:"action"`
	// Roles are the farm roles auth.Matrix allows for Action, most senior
	// first. The inner request is refused with FORBIDDEN for anyone else.
	Roles []string `json:"roles"`
}

type mcpCatalogRoute struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

// mcpCatalogRoles is the seniority order the roles are listed in.
var mcpCatalogRoles = []domain.Role{domain.RoleOwner, domain.RoleAdmin, domain.RoleWeigher}

// mcpCatalogEntry describes one registered tool. def is the definition the
// SDK was given; method and path are the route whose permission applies.
func (s *Server) mcpCatalogEntry(def *mcp.Tool, method, path string, twoStep bool) mcpCatalogTool {
	kind := "write"
	if def.Annotations != nil && def.Annotations.ReadOnlyHint {
		kind = "read"
	}
	action := s.mcpActions[method+" "+path]
	roles := []string{}
	for _, r := range mcpCatalogRoles {
		if action != "" && auth.AllowedFor(r, false, action) {
			roles = append(roles, string(r))
		}
	}
	return mcpCatalogTool{
		Name:        def.Name,
		Title:       def.Title,
		Description: def.Description,
		InputSchema: def.InputSchema,
		Annotations: def.Annotations,
		Kind:        kind,
		TwoStep:     twoStep,
		Route:       mcpCatalogRoute{Method: method, Path: path},
		Action:      string(action),
		Roles:       roles,
	}
}

// mcpCatalogDoc is the whole of tools.json.
type mcpCatalogDoc struct {
	Server struct {
		Name    string `json:"name"`
		Title   string `json:"title"`
		Version string `json:"version"`
	} `json:"server"`
	Endpoint     string           `json:"endpoint"`
	Docs         string           `json:"docs"`
	Transport    string           `json:"transport"`
	Instructions string           `json:"instructions"`
	Auth         mcpCatalogAuth   `json:"auth"`
	Tools        []mcpCatalogTool `json:"tools"`
}

type mcpCatalogAuth struct {
	Scheme                    string `json:"scheme"`
	ProtectedResourceMetadata string `json:"protectedResourceMetadata"`
	AuthorizationServer       string `json:"authorizationServerMetadata"`
	Note                      string `json:"note"`
}

func (s *Server) mcpCatalogFor(r *http.Request) mcpCatalogDoc {
	base := s.publicBase(r)
	var d mcpCatalogDoc
	d.Server.Name = mcpServerName
	d.Server.Title = mcpServerTitle
	d.Server.Version = mcpServerVersion
	d.Endpoint = s.mcpResource(r)
	d.Docs = base + "/mcp/docs"
	d.Transport = "MCP streamable HTTP, stateless: POST JSON-RPC 2.0 to the endpoint, one request, one JSON response"
	d.Instructions = mcpInstructions
	d.Auth = mcpCatalogAuth{
		Scheme:                    "Bearer",
		ProtectedResourceMetadata: base + "/.well-known/oauth-protected-resource",
		AuthorizationServer:       base + "/.well-known/oauth-authorization-server",
		Note: "Send Authorization: Bearer <access token>. The token is a Báscula session " +
			"JWT for one farm and one role, obtained through OAuth 2.1 (authorization code + PKCE) " +
			"or POST /v1/auth/login. Every tool answers according to that role.",
	}
	d.Tools = s.mcpCatalog
	if d.Tools == nil {
		d.Tools = []mcpCatalogTool{}
	}
	return d
}

// handleMCPToolsJSON is GET /mcp/tools.json.
func (s *Server) handleMCPToolsJSON(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	writeJSON(w, http.StatusOK, s.mcpCatalogFor(r))
}

//go:embed mcp_docs.html
var mcpDocsHTML string

// mcpDocsDataMarker is replaced by the catalogue, inline, so the page needs
// no second request to render.
const mcpDocsDataMarker = "/*__MCP_CATALOG__*/null"

// handleMCPDocsPage is GET /mcp/docs.
func (s *Server) handleMCPDocsPage(w http.ResponseWriter, r *http.Request) {
	// json.Marshal escapes <, > and & as \u003c…, so the catalogue cannot
	// close the <script> element it is embedded in.
	raw, err := json.Marshal(s.mcpCatalogFor(r))
	if err != nil {
		writeError(w, r, domain.Internal("could not encode the tool catalogue").WithCause(err))
		return
	}
	page := strings.Replace(mcpDocsHTML, mcpDocsDataMarker, string(raw), 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(page))
}
