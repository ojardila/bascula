package apitest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// Edges of sign-up, sign-in, refresh, password change, invitations, uploads
// and the onboarding tour that the main flows do not walk, including the
// "if err != nil" after the database calls on the routes the automatic fault
// replay skips (see fault_replay_test.go).

// cauServer is a server of the test's own, with signup limits out of the way
// and, when mail is true, a mailer and a public address (so signup asks for a
// mailed link and "olvidé mi clave" is on).
func cauServer(t *testing.T, h *harness, mail bool, tweak func(*httpapi.Config)) http.Handler {
	t.Helper()
	uploads, _ := os.MkdirTemp("", "bascula-cau-uploads-")
	t.Cleanup(func() { _ = os.RemoveAll(uploads) })
	cfg := httpapi.DefaultConfig()
	cfg.DevEcho = true
	cfg.UploadDir = uploads
	cfg.SignupsPerIPPerHour = 1 << 20
	cfg.SignupsPerEmailPerHour = 1 << 20
	cfg.MaxFarmsPerEmail = 1 << 20
	if mail {
		cfg.Mailer = &recordingMailer{}
		cfg.PublicBaseURL = "https://bascula.example.com"
	}
	if tweak != nil {
		tweak(&cfg)
	}
	return httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)
}

func cauSignupBody(farm, email, password string) map[string]any {
	return map[string]any{
		"farm":  map[string]any{"name": farm, "priceCents": 90000},
		"owner": map[string]any{"email": email, "name": "Dueno", "password": password},
	}
}

func cauEmail(prefix string) string {
	return fmt.Sprintf("%s-%s@example.com", prefix, uuid.NewString()[:8])
}

// cauReplayed runs the fault replay over one request, then serves it for
// real from ip, with an optional Host.
func cauReplayed(t *testing.T, srv http.Handler, ip, host, method, path, token string, body any) response {
	t.Helper()
	raw := ""
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		raw = string(b)
	}
	newReq := func() *http.Request {
		req := httptest.NewRequest(method, path, strings.NewReader(raw))
		req.RemoteAddr = ip + ":12345"
		if host != "" {
			req.Host = host
		}
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		return req
	}
	if faultReplayOn() {
		replayAllOn(srv, newReq(), raw)
	}
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, newReq())
	out := response{Status: rec.Code, Raw: rec.Body.String()}
	if out.Raw != "" {
		_ = json.Unmarshal([]byte(out.Raw), &out.Body)
	}
	return out
}

func expectCode(t *testing.T, what string, res response, status int, code domain.Code) {
	t.Helper()
	if res.Status != status || res.code() != string(code) {
		t.Fatalf("%s: got %d %q want %d %q: %s", what, res.Status, res.code(), status, code, res.Raw)
	}
}

