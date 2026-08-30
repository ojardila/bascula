package apitest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// The three failures an adversarial audit found, each with a test that fails
// without its fix.
//
// All three are the same shape and it is worth naming: a decision derived by
// reading, taken by a human or a rule, and then written — with nothing holding
// the world still in between. Every total in this system is derived on purpose,
// so every guard built on one needs something to serialise it, and two of them
// did not have it.

// ---------------------------------------------------------------------------
// A concurrent request helper
//
// It cannot use h.do: that calls t.Fatalf, and t is not safe from a goroutine.
// So it drives the server directly and hands the responses back to the test
// goroutine to judge.
// ---------------------------------------------------------------------------

type concurrentResult struct {
	Status int
	Body   map[string]any
	Raw    string
	Err    error
}

// fireConcurrently sends n requests at once and waits for all of them. The
// barrier is not decoration: without it the requests queue up behind each
// other and the very race under test never happens.
//
// `deadline` is what turns a hang into a failure. A self-deadlocked handler
// never writes a response and httptest has no timeout of its own, so without
// this the test would hang for ever instead of reporting the bug.
func (h *harness) fireConcurrently(n int, deadline time.Duration,
	build func(i int) (method, path, token string, body any)) []concurrentResult {

	results := make([]concurrentResult, n)
	var ready sync.WaitGroup
	var done sync.WaitGroup
	start := make(chan struct{})
	ready.Add(n)
	done.Add(n)

	for i := 0; i < n; i++ {
		go func(i int) {
			defer done.Done()
			method, path, token, body := build(i)
			var reader *strings.Reader
			if body != nil {
				raw, err := json.Marshal(body)
				if err != nil {
					results[i] = concurrentResult{Err: err}
					ready.Done()
					return
				}
				reader = strings.NewReader(string(raw))
			} else {
				reader = strings.NewReader("")
			}
			req := httptest.NewRequest(method, path, reader)
			req.RemoteAddr = "10.0.0.1:12345"
			if body != nil {
				req.Header.Set("Content-Type", "application/json")
			}
			if token != "" {
				req.Header.Set("Authorization", "Bearer "+token)
			}
			rec := httptest.NewRecorder()

			ready.Done()
			<-start
			h.server.ServeHTTP(rec, req)

			out := concurrentResult{Status: rec.Code, Raw: rec.Body.String()}
			if out.Raw != "" {
				_ = json.Unmarshal([]byte(out.Raw), &out.Body)
			}
			results[i] = out
		}(i)
	}

	ready.Wait()
	close(start)

	finished := make(chan struct{})
	go func() { done.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(deadline):
		// Deliberately not t.Fatal from here: the caller owns t. The unfinished
		// slots stay at their zero value, and status 0 is what the caller
		// reports as "never came back".
	}
	return results
}

func (r concurrentResult) code() string {
	errObj, ok := r.Body["error"].(map[string]any)
	if !ok {
		return ""
	}
	code, _ := errObj["code"].(string)
	return code
}

// ---------------------------------------------------------------------------
// 1. A reused refresh token must not deadlock against itself
// ---------------------------------------------------------------------------

// TestReusedRefreshTokenAnswersInsteadOfHanging is the whole platform, and it
// fails with ONE request.
//
// The reuse branch has to revoke the token family on a connection of its own,
// because the response is a 401 and rolls the request transaction back. What it
// must not ALSO do is revoke inside the request transaction: that takes row
// locks on refresh_tokens which cannot be released until the handler returns,
// and the second connection then waits for them for ever. Postgres sees an
// ordinary lock wait rather than a cycle, so nothing breaks it.
//
// The trigger is not an attack. It is a handset on two bars of signal that
// refreshes, loses the reply and retries with the same token.
func TestReusedRefreshTokenAnswersInsteadOfHanging(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del token reusado", 80000)

	first := h.login(t, f)
	// Use it once, so the token is rotated and the next presentation is a reuse.
	h.mustDo(t, http.MethodPost, "/v1/auth/refresh", "",
		map[string]any{"refreshToken": first}, http.StatusOK)

	res := h.fireConcurrently(1, 10*time.Second, func(int) (string, string, string, any) {
		return http.MethodPost, "/v1/auth/refresh", "",
			map[string]any{"refreshToken": first}
	})
	if res[0].Status == 0 {
		t.Fatal("a reused refresh token never came back. The handler is waiting " +
			"on row locks its own transaction holds, so the request hangs until " +
			"WriteTimeout while pinning one of the ten pool connections. A dozen " +
			"of these close the API for every farm at once.")
	}
	if res[0].code() != string(domain.CodeTokenReused) {
		t.Fatalf("got %d %s, want 401 TOKEN_REUSED", res[0].Status, res[0].Raw)
	}
}

