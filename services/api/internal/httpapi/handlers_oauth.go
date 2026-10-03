package httpapi

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/logsafe"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// OAuth 2.1 for the MCP tunnel. ChatGPT's connector UI will not take a
// pasted bearer; it discovers this service, registers a public client, and
// sends the farm owner through authorization-code + PKCE. The access token
// that comes back is the same JWT POST /v1/auth/login issues.

const (
	oauthScope     = "mcp"
	oauthCodeTTL   = 10 * time.Minute
	oauthChallenge = "S256"

	// Registration limits. A real connector registers one or two redirect
	// URIs and a short name in well under a kilobyte.
	oauthRegisterMaxBody = 64 << 10
	oauthMaxRedirects    = 10
	oauthMaxRedirectLen  = 2048
	oauthMaxClientName   = 80
	// oauthMaxStoredMetadata bounds the registration kept in the database.
	oauthMaxStoredMetadata = 8 << 10
)

// errOAuthBadCredentials is the one sign-in failure the login limiter counts.
var errOAuthBadCredentials = errors.New("Correo o contraseña incorrectos.")

// errOAuthBadPasskey is a passkey answer the sign-in page did not accept.
var errOAuthBadPasskey = errors.New("No reconocimos esa llave de acceso. Entre con su correo y contraseña.")

// oauthScopesSupported: "mcp" consults and registers within the member's
// role; "mcp:read" only consults (the person picks on the sign-in page).
// offline_access is advertised because clients (ChatGPT among them) ask for
// it to get a refresh token, which this server issues anyway. A scope this
// server does not know grants nothing.
var oauthScopesSupported = []string{auth.ScopeMCP, auth.ScopeMCPRead, "offline_access"}

// oauthAccessChoice is what the sign-in page offers: "write" (consult and
// register) or "read" (consult only). The default follows what the client
// asked for; an explicit choice on the form wins.
func oauthAccessChoice(q url.Values) string {
	switch q.Get("access") {
	case "read", "write":
		return q.Get("access")
	}
	if auth.ScopeIsReadOnly(q.Get("scope")) {
		return "read"
	}
	return "write"
}

// oauthGrantedScope is the scope a grant carries: mcp or mcp:read, plus
// offline_access when the client asked for it.
func oauthGrantedScope(requested, access string) string {
	granted := auth.ScopeMCP
	if access == "read" {
		granted = auth.ScopeMCPRead
	}
	for _, s := range strings.Fields(requested) {
		if s == "offline_access" {
			return granted + " offline_access"
		}
	}
	return granted
}

// oauthClientAuthMethods are the token endpoint client authentication
// methods. none (public client + PKCE) is what ChatGPT and Claude normally
// pick; the two secret methods are for a host that registers as confidential.
var oauthClientAuthMethods = []string{"none", "client_secret_post", "client_secret_basic"}

func (s *Server) publicBase(r *http.Request) string {
	if u := strings.TrimRight(s.cfg.PublicBaseURL, "/"); u != "" {
		return u
	}
	proto := "http"
	if r.TLS != nil {
		proto = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		proto = strings.TrimSpace(strings.Split(p, ",")[0])
	}
	return proto + "://" + r.Host
}

func (s *Server) mcpResource(r *http.Request) string {
	return s.publicBase(r) + "/mcp"
}

// requestOrigin is the origin this request arrived at, ignoring
// PublicBaseURL: on the shared stack a farm's own address
// ({slug}.bascula.engp.io) reaches the same process as the apex.
func requestOrigin(r *http.Request) string {
	proto := "http"
	if r.TLS != nil {
		proto = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		proto = strings.TrimSpace(strings.Split(p, ",")[0])
	}
	return proto + "://" + r.Host
}

// resourceIsThisServer reports whether an RFC 8707 resource indicator (or a
// token audience) names this MCP server: its canonical resource
// (<issuer>/mcp), the issuer itself, or the same two spelled with the host
// the request came to. Anything else — another farm's address, another site
// — is not this server, and a token for it must not be minted or accepted
// here.
func (s *Server) resourceIsThisServer(r *http.Request, resource string) bool {
	canon := func(v string) string {
		u, err := url.Parse(strings.TrimSpace(v))
		if err != nil || u.Scheme == "" || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
			return ""
		}
		return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host) + strings.TrimRight(u.EscapedPath(), "/")
	}
	got := canon(resource)
	if got == "" {
		return false
	}
	for _, base := range []string{s.publicBase(r), requestOrigin(r)} {
		if got == canon(base+"/mcp") || got == canon(base) {
			return true
		}
	}
	return false
}

func allowCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers",
		"Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id")
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowCORS(w)
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleMCPOptions(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	w.WriteHeader(http.StatusNoContent)
}

// writeMCPChallenge is the header an MCP client reads to find the OAuth
// server. It goes on every 401 from /mcp: with no token (the first contact),
// and with a token that no longer verifies — an access token lives fifteen
// minutes, and a client that is told only "401" with no challenge has no way
// to know it should refresh or sign in again, so the connector just stops
// working. errCode is "" for the first case and "invalid_token" for the second
// (RFC 6750 §3).
func (s *Server) writeMCPChallenge(w http.ResponseWriter, r *http.Request, errCode string) {
	meta := s.publicBase(r) + "/.well-known/oauth-protected-resource"
	v := fmt.Sprintf(`Bearer realm="bascula", resource_metadata=%q, scope=%q`, meta, oauthScope)
	if errCode != "" {
		v += fmt.Sprintf(`, error=%q, error_description="the access token expired or is not valid"`, errCode)
	}
	w.Header().Set("WWW-Authenticate", v)
}

func (s *Server) handleOAuthProtectedResource(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	base := s.publicBase(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 s.mcpResource(r),
		"authorization_servers":    []string{base},
		"scopes_supported":         []string{auth.ScopeMCP, auth.ScopeMCPRead},
		"bearer_methods_supported": []string{"header"},
		"resource_name":            "Báscula",
		"resource_documentation":   base + "/mcp/docs",
	})
}

