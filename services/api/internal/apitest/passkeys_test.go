package apitest

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
)

// A software authenticator: what a phone's passkey does, minus the phone. It
// makes an ES256 key per credential, answers create() with "none"
// attestation and get() with a signature over authenticatorData and the
// client data hash, and counts signatures like a real one.

const passkeyOrigin = "http://localhost:5173"

var b64 = base64.RawURLEncoding

type softPasskey struct {
	key        *ecdsa.PrivateKey
	credID     []byte
	userHandle []byte
	rpID       string
	count      uint32
	// zeroCounter is how synced passkeys (iCloud Keychain, Google Password
	// Manager) behave: the counter is always 0, so it can never flag a copy
	// and only the single-use challenge stops a replay.
	zeroCounter bool
}

func newSoftPasskey(t *testing.T) *softPasskey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := make([]byte, 32)
	_, _ = rand.Read(id)
	return &softPasskey{key: key, credID: id}
}

func clientData(typ, challenge, origin string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": typ, "challenge": challenge, "origin": origin, "crossOrigin": false,
	})
	return raw
}

func authData(rpID string, flags byte, count uint32, attested []byte) []byte {
	rpHash := sha256.Sum256([]byte(rpID))
	out := append([]byte{}, rpHash[:]...)
	out = append(out, flags)
	c := make([]byte, 4)
	binary.BigEndian.PutUint32(c, count)
	out = append(out, c...)
	return append(out, attested...)
}

const (
	flagUP = 0x01
	flagUV = 0x04
	flagAT = 0x40
)

// create answers navigator.credentials.create for the given options.
func (p *softPasskey) create(t *testing.T, options map[string]any, origin string) map[string]any {
	t.Helper()
	pk := options["publicKey"].(map[string]any)
	rp := pk["rp"].(map[string]any)
	user := pk["user"].(map[string]any)
	p.rpID = rp["id"].(string)
	handle, err := b64.DecodeString(user["id"].(string))
	if err != nil {
		t.Fatalf("user.id is not base64url: %v", err)
	}
	p.userHandle = handle

	cose, err := webauthncbor.Marshal(map[int]any{
		1: 2, 3: -7, -1: 1,
		-2: p.key.PublicKey.X.FillBytes(make([]byte, 32)),
		-3: p.key.PublicKey.Y.FillBytes(make([]byte, 32)),
	})
	if err != nil {
		t.Fatal(err)
	}
	attested := make([]byte, 16) // AAGUID: zeroes, as "none" attestation allows
	l := make([]byte, 2)
	binary.BigEndian.PutUint16(l, uint16(len(p.credID)))
	attested = append(attested, l...)
	attested = append(attested, p.credID...)
	attested = append(attested, cose...)

	att, err := webauthncbor.Marshal(map[string]any{
		"fmt": "none", "attStmt": map[string]any{},
		"authData": authData(p.rpID, flagUP|flagUV|flagAT, 0, attested),
	})
	if err != nil {
		t.Fatal(err)
	}
	cd := clientData("webauthn.create", pk["challenge"].(string), origin)
	return map[string]any{
		"id": b64.EncodeToString(p.credID), "rawId": b64.EncodeToString(p.credID),
		"type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64.EncodeToString(cd),
			"attestationObject": b64.EncodeToString(att),
			"transports":        []string{"internal"},
		},
	}
}

// get answers navigator.credentials.get for the given options.
func (p *softPasskey) get(t *testing.T, options map[string]any, origin string) map[string]any {
	t.Helper()
	pk := options["publicKey"].(map[string]any)
	if !p.zeroCounter {
		p.count++
	}
	ad := authData(p.rpID, flagUP|flagUV, p.count, nil)
	cd := clientData("webauthn.get", pk["challenge"].(string), origin)
	cdHash := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, ad...), cdHash[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, p.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{
		"id": b64.EncodeToString(p.credID), "rawId": b64.EncodeToString(p.credID),
		"type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64.EncodeToString(cd),
			"authenticatorData": b64.EncodeToString(ad),
			"signature":         b64.EncodeToString(sig),
			"userHandle":        b64.EncodeToString(p.userHandle),
		},
	}
}

// doOrigin is doFrom with the browser's Origin header, which is what names
// the relying party.
func (h *harness) doOrigin(t *testing.T, ip, origin, method, path, token string, body any) response {
	t.Helper()
	reader := strings.NewReader("")
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = strings.NewReader(string(raw))
	}
	req := httptest.NewRequest(method, path, reader)
	req.RemoteAddr = ip + ":12345"
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	out := response{Status: rec.Code, Raw: rec.Body.String()}
	if out.Raw != "" {
		_ = json.Unmarshal([]byte(out.Raw), &out.Body)
	}
	return out
}