func TestCauSignupSurvivesFaultsOnEveryBranch(t *testing.T) {
	h := requireDB(t)

	t.Run("with the platform-wide ceiling on, a new address", func(t *testing.T) {
		srv := cauServer(t, h, false, func(c *httpapi.Config) { c.SignupsPerHour = 1 << 20 })
		res := cauReplayed(t, srv, "10.81.0.1", "", http.MethodPost, "/v1/signup", "",
			cauSignupBody("Finca techo cau", cauEmail("cau-techo"), "una-clave-larga-1"))
		expectStatus(t, "signup under the ceiling", res, http.StatusCreated)
	})

	t.Run("a verified address registering another farm keeps the new password on that farm", func(t *testing.T) {
		f := h.signupFarm(t, "Finca cau existente", 90000)
		res := cauReplayed(t, h.server, "10.81.0.2", "", http.MethodPost, "/v1/signup", "",
			cauSignupBody("Finca cau segunda", f.OwnerEmail, "clave-de-la-segunda-1"))
		expectStatus(t, "signup with a verified address", res, http.StatusCreated)
		if _, leaked := res.Body["farmId"]; leaked {
			t.Fatalf("signup named the farm: %s", res.Raw)
		}
		// The farm's own password opens the new farm, and only it.
		login := h.doFrom(t, "10.81.0.3", http.MethodPost, "/v1/auth/login", "",
			map[string]any{"email": f.OwnerEmail, "password": "clave-de-la-segunda-1"})
		expectStatus(t, "login with the new farm's password", login, http.StatusOK)
		if login.Body["farmId"] == f.FarmID {
			t.Fatalf("the new farm's password opened the first farm: %s", login.Raw)
		}
	})

	t.Run("an unverified claim is replaced by the latest registration", func(t *testing.T) {
		srv := cauServer(t, h, true, nil)
		email := cauEmail("cau-claim")
		first := call(t, srv, http.MethodPost, "/v1/signup", "",
			cauSignupBody("Finca del primero", email, "clave-del-primero-1"))
		expectStatus(t, "first claim", first, http.StatusCreated)
		if first.Body["verificationRequired"] != true {
			t.Fatalf("with a mailer signup must ask for the link: %s", first.Raw)
		}
		second := cauReplayed(t, srv, "10.81.0.4", "", http.MethodPost, "/v1/signup", "",
			cauSignupBody("Finca del segundo", email, "clave-del-segundo-2"))
		expectStatus(t, "second claim", second, http.StatusCreated)
		token := mustString(t, second.Body, "verificationToken")

		// The first registration's password no longer finishes anything.
		expectCode(t, "verify with the replaced password", call(t, srv, http.MethodPost, "/v1/auth/verify-email", "",
			map[string]any{"token": token, "password": "clave-del-primero-1"}),
			http.StatusUnauthorized, domain.CodeInvalidCredentials)
		ok := call(t, srv, http.MethodPost, "/v1/auth/verify-email", "",
			map[string]any{"token": token, "password": "clave-del-segundo-2"})
		expectStatus(t, "verify with the latest password", ok, http.StatusOK)
		if ok.Body["verified"] != true || mustString(t, ok.Body, "slug") == "" {
			t.Fatalf("verify-email did not name the farm: %s", ok.Raw)
		}
	})
}

func TestCauLoginErrorBranches(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca cau ingreso", 90000)

	t.Run("a wrong password is counted even when the database fails around it", func(t *testing.T) {
		res := cauReplayed(t, h.server, "10.82.0.1", "", http.MethodPost, "/v1/auth/login", "",
			map[string]any{"email": f.OwnerEmail, "password": "no-es-la-clave-1"})
		expectCode(t, "wrong password", res, http.StatusUnauthorized, domain.CodeInvalidCredentials)
	})

	t.Run("a stored hash that is not one refuses like a wrong password", func(t *testing.T) {
		ctx := context.Background()
		id, email := uuid.NewString(), cauEmail("cau-hash-roto")
		if _, err := h.admin.Exec(ctx, `INSERT INTO users (id, email, name, password_hash, email_verified_at)
			VALUES ($1, $2, 'Roto', 'no-es-un-hash', now())`, id, email); err != nil {
			t.Fatal(err)
		}
		if _, err := h.admin.Exec(ctx, `INSERT INTO memberships (farm_id, user_id, role) VALUES ($1, $2, 'weigher')`,
			f.FarmID, id); err != nil {
			t.Fatal(err)
		}
		res := h.doFrom(t, "10.82.0.2", http.MethodPost, "/v1/auth/login", "",
			map[string]any{"email": email, "password": "una-clave-larga-1"})
		expectCode(t, "malformed hash", res, http.StatusUnauthorized, domain.CodeInvalidCredentials)
	})

	t.Run("an invited, unverified address opens the farm whose password it typed", func(t *testing.T) {
		email := cauEmail("cau-invitado")
		h.mustDo(t, http.MethodPost, "/v1/users", f.OwnerToken,
			map[string]any{"email": email, "name": "Invitado", "role": "weigher", "password": "clave-de-finca-1"},
			http.StatusCreated)
		res := cauReplayed(t, h.server, "10.82.0.3", "", http.MethodPost, "/v1/auth/login", "",
			map[string]any{"email": email, "password": "clave-de-finca-1"})
		expectStatus(t, "invited login", res, http.StatusOK)
		if res.Body["farmId"] != f.FarmID || res.Body["role"] != "weigher" {
			t.Fatalf("the invited password opened the wrong thing: %s", res.Raw)
		}
	})

	t.Run("a farm pinned by host and body opens that farm", func(t *testing.T) {
		slug := h.farmSlug(t, f.FarmID)
		res := cauReplayed(t, h.server, "10.82.0.4", slug+".bascula.engp.io", http.MethodPost, "/v1/auth/login", "",
			map[string]any{"email": f.OwnerEmail, "password": f.loginSecret(), "farmSlug": slug})
		expectStatus(t, "pinned login", res, http.StatusOK)
		if res.Body["farmId"] != f.FarmID {
			t.Fatalf("the pin opened another farm: %s", res.Raw)
		}
	})
}

