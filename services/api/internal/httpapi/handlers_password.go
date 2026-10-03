// SPDX-License-Identifier: MIT

package httpapi

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// Changing a password.
//
// Until this file a password could not be changed at all, by anybody: there
// was no endpoint, and /olvide-mi-clave sent people to a screen that cannot do
// it. Two doors now:
//
//   - POST /v1/me/password, signed in, with the current password. It needs no
//     mail and works everywhere.
//   - "Olvidé mi clave": POST /v1/auth/password-reset/request mails a link,
//     POST /v1/auth/password-reset spends it. Only where a mailer is
//     configured AND PUBLIC_BASE_URL is set; see passwordResetAvailable.
//
// Both end the same way: every other session of the account is closed, and
// the address is told its password changed (when there is a mailer).

// minPasswordLength is the floor signup and invite already use.
const minPasswordLength = 10

// passwordResetTTL is how long a mailed link works. Long enough to find the
// email on a phone in the field, short enough that an old inbox is not a key.
const passwordResetTTL = 30 * time.Minute

func checkNewPassword(p string) error {
	if len(p) < minPasswordLength {
		return domain.BadRequest("the new password must be at least 10 characters")
	}
	// Refused before the hash, like login does. See auth.MaxPasswordLength.
	if len(p) > auth.MaxPasswordLength {
		return domain.BadRequest(msgPasswordTooLong)
	}
	return nil
}

type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
	DeviceID        string `json:"deviceId"`
}

// POST /v1/me/password
//
// The password changed is the one that opens THIS farm: the farm's own owner
// password where it has one (farm_owner_credentials, see farmsUnlockedBy),
// otherwise the account's. Changing the account's from inside one farm is the
// same act as typing it on the login screen, which already opens all of them.
//
// A wrong current password counts as a failed sign-in and is limited like
// one. Without that, a session left open on a shared phone would be a place to
// guess the password at full speed, and the password is worth more than the
// session: it opens the farm from anywhere.
//
// The answer is a fresh session. Every other one is closed, so the device that
// made the change would otherwise be signed out by its own success.
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var req changePasswordRequest
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	if len(req.CurrentPassword) > auth.MaxPasswordLength {
		writeError(w, r, domain.BadRequest(msgPasswordTooLong))
		return
	}
	if err := checkNewPassword(req.NewPassword); err != nil {
		writeError(w, r, err)
		return
	}
	p, _ := auth.PrincipalFrom(r.Context())
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
	farmOwn, ok := s.checkCurrentPassword(w, r, tx, p, user, req.CurrentPassword)
	if !ok {
		return
	}

	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		writeError(w, r, domain.Internal("could not hash the password").WithCause(err))
		return
	}
	if farmOwn {
		err = store.SetFarmOwnerCredentialHash(r.Context(), tx, p.FarmID, p.UserID, hash)
	} else {
		err = store.SetUserPasswordHash(r.Context(), tx, p.UserID, hash)
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	// This farm's sessions go now, in this transaction; the row policy keeps
	// a request pinned to one farm from reaching the others.
	if err := store.RevokeUserSessions(r.Context(), tx, p.FarmID, p.UserID); err != nil {
		writeError(w, r, err)
		return
	}
	m, err := store.GetMembership(r.Context(), tx, p.FarmID, p.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	session, err := s.issueSession(r, tx, user, m, req.DeviceID, newID(), store.SignInPassword)
	if err != nil {
		writeError(w, r, err)
		return
	}
	// The account's password opens the user's other farms too, so their
	// sessions go as well — after this transaction, on a connection with no
	// farm pinned. A farm's own owner password opens only this farm.
	if !farmOwn {
		s.revokeSessionsElsewhere(r, p.UserID, p.FarmID)
	}
	s.mailLater(r, passwordChangedMessage(user.Email, user.Name, m.FarmName))
	writeJSON(w, http.StatusOK, session)
}

// GET /v1/auth/password-reset
//
// Whether "olvidé mi clave" can send a link here. Public: the screen that
// asks has nobody signed in.
func (s *Server) handlePasswordResetInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"available": s.passwordResetAvailable()})
}

// passwordResetAvailable: a mailer to send the link, and a configured public
// address to put in it. The second is not optional. Without PUBLIC_BASE_URL
// the only address there is to build a link from is the request's own Host,
// and a link built from a header the caller chose is a stranger asking for
// your reset link to be addressed to their site.
func (s *Server) passwordResetAvailable() bool {
	return s.cfg.Mailer != nil && strings.TrimSpace(s.cfg.PublicBaseURL) != ""
}

