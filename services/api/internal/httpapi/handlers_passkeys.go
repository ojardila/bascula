// SPDX-License-Identifier: MIT

package httpapi

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// Passkeys (WebAuthn): an optional way to sign in without typing the
// password. Migration 00041 has the table and the reasoning about rp_id and
// only_farm_id; this file has the ceremonies.
//
// # What a passkey can open
//
// Exactly what the password could, minus anything guarded by a farm's own
// owner password: the session goes through the same farm choice, the same
// host pin, the same suspended check and the same issueSession as handleLogin.
// A passkey added from a session on a farm with its own owner password is
// pinned to that farm (only_farm_id), because that session proved that
// password; any other passkey opens only the farms the account password opens.
//
// # Challenges without server state
//
// The ceremony state (go-webauthn's SessionData: challenge, rp id, origin,
// expiry, and for registration the user it is for) travels to the client
// sealed with the signing key and comes back with the answer. Asking for a
// sign-in challenge therefore writes nothing, which matters on a door anybody
// can knock on. What a seal cannot give is single use, so a successful sign-in
// records the challenge in passkey_used_challenges and a second one with the
// same challenge is refused. Registration needs no such table: it already
// runs under a session, and the credential id is unique.
//
// # The relying party is the host the person is on
//
// Every farm address ({slug}.bascula.engp.io) and the apex are separate
// relying parties. The browser's Origin decides which one, and it has to be
// PUBLIC_BASE_URL's host or a subdomain of it — never an arbitrary site.

const (
	passkeyTimeout       = 5 * time.Minute
	passkeyNameMaxLength = 60

	sealPasskeyRegister = "passkey-register"
	sealPasskeyLogin    = "passkey-login"
)

// passkeyRP is the relying party a request speaks to.
type passkeyRP struct {
	ID     string // host name, no port
	Origin string // scheme://host[:port], as the browser sent it
}

// passkeyRPFor reads the relying party from the browser's Origin header and
// refuses any origin this deployment does not serve. Without PUBLIC_BASE_URL
// (development) only localhost is accepted.
func (s *Server) passkeyRPFor(r *http.Request) (passkeyRP, error) {
	bad := domain.BadRequest("passkeys need a browser on this site's address")
	raw := strings.TrimSpace(r.Header.Get("Origin"))
	u, err := url.Parse(raw)
	if raw == "" || err != nil || u.Host == "" || u.Path != "" || u.User != nil {
		return passkeyRP{}, bad
	}
	host := strings.ToLower(u.Hostname())
	scheme := strings.ToLower(u.Scheme)
	switch {
	case scheme == "https":
	case scheme == "http" && isLocalHostname(host):
	default:
		return passkeyRP{}, bad
	}
	if err := s.passkeyHostAllowed(host); err != nil {
		return passkeyRP{}, err
	}
	return passkeyRP{ID: host, Origin: scheme + "://" + strings.ToLower(u.Host)}, nil
}

// passkeyRPIDFor is the relying party id alone, for reads that run no
// ceremony. A browser sends no Origin on a same-origin GET, so the host the
// request came to stands in for it, under the same rules.
func (s *Server) passkeyRPIDFor(r *http.Request) (string, error) {
	if strings.TrimSpace(r.Header.Get("Origin")) != "" {
		rp, err := s.passkeyRPFor(r)
		return rp.ID, err
	}
	host := strings.ToLower(requestHostname(r))
	if err := s.passkeyHostAllowed(host); err != nil {
		return "", err
	}
	return host, nil
}

func isLocalHostname(host string) bool {
	return host == "localhost" || strings.HasSuffix(host, ".localhost")
}

// passkeyHostAllowed accepts PUBLIC_BASE_URL's host and its subdomains, or
// only localhost in development (no PUBLIC_BASE_URL). Never a bare IP:
// WebAuthn has no relying party for one.
func (s *Server) passkeyHostAllowed(host string) error {
	bad := domain.BadRequest("passkeys need a browser on this site's address")
	if host == "" || net.ParseIP(host) != nil {
		return bad
	}
	if base := strings.TrimSpace(s.cfg.PublicBaseURL); base != "" {
		b, err := url.Parse(base)
		if err != nil || b.Hostname() == "" {
			return domain.Internal("PUBLIC_BASE_URL is not a URL")
		}
		apex := strings.ToLower(b.Hostname())
		if host != apex && !strings.HasSuffix(host, "."+apex) {
			return bad
		}
	} else if !isLocalHostname(host) {
		return bad
	}
	return nil
}