// handleOAuthAuthorizationServer serves RFC 8414 metadata. The same document
// answers /.well-known/openid-configuration and the path-suffixed variants
// (…/oauth-authorization-server/mcp, …/openid-configuration/mcp) that MCP
// clients try for an issuer with a path: ChatGPT asks for both documents, and
// a 404 on one of them is one more thing it may count against the server.
// The OpenID-only fields (jwks_uri, subject_types_supported,
// id_token_signing_alg_values_supported) are there so a strict OIDC discovery
// parser does not reject the document; openid is not an offered scope and no
// ID token is ever issued.
func (s *Server) handleOAuthAuthorizationServer(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	base := s.publicBase(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                         base,
		"authorization_endpoint":                         base + "/oauth/authorize",
		"token_endpoint":                                 base + "/oauth/token",
		"registration_endpoint":                          base + "/oauth/register",
		"revocation_endpoint":                            base + "/oauth/revoke",
		"jwks_uri":                                       base + "/.well-known/jwks.json",
		"service_documentation":                          base + "/mcp/docs",
		"response_types_supported":                       []string{"code"},
		"response_modes_supported":                       []string{"query"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{oauthChallenge},
		"token_endpoint_auth_methods_supported":          oauthClientAuthMethods,
		"revocation_endpoint_auth_methods_supported":     oauthClientAuthMethods,
		"scopes_supported":                               oauthScopesSupported,
		"authorization_response_iss_parameter_supported": true,
		"subject_types_supported":                        []string{"public"},
		"id_token_signing_alg_values_supported":          []string{"RS256"},
	})
}

// handleOAuthJWKS: the access tokens are HMAC-signed and verified only by
// this server, so there is no public key to publish. The empty set exists
// because jwks_uri is a required field of OpenID discovery.
func (s *Server) handleOAuthJWKS(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	writeJSON(w, http.StatusOK, map[string]any{"keys": []any{}})
}

// handleOAuthRegister is RFC 7591 dynamic client registration. Clients send
// much more metadata than this server uses, and RFC 7591 §2 says a server
// MUST ignore metadata it does not understand. So the body is decoded
// leniently, not with decode(): the strict decoder turned ChatGPT's
// registration, which carries grant_types, into a 400, and ChatGPT gave up on
// the connector before it ever showed the sign-in page.
//
// The response is the full §3.2.1 client information response: client_id,
// client_id_issued_at, the secret and client_secret_expires_at when the client
// asked to be confidential, and every registered metadata field as the server
// actually registered it.
func (s *Server) handleOAuthRegister(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	// Registration is anonymous by design (RFC 7591 open registration is what
	// ChatGPT and Claude use), so it is the one write a stranger can repeat at
	// will. Each registration is a row that nothing prunes; the cap per address
	// and the size limits below are what keep a loop from filling the disk.
	if !s.oauthRegs.allow(clientIP(r), time.Now()) || !s.oauthRegistrationBudgetLeft(r) {
		w.Header().Set("Retry-After", "3600")
		w.Header().Set(headerContentType, contentTypeJSON)
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":             "invalid_client_metadata",
			"error_description": "too many registrations from this address, try again later",
		})
		return
	}
	var raw map[string]any
	if err := json.NewDecoder(io.LimitReader(r.Body, oauthRegisterMaxBody)).Decode(&raw); err != nil || raw == nil {
		slog.Warn("connector request register body", "error", "not a JSON object")
		oauthRegisterError(w, "invalid_client_metadata", "the body is not a JSON client registration")
		return
	}
	str := func(k string) string {
		v, _ := raw[k].(string)
		return strings.TrimSpace(v)
	}
	list := func(k string) []string {
		var out []string
		switch v := raw[k].(type) {
		case []any:
			for _, e := range v {
				if s, ok := e.(string); ok && strings.TrimSpace(s) != "" {
					out = append(out, strings.TrimSpace(s))
				}
			}
		case string:
			if strings.TrimSpace(v) != "" {
				out = []string{strings.TrimSpace(v)}
			}
		}
		return out
	}

	redirects := list("redirect_uris")
	requestedMethod := str("token_endpoint_auth_method")
	method := requestedMethod
	switch method {
	case "", "none":
		method = "none"
	case "client_secret_post", "client_secret_basic":
	default:
		// private_key_jwt, tls_client_auth, ...: not supported. RFC 7591 §2
		// lets the server register a different method; PKCE public client is
		// the one every MCP host can use.
		method = "none"
	}
	var grants []string
	for _, g := range list("grant_types") {
		if (g == "authorization_code" || g == "refresh_token") && !containsString(grants, g) {
			grants = append(grants, g)
		}
	}
	if !containsString(grants, "authorization_code") {
		grants = append([]string{"authorization_code"}, grants...)
	}
	if !containsString(grants, "refresh_token") {
		grants = append(grants, "refresh_token")
	}
	scope := strings.Join(strings.Fields(str("scope")), " ")
	if scope == "" {
		scope = strings.Join(oauthScopesSupported, " ")
	}

	// Temporary diagnostics: what the connector asked for. Keys and
	// non-secret values only; a registration carries no secret, but a
	// software_statement (a signed JWT) is left out anyway.
	keys := make([]string, 0, len(raw))
	for k := range raw {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	slog.Info("connector request register body",
		"ua", logsafe.Str(r.UserAgent()),
		"keys", logsafe.Strs(keys),
		"client_name", logsafe.Str(str("client_name")),
		"redirect_uris", logsafe.Strs(redirects),
		"grant_types", logsafe.Strs(list("grant_types")),
		"response_types", logsafe.Strs(list("response_types")),
		"token_endpoint_auth_method", logsafe.Str(requestedMethod),
		"granted_auth_method", logsafe.Str(method),
		"scope", logsafe.Str(str("scope")),
		"application_type", logsafe.Str(str("application_type")),
	)

	if len(redirects) == 0 {
		oauthRegisterError(w, "invalid_redirect_uri", "redirect_uris is required")
		return
	}
	if len(redirects) > oauthMaxRedirects {
		oauthRegisterError(w, "invalid_redirect_uri", "too many redirect_uris")
		return
	}
	for _, u := range redirects {
		if len(u) > oauthMaxRedirectLen {
			oauthRegisterError(w, "invalid_redirect_uri", "redirect_uri is too long")
			return
		}
		if err := oauthRedirectOK(u); err != nil {
			oauthRegisterError(w, "invalid_redirect_uri", err.Error())
			return
		}
	}
	for _, rt := range list("response_types") {
		if rt != "code" {
			oauthRegisterError(w, "invalid_client_metadata", "only the code response type is supported")
			return
		}
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	id, err := randomToken(16)
	if err != nil {
		writeError(w, r, domain.Internal("could not mint a client id").WithCause(err))
		return
	}
	// The name is shown on the sign-in page, so it is kept short and plain:
	// no control or bidi-override characters that could make «ChatGPT» out
	// of something else (it is HTML-escaped on the page as well).
	name := sanitizeClientName(str("client_name"))
	if name == "" {
		name = "mcp-client"
	}

	resp := map[string]any{
		"client_id":                  id,
		"client_id_issued_at":        time.Now().Unix(),
		"client_name":                name,
		"redirect_uris":              redirects,
		"grant_types":                grants,
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": method,
		"scope":                      scope,
	}
	// Every other field the client registered is echoed verbatim (RFC 7591
	// §3.2.1), except anything secret-shaped the server does not keep.
	for k, v := range raw {
		if _, set := resp[k]; set || v == nil {
			continue
		}
		switch k {
		case "client_secret", "client_secret_expires_at", "software_statement", "client_id", "client_id_issued_at":
			continue
		}
		resp[k] = v
	}
	stored, err := json.Marshal(resp)
	if err != nil {
		writeError(w, r, domain.Internal("could not encode the registration").WithCause(err))
		return
	}
	// What is kept is bounded more tightly than what is accepted: the echo
	// goes back to the client once, the row stays for ever.
	if len(stored) > oauthMaxStoredMetadata {
		stored, _ = json.Marshal(map[string]any{
			"client_id": id, "client_name": name, "redirect_uris": redirects,
			"grant_types": grants, "response_types": []string{"code"},
			"token_endpoint_auth_method": method, "scope": scope,
		})
	}

	var secretHash []byte
	if method != "none" {
		secret, err := randomToken(32)
		if err != nil {
			writeError(w, r, domain.Internal("could not mint a client secret").WithCause(err))
			return
		}
		secretHash = auth.HashToken(secret)
		resp["client_secret"] = secret
		// 0: the secret does not expire. A connector whose secret lapsed
		// would fail with invalid_client long after it was set up.
		resp["client_secret_expires_at"] = 0
	}
	if err := store.InsertOAuthClientFrom(r.Context(), tx, store.OAuthClient{
		ID: id, Name: name, RedirectURIs: redirects,
		SecretHash: secretHash, AuthMethod: method, Scope: scope, Metadata: stored,
	}, clientIP(r)); err != nil {
		writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, resp)
}

func oauthRedirectOK(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("redirect_uri is not a URI")
	}
	// RFC 6749 §3.1.2: no fragment. And no user:password@ in front of the
	// host, which only exists to make a URI read as a different site.
	if u.Fragment != "" || strings.Contains(raw, "#") {
		return fmt.Errorf("redirect_uri must not contain a fragment")
	}
	if u.User != nil {
		return fmt.Errorf("redirect_uri must not contain credentials")
	}
	host := strings.ToLower(u.Hostname())
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if host == "localhost" || host == "127.0.0.1" || host == "::1" {
			return nil
		}
		return fmt.Errorf("http redirect_uri is only allowed on localhost")
	default:
		return fmt.Errorf("redirect_uri must be https")
	}
}

