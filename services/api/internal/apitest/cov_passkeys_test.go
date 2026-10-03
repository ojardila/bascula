// SPDX-License-Identifier: MIT

package apitest

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// The passkey ceremonies' corners that the other passkey tests leave out: the
// Origin header that is not an address, a sealed challenge that is stale,
// garbled or made for another address, an answer whose credential does not
// match what the server holds, the same account on two hosts, a deployment
// with a public address, and every database call failing in turn on the
// public sign-in door.

const (
	cpkFarmOrigin = "http://finca.localhost:5173"
	// cpkBadDomainOrigin passes the Origin checks (a subdomain of localhost)
	// but is not a valid WebAuthn relying party id: it has an empty label.
	cpkBadDomainOrigin = "http://a..localhost:5173"
	cpkLogin           = "/v1/auth/passkeys/login"
	cpkLoginOptions    = "/v1/auth/passkeys/login/options"
	cpkRegister        = "/v1/me/passkeys"
	cpkRegisterOptions = "/v1/me/passkeys/options"
)

// cpkSealRaw seals payload the way the server does, with the suite's key.
func cpkSealRaw(purpose string, payload []byte) string {
	return auth.NewSigner([]byte("test-signing-key"), "bascula").Seal(purpose, payload)
}

// cpkSeal seals ceremony state as the server would have handed it out.
func cpkSeal(t *testing.T, purpose string, sd webauthn.SessionData) string {
	t.Helper()
	raw, err := json.Marshal(sd)
	if err != nil {
		t.Fatal(err)
	}
	return cpkSealRaw(purpose, raw)
}

func cpkChallenge() string {
	c := make([]byte, 32)
	_, _ = rand.Read(c)
	return b64.EncodeToString(c)
}

// cpkLoginSession is a sign-in challenge for origin, valid for d (negative:
// already expired).
func cpkLoginSession(origin, rpID string, d time.Duration) webauthn.SessionData {
	return webauthn.SessionData{
		Challenge: cpkChallenge(), RelyingPartyID: rpID, Origin: origin,
		Expires: time.Now().Add(d), UserVerification: "required",
	}
}

// cpkOptionsFor is the part of the server's options the soft authenticator
// reads, for a challenge sealed by the test itself.
func cpkOptionsFor(sd webauthn.SessionData) map[string]any {
	return map[string]any{"publicKey": map[string]any{
		"challenge": sd.Challenge,
		"rp":        map[string]any{"id": sd.RelyingPartyID},
		"user":      map[string]any{"id": b64.EncodeToString(sd.UserID)},
	}}
}

func cpkUserHandle(t *testing.T, userID string) []byte {
	t.Helper()
	id, err := uuid.Parse(userID)
	if err != nil {
		t.Fatal(err)
	}
	return id[:]
}