func (rp passkeyRP) webauthn() (*webauthn.WebAuthn, error) {
	return webauthn.New(&webauthn.Config{
		RPID:          rp.ID,
		RPDisplayName: "Báscula",
		RPOrigins:     []string{rp.Origin},
		Timeouts: webauthn.TimeoutsConfig{
			Login:        webauthn.TimeoutConfig{Enforce: true, Timeout: passkeyTimeout, TimeoutUVD: passkeyTimeout},
			Registration: webauthn.TimeoutConfig{Enforce: true, Timeout: passkeyTimeout, TimeoutUVD: passkeyTimeout},
		},
	})
}

// passkeyUser adapts an account to go-webauthn. The user handle is the
// account's UUID as 16 bytes: stable, opaque, and not the email.
type passkeyUser struct {
	user  *store.User
	creds []webauthn.Credential
}

func (u passkeyUser) WebAuthnID() []byte {
	id, err := uuid.Parse(u.user.ID)
	if err != nil {
		return []byte(u.user.ID)
	}
	return id[:]
}
func (u passkeyUser) WebAuthnName() string                       { return u.user.Email }
func (u passkeyUser) WebAuthnDisplayName() string                { return u.user.Name }
func (u passkeyUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

func (s *Server) sealPasskeySession(purpose string, sd *webauthn.SessionData) (string, error) {
	raw, err := json.Marshal(sd)
	if err != nil {
		return "", err
	}
	return s.signer.Seal(purpose, raw), nil
}

// openPasskeySession returns the ceremony state if the seal is this server's,
// for this purpose, for this relying party, and not expired.
func (s *Server) openPasskeySession(purpose, sealed string, rp passkeyRP) (*webauthn.SessionData, error) {
	raw, err := s.signer.Open(purpose, sealed)
	if err != nil {
		return nil, err
	}
	var sd webauthn.SessionData
	if err := json.Unmarshal(raw, &sd); err != nil {
		return nil, err
	}
	if sd.Expires.IsZero() || time.Now().After(sd.Expires) {
		return nil, errors.New("passkey challenge expired")
	}
	if sd.RelyingPartyID != rp.ID || sd.Origin != rp.Origin {
		return nil, errors.New("passkey challenge is for another address")
	}
	return &sd, nil
}

func decodePasskeyRecord(p store.Passkey) (webauthn.Credential, error) {
	var c webauthn.Credential
	err := json.Unmarshal(p.Record, &c)
	return c, err
}

type passkeyView struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	// Host is the address the passkey works on; Here says whether that is
	// the address the caller is on.
	Host string `json:"host"`
	Here bool   `json:"here"`
}

func passkeyViewOf(p store.Passkey) passkeyView {
	return passkeyView{ID: p.ID, Name: p.Name, CreatedAt: p.CreatedAt, LastUsedAt: p.LastUsedAt, Host: p.RPID}
}

// ── managing one's own passkeys ──────────────────────────────────────────