// passwordResetBase is the origin the link points at: the address the person
// asked from when it is this deployment's own (the apex or a farm under it),
// otherwise PUBLIC_BASE_URL.
func (s *Server) passwordResetBase(r *http.Request) string {
	base := strings.TrimRight(s.cfg.PublicBaseURL, "/")
	u, err := url.Parse(base)
	if err != nil || u.Hostname() == "" {
		return base
	}
	apex := strings.ToLower(u.Hostname())
	host := strings.ToLower(requestHostname(r))
	// The host comes from X-Forwarded-Host or Host, both of which the caller
	// writes. A suffix check is not enough: "evil.com?.bascula.engp.io" ends
	// in ".bascula.engp.io" and turns the mailed link into
	// https://evil.com?.bascula.engp.io/restablecer-clave#SECRET, so a genuine
	// Báscula email hands the secret to a stranger's page. Only the apex or
	// exactly one DNS label in front of it (a farm address) is accepted.
	if host != apex {
		label, ok := strings.CutSuffix(host, "."+apex)
		if !ok || !dnsLabel.MatchString(label) {
			return base
		}
	}
	if u.Port() != "" {
		host += ":" + u.Port()
	}
	return u.Scheme + "://" + host
}

// dnsLabel is one lowercase DNS label: what a farm slug looks like.
var dnsLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

type passwordResetRequest struct {
	Email string `json:"email"`
}

// POST /v1/auth/password-reset/request
//
// Always 202, for an address with an account and for one without: an answer
// that differed would be a way to ask which addresses have accounts. The mail
// goes out after the response, so the clock does not say it either.
//
// The limit is per address and per caller, and it applies to both kinds of
// address alike for the same reason. A refused request is not counted (see
// windowLimiter), so knocking on a shut door does not keep it shut.
func (s *Server) handleRequestPasswordReset(w http.ResponseWriter, r *http.Request) {
	if !s.passwordResetAvailable() {
		writeError(w, r, domain.NotFound("password reset by email is not available here"))
		return
	}
	var req passwordResetRequest
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" || len(email) > 320 || !strings.Contains(email, "@") {
		writeError(w, r, domain.BadRequest("email is required"))
		return
	}
	now := time.Now()
	if !s.resetsByIP.allow(rateLimitBucket(clientIP(r)), now) || !s.resetsByEmail.allow(email, now) {
		writeError(w, r, domain.Coded(http.StatusTooManyRequests, domain.CodeRateLimited,
			"too many reset requests; try again later"))
		return
	}
	accepted := map[string]any{"requested": true}

	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	user, err := store.FindUserByEmail(r.Context(), tx, email)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusAccepted, accepted)
		return
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	secret, err := newResetSecret()
	if err != nil {
		writeError(w, r, domain.Internal("could not mint a reset link").WithCause(err))
		return
	}
	if err := store.InsertPasswordReset(r.Context(), tx, newID(), user.ID,
		auth.HashToken(secret), now.Add(passwordResetTTL)); err != nil {
		writeError(w, r, err)
		return
	}
	// The secret travels in the fragment: browsers do not send it to the
	// server or in a Referer, so it stays out of access logs.
	link := s.passwordResetBase(r) + "/restablecer-clave#" + secret
	s.mailLater(r, passwordResetMessage(user.Email, user.Name, link))
	if s.cfg.DevEcho {
		// Development only, like signup's verification token; the server
		// refuses to start with DevEcho on outside development.
		accepted["resetToken"] = secret
	}
	writeJSON(w, http.StatusAccepted, accepted)
}

type passwordResetSpend struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