func (h *harness) cpkLoginFailures(t *testing.T, ip string) int {
	t.Helper()
	var n int
	if err := h.admin.QueryRow(context.Background(),
		`SELECT count(*) FROM login_failures WHERE ip = $1::inet AND email = ''`, ip).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (h *harness) cpkPasskeyCount(t *testing.T, userID string) int {
	t.Helper()
	var n int
	if err := h.admin.QueryRow(context.Background(),
		`SELECT count(*) FROM passkeys WHERE user_id = $1`, userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// cpkReq is one request cpkCall sends: who it comes from (ip, Origin,
// Host), what it asks for, and the bearer token and JSON body, if any.
type cpkReq struct {
	ip, origin, host string
	method, path     string
	token            string
	body             any
}

// cpkCall sends one request to srv with an Origin header and a Host.
func cpkCall(t *testing.T, srv http.Handler, r cpkReq) response {
	t.Helper()
	ip, origin, host, token := r.ip, r.origin, r.host, r.token
	raw := ""
	if r.body != nil {
		b, err := json.Marshal(r.body)
		if err != nil {
			t.Fatal(err)
		}
		raw = string(b)
	}
	req := httptest.NewRequest(r.method, r.path, strings.NewReader(raw))
	req.RemoteAddr = ip + ":12345"
	if host != "" {
		req.Host = host
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	out := response{Status: rec.Code, Raw: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &out.Body)
	return out
}

// cpkReplayedLogin posts a passkey sign-in once per database call it makes,
// each run failing a later call, then for real.
func (h *harness) cpkReplayedLogin(t *testing.T, ip, origin string, body map[string]any) response {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, cpkLogin, strings.NewReader(string(raw)))
	req.RemoteAddr = ip + ":12345"
	req.Header.Set("Origin", origin)
	req.Header.Set("Content-Type", "application/json")
	rec := h.serveReplayed(req, string(raw))
	out := response{Status: rec.Code, Raw: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &out.Body)
	return out
}

func cpkExpectCode(t *testing.T, what string, res response, status int, code string) {
	t.Helper()
	if res.Status != status || (code != "" && res.code() != code) {
		t.Fatalf("%s: got %d %q want %d %q: %s", what, res.Status, res.code(), status, code, res.Raw)
	}
}

// An Origin that is not a plain browser address gets no ceremony, on either
// door; neither does a body that is not JSON.
func TestCpkPasskeyRequestShapeRefusals(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de origenes raros", 80000)

	for _, origin := range []string{
		"http://usuario@localhost:5173", // credentials in the origin
		"http://localhost:5173/ruta",    // a path is not an origin
		"https://exa mple.localhost",    // not a URL
		"ftp://localhost:5173",          // not http(s)
		"http://finca.example:5173",     // plain http off localhost
	} {
		cpkExpectCode(t, "login options from "+origin,
			h.doOrigin(t, "10.74.0.1", origin, http.MethodPost, cpkLoginOptions, "", nil), http.StatusBadRequest, "")
	}

	cpkExpectCode(t, "sign-in with no Origin", h.doOrigin(t, "10.74.0.2", "", http.MethodPost, cpkLogin, "",
		map[string]any{"challenge": "x", "credential": map[string]any{}}), http.StatusBadRequest, "")
	cpkExpectCode(t, "sign-in body that is not an object", h.doOrigin(t, "10.74.0.2", passkeyOrigin,
		http.MethodPost, cpkLogin, "", "no-es-json"), http.StatusBadRequest, "")
	if n := h.cpkLoginFailures(t, "10.74.0.2"); n != 0 {
		t.Fatalf("a malformed request is not a failed sign-in, yet %d were recorded", n)
	}

	cpkExpectCode(t, "register options with no Origin", h.doOrigin(t, "10.74.0.3", "", http.MethodPost,
		cpkRegisterOptions, f.OwnerToken, reauth), http.StatusBadRequest, "")
	cpkExpectCode(t, "register options body that is not an object", h.doOrigin(t, "10.74.0.3", passkeyOrigin,
		http.MethodPost, cpkRegisterOptions, f.OwnerToken, []int{1}), http.StatusBadRequest, "")
	cpkExpectCode(t, "register with no Origin", h.doOrigin(t, "10.74.0.3", "", http.MethodPost, cpkRegister,
		f.OwnerToken, map[string]any{"challenge": "x", "credential": map[string]any{}}), http.StatusBadRequest, "")
	cpkExpectCode(t, "register body that is not an object", h.doOrigin(t, "10.74.0.3", passkeyOrigin,
		http.MethodPost, cpkRegister, f.OwnerToken, "no-es-json"), http.StatusBadRequest, "")
	if n := h.cpkPasskeyCount(t, f.OwnerUserID); n != 0 {
		t.Fatalf("refused registrations left %d passkeys", n)
	}
}

// A sealed sign-in challenge the server did not make, or made and let expire,
// or made for another address, proves nothing: 401, counted for the limiter.
func TestCpkPasskeySignInRefusesBadSeals(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de sellos viejos", 80000)
	key := newSoftPasskey(t)
	h.registerPasskey(t, f.OwnerToken, key)

	answer := func(ip, challenge string, sd webauthn.SessionData) response {
		return h.doOrigin(t, ip, passkeyOrigin, http.MethodPost, cpkLogin, "", map[string]any{
			"challenge": challenge, "credential": key.get(t, cpkOptionsFor(sd), passkeyOrigin),
		})
	}

	expired := cpkLoginSession(passkeyOrigin, "localhost", -time.Minute)
	noExpiry := cpkLoginSession(passkeyOrigin, "localhost", 0)
	noExpiry.Expires = time.Time{}
	fresh := cpkLoginSession(passkeyOrigin, "localhost", time.Minute)
	otherHost := cpkLoginSession(cpkFarmOrigin, "finca.localhost", time.Minute)
	otherOrigin := cpkLoginSession("http://localhost:9999", "localhost", time.Minute)

	cases := []struct {
		name, ip, challenge string
		sd                  webauthn.SessionData
	}{
		{"an expired challenge", "10.74.1.1", cpkSeal(t, "passkey-login", expired), expired},
		{"a challenge with no expiry", "10.74.1.2", cpkSeal(t, "passkey-login", noExpiry), noExpiry},
		{"a seal that is not ceremony state", "10.74.1.3", cpkSealRaw("passkey-login", []byte("no es json")), fresh},
		{"a registration seal", "10.74.1.4", cpkSeal(t, "passkey-register", fresh), fresh},
		{"a challenge for another host", "10.74.1.5", cpkSeal(t, "passkey-login", otherHost), otherHost},
		{"a challenge for another port", "10.74.1.6", cpkSeal(t, "passkey-login", otherOrigin), otherOrigin},
	}
	for _, c := range cases {
		cpkExpectCode(t, c.name, answer(c.ip, c.challenge, c.sd), http.StatusUnauthorized, "INVALID_CREDENTIALS")
		if n := h.cpkLoginFailures(t, c.ip); n != 1 {
			t.Fatalf("%s: %d failures recorded, want 1", c.name, n)
		}
	}

	// The control: the same forging, done right, signs in — the refusals above
	// are about the seal, not about a test-made challenge.
	res := answer("10.74.1.7", cpkSeal(t, "passkey-login", fresh), fresh)
	cpkExpectCode(t, "a well-formed seal", res, http.StatusOK, "")
	if res.Body["farmId"] != f.FarmID {
		t.Fatalf("signed into the wrong farm: %s", res.Raw)
	}
}

// The answer is signed, but what it names does not match what the server
// holds: another address's passkey, another account's handle, no handle, or a
// stored record the server cannot read.
func TestCpkPasskeySignInRefusesMismatchedAnswers(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de respuestas cruzadas", 80000)
	key := newSoftPasskey(t)
	h.registerPasskey(t, f.OwnerToken, key)

	signIn := func(ip, origin string, k *softPasskey) response {
		opts := h.doOrigin(t, ip, origin, http.MethodPost, cpkLoginOptions, "", nil)
		expectStatus(t, "options at "+origin, opts, http.StatusOK)
		return h.doOrigin(t, ip, origin, http.MethodPost, cpkLogin, "", map[string]any{
			"challenge": opts.Body["challenge"], "credential": k.get(t, opts.Body, origin),
		})
	}

	// Registered on localhost, offered on the farm's address: the browser
	// would never do it, and the server must not accept it either.
	cpkExpectCode(t, "a passkey of another address", signIn("10.74.2.1", cpkFarmOrigin, key),
		http.StatusUnauthorized, "INVALID_CREDENTIALS")

	// A challenge asked for on one address, answered on another.
	opts := h.doOrigin(t, "10.74.2.2", cpkFarmOrigin, http.MethodPost, cpkLoginOptions, "", nil)
	expectStatus(t, "options on the farm address", opts, http.StatusOK)
	cpkExpectCode(t, "a challenge carried to another address", h.doOrigin(t, "10.74.2.2", passkeyOrigin,
		http.MethodPost, cpkLogin, "", map[string]any{
			"challenge": opts.Body["challenge"], "credential": key.get(t, opts.Body, passkeyOrigin),
		}), http.StatusUnauthorized, "INVALID_CREDENTIALS")

	other := h.signupFarm(t, "Finca de otro usuario", 80000)
	impostor := *key
	impostor.userHandle = cpkUserHandle(t, other.OwnerUserID)
	cpkExpectCode(t, "the owner's credential under another user's handle", signIn("10.74.2.3", passkeyOrigin, &impostor),
		http.StatusUnauthorized, "INVALID_CREDENTIALS")

	blank := *key
	blank.userHandle = nil
	cpkExpectCode(t, "an answer with no user handle", signIn("10.74.2.4", passkeyOrigin, &blank),
		http.StatusUnauthorized, "INVALID_CREDENTIALS")

	for _, ip := range []string{"10.74.2.1", "10.74.2.2", "10.74.2.3", "10.74.2.4"} {
		if n := h.cpkLoginFailures(t, ip); n != 1 {
			t.Fatalf("refusal from %s: %d failures recorded, want 1", ip, n)
		}
	}

	// The real key still works: none of the above spent or damaged it.
	key.count = impostor.count
	if blank.count > key.count {
		key.count = blank.count
	}
	cpkExpectCode(t, "the owner's own answer", signIn("10.74.2.5", passkeyOrigin, key), http.StatusOK, "")

	// A stored record the server cannot decode refuses rather than guesses.
	broken := newSoftPasskey(t)
	h.registerPasskey(t, f.OwnerToken, broken)
	adminExec(t, h, `UPDATE passkeys SET record = '"roto"'::jsonb WHERE credential_id = $1`, broken.credID)
	cpkExpectCode(t, "a passkey whose stored record is unreadable", signIn("10.74.2.6", passkeyOrigin, broken),
		http.StatusUnauthorized, "INVALID_CREDENTIALS")
}

// A registration challenge is bound to the address and expiry it was sealed
// with, and the credential to the origin it was made on. None of the refusals
// leaves a passkey behind.
func TestCpkPasskeyRegistrationRefusals(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de registros fallidos", 80000)
	register := func(origin string, body map[string]any) response {
		return h.doOrigin(t, "10.74.3.1", origin, http.MethodPost, cpkRegister, f.OwnerToken, body)
	}

	opts := h.doOrigin(t, "10.74.3.1", passkeyOrigin, http.MethodPost, cpkRegisterOptions, f.OwnerToken, reauth)
	expectStatus(t, "options", opts, http.StatusOK)
	cpkExpectCode(t, "a challenge carried to the farm's address", register(cpkFarmOrigin, map[string]any{
		"challenge": opts.Body["challenge"], "credential": newSoftPasskey(t).create(t, opts.Body, cpkFarmOrigin),
	}), http.StatusBadRequest, "")
	cpkExpectCode(t, "a credential made for another site", register(passkeyOrigin, map[string]any{
		"challenge": opts.Body["challenge"], "credential": newSoftPasskey(t).create(t, opts.Body, "http://evil.localhost:5173"),
	}), http.StatusBadRequest, "")

	handle := cpkUserHandle(t, f.OwnerUserID)
	for name, sd := range map[string]webauthn.SessionData{
		"an expired challenge": {Challenge: cpkChallenge(), RelyingPartyID: "localhost", Origin: passkeyOrigin,
			UserID: handle, Expires: time.Now().Add(-time.Minute)},
		"a challenge with no expiry": {Challenge: cpkChallenge(), RelyingPartyID: "localhost", Origin: passkeyOrigin,
			UserID: handle},
	} {
		cpkExpectCode(t, name, register(passkeyOrigin, map[string]any{
			"challenge": cpkSeal(t, "passkey-register", sd), "credential": newSoftPasskey(t).create(t, cpkOptionsFor(sd), passkeyOrigin),
		}), http.StatusBadRequest, "")
	}
	cpkExpectCode(t, "a seal that is not ceremony state", register(passkeyOrigin, map[string]any{
		"challenge": cpkSealRaw("passkey-register", []byte("[]")), "credential": map[string]any{},
	}), http.StatusBadRequest, "")

	if n := h.cpkPasskeyCount(t, f.OwnerUserID); n != 0 {
		t.Fatalf("refused registrations left %d passkeys", n)
	}

	// The exclusion list: a second passkey's options name the first.
	h.registerPasskey(t, f.OwnerToken, newSoftPasskey(t))
	again := h.doOrigin(t, "10.74.3.1", passkeyOrigin, http.MethodPost, cpkRegisterOptions, f.OwnerToken, reauth)
	expectStatus(t, "options with one passkey", again, http.StatusOK)
	pk, _ := again.Body["publicKey"].(map[string]any)
	if ex, _ := pk["excludeCredentials"].([]any); len(ex) != 1 {
		t.Fatalf("options should exclude the passkey already held: %s", again.Raw)
	}
}

// An Origin whose host is not a well-formed DNS name (an empty label) is a
// bad Origin like any other: 400 on every door since #405, before it can
// reach go-webauthn as a relying party id (where it used to surface as a
// 500). It opens nothing and stores nothing.
func TestCpkPasskeyInvalidRelyingPartyID(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de dominio invalido", 80000)
	const rpID = "a..localhost"

	cpkExpectCode(t, "login options", h.doOrigin(t, "10.74.4.1", cpkBadDomainOrigin, http.MethodPost,
		cpkLoginOptions, "", nil), http.StatusBadRequest, "BAD_REQUEST")
	cpkExpectCode(t, "register options", h.doOrigin(t, "10.74.4.1", cpkBadDomainOrigin, http.MethodPost,
		cpkRegisterOptions, f.OwnerToken, reauth), http.StatusBadRequest, "BAD_REQUEST")

	reg := webauthn.SessionData{Challenge: cpkChallenge(), RelyingPartyID: rpID, Origin: cpkBadDomainOrigin,
		UserID: cpkUserHandle(t, f.OwnerUserID), Expires: time.Now().Add(time.Minute)}
	cpkExpectCode(t, "register", h.doOrigin(t, "10.74.4.1", cpkBadDomainOrigin, http.MethodPost, cpkRegister,
		f.OwnerToken, map[string]any{
			"challenge":  cpkSeal(t, "passkey-register", reg),
			"credential": newSoftPasskey(t).create(t, cpkOptionsFor(reg), cpkBadDomainOrigin),
		}), http.StatusBadRequest, "BAD_REQUEST")
	if n := h.cpkPasskeyCount(t, f.OwnerUserID); n != 0 {
		t.Fatalf("an invalid relying party stored %d passkeys", n)
	}

	key := newSoftPasskey(t)
	key.rpID, key.userHandle = rpID, cpkUserHandle(t, f.OwnerUserID)
	login := cpkLoginSession(cpkBadDomainOrigin, rpID, time.Minute)
	res := h.doOrigin(t, "10.74.4.2", cpkBadDomainOrigin, http.MethodPost, cpkLogin, "", map[string]any{
		"challenge": cpkSeal(t, "passkey-login", login), "credential": key.get(t, cpkOptionsFor(login), cpkBadDomainOrigin),
	})
	cpkExpectCode(t, "sign-in", res, http.StatusBadRequest, "BAD_REQUEST")
	if _, ok := res.Body["accessToken"]; ok {
		t.Fatalf("an invalid relying party opened a session: %s", res.Raw)
	}
}

// Every passkey on the account is listed and removable from any of its
// addresses; Here says which one the caller is on.
func TestCpkPasskeyListAndDeleteAcrossHosts(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de dos direcciones", 80000)
	id := mustString(t, h.registerPasskey(t, f.OwnerToken, newSoftPasskey(t)), "id")

	list := h.doOrigin(t, "10.74.5.1", cpkFarmOrigin, http.MethodGet, cpkRegister, f.OwnerToken, nil)
	expectStatus(t, "list from the farm address", list, http.StatusOK)
	items, _ := list.Body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("the farm address should list the localhost passkey: %s", list.Raw)
	}
	item := items[0].(map[string]any)
	if item["host"] != "localhost" || item["here"] != false || item["id"] != id {
		t.Fatalf("host/here of a passkey on another address: %s", list.Raw)
	}
	cpkExpectCode(t, "list with a foreign Origin", h.doOrigin(t, "10.74.5.1", "https://evil.example",
		http.MethodGet, cpkRegister, f.OwnerToken, nil), http.StatusBadRequest, "")

	expectStatus(t, "delete from the farm address", h.doOrigin(t, "10.74.5.1", cpkFarmOrigin, http.MethodDelete,
		cpkRegister+"/"+id, f.OwnerToken, nil), http.StatusNoContent)
	if n := h.cpkPasskeyCount(t, f.OwnerUserID); n != 0 {
		t.Fatalf("the passkey is still stored: %d", n)
	}
	expectStatus(t, "deleting it twice", h.doOrigin(t, "10.74.5.1", cpkFarmOrigin, http.MethodDelete,
		cpkRegister+"/"+id, f.OwnerToken, nil), http.StatusNotFound)
}

// A passkey made in a farm-password session opens its farm even for an
// account whose address was never proved: that farm's password is what the
// passkey stands for.
func TestCpkPinnedPasskeyOpensItsFarmForAnUnverifiedAddress(t *testing.T) {
	h := requireDB(t)
	home := h.signupFarm(t, "Finca sin correo probado", 80000)
	locked := h.signupFarm(t, "Finca con su clave", 80000)
	adminExec(t, h, `INSERT INTO memberships (farm_id, user_id, role) VALUES ($1, $2, 'admin')`,
		locked.FarmID, home.OwnerUserID)
	hash, err := auth.HashPassword(claveDeLaFinca)
	if err != nil {
		t.Fatal(err)
	}
	adminExec(t, h, `INSERT INTO farm_owner_credentials (farm_id, user_id, name, phone, password_hash)
		VALUES ($1, $2, 'Dueña', '', $3)`, locked.FarmID, home.OwnerUserID, hash)
	login := h.do(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": home.OwnerEmail, "password": claveDeLaFinca, "farmId": locked.FarmID,
	})
	expectStatus(t, "farm-password sign-in", login, http.StatusOK)
	scoped := mustString(t, login.Body, "accessToken")

	pinned := newSoftPasskey(t)
	opts := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, cpkRegisterOptions, scoped,
		map[string]any{"currentPassword": claveDeLaFinca})
	expectStatus(t, "options", opts, http.StatusOK)
	expectStatus(t, "register", h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, cpkRegister, scoped,
		map[string]any{"challenge": opts.Body["challenge"], "credential": pinned.create(t, opts.Body, passkeyOrigin)}),
		http.StatusCreated)
	var only string
	if err := h.admin.QueryRow(context.Background(),
		`SELECT only_farm_id::text FROM passkeys WHERE credential_id = $1`, pinned.credID).Scan(&only); err != nil {
		t.Fatal(err)
	}
	if only != locked.FarmID {
		t.Fatalf("the passkey is pinned to %q, want the farm %q", only, locked.FarmID)
	}

	adminExec(t, h, `UPDATE users SET email_verified_at = NULL WHERE id = $1`, home.OwnerUserID)
	res := h.passkeyLogin(t, "10.74.6.1", pinned, nil)
	if res.Status != http.StatusOK || res.Body["farmId"] != locked.FarmID {
		t.Fatalf("the pinned passkey on an unverified address: %d %s", res.Status, res.Raw)
	}
	var used *time.Time
	if err := h.admin.QueryRow(context.Background(),
		`SELECT last_used_at FROM passkeys WHERE credential_id = $1`, pinned.credID).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if used == nil {
		t.Fatal("a sign-in did not mark the passkey used")
	}
}