func TestCauRefreshReuseClosesTheFamilyUnderFaults(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca cau refresco", 90000)
	login := h.mustDo(t, http.MethodPost, "/v1/auth/login", "",
		map[string]any{"email": f.OwnerEmail, "password": f.loginSecret()}, http.StatusOK)
	old := mustString(t, login.Body, "refreshToken")
	rotated := h.mustDo(t, http.MethodPost, "/v1/auth/refresh", "",
		map[string]any{"refreshToken": old}, http.StatusOK)

	res := cauReplayed(t, h.server, "10.83.0.1", "", http.MethodPost, "/v1/auth/refresh", "",
		map[string]any{"refreshToken": old})
	expectCode(t, "reused refresh token", res, http.StatusUnauthorized, domain.CodeTokenReused)

	// The reuse killed the family, the token rotated into included.
	again := h.do(t, http.MethodPost, "/v1/auth/refresh", "",
		map[string]any{"refreshToken": mustString(t, rotated.Body, "refreshToken")})
	expectCode(t, "the rotated token after a reuse", again, http.StatusUnauthorized, domain.CodeTokenReused)
}

// A farm with its own owner password changes THAT password, and the account's
// password keeps opening the other farm.
func TestCauChangeFarmOwnPassword(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca cau propia", 90000)
	h.mustDo(t, http.MethodPost, "/v1/signup", "",
		cauSignupBody("Finca cau con clave propia", f.OwnerEmail, "clave-de-la-finca-1"), http.StatusCreated)

	const ip = "10.84.0.1"
	farmLogin := h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "",
		map[string]any{"email": f.OwnerEmail, "password": "clave-de-la-finca-1"})
	expectStatus(t, "farm password login", farmLogin, http.StatusOK)
	farm2 := mustString(t, farmLogin.Body, "farmId")

	changed := h.doFrom(t, ip, http.MethodPost, "/v1/me/password", mustString(t, farmLogin.Body, "accessToken"),
		map[string]any{"currentPassword": "clave-de-la-finca-1", "newPassword": "clave-nueva-finca-3"})
	expectStatus(t, "change the farm's password", changed, http.StatusOK)
	if changed.Body["farmId"] != farm2 || mustString(t, changed.Body, "accessToken") == "" {
		t.Fatalf("the change did not answer with a session on that farm: %s", changed.Raw)
	}

	after := h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "",
		map[string]any{"email": f.OwnerEmail, "password": "clave-nueva-finca-3"})
	if after.Status != http.StatusOK || after.Body["farmId"] != farm2 {
		t.Fatalf("the new farm password: %d %s", after.Status, after.Raw)
	}
	account := h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "",
		map[string]any{"email": f.OwnerEmail, "password": f.loginSecret()})
	if account.Status != http.StatusOK || account.Body["farmId"] != f.FarmID {
		t.Fatalf("the account password stopped opening the first farm: %d %s", account.Status, account.Raw)
	}
	old := h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "",
		map[string]any{"email": f.OwnerEmail, "password": "clave-de-la-finca-1"})
	expectCode(t, "the old farm password", old, http.StatusUnauthorized, domain.CodeInvalidCredentials)
}