// registeredRedirect returns the client's registered redirect URI that
// equals requested exactly (RFC 6749 §3.1.2.3), parsed. The value returned
// is the registered one, re-checked like at registration, so a redirect
// built from it can only go where the client said it would.
func registeredRedirect(registered []string, requested string) (*url.URL, error) {
	for _, reg := range registered {
		if reg != requested {
			continue
		}
		if err := oauthRedirectOK(reg); err != nil {
			return nil, err
		}
		u, err := url.Parse(reg)
		if err != nil {
			return nil, fmt.Errorf("redirect_uri is not a URI")
		}
		return u, nil
	}
	return nil, errors.New("redirect_uri is not registered for this client")
}

func (s *Server) handleOAuthAuthorize(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	q := r.URL.Query()
	if r.Method == http.MethodPost {
		if err := r.ParseForm(); err != nil {
			writeError(w, r, domain.BadRequest(msgMalformedForm))
			return
		}
		q = r.Form
	}
	clientID := strings.TrimSpace(q.Get("client_id"))
	redirectURI := strings.TrimSpace(q.Get("redirect_uri"))
	state := q.Get("state")
	challenge := strings.TrimSpace(q.Get("code_challenge"))
	method := strings.TrimSpace(q.Get("code_challenge_method"))
	resource := strings.TrimSpace(q.Get("resource"))
	// The granted scope: what the person chose on the page (consult and
	// register, or consult only), plus offline_access if asked for. Unknown
	// requested scopes grant nothing.
	scope := oauthGrantedScope(q.Get("scope"), oauthAccessChoice(q))
	// RFC 9207: every authorization response, success or error, names the
	// issuer. The metadata advertises it, and ChatGPT checks it before it
	// exchanges the code.
	issuer := s.publicBase(r)
	if method == "" {
		method = oauthChallenge
	}

	// target is the client's registered redirect URI that the request's
	// redirect_uri matched exactly. Redirects are built from it, never from
	// the request, and it stays nil until the match below.
	var target *url.URL
	failToClient := func(code, desc string) {
		if target == nil {
			s.oauthForm(w, r, q, desc, nil, nil)
			return
		}
		u := *target
		qq := u.Query()
		qq.Set("error", code)
		qq.Set("error_description", desc)
		if state != "" {
			qq.Set("state", state)
		}
		qq.Set("iss", issuer)
		u.RawQuery = qq.Encode()
		// redirect_uri is exact-matched against the OAuth client's registered URIs before this redirect (RFC 6749).
		// nosemgrep: go.lang.security.injection.open-redirect.open-redirect
		http.Redirect(w, r, u.String(), http.StatusFound)
	}

	if clientID == "" || redirectURI == "" {
		s.oauthForm(w, r, q, "Faltan client_id o redirect_uri.", nil, nil)
		return
	}
	// The client and its exact redirect_uri are checked BEFORE anything is
	// sent to that redirect_uri. The PKCE check used to come first, and its
	// error went to whatever redirect_uri the query named: an open redirect
	// from the farm's own domain to any site.
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	client, err := store.GetOAuthClient(r.Context(), tx, clientID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			s.oauthForm(w, r, q, "Cliente OAuth desconocido. Vuelva a registrar el conector.", nil, nil)
			return
		}
		writeError(w, r, err)
		return
	}
	target, err = registeredRedirect(client.RedirectURIs, redirectURI)
	if err != nil {
		s.oauthForm(w, r, q, "redirect_uri no coincide con el cliente registrado.", nil, nil)
		return
	}
	if challenge == "" || method != oauthChallenge {
		failToClient("invalid_request", "PKCE S256 is required")
		return
	}
	// RFC 8707: a resource indicator must name this server's MCP endpoint.
	// The token is bound to it (see issueSessionFor), so a code asked for on
	// behalf of another resource is refused before anyone signs in.
	if resource != "" && !s.resourceIsThisServer(r, resource) {
		failToClient("invalid_target", "resource must be "+s.mcpResource(r))
		return
	}

	if r.Method == http.MethodGet {
		s.oauthForm(w, r, q, "", nil, client)
		return
	}

	// The same limiter as /v1/auth/login, on the same table: this form checks
	// the same password, and without it the sign-in page was an unmetered
	// way around the login limit. The second step (farm pick) carries a
	// ticket, not a password, and is not counted.
	//
	// A passkey answer has no address to count against; like
	// /v1/auth/passkeys/login it is limited on the per-IP axis, and a failed
	// one is recorded with no address.
	usingPasskey := q.Get("ticket") == "" && q.Get("passkey_credential") != ""
	email := strings.ToLower(strings.TrimSpace(q.Get("email")))
	if usingPasskey {
		email = ""
	}
	ip := clientIP(r)
	if q.Get("ticket") == "" && (email != "" || usingPasskey) {
		failedPair, failedIP, err := store.CountLoginFailures(r.Context(), tx, email, ip, s.cfg.LoginFailureWindow)
		if err != nil {
			writeError(w, r, err)
			return
		}
		if (!usingPasskey && failedPair >= s.cfg.LoginFailuresPerEmailPerIP) || failedIP >= s.cfg.LoginFailuresPerIP {
			s.oauthForm(w, r, q, "Demasiados intentos fallidos. Espere unos minutos e intente de nuevo.", nil, client)
			return
		}
	}

	user, chosen, pick, ferr := s.oauthSignIn(r, tx, q)
	if ferr != nil {
		if errors.Is(ferr, errOAuthBadCredentials) || errors.Is(ferr, errOAuthBadPasskey) {
			// The page is a 200, so the request transaction commits and the
			// failure is counted; nothing else has been written by now.
			if err := store.RecordLoginFailure(r.Context(), tx, newID(), ip, email); err != nil {
				writeError(w, r, domain.Internal("could not record the failed sign-in").WithCause(err))
				return
			}
		}
		s.oauthForm(w, r, q, ferr.Error(), nil, client)
		return
	}
	if pick != nil {
		// Several farms and nothing (host, choice) says which: second step.
		s.oauthForm(w, r, q, "", pick, client)
		return
	}

	// The code row carries a signed, purpose-bound proof of who signed in
	// and for which farm — not a bearer token: a dump of oauth_codes must not
	// hand out sessions. The session proper (access and refresh token) is
	// issued at the token endpoint, to whoever proves they hold the PKCE
	// verifier.
	proof := s.signer.SignTicket(oauthCodeTicketPurpose, user.ID+"|"+chosen.FarmID, oauthCodeTTL)
	code, err := randomToken(32)
	if err != nil {
		writeError(w, r, domain.Internal("could not mint an authorization code").WithCause(err))
		return
	}
	if err := store.InsertOAuthCode(r.Context(), tx, store.OAuthCode{
		// Only the code's hash is stored, like every other secret here.
		Code:                oauthCodeKey(code),
		ClientID:            clientID,
		RedirectURI:         redirectURI,
		CodeChallenge:       challenge,
		CodeChallengeMethod: method,
		Resource:            resource,
		Scope:               scope,
		AccessToken:         proof,
		ExpiresAt:           time.Now().Add(oauthCodeTTL),
	}); err != nil {
		writeError(w, r, err)
		return
	}

	u := *target
	qq := u.Query()
	qq.Set("code", code)
	if state != "" {
		qq.Set("state", state)
	}
	qq.Set("iss", issuer)
	u.RawQuery = qq.Encode()
	// redirect_uri is exact-matched against the OAuth client's registered URIs before this redirect (RFC 6749).
	// nosemgrep: go.lang.security.injection.open-redirect.open-redirect
	http.Redirect(w, r, u.String(), http.StatusFound)
}