func (h *harness) registerPasskey(t *testing.T, token string, p *softPasskey) map[string]any {
	t.Helper()
	opts := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, "/v1/me/passkeys/options", token, nil)
	if opts.Status != http.StatusOK {
		t.Fatalf("register options: %d %s", opts.Status, opts.Raw)
	}
	res := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, "/v1/me/passkeys", token, map[string]any{
		"challenge": opts.Body["challenge"], "credential": p.create(t, opts.Body, passkeyOrigin),
		"name": "Teléfono de prueba",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("register: %d %s", res.Status, res.Raw)
	}
	return res.Body
}

func (h *harness) passkeyOptions(t *testing.T, ip string) map[string]any {
	t.Helper()
	opts := h.doOrigin(t, ip, passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login/options", "", nil)
	if opts.Status != http.StatusOK {
		t.Fatalf("login options: %d %s", opts.Status, opts.Raw)
	}
	return opts.Body
}

func TestPasskeySignIn(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca con llave", 80000)
	key := newSoftPasskey(t)
	created := h.registerPasskey(t, f.OwnerToken, key)

	t.Run("it is listed for its owner", func(t *testing.T) {
		res := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodGet, "/v1/me/passkeys", f.OwnerToken, nil)
		items, _ := res.Body["items"].([]any)
		if res.Status != http.StatusOK || len(items) != 1 {
			t.Fatalf("list: %d %s", res.Status, res.Raw)
		}
		if items[0].(map[string]any)["name"] != "Teléfono de prueba" {
			t.Fatalf("name not kept: %s", res.Raw)
		}
	})

	t.Run("and not for anybody else on the farm", func(t *testing.T) {
		res := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodGet, "/v1/me/passkeys", f.AdminToken, nil)
		if items, _ := res.Body["items"].([]any); res.Status != http.StatusOK || len(items) != 0 {
			t.Fatalf("another user sees the owner's passkey: %d %s", res.Status, res.Raw)
		}
	})

	t.Run("it opens a session without the password", func(t *testing.T) {
		opts := h.passkeyOptions(t, "10.7.0.1")
		res := h.doOrigin(t, "10.7.0.1", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", map[string]any{
			"challenge": opts["challenge"], "credential": key.get(t, opts, passkeyOrigin),
		})
		if res.Status != http.StatusOK || res.Body["farmId"] != f.FarmID {
			t.Fatalf("passkey sign-in: %d %s", res.Status, res.Raw)
		}
		token, _ := res.Body["accessToken"].(string)
		me := h.do(t, http.MethodGet, "/v1/me", token, nil)
		if me.Status != http.StatusOK || me.Body["id"] != f.OwnerUserID {
			t.Fatalf("the session is not the owner's: %d %s", me.Status, me.Raw)
		}
	})

	t.Run("an answer is accepted once", func(t *testing.T) {
		opts := h.passkeyOptions(t, "10.7.0.2")
		body := map[string]any{"challenge": opts["challenge"], "credential": key.get(t, opts, passkeyOrigin)}
		first := h.doOrigin(t, "10.7.0.2", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", body)
		if first.Status != http.StatusOK {
			t.Fatalf("first: %d %s", first.Status, first.Raw)
		}
		again := h.doOrigin(t, "10.7.0.2", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", body)
		if again.Status != http.StatusUnauthorized || again.code() != "INVALID_CREDENTIALS" {
			t.Fatalf("a replayed answer: %d %s, want 401", again.Status, again.Raw)
		}
	})

	t.Run("a copied key whose counter goes backwards is refused", func(t *testing.T) {
		clone := *key
		clone.count = 0
		opts := h.passkeyOptions(t, "10.7.0.3")
		res := h.doOrigin(t, "10.7.0.3", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", map[string]any{
			"challenge": opts["challenge"], "credential": clone.get(t, opts, passkeyOrigin),
		})
		if res.Status != http.StatusUnauthorized {
			t.Fatalf("a cloned authenticator: %d %s, want 401", res.Status, res.Raw)
		}
	})

	t.Run("a key nobody registered is refused", func(t *testing.T) {
		stranger := newSoftPasskey(t)
		stranger.rpID, stranger.userHandle = "localhost", key.userHandle
		opts := h.passkeyOptions(t, "10.7.0.4")
		res := h.doOrigin(t, "10.7.0.4", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", map[string]any{
			"challenge": opts["challenge"], "credential": stranger.get(t, opts, passkeyOrigin),
		})
		if res.Status != http.StatusUnauthorized {
			t.Fatalf("an unknown key: %d %s, want 401", res.Status, res.Raw)
		}
	})

	t.Run("an answer for another site is refused", func(t *testing.T) {
		opts := h.passkeyOptions(t, "10.7.0.5")
		res := h.doOrigin(t, "10.7.0.5", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", map[string]any{
			"challenge": opts["challenge"], "credential": key.get(t, opts, "http://evil.localhost:5173"),
		})
		if res.Status != http.StatusUnauthorized {
			t.Fatalf("an answer made for another origin: %d %s, want 401", res.Status, res.Raw)
		}
	})

	t.Run("a site that is not this one gets no challenge", func(t *testing.T) {
		for _, origin := range []string{"", "https://evil.example", "http://10.0.0.9:5173", "null"} {
			res := h.doOrigin(t, "10.7.0.6", origin, http.MethodPost, "/v1/auth/passkeys/login/options", "", nil)
			if res.Status != http.StatusBadRequest {
				t.Fatalf("origin %q: %d %s, want 400", origin, res.Status, res.Raw)
			}
		}
	})

	t.Run("failed passkeys feed the login limiter", func(t *testing.T) {
		ip := "10.7.0.7"
		for i := 0; i < h.loginFailuresPerIP; i++ {
			res := h.doOrigin(t, ip, passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", map[string]any{
				"challenge": "not-a-seal", "credential": map[string]any{},
			})
			if res.Status != http.StatusUnauthorized {
				t.Fatalf("attempt %d: %d %s", i, res.Status, res.Raw)
			}
		}
		opts := h.passkeyOptions(t, ip)
		res := h.doOrigin(t, ip, passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", map[string]any{
			"challenge": opts["challenge"], "credential": key.get(t, opts, passkeyOrigin),
		})
		if res.Status != http.StatusTooManyRequests {
			t.Fatalf("after the limit: %d %s, want 429", res.Status, res.Raw)
		}
	})

	t.Run("nobody else can remove it", func(t *testing.T) {
		res := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodDelete,
			"/v1/me/passkeys/"+created["id"].(string), f.AdminToken, nil)
		if res.Status != http.StatusNotFound {
			t.Fatalf("another user removed the owner's passkey: %d %s", res.Status, res.Raw)
		}
	})

	t.Run("once removed it opens nothing", func(t *testing.T) {
		res := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodDelete,
			"/v1/me/passkeys/"+created["id"].(string), f.OwnerToken, nil)
		if res.Status != http.StatusNoContent {
			t.Fatalf("delete: %d %s", res.Status, res.Raw)
		}
		opts := h.passkeyOptions(t, "10.7.0.8")
		login := h.doOrigin(t, "10.7.0.8", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", map[string]any{
			"challenge": opts["challenge"], "credential": key.get(t, opts, passkeyOrigin),
		})
		if login.Status != http.StatusUnauthorized {
			t.Fatalf("a removed passkey: %d %s, want 401", login.Status, login.Raw)
		}
	})
}

