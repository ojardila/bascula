package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/ojardila/bascula/services/api/internal/logsafe"
)

// logConnectorTraffic writes one structured line per request to the surfaces
// an assistant such as ChatGPT talks to: /mcp, /oauth/* and /.well-known/*.
// Connecting a connector is a conversation between two servers that the
// owner never sees; without this line there is no way to tell how far it got
// (registered, sent to sign in, exchanged the code, listed tools).
//
// It logs what identifies a step and never a secret: no Authorization header,
// no token, code, verifier, password or request body. For /mcp it logs the
// JSON-RPC method name only (initialize, tools/list, tools/call) and whether
// a bearer was presented.
func logConnectorTraffic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if !edgeLogIsConnectorPath(p) {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rpcMethod, rpcTool := "", ""
		if p == "/mcp" && r.Method == http.MethodPost && r.Body != nil {
			rpcMethod, rpcTool = edgeLogPeekRPC(r)
		}
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)

		attrs := []any{
			"method", logsafe.Str(r.Method),
			"path", logsafe.Str(p),
			"host", logsafe.Str(r.Host),
			"status", ww.Status(),
			"ms", time.Since(start).Milliseconds(),
			"ua", logsafe.Str(r.UserAgent()),
			"ip", logsafe.Str(middleware.GetClientIP(r.Context())),
		}
		if rpcMethod != "" {
			attrs = append(attrs, "rpc", logsafe.Str(rpcMethod))
		}
		if rpcTool != "" {
			attrs = append(attrs, "tool", logsafe.Str(rpcTool))
		}
		if p == "/mcp" {
			attrs = append(attrs,
				"bearer", bearerToken(r) != "",
				"accept", logsafe.Str(r.Header.Get("Accept")),
				"mcp_protocol", logsafe.Str(r.Header.Get("MCP-Protocol-Version")),
				"mcp_session", r.Header.Get("Mcp-Session-Id") != "")
		}
		if strings.HasPrefix(p, "/oauth/") {
			attrs = append(attrs, edgeLogOAuthAttrs(r, ww.Header())...)
		}
		slog.Info("connector request", attrs...)
	})
}

// edgeLogIsConnectorPath reports whether p is one of the surfaces an
// assistant talks to: /mcp, /oauth/* and /.well-known/*.
func edgeLogIsConnectorPath(p string) bool {
	return p == "/mcp" || strings.HasPrefix(p, "/mcp/") || strings.HasPrefix(p, "/oauth/") || strings.HasPrefix(p, "/.well-known/")
}

// edgeLogPeekRPC reads the JSON-RPC method(s) and tool name of an /mcp POST
// and puts the body back for the handler.
func edgeLogPeekRPC(r *http.Request) (rpcMethod, rpcTool string) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return "", ""
	}
	r.Body = io.NopCloser(io.MultiReader(bytes.NewReader(raw), r.Body))
	return jsonRPCMethods(raw), jsonRPCToolName(raw)
}

// edgeLogOAuthAttrs is the non-secret part of an /oauth/* request, and where
// its response redirected to.
func edgeLogOAuthAttrs(r *http.Request, respHeader http.Header) []any {
	q := r.URL.Query()
	// r.Form is filled by the handler for form posts (authorize,
	// token); read back only the non-secret fields.
	get := func(k string) string {
		if v := q.Get(k); v != "" {
			return v
		}
		if r.Form != nil {
			return r.Form.Get(k)
		}
		return ""
	}
	clientID, clientAuth := edgeLogOAuthClient(r, get("client_id"))
	attrs := []any{
		"client_id", logsafe.Str(clientID),
		"client_auth", clientAuth,
		"grant_type", logsafe.Str(get("grant_type")),
		"redirect_uri", logsafe.Str(get("redirect_uri")),
		"resource", logsafe.Str(get("resource")),
		"scope", logsafe.Str(get("scope")),
		"pkce", logsafe.Str(get("code_challenge_method")),
		"has_state", get("state") != "",
	}
	if loc := respHeader.Get("Location"); loc != "" {
		if u, err := url.Parse(loc); err == nil {
			attrs = append(attrs,
				"redirect_to", logsafe.Str(u.Scheme+"://"+u.Host+u.Path),
				"redirect_has_code", u.Query().Get("code") != "",
				"redirect_error", logsafe.Str(u.Query().Get("error")))
		}
	}
	return attrs
}

// edgeLogOAuthClient is the client id (from the parameters, or else the Basic
// user) and how the client authenticated: basic, post or "".
func edgeLogOAuthClient(r *http.Request, clientID string) (string, string) {
	if u, _, ok := r.BasicAuth(); ok {
		if clientID == "" {
			if v, err := url.QueryUnescape(u); err == nil {
				clientID = v
			}
		}
		return clientID, "basic"
	}
	if r.Form != nil && r.Form.Get("client_secret") != "" {
		return clientID, "post"
	}
	return clientID, ""
}

// jsonRPCToolName is the tool a tools/call names — its name only, never its
// arguments, which carry people's names, documents and amounts.
func jsonRPCToolName(raw []byte) string {
	var one struct {
		Method string `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if json.Unmarshal(raw, &one) != nil || one.Method != "tools/call" {
		return ""
	}
	if len(one.Params.Name) > 64 {
		return one.Params.Name[:64]
	}
	return one.Params.Name
}

// jsonRPCMethods returns the method of a JSON-RPC message, or the methods of
// a batch joined with commas. Params are never looked at.
func jsonRPCMethods(raw []byte) string {
	var one struct {
		Method string `json:"method"`
	}
	if json.Unmarshal(raw, &one) == nil && one.Method != "" {
		return one.Method
	}
	var batch []struct {
		Method string `json:"method"`
	}
	if json.Unmarshal(raw, &batch) == nil {
		names := make([]string, 0, len(batch))
		for _, m := range batch {
			names = append(names, m.Method)
		}
		return strings.Join(names, ",")
	}
	return ""
}
