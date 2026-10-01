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
}

func passkeyViewOf(p store.Passkey) passkeyView {
	return passkeyView{ID: p.ID, Name: p.Name, CreatedAt: p.CreatedAt, LastUsedAt: p.LastUsedAt}
}

// ── managing one's own passkeys ──────────────────────────────────────────

// handleListPasskeys lists the caller's passkeys for the address they are on.
// A passkey made on another farm's address is not usable here, so it is not
// shown here either.
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
	list, err := store.ListPasskeys(r.Context(), tx, p.UserID, rpID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	out := make([]passkeyView, 0, len(list))
	for _, pk := range list {
		out = append(out, passkeyViewOf(pk))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// handlePasskeyRegisterOptions starts adding a passkey to the caller's account.
func (s *Server) handlePasskeyRegisterOptions(w http.ResponseWriter, r *http.Request) {
	p, _ := auth.PrincipalFrom(r.Context())
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
		writeError(w, r, domain.Internal("passkeys are misconfigured").WithCause(err))
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
		writeError(w, r, domain.Internal("passkeys are misconfigured").WithCause(err))
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
	writeJSON(w, http.StatusCreated, passkeyViewOf(pk))
}

// handleDeletePasskey removes one of the caller's passkeys. Somebody else's
// id answers 404, the same as an id that does not exist.
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
	ok, err := store.DeletePasskey(r.Context(), tx, p.UserID, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if !ok {
		writeError(w, r, domain.NotFound("passkey not found"))
		return
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
		writeError(w, r, domain.Internal("passkeys are misconfigured").WithCause(err))
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
	invalid := domain.Coded(http.StatusUnauthorized, domain.CodeInvalidCredentials,
		"the passkey was not accepted")
	ip := clientIP(r)

	// The same limiter as the password door, on its per-IP axis: there is no
	// email to count against, and a failed passkey is recorded with none.
	_, failedForIP, err := store.CountLoginFailures(r.Context(), tx, "", ip, s.cfg.LoginFailureWindow)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if failedForIP >= s.cfg.LoginFailuresPerIP {
		writeError(w, r, domain.Coded(http.StatusTooManyRequests, domain.CodeRateLimited,
			"too many failed sign-in attempts; try again later"))
		return
	}
	refuse := func() {
		if err := store.RecordLoginFailure(r.Context(), tx, newID(), ip, ""); err != nil {
			writeError(w, r, domain.Internal(
				"could not record the failed sign-in").WithCause(err))
			return
		}
		tenant.KeepChanges(r.Context())
		writeError(w, r, invalid)
	}

	sd, err := s.openPasskeySession(sealPasskeyLogin, req.Challenge, rp)
	if err != nil {
		refuse()
		return
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(req.Credential)
	if err != nil {
		refuse()
		return
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
		writeError(w, r, domain.Internal("passkeys are misconfigured").WithCause(err))
		return
	}
	_, cred, err := wa.ValidatePasskeyLogin(lookup, *sd, parsed)
	if err != nil || found == nil || user == nil {
		refuse()
		return
	}
	// A signature counter that went backwards means the key may have been
	// copied off the authenticator. Refused, not merely logged.
	if cred.Authenticator.CloneWarning {
		refuse()
		return
	}

	// Single use: a recorded answer is never accepted twice, and the row is
	// written in this transaction, so a refusal further down undoes it and
	// leaves the challenge usable for the farm choice that follows.
	challengeHash := sha256.Sum256([]byte(sd.Challenge))
	first, err := store.ConsumePasskeyChallenge(r.Context(), tx, challengeHash[:], sd.Expires)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if !first {
		refuse()
		return
	}

	if err := tenant.SetUser(r.Context(), tx, user.ID); err != nil {
		writeError(w, r, err)
		return
	}
	all, err := store.ListMemberships(r.Context(), tx, user.ID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	memberships, err := farmsUnlockedByPasskey(r, tx, user.ID, found, all)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if user.EmailVerifiedAt == nil {
		writeError(w, r, domain.Coded(http.StatusForbidden, domain.CodeEmailNotVerified,
			"verify the email address before opening a session"))
		return
	}
	if len(memberships) == 0 {
		writeError(w, r, domain.Forbidden("this passkey opens no farm; sign in with the password"))
		return
	}

	pinnedID, err := loginFarmPin(r.Context(), tx, r, req.FarmSlug)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if pinnedID != "" && req.FarmID != "" && pinnedID != req.FarmID {
		writeError(w, r, domain.BadRequest("farmId does not match the host"))
		return
	}
	if pinnedID != "" {
		req.FarmID = pinnedID
	}

	var chosen *store.Membership
	switch {
	case req.FarmID != "":
		for i := range memberships {
			if memberships[i].FarmID == req.FarmID {
				chosen = &memberships[i]
			}
		}
		if chosen == nil {
			writeError(w, r, domain.Forbidden("this passkey does not open that farm"))
			return
		}
	case len(memberships) == 1:
		chosen = &memberships[0]
	default:
		farms := make([]map[string]any, 0, len(memberships))
		for _, m := range memberships {
			farms = append(farms, map[string]any{
				"id": m.FarmID, "name": m.FarmName, "slug": m.FarmSlug, "role": m.Role,
			})
		}
		writeError(w, r, domain.BadRequest("choose a farm").
			WithDetails(map[string]any{"farms": farms}))
		return
	}
	if chosen.SuspendedAt != nil {
		writeError(w, r, domain.Coded(http.StatusForbidden, domain.CodeFarmSuspended,
			"that farm is suspended"))
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
	session, err := s.issueSession(r, tx, user, chosen, req.DeviceID, newID())
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
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
