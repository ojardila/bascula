// SPDX-License-Identifier: MIT

package apitest

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// Coverage round 3 for httpapi: a failure the suite-wide fault replay cannot
// aim at (a savepoint that will not release), the DNS length limit on a
// passkey Origin, and a deployment whose public address go-webauthn refuses
// as a relying party.

var errC3hInjected = errors.New("c3h: injected failure")

// c3hFault makes the release of every savepoint of one request fail.
type c3hFault struct {
	hits int
}

type c3hFaultKey struct{}

// c3hTx is the request transaction with c3hFault applied.
type c3hTx struct {
	pgx.Tx
	f      *c3hFault
	nested bool
}

func (x *c3hTx) Begin(ctx context.Context) (pgx.Tx, error) {
	inner, err := x.Tx.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &c3hTx{Tx: inner, f: x.f, nested: true}, nil
}

func (x *c3hTx) Commit(ctx context.Context) error {
	if x.nested {
		x.f.hits++
		_ = x.Tx.Rollback(ctx)
		return errC3hInjected
	}
	return x.Tx.Commit(ctx)
}

// c3hReplayOnly is the wrapper fault_replay_test.go installs; c3hWrap adds
// the c3hFault on top of it.
func c3hReplayOnly(ctx context.Context, tx pgx.Tx) pgx.Tx {
	if plan, _ := ctx.Value(faultKey{}).(*faultPlan); plan != nil {
		return &flakyTx{Tx: tx, plan: plan}
	}
	return tx
}

func c3hWrap(ctx context.Context, tx pgx.Tx) pgx.Tx {
	if f, _ := ctx.Value(c3hFaultKey{}).(*c3hFault); f != nil {
		return &c3hTx{Tx: tx, f: f}
	}
	return c3hReplayOnly(ctx, tx)
}

func c3hInstall(t *testing.T) {
	t.Helper()
	tenant.SetTestTxWrapper(c3hWrap)
	t.Cleanup(func() { tenant.SetTestTxWrapper(c3hReplayOnly) })
}

// c3hServe sends req through the suite's server with fault f on its
// transaction.
func (h *harness) c3hServe(req *http.Request, f *c3hFault) *httptest.ResponseRecorder {
	req = req.WithContext(context.WithValue(req.Context(), c3hFaultKey{}, f))
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	return rec
}