// POST /v1/auth/password-reset
//
// Spends a mailed link and sets the new password. Holding the link is proof
// the address is the caller's, which is the one thing signup never had, so
// this also:
//
//   - drops the farm-specific passwords (farm_owner_credentials). They exist
//     only because an unproven address could have been registered by somebody
//     else first, or was handed a farm password by an administrator with an
//     invite; after a reset, the new password opens all of the person's
//     farms, the invited ones included — the farm was given to the address,
//     and the address has just been proved. Whoever held the handed-over
//     password without owning the mailbox loses that farm, which is the point
//     (see handleInviteUser).
//   - marks the address verified.
//   - closes every session of the account, on every farm. The request has no
//     farm pinned, so the row policy reaches all of them.
//
// It does not sign the person in. They go to the login screen and type the
// new password, which is also how they find out it works.
func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	if !s.passwordResetAvailable() {
		writeError(w, r, domain.NotFound("password reset by email is not available here"))
		return
	}
	var req passwordResetSpend
	if err := decode(r, &req); err != nil {
		writeError(w, r, err)
		return
	}
	if err := checkNewPassword(req.Password); err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	userID, err := store.ConsumePasswordReset(r.Context(), tx, auth.HashToken(strings.TrimSpace(req.Token)))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, domain.BadRequest("that reset link is not valid any more"))
		return
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeError(w, r, domain.Internal("could not hash the password").WithCause(err))
		return
	}
	if err := tenant.SetUser(r.Context(), tx, userID); err != nil {
		writeError(w, r, err)
		return
	}
	var removedPasskeys int64
	for _, step := range []func() error{
		func() error { return store.SetUserPasswordHash(r.Context(), tx, userID, hash) },
		func() error { return store.DropFarmOwnerCredentials(r.Context(), tx, userID) },
		func() error { return store.VerifyUserEmail(r.Context(), tx, userID) },
		func() error { return store.RevokeAllUserSessions(r.Context(), tx, userID, "") },
		// A passkey opens the account without the password and outlives a
		// password change. Somebody who once had a session (and the password,
		// which adding one asks for) could plant one, and the owner resetting
		// from the email would have closed nothing. The mailbox proved who
		// the account belongs to; every way in now starts from that.
		func() (err error) {
			removedPasskeys, err = store.DeleteAllPasskeys(r.Context(), tx, userID)
			return err
		},
	} {
		if err := step(); err != nil {
			writeError(w, r, err)
			return
		}
	}
	user, err := store.FindUserByID(r.Context(), tx, userID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	msg := passwordChangedMessage(user.Email, user.Name, "")
	if removedPasskeys > 0 {
		msg.Body = strings.Replace(msg.Body, "se cerraron.",
			"se cerraron, y se quitaron las llaves de acceso (huella o cara) de la cuenta: si las usaba, agréguelas de nuevo desde Conexiones.", 1)
	}
	s.mailLater(r, msg)
	writeJSON(w, http.StatusNoContent, nil)
}

// newResetSecret is 32 random bytes, base64url: URL-safe without escaping.
func newResetSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// checkCurrentPassword asks the caller to prove they know the password that
// opens THIS farm (the farm's own owner password where it has one, otherwise
// the account's) before something worth more than the session. A wrong
// password counts as a failed sign-in and is limited like one. It writes the
// error itself and answers ok=false when the request must stop; farmOwn says
// which of the two passwords it was.
func (s *Server) checkCurrentPassword(w http.ResponseWriter, r *http.Request, tx pgx.Tx, p *auth.Principal, user *store.User, password string) (farmOwn, ok bool) {
	if len(password) > auth.MaxPasswordLength {
		writeError(w, r, domain.BadRequest(msgPasswordTooLong))
		return false, false
	}
	email := strings.ToLower(user.Email)
	ip := clientIP(r)
	byPair, byIP, err := store.CountLoginFailures(r.Context(), tx, email, ip, s.cfg.LoginFailureWindow)
	if err != nil {
		writeError(w, r, err)
		return false, false
	}
	if byPair >= s.cfg.LoginFailuresPerEmailPerIP || byIP >= s.cfg.LoginFailuresPerIP {
		s.loginRefused(ip, email, "current-password")
		writeError(w, r, domain.Coded(http.StatusTooManyRequests, domain.CodeRateLimited,
			"too many failed attempts; try again later"))
		return false, false
	}

	farmHash, farmOwn, err := store.FarmOwnerCredentialHash(r.Context(), tx, p.FarmID, p.UserID)
	if err != nil {
		writeError(w, r, err)
		return false, false
	}
	current := user.PasswordHash
	if farmOwn {
		current = farmHash
	}
	if ok, err := auth.VerifyPassword(password, current); err != nil || !ok {
		// The failure is kept although the answer is an error; nothing else
		// has been written yet. See refuse in handleLogin.
		s.loginRefused(ip, email, "current-password")
		if err := store.RecordLoginFailure(r.Context(), tx, newID(), ip, email); err != nil {
			writeError(w, r, domain.Internal("could not record the failed attempt").WithCause(err))
			return false, false
		}
		tenant.KeepChanges(r.Context())
		// 403, not 401: the session is fine, the password typed is not. A
		// 401 means "this token is no good" to every client, which then
		// refreshes, asks again (a second counted failure) and signs out.
		writeError(w, r, domain.Coded(http.StatusForbidden, domain.CodeInvalidCredentials,
			"the current password is not correct"))
		return false, false
	}
	return farmOwn, true
}