// With PUBLIC_BASE_URL set, the relying party is that host or one of its
// farm subdomains, over https; nothing else, not even localhost.
func TestCpkPasskeyRelyingPartyUnderPublicBaseURL(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de direccion publica", 80000)
	srv, _ := mailServer(t, h)

	for origin, want := range map[string]int{
		"https://bascula.example.com":         http.StatusOK,
		"https://finca.bascula.example.com":   http.StatusOK,
		"https://bascula.example.com.evil.io": http.StatusBadRequest,
		"https://notbascula.example.com":      http.StatusBadRequest,
		"http://localhost:5173":               http.StatusBadRequest,
		"http://finca.bascula.example.com":    http.StatusBadRequest,
		"https://[2001:db8::1]":               http.StatusBadRequest,
	} {
		res := cpkCall(t, srv, cpkReq{ip: "10.74.7.1", origin: origin, method: http.MethodPost, path: cpkLoginOptions})
		cpkExpectCode(t, "login options from "+origin, res, want, "")
		if want == http.StatusOK {
			pk, _ := res.Body["publicKey"].(map[string]any)
			if wantID := strings.TrimPrefix(origin, "https://"); pk["rpId"] != wantID {
				t.Fatalf("relying party for %s: %s", origin, res.Raw)
			}
		}
	}
	// A same-origin GET carries no Origin: the host it came to stands in.
	cpkExpectCode(t, "list on a farm subdomain", cpkCall(t, srv, cpkReq{ip: "10.74.7.1", host: "finca.bascula.example.com",
		method: http.MethodGet, path: cpkRegister, token: f.OwnerToken}), http.StatusOK, "")
	cpkExpectCode(t, "list on another domain", cpkCall(t, srv, cpkReq{ip: "10.74.7.1", host: "bascula.example.org",
		method: http.MethodGet, path: cpkRegister, token: f.OwnerToken}), http.StatusBadRequest, "")

	// A PUBLIC_BASE_URL with no host is the operator's mistake, not the
	// visitor's: 500, and no challenge.
	for _, base := range []string{"https://", "http://[::1"} {
		cfg := httpapi.DefaultConfig()
		cfg.DevEcho = true
		cfg.UploadDir = t.TempDir()
		cfg.PublicBaseURL = base
		broken := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)
		cpkExpectCode(t, "PUBLIC_BASE_URL "+base, cpkCall(t, broken, cpkReq{ip: "10.74.7.2", origin: "https://bascula.example.com",
			method: http.MethodPost, path: cpkLoginOptions}), http.StatusInternalServerError, "")
	}
}