// TestManyReusedRefreshTokensDoNotExhaustThePool is the same bug at the scale
// that matters. internal/store/db.go caps the pool at ten connections, so a
// handful of hung refreshes is the whole API — and /health keeps answering,
// because it touches no database, so a health check would not notice.
func TestManyReusedRefreshTokensDoNotExhaustThePool(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del pool", 80000)

	used := h.login(t, f)
	h.mustDo(t, http.MethodPost, "/v1/auth/refresh", "",
		map[string]any{"refreshToken": used}, http.StatusOK)

	const n = 12 // more than MaxConns
	res := h.fireConcurrently(n, 20*time.Second, func(int) (string, string, string, any) {
		return http.MethodPost, "/v1/auth/refresh", "",
			map[string]any{"refreshToken": used}
	})
	for i, r := range res {
		if r.Status == 0 {
			t.Fatalf("refresh %d of %d never came back; the pool is gone and with "+
				"it every farm's login", i, n)
		}
	}

	// And the rest of the API is still there, from another farm, which is the
	// part that makes this a platform outage rather than one session's problem.
	other := h.signupFarm(t, "Finca vecina del pool", 90000)
	after := h.fireConcurrently(1, 10*time.Second, func(int) (string, string, string, any) {
		return http.MethodGet, "/v1/workers", other.OwnerToken, nil
	})
	if after[0].Status != http.StatusOK {
		t.Fatalf("another farm's worker list answered %d after a dozen reused "+
			"tokens: %s", after[0].Status, after[0].Raw)
	}
}

// ---------------------------------------------------------------------------
// 2. AMOUNT_EXCEEDS_BALANCE has to survive two tabs
// ---------------------------------------------------------------------------

// TestConcurrentPaymentsCannotPayTheSameDebtTwice.
//
// The balance is derived — there is no stored total anywhere, deliberately — so
// the guard is "read, decide, write" and two requests interleave all three. The
// audit reproduced it at N = 2, 3 and 5 with a hundred per cent acceptance
// every time, and with allowOverpayment false. Two browser tabs do it; so does
// a foreman double-clicking Pagar. It is pesos leaving the farm.
func TestConcurrentPaymentsCannotPayTheSameDebtTwice(t *testing.T) {
	h := requireDB(t)

	// Several rounds, each with its own farm and its own debt. One round is a
	// race and a race can be lost; the guard has to hold every time, and a
	// round that overpays is a round in which real money left the farm.
	const rounds, n = 4, 12
	for round := 0; round < rounds; round++ {
		f := h.signupFarm(t, "Finca del doble pago", 80000)
		worker := h.createWorker(t, f, "Doble", fmt.Sprintf("909090%04d", round))
		h.settleSomething(t, f, worker, h.createPlot(t, f, "Lote doble pago"))

		owed := h.balanceOf(t, f, worker)
		if owed <= 0 {
			t.Fatalf("round %d: the fixture owes nothing (%d); there is no guard to test",
				round, owed)
		}

		res := h.fireConcurrently(n, 30*time.Second, func(int) (string, string, string, any) {
			// Distinct ids: these are n DIFFERENT payments, not a retry of one.
			// Idempotency is not what should stop them — the balance is.
			return http.MethodPost, "/v1/payments", f.OwnerToken, map[string]any{
				"id": uuid.NewString(), "workerId": worker,
				"amountCents": owed, "date": "2026-08-26", "method": "efectivo",
			}
		})

		accepted := 0
		for i, r := range res {
			switch {
			case r.Status == 0:
				t.Fatalf("round %d: payment %d never came back", round, i)
			case r.Status == http.StatusCreated:
				accepted++
			case r.Status == http.StatusConflict && r.code() == string(domain.CodeAmountExceedsBalance):
			default:
				t.Fatalf("round %d: payment %d answered %d %s; want 201 or 409 "+
					"AMOUNT_EXCEEDS_BALANCE", round, i, r.Status, r.Raw)
			}
		}
		if accepted != 1 {
			t.Fatalf("round %d: %d of %d concurrent payments of the whole balance "+
				"were accepted, want exactly 1. The farm just paid the same debt "+
				"%d times, and AMOUNT_EXCEEDS_BALANCE is a guard that does not "+
				"exist under concurrency.", round, accepted, n, accepted)
		}
		if left := h.balanceOf(t, f, worker); left < 0 {
			t.Fatalf("round %d: the balance ended at %d — the worker was overpaid "+
				"and now owes the farm money nobody decided to lend them", round, left)
		}
	}
}