const (
	oauthPickTicketPurpose = "oauth-farm-pick"
	oauthPickTicketTTL     = 10 * time.Minute
	// oauthCodeTicketPurpose seals who signed in, for the code exchange.
	oauthCodeTicketPurpose = "oauth-code"
)

// oauthCodeKey is the lookup key an authorization code is stored under: its
// SHA-256, so the table never holds a code that can be exchanged.
func oauthCodeKey(code string) string {
	return hex.EncodeToString(auth.HashToken(code))
}

// sanitizeClientName drops control, format (bidi overrides, zero-width) and
// other invisible characters from a registered client name, collapses
// whitespace and cuts it to oauthMaxClientName runes.
func sanitizeClientName(v string) string {
	var b strings.Builder
	for _, r := range v {
		switch {
		case unicode.IsControl(r), unicode.In(r, unicode.Cf, unicode.Co, unicode.Cs):
			continue
		case unicode.IsSpace(r):
			b.WriteRune(' ')
		default:
			b.WriteRune(r)
		}
	}
	name := strings.Join(strings.Fields(b.String()), " ")
	if rs := []rune(name); len(rs) > oauthMaxClientName {
		name = string(rs[:oauthMaxClientName])
	}
	return name
}

// oauthRegistrationBudgetLeft is the platform-wide cap on anonymous client
// registrations, counted in the database so every replica shares it (the
// per-address limiter in front of it is per process). It is what bounds the
// table when the addresses are many.
func (s *Server) oauthRegistrationBudgetLeft(r *http.Request) bool {
	max := s.cfg.OAuthRegistrationsPerHour
	if max <= 0 {
		return true
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		return true
	}
	n, err := store.CountRecentOAuthClients(r.Context(), tx, time.Hour)
	if err != nil {
		slog.Error("oauth registration budget", "err", err)
		return true
	}
	if n >= max {
		return false
	}
	// The per-address cap again, counted in the database: the in-memory
	// limiter is per replica and forgets on restart.
	perIP := s.cfg.OAuthRegistrationsPerIPPerHour
	if perIP <= 0 {
		return true
	}
	n, err = store.CountRecentOAuthClientsFrom(r.Context(), tx, clientIP(r), time.Hour)
	if err != nil {
		slog.Error("oauth registration budget", "err", err)
		return true
	}
	return n < perIP
}