// handleListPasskeys lists every passkey on the caller's account, each with
// the address it works on. Listing only this address's hid the rest: a
// passkey somebody planted on the main domain could not be seen, let alone
// removed, from the farm's address where the owner manages their account.
func (s *Server) handleListPasskeys(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.PrincipalFrom(r.Context())
	rpID, err := s.passkeyRPIDFor(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	list, err := passkeysThisSessionReaches(r, tx, p)
	if err != nil {
		writeError(w, r, err)
		return
	}
	out := make([]passkeyView, 0, len(list))
	for _, pk := range list {
		v := passkeyViewOf(pk)
		v.Here = pk.RPID == rpID
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

type passkeyRegisterOptionsRequest struct {
	CurrentPassword string `json:"currentPassword"`
}

// handlePasskeyRegisterOptions starts adding a passkey to the caller's account.
//
// It asks for the current password first. A passkey outlives the session that
// made it and survives a password change, so without this a stolen access
// token (a phone left open, a token copied out of a browser) could register
// its own passkey and keep the account after the owner changed the password.
// The check is the same as «Cambiar clave»: a wrong password is a counted,
// rate-limited failed sign-in.
func (s *Server) handlePasskeyRegisterOptions(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.PrincipalFrom(r.Context())
	var req passkeyRegisterOptionsRequest
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	if req.CurrentPassword == "" {
		writeError(w, r, domain.BadRequest("currentPassword is required"))
		return
	}
	rp, err := s.passkeyRPFor(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	user, err := store.FindUserByID(r.Context(), tx, p.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if _, ok := s.checkCurrentPassword(w, r, tx, p, user, req.CurrentPassword); !ok {
		return
	}
	existing, err := store.ListPasskeys(r.Context(), tx, p.UserID, rp.ID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	// The phone is told which passkeys it already holds for this account, so
	// it says so instead of making a second one.
	exclude := make([]protocol.CredentialDescriptor, 0, len(existing))
	for _, pk := range existing {
		exclude = append(exclude, protocol.CredentialDescriptor{
			Type: protocol.PublicKeyCredentialType, CredentialID: pk.CredentialID,
		})
	}
	wa, err := rp.webauthn()
	if err != nil {
		writeError(w, r, domain.Internal(msgPasskeysMisconfigured).WithCause(err))
		return
	}
	creation, sd, err := wa.BeginRegistration(passkeyUser{user: user},
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
		webauthn.WithExclusions(exclude),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
		webauthn.WithRegistrationOrigin(rp.Origin),
	)
	if err != nil {
		writeError(w, r, domain.Internal("could not start the passkey").WithCause(err))
		return
	}
	sealed, err := s.sealPasskeySession(sealPasskeyRegister, sd)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge": sealed,
		"publicKey": creation.Response,
	})
}

type passkeyRegisterRequest struct {
	Challenge  string          `json:"challenge"`
	Credential json.RawMessage `json:"credential"`
	Name       string          `json:"name"`
}

// handlePasskeyRegister finishes adding a passkey.
func (s *Server) handlePasskeyRegister(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.PrincipalFrom(r.Context())
	var req passkeyRegisterRequest
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Llave de acceso"
	}
	if utf8.RuneCountInString(name) > passkeyNameMaxLength {
		writeError(w, r, domain.BadRequest("the passkey name is too long"))
		return
	}
	rp, err := s.passkeyRPFor(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	invalid := domain.BadRequest("the passkey could not be verified; try again")
	sd, err := s.openPasskeySession(sealPasskeyRegister, req.Challenge, rp)
	if err != nil {
		writeError(w, r, invalid.WithCause(err))
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	user, err := store.FindUserByID(r.Context(), tx, p.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	pu := passkeyUser{user: user}
	// The seal was made for somebody: it must be this caller.
	if string(sd.UserID) != string(pu.WebAuthnID()) {
		writeError(w, r, invalid)
		return
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(req.Credential)
	if err != nil {
		writeError(w, r, invalid.WithCause(err))
		return
	}
	wa, err := rp.webauthn()
	if err != nil {
		writeError(w, r, domain.Internal(msgPasskeysMisconfigured).WithCause(err))
		return
	}
	cred, err := wa.CreateCredential(pu, *sd, parsed)
	if err != nil {
		writeError(w, r, invalid.WithCause(err))
		return
	}
	record, err := json.Marshal(cred)
	if err != nil {
		writeError(w, r, err)
		return
	}

	// A session on a farm with its own owner password proved that password;
	// the passkey it adds opens that farm and nothing else. See 00041.
	var onlyFarm *string
	own, err := store.OwnerCredentialHashes(r.Context(), tx, p.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if _, locked := own[p.FarmID]; locked {
		farm := p.FarmID
		onlyFarm = &farm
	}

	pk := store.Passkey{
		ID: newID(), UserID: p.UserID, RPID: rp.ID, CredentialID: cred.ID,
		OnlyFarmID: onlyFarm, Name: name, Record: record,
	}
	if err := store.InsertPasskey(r.Context(), tx, pk); err != nil {
		if store.IsUniqueViolation(err, "ux_passkeys_credential") {
			writeError(w, r, domain.Conflict(domain.CodeConflict, "that passkey is already registered"))
			return
		}
		writeError(w, r, err)
		return
	}
	pk.CreatedAt = time.Now()
	s.mailLater(r, passkeyAddedMessage(user.Email, user.Name, name))
	v := passkeyViewOf(pk)
	v.Here = true // made just now, on this address
	writeJSON(w, http.StatusCreated, v)
}

// passkeysThisSessionReaches is every passkey on the account, unless the
// session was opened with this farm's own password (farmScopedSession). That
// password may have been handed over by the farm's administrator with an
// invite, so such a session sees and removes only the passkeys pinned to this
// farm — the ones a session like it made — and never the account's others.
func passkeysThisSessionReaches(r *http.Request, tx pgx.Tx, p *auth.Principal) ([]store.Passkey, error) {
	list, err := store.ListAllPasskeys(r.Context(), tx, p.UserID)
	if err != nil {
		return nil, err
	}
	scoped, err := farmScopedSession(r.Context(), tx, p)
	if err != nil || !scoped {
		return list, err
	}
	out := make([]store.Passkey, 0, len(list))
	for _, pk := range list {
		if pk.OnlyFarmID != nil && *pk.OnlyFarmID == p.FarmID {
			out = append(out, pk)
		}
	}
	return out, nil
}

// handleDeletePasskey removes one of the caller's passkeys. Somebody else's
// id answers 404, the same as an id that does not exist.
//
// Removing a passkey also closes the sessions it opened, on every farm, except
// the caller's own: the person removing the passkey of a lost phone expects
// that phone to be signed out, not to stay in for the rest of its sixty days.
func (s *Server) handleDeletePasskey(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.PrincipalFrom(r.Context())
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		writeError(w, r, domain.NotFound("passkey not found"))
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	reach, err := passkeysThisSessionReaches(r, tx, p)
	if err != nil {
		writeError(w, r, err)
		return
	}
	ok := false
	for _, pk := range reach {
		if pk.ID == id {
			ok = true
		}
	}
	if ok {
		ok, err = store.DeletePasskey(r.Context(), tx, p.UserID, id)
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	if !ok {
		writeError(w, r, domain.NotFound("passkey not found"))
		return
	}
	s.revokePasskeySessions(r, p.UserID, id, p.SessionID)
	if user, err := store.FindUserByID(r.Context(), tx, p.UserID); err == nil {
		s.mailLater(r, passkeyRemovedMessage(user.Email, user.Name))
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── signing in with one ──────────────────────────────────────────────────

// handlePasskeyLoginOptions hands out a sign-in challenge. It asks for no
// email: the phone offers whichever passkeys it holds for this address, so
// there is no "does this address have a passkey" question to answer.
func (s *Server) handlePasskeyLoginOptions(w http.ResponseWriter, r *http.Request) {
	rp, err := s.passkeyRPFor(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	wa, err := rp.webauthn()
	if err != nil {
		writeError(w, r, domain.Internal(msgPasskeysMisconfigured).WithCause(err))
		return
	}
	assertion, sd, err := wa.BeginDiscoverableLogin(
		webauthn.WithUserVerification(protocol.VerificationRequired),
		webauthn.WithLoginOrigin(rp.Origin))
	if err != nil {
		writeError(w, r, domain.Internal("could not start the passkey sign-in").WithCause(err))
		return
	}
	sealed, err := s.sealPasskeySession(sealPasskeyLogin, sd)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge": sealed,
		"publicKey": assertion.Response,
	})
}

type passkeyLoginRequest struct {
	Challenge  string          `json:"challenge"`
	Credential json.RawMessage `json:"credential"`
	FarmID     string          `json:"farmId"`
	FarmSlug   string          `json:"farmSlug"`
	DeviceID   string          `json:"deviceId"`
}

// handlePasskeyLogin is handleLogin with a passkey in place of the password.
// Everything after "who is this" is the same sequence; see handleLogin for
// why each step is where it is.
func (s *Server) handlePasskeyLogin(w http.ResponseWriter, r *http.Request) {
	var req passkeyLoginRequest
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	rp, err := s.passkeyRPFor(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	ip := clientIP(r)

	// The same limiter as the password door, on its per-IP axis: there is no
	// email to count against, and a failed passkey is recorded with none.
	_, failedForIP, err := store.CountLoginFailures(r.Context(), tx, "", ip, s.cfg.LoginFailureWindow)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if failedForIP >= s.cfg.LoginFailuresPerIP {
		s.loginRefused(ip, "", "passkey")
		writeError(w, r, domain.Coded(http.StatusTooManyRequests, domain.CodeRateLimited,
			"too many failed sign-in attempts; try again later"))
		return
	}

	found, user, cred, err := s.verifyPasskeyAnswer(r, tx, rp, req.Challenge, req.Credential)
	if errors.Is(err, errPasskeyRefused) {
		s.passkeyLoginRefuse(w, r, tx, ip)
		return
	}
	if err != nil {
		writeError(w, r, err)
		return
	}

	memberships, err := passkeyLoginMemberships(r, tx, user, found)
	if err != nil {
		writeError(w, r, err)
		return
	}
	chosen, err := passkeyLoginChooseFarm(r, tx, &req, memberships)
	if err != nil {
		writeError(w, r, err)
		return
	}

	record, err := json.Marshal(cred)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err := store.TouchPasskey(r.Context(), tx, found.ID, record); err != nil {
		writeError(w, r, err)
		return
	}
	method := store.SignInPasskey
	session, err := s.issueSessionFor(r, tx, user, chosen, req.DeviceID, newID(),
		familyGrant{Method: &method, PasskeyID: &found.ID})
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

// passkeyLoginRefuse answers a passkey that was not accepted, and records the
// failure (with no email) for the limiter. The failure row must survive the
// error response, hence KeepChanges.
func (s *Server) passkeyLoginRefuse(w http.ResponseWriter, r *http.Request, tx pgx.Tx, ip string) {
	s.loginRefused(ip, "", "passkey")
	if err := store.RecordLoginFailure(r.Context(), tx, newID(), ip, ""); err != nil {
		writeError(w, r, domain.Internal(
			"could not record the failed sign-in").WithCause(err))
		return
	}
	tenant.KeepChanges(r.Context())
	writeError(w, r, domain.Coded(http.StatusUnauthorized, domain.CodeInvalidCredentials,
		"the passkey was not accepted"))
}

// passkeyLoginMemberships is the memberships the passkey opens for user. It
// sets the transaction's user first, as handleLogin does.
func passkeyLoginMemberships(r *http.Request, tx pgx.Tx, user *store.User, found *store.Passkey) ([]store.Membership, error) {
	if err := tenant.SetUser(r.Context(), tx, user.ID); err != nil {
		return nil, err
	}
	all, err := store.ListMemberships(r.Context(), tx, user.ID)
	if err != nil {
		return nil, err
	}
	memberships, err := farmsUnlockedByPasskey(r, tx, user.ID, found, all)
	if err != nil {
		return nil, err
	}
	// The same rule as the password: an unproved address opens only farms of
	// its own password, which is where a passkey pinned to a farm came from.
	if user.EmailVerifiedAt == nil {
		if memberships, err = onlyFarmScoped(r.Context(), tx, user.ID, memberships); err != nil {
			return nil, err
		}
		if len(memberships) == 0 {
			return nil, domain.Coded(http.StatusForbidden, domain.CodeEmailNotVerified,
				"verify the email address before opening a session")
		}
	}
	if len(memberships) == 0 {
		return nil, domain.Forbidden("this passkey opens no farm; sign in with the password")
	}
	return memberships, nil
}

// passkeyLoginChooseFarm picks the farm to sign in to: the one the host pins,
// the one asked for, or the only one. It refuses a suspended farm. req.FarmID
// is set to the host's farm when the host pins one.
func passkeyLoginChooseFarm(r *http.Request, tx pgx.Tx, req *passkeyLoginRequest, memberships []store.Membership) (*store.Membership, error) {
	pinnedID, err := loginFarmPin(r.Context(), tx, r, req.FarmSlug)
	if err != nil {
		return nil, err
	}
	if pinnedID != "" && req.FarmID != "" && pinnedID != req.FarmID {
		return nil, domain.BadRequest("farmId does not match the host")
	}
	if pinnedID != "" {
		req.FarmID = pinnedID
	}

	var chosen *store.Membership
	switch {
	case req.FarmID != "":
		chosen = passkeyLoginFindFarm(memberships, req.FarmID)
		if chosen == nil {
			return nil, domain.Forbidden("this passkey does not open that farm")
		}
	case len(memberships) == 1:
		chosen = &memberships[0]
	default:
		return nil, passkeyLoginChooseAFarm(memberships)
	}
	if chosen.SuspendedAt != nil {
		return nil, domain.Coded(http.StatusForbidden, domain.CodeFarmSuspended,
			"that farm is suspended")
	}
	return chosen, nil
}

// passkeyLoginFindFarm is the membership of farmID (the last one, should
// there be more), or nil.
func passkeyLoginFindFarm(memberships []store.Membership, farmID string) *store.Membership {
	var chosen *store.Membership
	for i := range memberships {
		if memberships[i].FarmID == farmID {
			chosen = &memberships[i]
		}
	}
	return chosen
}

// passkeyLoginChooseAFarm is the error that asks the client to choose one of
// the farms the passkey opens, listed in its details.
func passkeyLoginChooseAFarm(memberships []store.Membership) error {
	farms := make([]map[string]any, 0, len(memberships))
	for _, m := range memberships {
		farms = append(farms, map[string]any{
			"id": m.FarmID, "name": m.FarmName, "slug": m.FarmSlug, "role": m.Role,
		})
	}
	return domain.BadRequest("choose a farm").
		WithDetails(map[string]any{"farms": farms})
}

// farmsUnlockedByPasskey is farmsUnlockedBy for a passkey: a passkey pinned
// to a farm opens that farm; any other opens the farms with no owner password
// of their own, which are the ones the account password opens.
func farmsUnlockedByPasskey(r *http.Request, tx pgx.Tx, userID string, pk *store.Passkey,
	memberships []store.Membership) ([]store.Membership, error) {
	if pk.OnlyFarmID != nil {
		out := []store.Membership{}
		for _, m := range memberships {
			if m.FarmID == *pk.OnlyFarmID {
				out = append(out, m)
			}
		}
		return out, nil
	}
	own, err := store.OwnerCredentialHashes(r.Context(), tx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]store.Membership, 0, len(memberships))
	for _, m := range memberships {
		if _, locked := own[m.FarmID]; !locked {
			out = append(out, m)
		}
	}
	return out, nil
}

// errPasskeyRefused is a passkey answer that does not prove anything: a
// stale or forged challenge, an unknown credential, a bad signature, a
// cloned key or a replay. Every door counts it as a failed sign-in.
var errPasskeyRefused = errors.New("the passkey was not accepted")

// verifyPasskeyAnswer checks a signed passkey sign-in answer for the relying
// party rp and spends its challenge: whose passkey it is, that it belongs to
// this address and that user, the signature, the counter, and single use.
// It is the part of a passkey sign-in that /v1/auth/passkeys/login and the
// OAuth sign-in page share; what the passkey then opens is the caller's.
//
// The challenge row is written in tx, so a refusal further down that rolls
// tx back leaves it usable again.
func (s *Server) verifyPasskeyAnswer(r *http.Request, tx pgx.Tx, rp passkeyRP,
	challenge string, credential []byte) (*store.Passkey, *store.User, *webauthn.Credential, error) {
	sd, err := s.openPasskeySession(sealPasskeyLogin, challenge, rp)
	if err != nil {
		return nil, nil, nil, errPasskeyRefused
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(credential)
	if err != nil {
		return nil, nil, nil, errPasskeyRefused
	}

	// The handler is how go-webauthn asks "whose credential is this": look it
	// up by id, check it belongs to this address and to the user the phone
	// named, and hand back the account with that one credential.
	var found *store.Passkey
	var user *store.User
	lookup := func(rawID, userHandle []byte) (webauthn.User, error) {
		pk, err := store.FindPasskeyByCredential(r.Context(), tx, rawID)
		if err != nil {
			return nil, err
		}
		if pk.RPID != rp.ID {
			return nil, errors.New("passkey belongs to another address")
		}
		u, err := store.FindUserByID(r.Context(), tx, pk.UserID)
		if err != nil {
			return nil, err
		}
		cred, err := decodePasskeyRecord(*pk)
		if err != nil {
			return nil, err
		}
		pu := passkeyUser{user: u, creds: []webauthn.Credential{cred}}
		if string(userHandle) != string(pu.WebAuthnID()) {
			return nil, errors.New("passkey user handle does not match")
		}
		found, user = pk, u
		return pu, nil
	}
	wa, err := rp.webauthn()
	if err != nil {
		return nil, nil, nil, domain.Internal(msgPasskeysMisconfigured).WithCause(err)
	}
	_, cred, err := wa.ValidatePasskeyLogin(lookup, *sd, parsed)
	if err != nil || found == nil || user == nil {
		return nil, nil, nil, errPasskeyRefused
	}
	// A signature counter that went backwards means the key may have been
	// copied off the authenticator. Refused, not merely logged.
	if cred.Authenticator.CloneWarning {
		return nil, nil, nil, errPasskeyRefused
	}

	// Single use: a recorded answer is never accepted twice, and the row is
	// written in this transaction, so a refusal further down undoes it and
	// leaves the challenge usable for the farm choice that follows.
	challengeHash := sha256.Sum256([]byte(sd.Challenge))
	first, err := store.ConsumePasskeyChallenge(r.Context(), tx, challengeHash[:], sd.Expires)
	if err != nil {
		return nil, nil, nil, err
	}
	if !first {
		return nil, nil, nil, errPasskeyRefused
	}
	return found, user, cred, nil
}