// TestTwoTransactionsCannotBothReadTheSameBalance is the same failure with the
// timing taken out of it.
//
// The concurrent test above is an end-to-end check and, like every race, it can
// be lucky. This one is not a race at all: it drives two real transactions
// through the exact sequence the handler uses — confirm the worker, take the
// lock, derive the balance — and holds the first one open. With the lock, the
// second transaction cannot reach the balance until the first commits, and by
// then the balance is the one the first payment left behind. Without it, both
// read the same debt, both decide it is payable, and the farm pays it twice.
func TestTwoTransactionsCannotBothReadTheSameBalance(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del saldo compartido", 80000)
	worker := h.createWorker(t, f, "Compartido", "1313131313")
	h.settleSomething(t, f, worker, h.createPlot(t, f, "Lote saldo"))
	owed := h.balanceOf(t, f, worker)

	ctx := context.Background()
	first, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = first.Rollback(ctx) }()
	if err := setTenant(ctx, first, f.FarmID, f.OwnerUserID, domain.RoleOwner); err != nil {
		t.Fatalf("tenant: %v", err)
	}
	if err := store.LockEmployeeForMoney(ctx, first, worker); err != nil {
		t.Fatalf("lock in the first transaction: %v", err)
	}
	firstBalance, err := store.Balance(ctx, first, worker)
	if err != nil {
		t.Fatalf("balance: %v", err)
	}
	if firstBalance.BalanceMinor != owed {
		t.Fatalf("the first transaction reads %d, want %d", firstBalance.BalanceMinor, owed)
	}

	// The second transaction starts while the first still holds the lock.
	type reading struct {
		balance int64
		err     error
	}
	got := make(chan reading, 1)
	go func() {
		second, err := h.pool.Begin(ctx)
		if err != nil {
			got <- reading{err: err}
			return
		}
		defer func() { _ = second.Rollback(ctx) }()
		if err := setTenant(ctx, second, f.FarmID, f.OwnerUserID, domain.RoleOwner); err != nil {
			got <- reading{err: err}
			return
		}
		if err := store.LockEmployeeForMoney(ctx, second, worker); err != nil {
			got <- reading{err: err}
			return
		}
		b, err := store.Balance(ctx, second, worker)
		if err != nil {
			got <- reading{err: err}
			return
		}
		got <- reading{balance: b.BalanceMinor}
	}()

	select {
	case r := <-got:
		t.Fatalf("the second transaction read the balance (%d, err %v) while the "+
			"first still held the worker. Both would now decide that %d is "+
			"payable, and the farm would pay the same debt twice.",
			r.balance, r.err, owed)
	case <-time.After(750 * time.Millisecond):
		// Blocked, which is the whole point.
	}

	// The first transaction pays the debt off and commits. Only then may the
	// second proceed — and it must see the balance the payment left.
	if _, _, err := store.AddLedgerEntry(ctx, first, f.FarmID, store.NewLedgerEntry{
		ID: uuid.NewString(), EmployeeID: worker, Kind: domain.KindPayment,
		AmountMinor: -owed, CreatedBy: f.OwnerUserID,
	}); err != nil {
		t.Fatalf("pay: %v", err)
	}
	if err := first.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	select {
	case r := <-got:
		if r.err != nil {
			t.Fatalf("the second transaction failed after the lock was released: %v", r.err)
		}
		if r.balance != 0 {
			t.Fatalf("the second transaction reads %d after the debt was paid off; "+
				"it is deciding against a balance that no longer exists", r.balance)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the second transaction never got the lock after the first committed")
	}
}