// oauthPick is the second step of the sign-in page: the password was right and
// the account belongs to several farms, none of them named by the host.
type oauthPick struct {
	Ticket string
	Farms  []store.Membership
}

// oauthSignIn resolves who is signing in and for which farm.
//
// First step: email and password, or a passkey (see oauthPasskeySignIn).
// Second step (only on the main host, for an
// account with several farms): a ticket proving the password was already
// checked, plus the farm the person picked from the list. A farm host
// ({slug}.bascula.engp.io) names its farm, so it never asks.
//
// Exactly one of (membership, pick, error) is meaningful.
func (s *Server) oauthSignIn(r *http.Request, tx pgx.Tx, q url.Values) (*store.User, *store.Membership, *oauthPick, error) {
	var user *store.User
	// The farms the password opened: carried by the ticket on the second step,
	// computed from the password on the first. See farmsUnlockedBy.
	var ticketFarms []string
	password, globalOK := "", false
	// The passkey that signed in, when one did; it decides the farms instead
	// of the password (farmsUnlockedByPasskey).
	var passkey *store.Passkey
	if ticket := q.Get("ticket"); ticket != "" {
		sub, err := s.signer.VerifyTicket(oauthPickTicketPurpose, ticket)
		uid, farms, found := strings.Cut(sub, "|")
		if err != nil || !found || farms == "" {
			return nil, nil, nil, errors.New("Pasó demasiado tiempo. Entre de nuevo con su correo y contraseña.")
		}
		ticketFarms = strings.Split(farms, ",")
		u, err := store.FindUserByID(r.Context(), tx, uid)
		if err != nil {
			return nil, nil, nil, errors.New("Pasó demasiado tiempo. Entre de nuevo con su correo y contraseña.")
		}
		user = u
	} else if q.Get("passkey_credential") != "" {
		pk, u, err := s.oauthPasskeySignIn(r, tx, q)
		if err != nil {
			return nil, nil, nil, err
		}
		user, passkey = u, pk
	} else {
		email := strings.ToLower(strings.TrimSpace(q.Get("email")))
		password = q.Get("password")
		if email == "" || password == "" {
			return nil, nil, nil, errors.New("Correo y contraseña son obligatorios.")
		}
		u, err := store.FindUserByEmail(r.Context(), tx, email)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, nil, err
		}
		hash := auth.DecoyHash()
		if u != nil {
			hash = u.PasswordHash
		}
		ok, err := auth.VerifyPassword(password, hash)
		if err != nil || u == nil {
			return nil, nil, nil, errOAuthBadCredentials
		}
		user, globalOK = u, ok
	}
	if err := tenant.SetUser(r.Context(), tx, user.ID); err != nil {
		return nil, nil, nil, err
	}
	all, err := store.ListMemberships(r.Context(), tx, user.ID)
	if err != nil {
		return nil, nil, nil, err
	}
	if len(all) == 0 && (ticketFarms != nil || globalOK || passkey != nil) {
		return nil, nil, nil, errors.New("Esa cuenta no pertenece a ninguna finca.")
	}
	var memberships []store.Membership
	if ticketFarms != nil {
		for _, m := range all {
			if containsString(ticketFarms, m.FarmID) {
				memberships = append(memberships, m)
			}
		}
	} else if passkey != nil {
		if memberships, err = farmsUnlockedByPasskey(r, tx, user.ID, passkey, all); err != nil {
			return nil, nil, nil, err
		}
		if len(memberships) == 0 {
			return nil, nil, nil, errors.New("Esa llave de acceso no abre ninguna finca. Entre con su correo y contraseña.")
		}
	} else if memberships, err = farmsUnlockedBy(r.Context(), tx, user.ID, password, globalOK, all); err != nil {
		return nil, nil, nil, err
	}
	if len(memberships) == 0 {
		// A password that opens none of the account's farms is a wrong
		// password, and the login limiter counts it as one.
		return nil, nil, nil, errOAuthBadCredentials
	}
	// An unproved address connects only the farms whose own password it was
	// given (an invite); see onlyFarmScoped.
	if user.EmailVerifiedAt == nil {
		if memberships, err = onlyFarmScoped(r.Context(), tx, user.ID, memberships); err != nil {
			return nil, nil, nil, err
		}
		if len(memberships) == 0 {
			return nil, nil, nil, errors.New("Verifique el correo antes de conectar un asistente.")
		}
	}
	var active []store.Membership
	for _, m := range memberships {
		if m.SuspendedAt == nil {
			active = append(active, m)
		}
	}
	if len(memberships) == 0 {
		return nil, nil, nil, errors.New("Esa cuenta no pertenece a ninguna finca.")
	}
	if len(active) == 0 {
		return nil, nil, nil, errors.New("Esa finca está suspendida.")
	}
	find := func(farmID string) *store.Membership {
		for i := range active {
			if active[i].FarmID == farmID {
				return &active[i]
			}
		}
		return nil
	}

	// A farm address names its farm: no question, and no other farm.
	if slug := farmSlugFromHost(r); slug != "" {
		for _, m := range memberships {
			if m.FarmSlug == slug && m.SuspendedAt != nil {
				return nil, nil, nil, errors.New("Esa finca está suspendida.")
			}
		}
		for i := range active {
			if active[i].FarmSlug == slug {
				return user, &active[i], nil, nil
			}
		}
		pinned, err := visibleFarmIDBySlug(r.Context(), tx, slug)
		if err != nil {
			return nil, nil, nil, err
		}
		if m := find(pinned); pinned != "" && m != nil {
			return user, m, nil, nil
		}
		// A dedicated farm stack holds only its own farm, so on its host
		// the one active membership is that farm.
		if len(active) == 1 {
			return user, &active[0], nil, nil
		}
		return nil, nil, nil, errors.New("Esa cuenta no pertenece a esta finca.")
	}

	if farmID := strings.TrimSpace(q.Get("farm_id")); farmID != "" {
		if m := find(farmID); m != nil {
			return user, m, nil, nil
		}
		return nil, nil, nil, errors.New("Esa cuenta no pertenece a esa finca.")
	}
	if len(active) == 1 {
		return user, &active[0], nil, nil
	}
	return user, nil, &oauthPick{
		Ticket: s.signer.SignTicket(oauthPickTicketPurpose, user.ID+"|"+strings.Join(farmIDs(active), ","), oauthPickTicketTTL),
		Farms:  active,
	}, nil
}