// The public sign-in door is left out of the suite-wide fault replay (it
// counts failures in memory); here it gets it, request by request: a
// sign-in, a farm choice, a pinned passkey on an unverified address, and a
// refusal whose failure row cannot be written. Every injected failure is
// rolled back, so each real request still answers as it would have.
func TestCpkPasskeySignInSurvivesFaults(t *testing.T) {
	if !faultReplayOn() {
		t.Skip("API_FAULT_REPLAY=0")
	}
	h := requireDB(t)
	a := h.signupFarm(t, "Finca uno de fallas", 80000)
	b := h.signupFarm(t, "Finca dos de fallas", 80000)
	h.addOwner(t, b.FarmID, a.OwnerUserID)
	key := newSoftPasskey(t)
	h.registerPasskey(t, a.OwnerToken, key)

	answer := func(ip string, extra map[string]any) map[string]any {
		opts := h.passkeyOptions(t, ip)
		body := map[string]any{"challenge": opts["challenge"], "credential": key.get(t, opts, passkeyOrigin)}
		for k, v := range extra {
			body[k] = v
		}
		return body
	}

	choose := h.cpkReplayedLogin(t, "10.74.8.1", passkeyOrigin, answer("10.74.8.1", nil))
	cpkExpectCode(t, "two farms and none named", choose, http.StatusBadRequest, "")
	if !strings.Contains(choose.Raw, a.FarmID) || !strings.Contains(choose.Raw, b.FarmID) {
		t.Fatalf("the choice should list both farms: %s", choose.Raw)
	}

	body := answer("10.74.8.2", map[string]any{"farmSlug": h.farmSlug(t, b.FarmID)})
	ok := h.cpkReplayedLogin(t, "10.74.8.2", passkeyOrigin, body)
	if ok.Status != http.StatusOK || ok.Body["farmId"] != b.FarmID {
		t.Fatalf("sign-in after the fault replay: %d %s", ok.Status, ok.Raw)
	}
	// The same answer again is a replay: refused and counted, and its own
	// fault runs include the one where the failure row cannot be written.
	again := h.cpkReplayedLogin(t, "10.74.8.2", passkeyOrigin, body)
	cpkExpectCode(t, "the same answer twice", again, http.StatusUnauthorized, "INVALID_CREDENTIALS")
	if n := h.cpkLoginFailures(t, "10.74.8.2"); n != 1 {
		t.Fatalf("the replayed answer recorded %d failures, want 1", n)
	}
	if n := h.cpkLoginFailures(t, "10.250.0.1"); n != 0 {
		t.Fatalf("the fault runs left %d failure rows behind", n)
	}

	// A pinned passkey on an unverified address (farm-scoped memberships).
	hash, err := auth.HashPassword(claveDeLaFinca)
	if err != nil {
		t.Fatal(err)
	}
	adminExec(t, h, `INSERT INTO farm_owner_credentials (farm_id, user_id, name, phone, password_hash)
		VALUES ($1, $2, 'Dueño', '', $3)`, b.FarmID, a.OwnerUserID, hash)
	login := h.do(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": a.OwnerEmail, "password": claveDeLaFinca, "farmId": b.FarmID,
	})
	expectStatus(t, "farm-password sign-in", login, http.StatusOK)
	pinned := newSoftPasskey(t)
	scoped := mustString(t, login.Body, "accessToken")
	opts := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, cpkRegisterOptions, scoped,
		map[string]any{"currentPassword": claveDeLaFinca})
	expectStatus(t, "options", opts, http.StatusOK)
	expectStatus(t, "register pinned", h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, cpkRegister, scoped,
		map[string]any{"challenge": opts.Body["challenge"], "credential": pinned.create(t, opts.Body, passkeyOrigin)}),
		http.StatusCreated)
	adminExec(t, h, `UPDATE users SET email_verified_at = NULL WHERE id = $1`, a.OwnerUserID)
	popts := h.passkeyOptions(t, "10.74.8.3")
	res := h.cpkReplayedLogin(t, "10.74.8.3", passkeyOrigin, map[string]any{
		"challenge": popts["challenge"], "credential": pinned.get(t, popts, passkeyOrigin),
	})
	if res.Status != http.StatusOK || res.Body["farmId"] != b.FarmID {
		t.Fatalf("pinned sign-in after the fault replay: %d %s", res.Status, res.Raw)
	}
	// And the account's passkey on that unverified address opens nothing.
	cpkExpectCode(t, "unpinned passkey, unverified address",
		h.cpkReplayedLogin(t, "10.74.8.4", passkeyOrigin, answer("10.74.8.4", nil)),
		http.StatusForbidden, "EMAIL_NOT_VERIFIED")
}
