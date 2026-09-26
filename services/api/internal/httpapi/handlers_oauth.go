package httpapi

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"net/url"
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
)

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
		"resource_documentation":   base + "/mcp",
	})
}

func (s *Server) handleOAuthAuthorizationServer(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	base := s.publicBase(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                base,
		"authorization_endpoint":                base + "/oauth/authorize",
		"token_endpoint":                        base + "/oauth/token",
		"registration_endpoint":                 base + "/oauth/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{oauthChallenge},
		"token_endpoint_auth_methods_supported": []string{"none"},
		"scopes_supported":                      []string{oauthScope},
	})
}

type oauthRegisterRequest struct {
	ClientName   string   `json:"client_name"`
	RedirectURIs []string `json:"redirect_uris"`
}

func (s *Server) handleOAuthRegister(w http.ResponseWriter, r *http.Request) {
	allowCORS(w)
	var req oauthRegisterRequest
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	if len(req.RedirectURIs) == 0 {
		writeError(w, r, domain.BadRequest("redirect_uris is required"))
		return
	}
	for _, u := range req.RedirectURIs {
		if err := oauthRedirectOK(u); err != nil {
			writeError(w, r, domain.BadRequest(err.Error()))
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
	name := strings.TrimSpace(req.ClientName)
	if name == "" {
		name = "mcp-client"
	}
	if err := store.InsertOAuthClient(r.Context(), tx, store.OAuthClient{
		ID: id, Name: name, RedirectURIs: req.RedirectURIs,
	}); err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id":                  id,
		"client_name":                name,
		"redirect_uris":              req.RedirectURIs,
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
		"code_challenge_methods":     []string{oauthChallenge},
	})
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
	if method == "" {
		method = oauthChallenge
	}

	failToClient := func(desc string) {
		if redirectURI == "" {
			s.oauthForm(w, q, desc, nil)
			return
		}
		u, err := url.Parse(redirectURI)
		if err != nil {
			s.oauthForm(w, q, desc, nil)
			return
		}
		qq := u.Query()
		qq.Set("error", "invalid_request")
		qq.Set("error_description", desc)
		if state != "" {
			qq.Set("state", state)
		}
		u.RawQuery = qq.Encode()
		http.Redirect(w, r, u.String(), http.StatusFound)
	}

	if clientID == "" || redirectURI == "" {
		s.oauthForm(w, q, "Faltan client_id o redirect_uri.", nil)
		return
	}
	if challenge == "" || method != oauthChallenge {
		failToClient("PKCE S256 is required")
		return
	}

	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	client, err := store.GetOAuthClient(r.Context(), tx, clientID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			s.oauthForm(w, q, "Cliente OAuth desconocido. Vuelva a registrar el conector.", nil)
			return
		}
		writeError(w, r, err)
		return
	}
	if !containsString(client.RedirectURIs, redirectURI) {
		s.oauthForm(w, q, "redirect_uri no coincide con el cliente registrado.", nil)
		return
	}

	if r.Method == http.MethodGet {
		s.oauthForm(w, q, "", nil)
		return
	}

	email := strings.ToLower(strings.TrimSpace(q.Get("email")))
	password := q.Get("password")
	farmID := strings.TrimSpace(q.Get("farm_id"))
	if email == "" || password == "" {
		s.oauthForm(w, q, "Correo y contraseña son obligatorios.", nil)
		return
	}

	user, chosen, ferr := s.oauthLogin(r, tx, email, password, farmID)
	if ferr != nil {
		s.oauthForm(w, q, ferr.Error(), nil)
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
	u.RawQuery = qq.Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

func (s *Server) oauthLogin(r *http.Request, tx pgx.Tx, email, password, farmID string) (*store.User, *store.Membership, error) {
	user, err := store.FindUserByEmail(r.Context(), tx, email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, err
	}
	hash := auth.DecoyHash()
	if user != nil {
		hash = user.PasswordHash
	}
	ok, err := auth.VerifyPassword(password, hash)
	if err != nil || !ok || user == nil {
		return nil, nil, fmt.Errorf("correo o contraseña incorrectos")
	}
	if user.EmailVerifiedAt == nil {
		return nil, nil, fmt.Errorf("verifique el correo antes de conectar un asistente")
	}
	if err := tenant.SetUser(r.Context(), tx, user.ID); err != nil {
		return nil, nil, err
	}
	memberships, err := store.ListMemberships(r.Context(), tx, user.ID)
	if err != nil {
		return nil, nil, err
	}
	if len(memberships) == 0 {
		return nil, nil, fmt.Errorf("esa cuenta no pertenece a ninguna finca")
	}
	// A farm address (cafin3.bascula.engp.io) names its farm, so an account
	// with several farms signing in there needs no UUID typed by hand.
	if farmID == "" && len(memberships) > 1 {
		if pinned, err := loginFarmPin(r.Context(), tx, r, ""); err == nil {
			farmID = pinned
		}
	}
	var chosen *store.Membership
	switch {
	case farmID != "":
		for i := range memberships {
			if memberships[i].FarmID == farmID {
				chosen = &memberships[i]
			}
		}
		if chosen == nil {
			return nil, nil, fmt.Errorf("esa cuenta no pertenece a esa finca")
		}
	case len(memberships) == 1:
		chosen = &memberships[0]
	default:
		return nil, nil, fmt.Errorf("esta cuenta tiene varias fincas; elija una")
	}
	if chosen.SuspendedAt != nil {
		return nil, nil, fmt.Errorf("esa finca está suspendida")
	}
	return user, chosen, nil
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
		session, err := s.rotateRefresh(r, tx, secret, "")
		if err != nil {
			oauthTokenError(w, "invalid_grant", "the refresh token is not valid; sign in again")
			return
		}
		writeOAuthSession(w, session)
	default:
		oauthTokenError(w, "unsupported_grant_type", "only authorization_code and refresh_token are supported")
	}
}