// oauthPasskeySignIn is the sign-in page's passkey door: the page's script
// asked /v1/auth/passkeys/login/options for a challenge, the phone signed it,
// and the form posted the answer here instead of a password.
//
// It is checked exactly as /v1/auth/passkeys/login checks it
// (verifyPasskeyAnswer): the relying party is the page's own Origin, so an
// answer made for this farm address is the only one accepted, and a form
// posted from another site has the wrong Origin and is refused; the user
// was verified on the device; the challenge is single use. What the person
// consents to (the client, where the code goes, read or write) is the same
// page and the same choice as with the password.
func (s *Server) oauthPasskeySignIn(r *http.Request, tx pgx.Tx, q url.Values) (*store.Passkey, *store.User, error) {
	rp, err := s.passkeyRPFor(r)
	if err != nil {
		return nil, nil, errOAuthBadPasskey
	}
	pk, user, cred, err := s.verifyPasskeyAnswer(r, tx, rp, q.Get("passkey_challenge"), []byte(q.Get("passkey_credential")))
	if errors.Is(err, errPasskeyRefused) {
		return nil, nil, errOAuthBadPasskey
	}
	if err != nil {
		return nil, nil, err
	}
	record, err := json.Marshal(cred)
	if err != nil {
		return nil, nil, err
	}
	if err := store.TouchPasskey(r.Context(), tx, pk.ID, record); err != nil {
		return nil, nil, err
	}
	return pk, user, nil
}

// oauthClientCredentials reads the client's identity the way RFC 6749 §2.3
// allows: HTTP Basic (client_secret_basic, both halves form-urlencoded) or
// client_id / client_secret in the form (client_secret_post, or a public
// client that sends only client_id).
func oauthClientCredentials(r *http.Request) (id, secret string, basic bool) {
	if u, p, ok := r.BasicAuth(); ok {
		if v, err := url.QueryUnescape(u); err == nil {
			u = v
		}
		if v, err := url.QueryUnescape(p); err == nil {
			p = v
		}
		return u, p, true
	}
	return strings.TrimSpace(r.Form.Get("client_id")), r.Form.Get("client_secret"), false
}

// oauthAuthenticateClient checks a client against its registration. A
// confidential client must present its secret; a public client is identified
// by client_id alone (PKCE is what protects its code). A wrong secret is
// always refused.
func oauthAuthenticateClient(r *http.Request, tx pgx.Tx, id, secret string) (*store.OAuthClient, error) {
	client, err := store.GetOAuthClient(r.Context(), tx, id)
	if err != nil {
		return nil, errors.New("unknown client")
	}
	if len(client.SecretHash) > 0 {
		if secret == "" {
			return nil, errors.New("client authentication is required for this client")
		}
		if subtle.ConstantTimeCompare(auth.HashToken(secret), client.SecretHash) != 1 {
			return nil, errors.New("client authentication failed")
		}
	}
	return client, nil
}

// oauthClientError is RFC 6749 §5.2 invalid_client: 401, with a Basic
// challenge when the client tried Basic.
func oauthClientError(w http.ResponseWriter, basic bool, desc string) {
	allowCORS(w)
	if basic {
		w.Header().Set("WWW-Authenticate", `Basic realm="bascula"`)
	}
	w.Header().Set(headerContentType, contentTypeJSON)
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error":             "invalid_client",
		"error_description": desc,
	})
}