func (h *harness) c3hCount(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := h.admin.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A push envelope whose write went through but whose savepoint cannot be
// released is rejected as INTERNAL, the batch still answers, and the worker
// it carried is not there: a handset retries it instead of believing it
// saved.
func TestC3hSyncPushSavepointReleaseFails(t *testing.T) {
	h := requireDB(t)
	c3hInstall(t)
	f := h.signupFarm(t, "Finca c3h savepoint", 250000)
	workerID := uuid.NewString()

	body := `{"deviceId":"` + uuid.NewString() + `","ops":[{"opId":"` + uuid.NewString() +
		`","entity":"worker","op":"upsert","payload":{"id":"` + workerID + `","name":"Ana"}}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/sync/push", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+f.OwnerToken)
	req.RemoteAddr = "10.93.0.1:12345"
	fault := &c3hFault{}
	rec := h.c3hServe(req, fault)

	if rec.Code != http.StatusOK || fault.hits != 1 {
		t.Fatalf("push: %d (release failures %d) %s", rec.Code, fault.hits, rec.Body.String())
	}
	out := response{Raw: rec.Body.String()}
	if err := json.Unmarshal(rec.Body.Bytes(), &out.Body); err != nil {
		t.Fatal(err)
	}
	results, _ := out.Body["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("one result per envelope: %s", out.Raw)
	}
	res := results[0].(map[string]any)
	errObj, _ := res["error"].(map[string]any)
	if res["status"] != "rejected" || errObj["code"] != "INTERNAL" {
		t.Fatalf("an unreleased savepoint must be an INTERNAL rejection: %s", out.Raw)
	}
	if n := h.c3hCount(t, `SELECT count(*) FROM employees WHERE id = $1`, workerID); n != 0 {
		t.Fatalf("the rejected worker was stored anyway: %d", n)
	}
}

// A relying party id longer than DNS allows (253) is refused as a bad Origin;
// the longest one allowed still gets a challenge.
func TestC3hPasskeyOriginLengthLimit(t *testing.T) {
	h := requireDB(t)
	label := strings.Repeat("a", 60)
	longest := "http://" + strings.Join([]string{label, label, label, label}, ".") + ".localhost"
	tooLong := "http://b" + strings.TrimPrefix(longest, "http://")
	if got := len(strings.TrimPrefix(longest, "http://")); got != 253 {
		t.Fatalf("fixture: the longest host is %d long", got)
	}

	ok := h.doOrigin(t, "10.93.2.1", longest, http.MethodPost, cpkLoginOptions, "", nil)
	cpkExpectCode(t, "a 253-character host", ok, http.StatusOK, "")
	if _, sealed := ok.Body["challenge"].(string); !sealed {
		t.Fatalf("no challenge for the longest host: %s", ok.Raw)
	}
	bad := h.doOrigin(t, "10.93.2.1", tooLong, http.MethodPost, cpkLoginOptions, "", nil)
	cpkExpectCode(t, "a 254-character host", bad, http.StatusBadRequest, "BAD_REQUEST")
	if _, sealed := bad.Body["challenge"]; sealed {
		t.Fatalf("a refused Origin got a challenge: %s", bad.Raw)
	}
}

// c3hMisconfigured is a deployment whose PUBLIC_BASE_URL is a single-label
// host: it passes the Origin checks, but go-webauthn refuses it as a relying
// party id. That is the operator's mistake: every ceremony answers 500 and
// stores nothing.
const c3hSingleLabel = "https://bascula"

func (h *harness) c3hMisconfiguredServer(t *testing.T) *httpapi.Server {
	t.Helper()
	cfg := httpapi.DefaultConfig()
	cfg.DevEcho = true
	cfg.UploadDir = t.TempDir()
	cfg.PublicBaseURL = c3hSingleLabel
	return httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)
}

func c3hMisconfigured(t *testing.T, what string, res response) {
	t.Helper()
	cpkExpectCode(t, what, res, http.StatusInternalServerError, "INTERNAL")
	if _, ok := res.Body["challenge"]; ok {
		t.Fatalf("%s: a misconfigured relying party handed out a challenge: %s", what, res.Raw)
	}
	if _, ok := res.Body["accessToken"]; ok {
		t.Fatalf("%s: a misconfigured relying party opened a session: %s", what, res.Raw)
	}
}

func TestC3hPasskeyMisconfiguredRelyingParty(t *testing.T) {
	h := requireDB(t)
	srv := h.c3hMisconfiguredServer(t)
	f := h.signupFarm(t, "Finca c3h sin dominio", 80000)
	handle := cpkUserHandle(t, f.OwnerUserID)
	call := func(ip, path, token string, body any) response {
		return cpkCall(t, srv, cpkReq{ip: ip, origin: c3hSingleLabel, method: http.MethodPost,
			path: path, token: token, body: body})
	}

	t.Run("sign-in options", func(t *testing.T) {
		c3hMisconfigured(t, "login options", call("10.93.3.1", cpkLoginOptions, "", nil))
	})
	t.Run("registration options", func(t *testing.T) {
		c3hMisconfigured(t, "register options", call("10.93.3.1", cpkRegisterOptions, f.OwnerToken, reauth))
	})
	t.Run("registration", func(t *testing.T) {
		sd := webauthn.SessionData{Challenge: cpkChallenge(), RelyingPartyID: "bascula", Origin: c3hSingleLabel,
			UserID: handle, Expires: time.Now().Add(time.Minute)}
		c3hMisconfigured(t, "register", call("10.93.3.1", cpkRegister, f.OwnerToken, map[string]any{
			"challenge":  cpkSeal(t, "passkey-register", sd),
			"credential": newSoftPasskey(t).create(t, cpkOptionsFor(sd), c3hSingleLabel),
		}))
		if n := h.cpkPasskeyCount(t, f.OwnerUserID); n != 0 {
			t.Fatalf("a misconfigured relying party stored %d passkeys", n)
		}
	})
	t.Run("sign-in", func(t *testing.T) {
		key := newSoftPasskey(t)
		key.rpID, key.userHandle = "bascula", handle
		sd := cpkLoginSession(c3hSingleLabel, "bascula", time.Minute)
		c3hMisconfigured(t, "login", call("10.93.3.2", cpkLogin, "", map[string]any{
			"challenge": cpkSeal(t, "passkey-login", sd), "credential": key.get(t, cpkOptionsFor(sd), c3hSingleLabel),
		}))
		// The server's fault, not the visitor's: no failed sign-in counted.
		if n := h.cpkLoginFailures(t, "10.93.3.2"); n != 0 {
			t.Fatalf("a misconfiguration was counted as %d failed sign-ins", n)
		}
	})
}