func TestPasskeyChallengeIsSingleUse(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca sincronizada", 80000)
	key := newSoftPasskey(t)
	key.zeroCounter = true
	h.registerPasskey(t, f.OwnerToken, key)

	opts := h.passkeyOptions(t, "10.7.3.1")
	body := map[string]any{"challenge": opts["challenge"], "credential": key.get(t, opts, passkeyOrigin)}
	if res := h.doOrigin(t, "10.7.3.1", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", body); res.Status != http.StatusOK {
		t.Fatalf("first: %d %s", res.Status, res.Raw)
	}
	again := h.doOrigin(t, "10.7.3.1", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", body)
	if again.Status != http.StatusUnauthorized {
		t.Fatalf("the same answer opened a second session: %d %s, want 401", again.Status, again.Raw)
	}

	// A fresh challenge still works: a zero counter is not itself a refusal.
	opts = h.passkeyOptions(t, "10.7.3.1")
	res := h.doOrigin(t, "10.7.3.1", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", map[string]any{
		"challenge": opts["challenge"], "credential": key.get(t, opts, passkeyOrigin),
	})
	if res.Status != http.StatusOK {
		t.Fatalf("a new sign-in with a zero-counter passkey: %d %s", res.Status, res.Raw)
	}
}

func TestPasskeyRegistrationIsBoundToTheCaller(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de registro", 80000)

	t.Run("a challenge made for one user does not register for another", func(t *testing.T) {
		opts := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, "/v1/me/passkeys/options", f.OwnerToken, nil)
		res := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, "/v1/me/passkeys", f.AdminToken, map[string]any{
			"challenge": opts.Body["challenge"], "credential": newSoftPasskey(t).create(t, opts.Body, passkeyOrigin),
		})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("someone else's challenge: %d %s, want 400", res.Status, res.Raw)
		}
	})

	t.Run("the same key cannot be registered twice", func(t *testing.T) {
		key := newSoftPasskey(t)
		h.registerPasskey(t, f.AdminToken, key)
		opts := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, "/v1/me/passkeys/options", f.AdminToken, nil)
		res := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, "/v1/me/passkeys", f.AdminToken, map[string]any{
			"challenge": opts.Body["challenge"], "credential": key.create(t, opts.Body, passkeyOrigin),
		})
		if res.Status != http.StatusConflict {
			t.Fatalf("a second registration of one key: %d %s, want 409", res.Status, res.Raw)
		}
	})

	t.Run("it needs a session", func(t *testing.T) {
		res := h.doOrigin(t, "10.0.0.1", passkeyOrigin, http.MethodPost, "/v1/me/passkeys/options", "", nil)
		if res.Status != http.StatusUnauthorized {
			t.Fatalf("no token: %d %s, want 401", res.Status, res.Raw)
		}
	})
}