func (s *Server) handleOAuthToken(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	if err := r.ParseForm(); err != nil {
		oauthTokenError(w, "invalid_request", msgMalformedForm)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	// RFC 8707 at the token endpoint: a resource, if named, must be this
	// server's MCP endpoint, which is what the token will be bound to.
	if res := strings.TrimSpace(r.Form.Get("resource")); res != "" && !s.resourceIsThisServer(r, res) {
		oauthTokenError(w, "invalid_target", "resource must be "+s.mcpResource(r))
		return
	}
	switch r.Form.Get("grant_type") {
	case "authorization_code":
		s.oauthExchangeCode(w, r, tx)
	case "refresh_token":
		s.oauthRefresh(w, r, tx)
	default:
		oauthTokenError(w, "unsupported_grant_type", "only authorization_code and refresh_token are supported")
	}
}

// oauthRefresh is the refresh_token grant. The same rotation a handset gets:
// single use, and a replay closes the whole family. Without this grant an
// assistant's connection died fifteen minutes after it was made, when the
// access token expired.
func (s *Server) oauthRefresh(w http.ResponseWriter, r *http.Request, tx pgx.Tx) {
	secret := r.Form.Get("refresh_token")
	if secret == "" {
		oauthTokenError(w, "invalid_request", "refresh_token is required")
		return
	}
	// RFC 6749 §6: a refresh token is bound to the client it was issued
	// to. A confidential client must authenticate even when it leaves out
	// client_id, and another client's refresh token is refused.
	id, clientSecret, basic := oauthClientCredentials(r)
	tok, err := store.FindRefreshToken(r.Context(), tx, auth.HashToken(secret))
	if err != nil || tok.OAuthClientID == nil {
		// Unknown, or a web or handset session's token: this endpoint
		// only rotates what it issued. A browser's refresh token is
		// redeemed at /v1/auth/refresh and nowhere else.
		oauthTokenError(w, "invalid_grant", "the refresh token is not valid; sign in again")
		return
	}
	if id != "" && id != *tok.OAuthClientID {
		oauthTokenError(w, "invalid_grant", "the refresh token was issued to another client")
		return
	}
	id = *tok.OAuthClientID
	if id != "" {
		if _, err := oauthAuthenticateClient(r, tx, id, clientSecret); err != nil {
			oauthClientError(w, basic, err.Error())
			return
		}
	}
	session, err := s.rotateRefresh(r, tx, secret, "")
	if err != nil {
		oauthTokenError(w, "invalid_grant", "the refresh token is not valid; sign in again")
		return
	}
	writeOAuthSession(w, session, "")
}

func (s *Server) oauthExchangeCode(w http.ResponseWriter, r *http.Request, tx pgx.Tx) {
	code := r.Form.Get("code")
	verifier := r.Form.Get("code_verifier")
	redirectURI := r.Form.Get("redirect_uri")
	clientID, clientSecret, basic := oauthClientCredentials(r)
	if code == "" || verifier == "" || redirectURI == "" || clientID == "" {
		oauthTokenError(w, "invalid_request", "code, code_verifier, redirect_uri and client_id are required")
		return
	}
	client, err := oauthAuthenticateClient(r, tx, clientID, clientSecret)
	if err != nil {
		oauthClientError(w, basic, err.Error())
		return
	}
	row, err := store.ConsumeOAuthCode(r.Context(), tx, oauthCodeKey(code))
	if err != nil {
		oauthTokenError(w, "invalid_grant", "code is not valid")
		return
	}
	// The code is spent even if PKCE fails: a retry with the same code must
	// not succeed, and a 400 would otherwise roll the delete back.
	tenant.KeepChanges(r.Context())
	if row.ClientID != clientID || row.RedirectURI != redirectURI {
		oauthTokenError(w, "invalid_grant", "code does not match this client")
		return
	}
	if pkceS256(verifier) != row.CodeChallenge {
		oauthTokenError(w, "invalid_grant", "PKCE verification failed")
		return
	}

	// The code carries the proof sealed at sign-in. It says who and which
	// farm; the session is issued now, with a refresh token, from the
	// membership as it stands.
	who, err := s.signer.VerifyTicket(oauthCodeTicketPurpose, row.AccessToken)
	userID, farmID, found := strings.Cut(who, "|")
	if err != nil || !found {
		oauthTokenError(w, "invalid_grant", "code expired")
		return
	}
	if row.Resource != "" && !s.resourceIsThisServer(r, row.Resource) {
		oauthTokenError(w, "invalid_target", "the code was issued for another resource")
		return
	}
	user, err := store.FindUserByID(r.Context(), tx, userID)
	if err != nil {
		oauthTokenError(w, "invalid_grant", "that account no longer exists")
		return
	}
	if err := tenant.SetUser(r.Context(), tx, user.ID); err != nil {
		writeError(w, r, err)
		return
	}
	m, err := store.GetMembership(r.Context(), tx, farmID, user.ID)
	if err != nil || m.SuspendedAt != nil {
		oauthTokenError(w, "invalid_grant", "that account no longer has access to this farm")
		return
	}
	scope := row.Scope
	if scope == "" {
		scope = auth.ScopeMCP
	}
	method := store.SignInOAuth
	session, err := s.issueSessionFor(r, tx, user, m, "", newID(), familyGrant{Method: &method, ClientID: &row.ClientID, Scope: &scope})
	if err != nil {
		writeError(w, r, err)
		return
	}
	// A new connection is a new family, minted here and only here (a refresh
	// keeps its family), so this is once per connection. See notices.go.
	s.mailLater(r, assistantConnectedMessage(user.Email, user.Name, client.Name, m.FarmName,
		auth.ScopeIsReadOnly(scope)))
	writeOAuthSession(w, session, scope)
}

// writeOAuthSession answers the token endpoint. scope is the granted scope;
// "" leaves it out, which RFC 6749 §5.1 reads as "the same as before" (the
// refresh grant).
func writeOAuthSession(w http.ResponseWriter, session *sessionResponse, scope string) {
	body := map[string]any{
		"access_token":  session.AccessToken,
		"refresh_token": session.RefreshToken,
		"token_type":    "Bearer",
		"expires_in":    session.ExpiresIn,
	}
	if scope != "" {
		body["scope"] = scope
	}
	w.Header().Set("Pragma", "no-cache")
	writeJSON(w, http.StatusOK, body)
}

// handleOAuthRevoke is RFC 7009 token revocation. A refresh token closes its
// whole family (the connection disappears from «Conexiones»); an access token
// is a fifteen-minute JWT with no server-side state, so it simply lapses. The
// answer is 200 either way, including for a token this server never issued.
func (s *Server) handleOAuthRevoke(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	if err := r.ParseForm(); err != nil {
		oauthTokenError(w, "invalid_request", msgMalformedForm)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	id, secret, basic := oauthClientCredentials(r)
	token := r.Form.Get("token")
	if token == "" {
		oauthTokenError(w, "invalid_request", "token is required")
		return
	}
	// Access tokens are stateless and simply lapse; only a refresh token has
	// anything to revoke. Whatever the hint says, it is looked up as one.
	tok, err := store.FindRefreshToken(r.Context(), tx, auth.HashToken(token))
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, r, err)
			return
		}
		tok = nil
	}
	// RFC 7009 §2.1: the server verifies the token was issued to the client
	// asking. This endpoint closes an assistant's own grant and nothing
	// else: a web or handset session's refresh token presented here is left
	// alone (its door is /v1/auth/logout), and so is another client's.
	if tok == nil || tok.OAuthClientID == nil {
		if id != "" {
			if _, err := oauthAuthenticateClient(r, tx, id, secret); err != nil {
				oauthClientError(w, basic, err.Error())
				return
			}
		}
		w.WriteHeader(http.StatusOK)
		return
	}
	if id == "" {
		// A public client may identify itself by the token alone; a
		// confidential one must still authenticate (checked below).
		id = *tok.OAuthClientID
	}
	if _, err := oauthAuthenticateClient(r, tx, id, secret); err != nil {
		oauthClientError(w, basic, err.Error())
		return
	}
	if id != *tok.OAuthClientID {
		oauthTokenError(w, "unauthorized_client", "the token was issued to another client")
		return
	}
	if err := store.RevokeFamily(r.Context(), tx, tok.FamilyID); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func oauthTokenError(w http.ResponseWriter, code, desc string) {
	allowCORS(w)
	w.Header().Set(headerContentType, contentTypeJSON)
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error":             code,
		"error_description": desc,
	})
}

// oauthRegisterError is RFC 7591 §3.2.2: a 400 with error and
// error_description, the shape registration clients parse and show.
//
// RFC 6749 §5.2 gives token errors the same shape, so it is the same writer.
func oauthRegisterError(w http.ResponseWriter, code, desc string) {
	oauthTokenError(w, code, desc)
}

