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
		if !(p == "/mcp" || strings.HasPrefix(p, "/mcp/") || strings.HasPrefix(p, "/oauth/") || strings.HasPrefix(p, "/.well-known/")) {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rpcMethod, rpcTool := "", ""
		if p == "/mcp" && r.Method == http.MethodPost && r.Body != nil {
			raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			if err == nil {
				r.Body = io.NopCloser(io.MultiReader(bytes.NewReader(raw), r.Body))
				rpcMethod = jsonRPCMethods(raw)
				rpcTool = jsonRPCToolName(raw)
			}
		}
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)

		attrs := []any{
			"method", r.Method,
			"path", sanitizeLog(p),
			"host", sanitizeLog(r.Host),
			"status", ww.Status(),
			"ms", time.Since(start).Milliseconds(),
			"ua", sanitizeLog(r.UserAgent()),
			"ip", sanitizeLog(middleware.GetClientIP(r.Context())),
		}
		if rpcMethod != "" {
			attrs = append(attrs, "rpc", sanitizeLog(rpcMethod))
		}
		if rpcTool != "" {
			attrs = append(attrs, "tool", sanitizeLog(rpcTool))
		}
		if p == "/mcp" {
			attrs = append(attrs,
				"bearer", bearerToken(r) != "",
				"accept", sanitizeLog(r.Header.Get("Accept")),
				"mcp_protocol", sanitizeLog(r.Header.Get("MCP-Protocol-Version")),
				"mcp_session", r.Header.Get("Mcp-Session-Id") != "")
		}
		if strings.HasPrefix(p, "/oauth/") {
			q := r.URL.Query()
			// r.Form is filled by the handler for form posts (authorize,
			// token); read back only the non-secret fields.
			get := func(k string) string {
				if v := q.Get(k); v != "" {
					return sanitizeLog(v)
				}
				if r.Form != nil {
					return sanitizeLog(r.Form.Get(k))
				}
				return ""
			}
			clientID, clientAuth := get("client_id"), ""
			if u, _, ok := r.BasicAuth(); ok {
				clientAuth = "basic"
				if clientID == "" {
					if v, err := url.QueryUnescape(u); err == nil {
						clientID = sanitizeLog(v)
					}
				}
			} else if r.Form != nil && r.Form.Get("client_secret") != "" {
				clientAuth = "post"
			}
			attrs = append(attrs,
				"client_id", clientID,
				"client_auth", clientAuth,
				"grant_type", get("grant_type"),
				"redirect_uri", get("redirect_uri"),
				"resource", get("resource"),
				"scope", get("scope"),
				"pkce", get("code_challenge_method"),
				"has_state", get("state") != "")
			if loc := ww.Header().Get("Location"); loc != "" {
				if u, err := url.Parse(loc); err == nil {
					attrs = append(attrs,
						"redirect_to", sanitizeLog(u.Scheme+"://"+u.Host+u.Path),
						"redirect_has_code", u.Query().Get("code") != "",
						"redirect_error", sanitizeLog(u.Query().Get("error")))
				}
			}
		}
		slog.Info("connector request", attrs...)
	})
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
