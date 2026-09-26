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
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
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
)

// errOAuthBadCredentials is the one sign-in failure the login limiter counts.
var errOAuthBadCredentials = errors.New("Correo o contraseña incorrectos.")

// oauthScopesSupported: "mcp" is the only permission there is; offline_access
// is advertised because clients (ChatGPT among them) ask for it to get a
// refresh token, which this server issues anyway. Any requested scope is
// accepted: a scope this server does not know grants nothing extra.
var oauthScopesSupported = []string{oauthScope, "offline_access"}

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
		"scopes_supported":         []string{oauthScope},
		"bearer_methods_supported": []string{"header"},
		"resource_name":            "Báscula",
		"resource_documentation":   base + "/mcp",
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
		"service_documentation":                          base + "/mcp",
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
	if !s.oauthRegs.allow(clientIP(r), time.Now()) {
		w.Header().Set("Retry-After", "3600")
		w.Header().Set("Content-Type", "application/json")
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
		"ua", r.UserAgent(),
		"keys", keys,
		"client_name", str("client_name"),
		"redirect_uris", redirects,
		"grant_types", list("grant_types"),
		"response_types", list("response_types"),
		"token_endpoint_auth_method", requestedMethod,
		"granted_auth_method", method,
		"scope", str("scope"),
		"application_type", str("application_type"),
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
	name := str("client_name")
	if name == "" {
		name = "mcp-client"
	}
	// The name is shown on the sign-in page, so it is kept short and plain.
	if r := []rune(name); len(r) > oauthMaxClientName {
		name = string(r[:oauthMaxClientName])
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
	if err := store.InsertOAuthClient(r.Context(), tx, store.OAuthClient{
		ID: id, Name: name, RedirectURIs: redirects,
		SecretHash: secretHash, AuthMethod: method, Scope: scope, Metadata: stored,
	}); err != nil {
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

func (s *Server) handleOAuthAuthorize(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	q := r.URL.Query()
	if r.Method == http.MethodPost {
		if err := r.ParseForm(); err != nil {
			writeError(w, r, domain.BadRequest("malformed form"))
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
	// Any requested scope is accepted (unknown ones grant nothing more); it
	// is carried to the token response so the client sees what it asked for.
	scope := strings.Join(strings.Fields(q.Get("scope")), " ")
	// RFC 9207: every authorization response, success or error, names the
	// issuer. The metadata advertises it, and ChatGPT checks it before it
	// exchanges the code.
	issuer := s.publicBase(r)
	if method == "" {
		method = oauthChallenge
	}

	failToClient := func(desc string) {
		if redirectURI == "" {
			s.oauthForm(w, r, q, desc, nil, nil)
			return
		}
		u, err := url.Parse(redirectURI)
		if err != nil {
			s.oauthForm(w, r, q, desc, nil, nil)
			return
		}
		qq := u.Query()
		qq.Set("error", "invalid_request")
		qq.Set("error_description", desc)
		if state != "" {
			qq.Set("state", state)
		}
		qq.Set("iss", issuer)
		u.RawQuery = qq.Encode()
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
	if !containsString(client.RedirectURIs, redirectURI) {
		s.oauthForm(w, r, q, "redirect_uri no coincide con el cliente registrado.", nil, nil)
		return
	}
	if challenge == "" || method != oauthChallenge {
		failToClient("PKCE S256 is required")
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
	email := strings.ToLower(strings.TrimSpace(q.Get("email")))
	ip := clientIP(r)
	if q.Get("ticket") == "" && email != "" {
		failedPair, failedIP, err := store.CountLoginFailures(r.Context(), tx, email, ip, s.cfg.LoginFailureWindow)
		if err != nil {
			writeError(w, r, err)
			return
		}
		if failedPair >= s.cfg.LoginFailuresPerEmailPerIP || failedIP >= s.cfg.LoginFailuresPerIP {
			s.oauthForm(w, r, q, "Demasiados intentos fallidos. Espere unos minutos e intente de nuevo.", nil, client)
			return
		}
	}

	user, chosen, pick, ferr := s.oauthSignIn(r, tx, q)
	if ferr != nil {
		if errors.Is(ferr, errOAuthBadCredentials) {
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

	// Only the access token is minted here, as proof of who signed in; the
	// session proper (with its refresh token) is issued at the token
	// endpoint, to whoever proves they hold the PKCE verifier.
	access, err := s.signer.Issue(user.ID, chosen.FarmID, chosen.Role, "", user.IsSuperadmin)
	if err != nil {
		writeError(w, r, domain.Internal("could not issue the access token").WithCause(err))
		return
	}
	code, err := randomToken(32)
	if err != nil {
		writeError(w, r, domain.Internal("could not mint an authorization code").WithCause(err))
		return
	}
	if err := store.InsertOAuthCode(r.Context(), tx, store.OAuthCode{
		Code:                code,
		ClientID:            clientID,
		RedirectURI:         redirectURI,
		CodeChallenge:       challenge,
		CodeChallengeMethod: method,
		Resource:            resource,
		Scope:               scope,
		AccessToken:         access,
		ExpiresAt:           time.Now().Add(oauthCodeTTL),
	}); err != nil {
		writeError(w, r, err)
		return
	}

	u, err := url.Parse(redirectURI)
	if err != nil {
		writeError(w, r, domain.BadRequest("redirect_uri is not a URI"))
		return
	}
	qq := u.Query()
	qq.Set("code", code)
	if state != "" {
		qq.Set("state", state)
	}
	qq.Set("iss", issuer)
	u.RawQuery = qq.Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

const (
	oauthPickTicketPurpose = "oauth-farm-pick"
	oauthPickTicketTTL     = 10 * time.Minute
)

// oauthPick is the second step of the sign-in page: the password was right and
// the account belongs to several farms, none of them named by the host.
type oauthPick struct {
	Ticket string
	Farms  []store.Membership
}

// oauthSignIn resolves who is signing in and for which farm.
//
// First step: email and password. Second step (only on the main host, for an
// account with several farms): a ticket proving the password was already
// checked, plus the farm the person picked from the list. A farm host
// ({slug}.bascula.engp.io) names its farm, so it never asks.
//
// Exactly one of (membership, pick, error) is meaningful.
func (s *Server) oauthSignIn(r *http.Request, tx pgx.Tx, q url.Values) (*store.User, *store.Membership, *oauthPick, error) {
	var user *store.User
	if ticket := q.Get("ticket"); ticket != "" {
		uid, err := s.signer.VerifyTicket(oauthPickTicketPurpose, ticket)
		if err != nil {
			return nil, nil, nil, errors.New("Pasó demasiado tiempo. Entre de nuevo con su correo y contraseña.")
		}
		u, err := store.FindUserByID(r.Context(), tx, uid)
		if err != nil {
			return nil, nil, nil, errors.New("Pasó demasiado tiempo. Entre de nuevo con su correo y contraseña.")
		}
		user = u
	} else {
		email := strings.ToLower(strings.TrimSpace(q.Get("email")))
		password := q.Get("password")
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
		if err != nil || !ok || u == nil {
			return nil, nil, nil, errOAuthBadCredentials
		}
		user = u
	}
	if user.EmailVerifiedAt == nil {
		return nil, nil, nil, errors.New("Verifique el correo antes de conectar un asistente.")
	}
	if err := tenant.SetUser(r.Context(), tx, user.ID); err != nil {
		return nil, nil, nil, err
	}
	memberships, err := store.ListMemberships(r.Context(), tx, user.ID)
	if err != nil {
		return nil, nil, nil, err
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
		Ticket: s.signer.SignTicket(oauthPickTicketPurpose, user.ID, oauthPickTicketTTL),
		Farms:  active,
	}, nil
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
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error":             "invalid_client",
		"error_description": desc,
	})
}

func (s *Server) handleOAuthToken(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	if err := r.ParseForm(); err != nil {
		oauthTokenError(w, "invalid_request", "malformed form")
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	switch r.Form.Get("grant_type") {
	case "authorization_code":
		s.oauthExchangeCode(w, r, tx)
	case "refresh_token":
		// The same rotation a handset gets: single use, and a replay closes
		// the whole family. Without this grant an assistant's connection died
		// fifteen minutes after it was made, when the access token expired.
		secret := r.Form.Get("refresh_token")
		if secret == "" {
			oauthTokenError(w, "invalid_request", "refresh_token is required")
			return
		}
		// RFC 6749 §6: a refresh token is bound to the client it was issued
		// to. A confidential client must authenticate even when it leaves out
		// client_id, and another client's refresh token is refused.
		id, clientSecret, basic := oauthClientCredentials(r)
		if tok, err := store.FindRefreshToken(r.Context(), tx, auth.HashToken(secret)); err == nil && tok.OAuthClientID != nil {
			if id != "" && id != *tok.OAuthClientID {
				oauthTokenError(w, "invalid_grant", "the refresh token was issued to another client")
				return
			}
			id = *tok.OAuthClientID
		}
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
	default:
		oauthTokenError(w, "unsupported_grant_type", "only authorization_code and refresh_token are supported")
	}
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
	if _, err := oauthAuthenticateClient(r, tx, clientID, clientSecret); err != nil {
		oauthClientError(w, basic, err.Error())
		return
	}
	row, err := store.ConsumeOAuthCode(r.Context(), tx, code)
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

	// The code carries the access token signed at sign-in. It says who and
	// which farm; the session is issued now, with a refresh token, from the
	// membership as it stands.
	claims, err := s.signer.Parse(row.AccessToken)
	if err != nil {
		oauthTokenError(w, "invalid_grant", "code expired")
		return
	}
	user, err := store.FindUserByID(r.Context(), tx, claims.Subject)
	if err != nil {
		oauthTokenError(w, "invalid_grant", "that account no longer exists")
		return
	}
	if err := tenant.SetUser(r.Context(), tx, user.ID); err != nil {
		writeError(w, r, err)
		return
	}
	m, err := store.GetMembership(r.Context(), tx, claims.FarmID, user.ID)
	if err != nil || m.SuspendedAt != nil {
		oauthTokenError(w, "invalid_grant", "that account no longer has access to this farm")
		return
	}
	session, err := s.issueSessionFor(r, tx, user, m, "", newID(), &row.ClientID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	scope := row.Scope
	if scope == "" {
		scope = oauthScope
	}
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
		oauthTokenError(w, "invalid_request", "malformed form")
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	if id, secret, basic := oauthClientCredentials(r); id != "" {
		if _, err := oauthAuthenticateClient(r, tx, id, secret); err != nil {
			oauthClientError(w, basic, err.Error())
			return
		}
	}
	token := r.Form.Get("token")
	if token == "" {
		oauthTokenError(w, "invalid_request", "token is required")
		return
	}
	if r.Form.Get("token_type_hint") != "access_token" {
		tok, err := store.FindRefreshToken(r.Context(), tx, auth.HashToken(token))
		if err == nil {
			if err := store.RevokeFamily(r.Context(), tx, tok.FamilyID); err != nil {
				writeError(w, r, err)
				return
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, r, err)
			return
		}
	}
	w.WriteHeader(http.StatusOK)
}

func oauthTokenError(w http.ResponseWriter, code, desc string) {
	allowCORS(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error":             code,
		"error_description": desc,
	})
}

// oauthRegisterError is RFC 7591 §3.2.2: a 400 with error and
// error_description, the shape registration clients parse and show.
func oauthRegisterError(w http.ResponseWriter, code, desc string) {
	allowCORS(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error":             code,
		"error_description": desc,
	})
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
</style>`

// oauthForm renders the sign-in page. client is nil until the request names a
// registered client; from then on the page says which application is asking
// and which site the code goes to, because registration is open and a
// stranger can register a client of their own.
func (s *Server) oauthForm(w http.ResponseWriter, r *http.Request, q url.Values, notice string, pick *oauthPick, client *store.OAuthClient) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// A password form must not be framed (clickjacking), and its URL carries
	// state and the PKCE challenge, which no Referer should repeat.
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	esc := html.EscapeString
	hidden := func(name string) string {
		v := q.Get(name)
		if v == "" {
			return ""
		}
		return `<input type="hidden" name="` + esc(name) + `" value="` + esc(v) + `">`
	}
	oauthParams := hidden("client_id") + hidden("redirect_uri") + hidden("state") +
		hidden("code_challenge") + hidden("code_challenge_method") + hidden("resource") +
		hidden("scope") + hidden("response_type")
	msg := ""
	if notice != "" {
		// Why the sign-in page came back instead of going on to the assistant
		// (wrong password, unknown client, ...). Never the password itself.
		slog.Warn("oauth sign-in page notice", "notice", notice, "client_id", q.Get("client_id"))
		msg = `<p class="err">` + esc(notice) + `</p>`
	}
	if client != nil {
		dest := q.Get("redirect_uri")
		if u, err := url.Parse(dest); err == nil && u.Host != "" {
			dest = u.Host
		}
		msg = `<p class="who">Aplicación: <strong>` + esc(client.Name) + `</strong><br>` +
			`Le devolverá el acceso a: <strong>` + esc(dest) + `</strong></p>` +
			`<p class="warn">Si no reconoce ese sitio, no escriba su contraseña.</p>` + msg
	}
	head := `<!doctype html>
<html lang="es">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Conectar Báscula</title>
` + oauthFormStyle + `
<h1>Conectar Báscula a un asistente</h1>
`
	if pick != nil {
		var opts strings.Builder
		for i, m := range pick.Farms {
			checked := ""
			if i == 0 {
				checked = " checked"
			}
			name := strings.TrimSpace(m.FarmName)
			if name == "" {
				name = m.FarmSlug
			}
			slug := ""
			if m.FarmSlug != "" {
				slug = `<span class="slug">` + esc(m.FarmSlug) + `.bascula.engp.io</span>`
			}
			fmt.Fprintf(&opts, `<label class="opt"><input type="radio" name="farm_id" value="%s"%s><span>%s%s</span></label>
`, esc(m.FarmID), checked, esc(name), slug)
		}
		_, _ = fmt.Fprintf(w, `%s<p>Su cuenta tiene varias fincas. Elija cuál va a usar el asistente.</p>
%s
<form method="post" action="/oauth/authorize">
  %s<input type="hidden" name="ticket" value="%s">
  <fieldset>
    <legend>Finca</legend>
    %s
  </fieldset>
  <button type="submit">Continuar</button>
</form>
`, head, msg, oauthParams, esc(pick.Ticket), opts.String())
		return
	}

	farmLine := ""
	if slug := farmSlugFromHost(r); slug != "" {
		name := slug
		if s.pool != nil {
			var dn *string
			if err := s.pool.QueryRow(r.Context(), `SELECT farm_display_name($1)`, slug).Scan(&dn); err == nil && dn != nil && *dn != "" {
				name = *dn
			}
		}
		farmLine = `<p class="farm">Finca: <strong>` + esc(name) + `</strong></p>`
	}
	_, _ = fmt.Fprintf(w, `%s<p>Entre con la misma cuenta de la finca. El asistente podrá <strong>consultar y registrar</strong> cosecha y nómina con los permisos de su rol. Pagos, anticipos, liquidaciones y cambios de precio siempre le piden su confirmación antes de hacerse.</p>
%s%s
<form method="post" action="/oauth/authorize">
  %s
  <label class="f" for="email">Correo</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="%s">
  <label class="f" for="password">Contraseña</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Autorizar</button>
</form>
`, head, farmLine, msg, oauthParams, esc(q.Get("email")))
}