func pkceS256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// oauthFormStyle: large tap targets, readable on a phone and on a desk.
const oauthFormStyle = `<style>
  body{font:17px/1.45 system-ui,sans-serif;max-width:30rem;margin:8vh auto;padding:0 1.25rem;color:#111}
  h1{font-size:1.3rem;margin:0 0 .5rem}
  p{color:#444}
  label.f{display:block;margin:.9rem 0 .3rem;font-weight:600}
  input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:.75rem .8rem;font:inherit;border:1px solid #bbb;border-radius:8px}
  button{margin-top:1.25rem;width:100%;padding:.9rem 1rem;font:inherit;font-weight:600;background:#2e7d32;color:#fff;border:0;border-radius:8px;cursor:pointer}
  .err{color:#a30;background:#fee;padding:.6rem .8rem;border-radius:8px}
  .farm{color:#1b5e20;background:#eef7ee;padding:.6rem .8rem;border-radius:8px}
  fieldset{border:0;margin:1rem 0 0;padding:0}
  legend{font-weight:600;margin-bottom:.5rem}
  label.opt{display:flex;align-items:center;gap:.8rem;min-height:3.25rem;margin:.5rem 0;padding:.8rem 1rem;border:1px solid #bbb;border-radius:10px;cursor:pointer}
  label.opt:has(input:checked){border-color:#2e7d32;background:#eef7ee}
  label.opt input{width:1.4rem;height:1.4rem;margin:0;flex:none}
  .slug{display:block;color:#666;font-size:.9rem}
  .who{background:#f4f4f4;padding:.6rem .8rem;border-radius:8px;color:#111;word-break:break-all}
  .warn{font-size:.9rem}
  button.alt{background:#fff;color:#1b5e20;border:2px solid #2e7d32}
</style>`

// oauthPasskeyScript is the sign-in page's «Entrar con llave de acceso»:
// ask this origin for a challenge, let the phone sign it, put the answer in
// the form and post it (the access choice goes with it). Shown only where
// the browser has passkeys; anything that fails leaves the password form as
// it was.
const oauthPasskeyScript = `(function(){
var b=document.getElementById("passkey");
if(!b||!window.PublicKeyCredential||!navigator.credentials)return;
b.hidden=false;
var f=b.form;
function dec(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var r=atob(s),u=new Uint8Array(r.length);for(var i=0;i<r.length;i++)u[i]=r.charCodeAt(i);return u.buffer;}
function enc(v){if(!v)return undefined;var a=new Uint8Array(v),s="";for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
b.addEventListener("click",function(){
b.disabled=true;
fetch("/v1/auth/passkeys/login/options",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}",credentials:"omit"})
.then(function(res){if(!res.ok)throw new Error("options");return res.json();})
.then(function(o){
var P=window.PublicKeyCredential,pk=o.publicKey;
var opts=P.parseRequestOptionsFromJSON?P.parseRequestOptionsFromJSON(pk):Object.assign({},pk,{challenge:dec(pk.challenge),allowCredentials:(pk.allowCredentials||[]).map(function(c){return Object.assign({},c,{id:dec(c.id)});})});
return navigator.credentials.get({publicKey:opts}).then(function(c){
var j=c.toJSON?c.toJSON():{id:c.id,rawId:enc(c.rawId),type:c.type,response:{clientDataJSON:enc(c.response.clientDataJSON),authenticatorData:enc(c.response.authenticatorData),signature:enc(c.response.signature),userHandle:enc(c.response.userHandle)},clientExtensionResults:c.getClientExtensionResults?c.getClientExtensionResults():{}};
f.elements.passkey_challenge.value=o.challenge;
f.elements.passkey_credential.value=JSON.stringify(j);
f.submit();
});
})
.catch(function(){b.disabled=false;});
});
})();`

// oauthForm renders the sign-in page. client is nil until the request names a
// registered client; from then on the page says which application is asking
// and which site the code goes to, because registration is open and a
// stranger can register a client of their own.
func (s *Server) oauthForm(w http.ResponseWriter, r *http.Request, q url.Values, notice string, pick *oauthPick, client *store.OAuthClient) {
	w.Header().Set(headerContentType, "text/html; charset=utf-8")
	// A password form must not be framed (clickjacking), and its URL carries
	// state and the PKCE challenge, which no Referer should repeat.
	w.Header().Set("X-Frame-Options", "DENY")
	// The only script is the passkey button's, inline under a per-response
	// nonce; it may call this origin and nothing else.
	nonce, err := randomToken(16)
	if err != nil {
		writeError(w, r, domain.Internal("could not render the sign-in page").WithCause(err))
		return
	}
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-"+nonce+"'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	data := oauthPageData{Nonce: nonce, Notice: notice, Pick: pick != nil}
	// The request's OAuth parameters ride along as hidden fields. The access
	// choice is its own field on the sign-in form, so the hidden copy of an
	// earlier choice is only carried by the farm pick.
	for _, name := range []string{"client_id", "redirect_uri", "state", "code_challenge",
		"code_challenge_method", "resource", "scope", "response_type", "access"} {
		if v := q.Get(name); v != "" && (pick != nil || name != "access") {
			data.Hidden = append(data.Hidden, oauthPageField{Name: name, Value: v})
		}
	}
	if notice != "" {
		// Why the sign-in page came back instead of going on to the assistant
		// (wrong password, unknown client, ...). Never the password itself.
		slog.Warn("oauth sign-in page notice", "notice", notice, "client_id", q.Get("client_id"))
	}
	if client != nil {
		dest := q.Get("redirect_uri")
		if u, err := url.Parse(dest); err == nil && u.Host != "" {
			dest = u.Host
		}
		data.Client = &oauthPageClient{Name: client.Name, Dest: dest}
	}
	if pick != nil {
		data.Ticket = pick.Ticket
		for i, m := range pick.Farms {
			name := strings.TrimSpace(m.FarmName)
			if name == "" {
				name = m.FarmSlug
			}
			data.Farms = append(data.Farms, oauthPageFarm{ID: m.FarmID, Name: name, Slug: m.FarmSlug, Checked: i == 0})
		}
	} else {
		if slug := farmSlugFromHost(r); slug != "" {
			data.FarmName = slug
			if s.pool != nil {
				var dn *string
				// farm_display_name is a SECURITY DEFINER lookup by slug, before any tenant exists.
				// nosemgrep: bascula-pool-query-outside-tenant-tx
				if err := s.pool.QueryRow(r.Context(), `SELECT farm_display_name($1)`, slug).Scan(&dn); err == nil && dn != nil && *dn != "" {
					data.FarmName = *dn
				}
			}
		}
		data.ReadOnly = oauthAccessChoice(q) == "read"
		data.Email = q.Get("email")
	}
	w.WriteHeader(http.StatusOK)
	// The template is parsed and checked at start-up and its data is plain
	// strings, so it cannot fail halfway for a reason the request controls;
	// a failed write is a client that went away.
	if err := oauthPageTmpl.Execute(w, data); err != nil {
		slog.Warn("oauth sign-in page not fully written", "err", err)
	}
}

func farmIDs(ms []store.Membership) []string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.FarmID
	}
	return out
}