func TestCauInviteRefusalsAndPasswords(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca cau invitaciones", 90000)

	expectStatus(t, "unknown role", h.do(t, http.MethodPost, "/v1/users", f.OwnerToken,
		map[string]any{"email": cauEmail("cau-rol"), "role": "capataz"}), http.StatusBadRequest)
	expectStatus(t, "no address", h.do(t, http.MethodPost, "/v1/users", f.OwnerToken,
		map[string]any{"email": "sin-arroba", "role": "weigher"}), http.StatusBadRequest)
	expectStatus(t, "password over the limit", h.do(t, http.MethodPost, "/v1/users", f.OwnerToken,
		map[string]any{"email": cauEmail("cau-larga"), "role": "weigher", "password": strings.Repeat("x", 129)}),
		http.StatusBadRequest)
	expectStatus(t, "an administrator granting owner", h.do(t, http.MethodPost, "/v1/users", f.AdminToken,
		map[string]any{"email": cauEmail("cau-dueno"), "role": "owner"}), http.StatusForbidden)

	given := h.mustDo(t, http.MethodPost, "/v1/users", f.OwnerToken,
		map[string]any{"email": cauEmail("cau-dada"), "role": "weigher", "password": "clave-dada-1"}, http.StatusCreated)
	if _, ok := given.Body["temporaryPassword"]; ok {
		t.Fatalf("a password the administrator typed came back: %s", given.Raw)
	}
	minted := h.mustDo(t, http.MethodPost, "/v1/users", f.OwnerToken,
		map[string]any{"email": cauEmail("cau-acunada"), "role": "weigher"}, http.StatusCreated)
	if len(mustString(t, minted.Body, "temporaryPassword")) < 16 {
		t.Fatalf("a minted password is missing or short: %s", minted.Raw)
	}
	if minted.Body["emailVerifiedAt"] != nil {
		t.Fatalf("an invited address came back verified: %s", minted.Raw)
	}

	// An administrator addresses an owner's membership in neither direction.
	expectStatus(t, "admin demoting the owner", h.do(t, http.MethodPatch, "/v1/users/"+f.OwnerUserID, f.AdminToken,
		map[string]any{"role": "weigher"}), http.StatusForbidden)
	expectStatus(t, "admin removing the owner", h.do(t, http.MethodDelete, "/v1/users/"+f.OwnerUserID, f.AdminToken, nil),
		http.StatusForbidden)
	expectStatus(t, "bad role on PATCH", h.do(t, http.MethodPatch, "/v1/users/"+f.WeigherID, f.OwnerToken,
		map[string]any{"role": "capataz"}), http.StatusBadRequest)
}