func (s *Server) oauthExchangeCode(w http.ResponseWriter, r *http.Request, tx pgx.Tx) {
	code := r.Form.Get("code")
	verifier := r.Form.Get("code_verifier")
	redirectURI := r.Form.Get("redirect_uri")
	clientID := r.Form.Get("client_id")
	if code == "" || verifier == "" || redirectURI == "" || clientID == "" {
		oauthTokenError(w, "invalid_request", "code, code_verifier, redirect_uri and client_id are required")
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
	writeOAuthSession(w, session)
}

func writeOAuthSession(w http.ResponseWriter, session *sessionResponse) {
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  session.AccessToken,
		"refresh_token": session.RefreshToken,
		"token_type":    "Bearer",
		"expires_in":    session.ExpiresIn,
		"scope":         oauthScope,
	})
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

func (s *Server) oauthForm(w http.ResponseWriter, q url.Values, notice string, _ any) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	esc := html.EscapeString
	hidden := func(name string) string {
		v := q.Get(name)
		if v == "" {
			return ""
		}
		return `<input type="hidden" name="` + esc(name) + `" value="` + esc(v) + `">`
	}
	msg := ""
	if notice != "" {
		msg = `<p class="err">` + esc(notice) + `</p>`
	}
	_, _ = fmt.Fprintf(w, `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar Báscula</title>
<style>
  body{font:16px/1.4 system-ui,sans-serif;max-width:28rem;margin:12vh auto;padding:0 1.25rem;color:#111}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{color:#444}
  label{display:block;margin:.75rem 0 .25rem;font-weight:600}
  input{width:100%%;box-sizing:border-box;padding:.5rem .6rem;font:inherit;border:1px solid #ccc;border-radius:6px}
  button{margin-top:1rem;padding:.6rem 1rem;font:inherit;background:#0a7;color:#fff;border:0;border-radius:6px;cursor:pointer}
  .err{color:#a30;background:#fee;padding:.5rem .75rem;border-radius:6px}
</style>
<h1>Conectar Báscula a un asistente</h1>
<p>Entre con la misma cuenta de la finca. El asistente podrá <strong>consultar y registrar</strong> cosecha y nómina con los permisos de su rol. Pagos, anticipos, liquidaciones y cambios de precio siempre le piden su confirmación antes de hacerse.</p>
%s
<form method="post" action="/oauth/authorize">
  %s%s%s%s%s%s
  <label for="email">Correo</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="%s">
  <label for="password">Contraseña</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <label for="farm_id">Finca (UUID, si tiene más de una)</label>
  <input id="farm_id" name="farm_id" value="%s" placeholder="se elige sola si solo hay una">
  <button type="submit">Autorizar</button>
</form>
`, msg,
		hidden("client_id"), hidden("redirect_uri"), hidden("state"),
		hidden("code_challenge"), hidden("code_challenge_method"), hidden("resource"),
		esc(q.Get("email")), esc(q.Get("farm_id")))
}