// TestARetriedFullPaymentStillAnswersWithThePaymentItAlreadyMade guards the
// ordering the lock had to slot into, because getting it wrong is worse than
// the race it fixes.
//
// The idempotency check runs BEFORE the balance is derived, and the lock goes
// between them. Pay a balance off in full, lose the reply, resend: by then the
// balance is zero, so a balance check running first would answer 409
// AMOUNT_EXCEEDS_BALANCE — a business rule refusing a payment that has already
// been handed over in cash, in front of somebody waiting to be paid.
func TestARetriedFullPaymentStillAnswersWithThePaymentItAlreadyMade(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del reintento exacto", 80000)
	worker := h.createWorker(t, f, "Reintento", "1212121212")
	h.settleSomething(t, f, worker, h.createPlot(t, f, "Lote reintento"))

	owed := h.balanceOf(t, f, worker)
	paymentID := uuid.NewString()
	body := map[string]any{
		"id": paymentID, "workerId": worker,
		"amountCents": owed, "date": "2026-08-26", "method": "efectivo",
	}
	h.mustDo(t, http.MethodPost, "/v1/payments", f.OwnerToken, body, http.StatusCreated)

	again := h.mustDo(t, http.MethodPost, "/v1/payments", f.OwnerToken, body, http.StatusOK)
	if again.Body["id"] != paymentID {
		t.Fatalf("the retry did not come back with the payment that was made: %s", again.Raw)
	}
}

// ---------------------------------------------------------------------------
// 3. Stock on hand, the same hole in the same shape
// ---------------------------------------------------------------------------

// TestConcurrentSalesCannotSellTheSameStockTwice. Five sales of a hundred
// against a hundred on hand left the warehouse at minus four hundred.
func TestConcurrentSalesCannotSellTheSameStockTwice(t *testing.T) {
	h := requireDB(t)

	const rounds, n = 4, 12
	for round := 0; round < rounds; round++ {
		f := h.signupFarm(t, "Finca del stock negativo", 80000)
		inv := h.seedInventory(t, f, "Cafe seco", "Bodega carrera")
		h.move(t, f, inv, "cosecha", 100, nil)

		res := h.fireConcurrently(n, 30*time.Second, func(int) (string, string, string, any) {
			return http.MethodPost, "/v1/sales", f.OwnerToken, map[string]any{
				"id": uuid.NewString(), "productId": inv.ProductID,
				"warehouseId": inv.WarehouseID, "qty": 100, "amountCents": 80_000_00,
			}
		})

		accepted := 0
		for i, r := range res {
			switch {
			case r.Status == 0:
				t.Fatalf("round %d: sale %d never came back", round, i)
			case r.Status == http.StatusCreated:
				accepted++
			case r.Status == http.StatusConflict && r.code() == string(domain.CodeInsufficientStock):
			default:
				t.Fatalf("round %d: sale %d answered %d %s; want 201 or 409 "+
					"INSUFFICIENT_STOCK", round, i, r.Status, r.Raw)
			}
		}
		if accepted != 1 {
			t.Fatalf("round %d: %d of %d concurrent sales of the whole warehouse "+
				"were accepted, want exactly 1", round, accepted, n)
		}
		if left := h.stockOf(t, f, inv.ProductID); left < 0 {
			t.Fatalf("round %d: the warehouse holds %v units. Stock on hand is "+
				"derived from the movements, so a negative total is not a display "+
				"bug: it is stock that was sold and never existed.", round, left)
		}
	}
}