// A farm with its own owner password opens only with that password. A passkey
// added from another farm's session must not become a way around it.
func TestPasskeyNeverOpensAFarmLockedByItsOwnPassword(t *testing.T) {
	h := requireDB(t)
	home := h.signupFarm(t, "Finca de casa", 80000)
	other := h.signupFarm(t, "Finca con clave propia", 80000)
	ctx := context.Background()
	if _, err := h.admin.Exec(ctx, `
		INSERT INTO memberships (farm_id, user_id, role) VALUES ($1, $2, 'admin')`,
		other.FarmID, home.OwnerUserID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.admin.Exec(ctx, `
		INSERT INTO farm_owner_credentials (farm_id, user_id, name, phone, password_hash)
		VALUES ($1, $2, 'Owner', '', 'x')`, other.FarmID, home.OwnerUserID); err != nil {
		t.Fatal(err)
	}

	key := newSoftPasskey(t)
	h.registerPasskey(t, home.OwnerToken, key)

	signIn := func(ip string, extra map[string]any) response {
		opts := h.passkeyOptions(t, ip)
		body := map[string]any{"challenge": opts["challenge"], "credential": key.get(t, opts, passkeyOrigin)}
		for k, v := range extra {
			body[k] = v
		}
		return h.doOrigin(t, ip, passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", body)
	}

	if res := signIn("10.7.1.1", nil); res.Status != http.StatusOK || res.Body["farmId"] != home.FarmID {
		t.Fatalf("the passkey should open its own farm straight away: %d %s", res.Status, res.Raw)
	}
	if res := signIn("10.7.1.2", map[string]any{"farmId": other.FarmID}); res.Status != http.StatusForbidden {
		t.Fatalf("the passkey opened a farm guarded by its own password: %d %s", res.Status, res.Raw)
	}
}

func TestPasskeyNeedsAVerifiedAddress(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca sin verificar", 80000)
	key := newSoftPasskey(t)
	h.registerPasskey(t, f.OwnerToken, key)
	if _, err := h.admin.Exec(context.Background(),
		`UPDATE users SET email_verified_at = NULL WHERE id = $1`, f.OwnerUserID); err != nil {
		t.Fatal(err)
	}
	opts := h.passkeyOptions(t, "10.7.2.1")
	res := h.doOrigin(t, "10.7.2.1", passkeyOrigin, http.MethodPost, "/v1/auth/passkeys/login", "", map[string]any{
		"challenge": opts["challenge"], "credential": key.get(t, opts, passkeyOrigin),
	})
	if res.Status != http.StatusForbidden || res.code() != "EMAIL_NOT_VERIFIED" {
		t.Fatalf("unverified address: %d %s, want 403 EMAIL_NOT_VERIFIED", res.Status, res.Raw)
	}
}