func TestCauUploadRefusalsAndHeaders(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca cau fotos", 90000)
	ticket := func(t *testing.T) (string, string) {
		t.Helper()
		res := h.mustDo(t, http.MethodPost, "/v1/uploads", f.OwnerToken,
			map[string]any{"purpose": "worker-photo", "filename": "foto.png"}, http.StatusCreated)
		a, _ := res.Body["attachment"].(map[string]any)
		return mustString(t, a, "id"), mustString(t, res.Body, "uploadUrl")
	}
	put := func(path string, body []byte, length int64) response {
		req := httptest.NewRequest(http.MethodPut, path, bytes.NewReader(body))
		req.RemoteAddr = "10.85.0.1:12345"
		req.ContentLength = length
		req.Header.Set("Authorization", "Bearer "+f.OwnerToken)
		rec := httptest.NewRecorder()
		h.server.ServeHTTP(rec, req)
		out := response{Status: rec.Code, Raw: rec.Body.String()}
		_ = json.Unmarshal(rec.Body.Bytes(), &out.Body)
		return out
	}
	setKey := func(t *testing.T, id, key string) {
		t.Helper()
		if _, err := h.admin.Exec(context.Background(),
			`UPDATE attachments SET object_key = $2 WHERE id = $1`, id, key); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("a body with no length over the limit is refused when it arrives", func(t *testing.T) {
		_, url := ticket(t)
		res := put(url, pngOf(5*1024*1024+1), -1)
		expectCode(t, "chunked 5 MB + 1", res, http.StatusRequestEntityTooLarge, domain.CodeUploadTooLarge)
	})

	t.Run("bytes that cannot be stored are a 400", func(t *testing.T) {
		id, url := ticket(t)
		setKey(t, id, "malo/"+uuid.NewString()+"/x")
		res := put(url, pngOf(64), 64)
		expectStatus(t, "unstorable key", res, http.StatusBadRequest)
	})

	t.Run("the confirmation survives faults and the bytes come back with safe headers", func(t *testing.T) {
		id, url := ticket(t)
		body := pngOf(512)
		if faultReplayOn() {
			req := httptest.NewRequest(http.MethodPut, url, bytes.NewReader(body))
			req.RemoteAddr = "10.85.0.2:12345"
			req.ContentLength = int64(len(body))
			req.Header.Set("Authorization", "Bearer "+f.OwnerToken)
			h.replayAll(req, string(body))
		}
		res := put(url, body, int64(len(body)))
		if res.Status != http.StatusOK || res.Body["status"] != "ready" {
			t.Fatalf("upload after the replay: %d %s", res.Status, res.Raw)
		}
		req := httptest.NewRequest(http.MethodGet, "/v1/uploads/"+id+"/content", nil)
		req.Header.Set("Authorization", "Bearer "+f.OwnerToken)
		rec := httptest.NewRecorder()
		h.server.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || rec.Body.Len() != 512 {
			t.Fatalf("download: %d, %d bytes", rec.Code, rec.Body.Len())
		}
		for k, want := range map[string]string{
			"Content-Type": "image/png", "Content-Length": "512", "Cache-Control": "private, max-age=300",
			"X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN",
		} {
			if got := rec.Header().Get(k); got != want {
				t.Errorf("%s is %q, want %q", k, got, want)
			}
		}

		// The row says ready and the object is gone: a 500, not a 404.
		setKey(t, id, f.FarmID+"/"+strings.ReplaceAll(uuid.NewString(), "-", ""))
		expectStatus(t, "missing object", h.do(t, http.MethodGet, "/v1/uploads/"+id+"/content", f.OwnerToken, nil),
			http.StatusInternalServerError)
		// A key the store cannot even resolve is a 500 too.
		setKey(t, id, "malo/"+uuid.NewString()+"/x")
		expectStatus(t, "unresolvable key", h.do(t, http.MethodGet, "/v1/uploads/"+id+"/content", f.OwnerToken, nil),
			http.StatusInternalServerError)
	})
}

// "Más tarde" and "no volver a mostrar" are both kept, per person.
func TestCauTourLaterAndDismissed(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca cau recorrido", 90000)
	h.mustDo(t, http.MethodPut, "/v1/me/tours/owner", f.OwnerToken,
		map[string]any{"step": 2, "status": "later"}, http.StatusOK)
	saved := h.mustDo(t, http.MethodPut, "/v1/me/tours/owner", f.OwnerToken,
		map[string]any{"step": 2, "status": "dismissed"}, http.StatusOK)
	if saved.Body["status"] != "dismissed" || mustInt(t, saved.Body, "step") != 2 {
		t.Fatalf("dismissed did not stick: %s", saved.Raw)
	}
	h.mustDo(t, http.MethodPut, "/v1/me/tours/owner", f.OwnerToken,
		map[string]any{"step": 101, "status": "active"}, http.StatusBadRequest)
	res := h.mustDo(t, http.MethodGet, "/v1/me/tours", f.AdminToken, nil, http.StatusOK)
	if items, _ := res.Body["items"].([]any); len(items) != 0 {
		t.Fatalf("the administrator sees the owner's tour: %s", res.Raw)
	}
}

// Two refreshes of one token racing: the loser finds the token rotated under
// it, gets nothing, and does NOT close the family — the winner's session
// stands. The race is staged with a row lock: the request reads the token as
// live, then waits on the lock while the "winner" rotates it.
func TestCauRefreshLosingTheRaceKeepsTheFamily(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca cau carrera", 90000)
	ctx := context.Background()
	login := h.mustDo(t, http.MethodPost, "/v1/auth/login", "",
		map[string]any{"email": f.OwnerEmail, "password": f.loginSecret()}, http.StatusOK)
	secret := mustString(t, login.Body, "refreshToken")

	lock, err := h.admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lock.Rollback(ctx) }()
	var id, family string
	if err := lock.QueryRow(ctx, `SELECT id::text, family_id::text FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
		auth.HashToken(secret)).Scan(&id, &family); err != nil {
		t.Fatal(err)
	}

	done := make(chan response, 1)
	go func() {
		done <- h.doFrom(t, "10.86.0.1", http.MethodPost, "/v1/auth/refresh", "",
			map[string]any{"refreshToken": secret})
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var waiting int
		if err := h.admin.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'
			  AND query LIKE '%SET rotated_at = now()%'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the refresh never reached the rotation")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := lock.Exec(ctx, `UPDATE refresh_tokens SET rotated_at = now() WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	if err := lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	res := <-done
	expectCode(t, "the losing refresh", res, http.StatusUnauthorized, domain.CodeTokenReused)
	if !strings.Contains(res.Raw, "just used") {
		t.Fatalf("the loser was not told the token was just used: %s", res.Raw)
	}
	var revoked int
	if err := h.admin.QueryRow(ctx, `SELECT count(*) FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL`,
		family).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked != 0 {
		t.Fatalf("losing a race closed the family (%d revoked)", revoked)
	}
}
