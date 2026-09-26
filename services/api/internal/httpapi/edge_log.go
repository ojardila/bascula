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
		rpcMethod := ""
		if p == "/mcp" && r.Method == http.MethodPost && r.Body != nil {
			raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			if err == nil {
				r.Body = io.NopCloser(io.MultiReader(bytes.NewReader(raw), r.Body))
				rpcMethod = jsonRPCMethods(raw)
			}
		}
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)

		attrs := []any{
			"method", r.Method,
			"path", p,
			"host", r.Host,
			"status", ww.Status(),
			"ms", time.Since(start).Milliseconds(),
			"ua", r.UserAgent(),
			"ip", middleware.GetClientIP(r.Context()),
		}
		if rpcMethod != "" {
			attrs = append(attrs, "rpc", rpcMethod)
		}
		if p == "/mcp" {
			attrs = append(attrs,
				"bearer", strings.HasPrefix(r.Header.Get("Authorization"), "Bearer "),
				"accept", r.Header.Get("Accept"),
				"mcp_protocol", r.Header.Get("MCP-Protocol-Version"),
				"mcp_session", r.Header.Get("Mcp-Session-Id") != "")
		}
		if strings.HasPrefix(p, "/oauth/") {
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
			attrs = append(attrs,
				"client_id", get("client_id"),
				"grant_type", get("grant_type"),
				"redirect_uri", get("redirect_uri"),
				"resource", get("resource"),
				"scope", get("scope"),
				"pkce", get("code_challenge_method"),
				"has_state", get("state") != "")
			if loc := ww.Header().Get("Location"); loc != "" {
				if u, err := url.Parse(loc); err == nil {
					attrs = append(attrs,
						"redirect_to", u.Scheme+"://"+u.Host+u.Path,
						"redirect_has_code", u.Query().Get("code") != "",
						"redirect_error", u.Query().Get("error"))
				}
			}
		}
		slog.Info("connector request", attrs...)
	})
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