// ---------------------------------------------------------------------------
// Fixtures for the above
// ---------------------------------------------------------------------------

// login opens a session and returns the refresh token.
func (h *harness) login(t *testing.T, f *farmFixture) string {
	t.Helper()
	var email string
	if err := h.admin.QueryRow(t.Context(),
		`SELECT email FROM users WHERE id = $1`, f.OwnerUserID).Scan(&email); err != nil {
		t.Fatalf("read the owner's address: %v", err)
	}
	res := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": email, "password": "una-clave-larga-1",
	}, http.StatusOK)
	return mustString(t, res.Body, "refreshToken")
}

func (h *harness) balanceOf(t *testing.T, f *farmFixture, workerID string) int64 {
	t.Helper()
	res := h.mustDo(t, http.MethodGet, "/v1/workers/"+workerID+"/balance",
		f.OwnerToken, nil, http.StatusOK)
	return mustInt(t, res.Body, "balanceCents")
}

// setTenant puts a raw transaction into the same request context the middleware
// would: one farm, one user, one role. It is the seam the two-transaction test
// needs, because that test has to hold a transaction open ACROSS another one,
// which withTenantCommit cannot do — it owns the transaction it opens.
func setTenant(ctx context.Context, tx pgx.Tx, farmID, userID string, role domain.Role) error {
	_, err := tx.Exec(ctx, `
		SELECT set_config('app.farm_id', $1, true),
		       set_config('app.role',    $2, true),
		       set_config('app.user_id', $3, true)`, farmID, string(role), userID)
	return err
}

// TestTheRevocationOfAReusedFamilySurvivesThe401 is the property that made the
// second connection look necessary in the first place, asserted directly.
//
// The whole family has to be dead AFTER the request, and the request answered
// 401 — which the tenant middleware rolls back. If tenant.KeepChanges ever
// stops working, this is what catches it, and the symptom it would otherwise
// have is the bad one: a stolen refresh token that keeps working because the
// revocation was rolled back with the error that reported it.
func TestTheRevocationOfAReusedFamilySurvivesThe401(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la familia revocada", 80000)

	first := h.login(t, f)
	rotated := h.mustDo(t, http.MethodPost, "/v1/auth/refresh", "",
		map[string]any{"refreshToken": first}, http.StatusOK)
	// The token the rotation handed back: a live member of the same family.
	live := mustString(t, rotated.Body, "refreshToken")

	reuse := h.do(t, http.MethodPost, "/v1/auth/refresh", "",
		map[string]any{"refreshToken": first})
	if reuse.code() != string(domain.CodeTokenReused) {
		t.Fatalf("reusing a rotated token: got %d %s, want TOKEN_REUSED",
			reuse.Status, reuse.Raw)
	}

	// The family is dead, including the token that was still perfectly good a
	// moment ago. That is the point of killing the family rather than the one
	// token: the server cannot tell the thief's copy from the owner's.
	after := h.do(t, http.MethodPost, "/v1/auth/refresh", "",
		map[string]any{"refreshToken": live})
	if after.Status == http.StatusOK {
		t.Fatalf("the family was not revoked, or the revocation was rolled back "+
			"with the 401 that reported it. A stolen refresh token is still "+
			"opening sessions: %s", after.Raw)
	}
	if after.code() != string(domain.CodeTokenReused) {
		t.Fatalf("the surviving token answered %d %s, want TOKEN_REUSED",
			after.Status, after.Raw)
	}
}
