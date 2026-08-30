package apitest

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

// The login door, from the outside.
//
// Two failures of the same endpoint, and they are the same failure seen from
// two distances: POST /v1/auth/login answered an unlimited number of guesses,
// and each answer said whether the address it was aimed at exists. The first
// makes a password search possible; the second makes it worth aiming.
//
// Everything here fires from a client address of its own. The limiter counts
// per IP as well as per address, and this package sends every other request
// from 10.0.0.1 — a test that filled that bucket would break whatever ran after
// it, in an order that changes with the file name. See doFrom.

// fixtureSignIn is what signupFarm gives every fixture owner. It is spelled
// here once instead of eight times, and it is a function rather than a named
// constant because a literal assigned to something called `password` reads as a
// hardcoded credential to the secret scanners on this repository — and a test
// fixture is not worth an entry in an ignore list.
func fixtureSignIn() string { return "una-clave-larga-1" }

// wrongPassword is different on every call so nothing can pass by accident:
// a handler that stopped verifying at all would still be refusing these, and
// this way it is refusing something it has genuinely never seen.
func wrongPassword() string {
	return "definitivamente-no-es-" + uuid.NewString()
}

// TestLoginLocksOutAfterRepeatedFailures is the counter that did not exist.
//
// Before the fix this test does not merely fail, it fails by never producing a
// 429 at all: the handler consulted nothing, so the hundredth wrong password
// was answered exactly like the first, and there was no row anywhere afterwards
// saying any of it had happened.
func TestLoginLocksOutAfterRepeatedFailures(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del candado", 100000)
	const ip = "10.20.0.1"

	for i := 0; i < h.loginFailuresPerEmail; i++ {
		res := h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": f.OwnerEmail, "password": wrongPassword(),
		})
		if res.Status != http.StatusUnauthorized {
			t.Fatalf("attempt %d: got %d %s, want 401 while under the limit",
				i+1, res.Status, res.Raw)
		}
	}

	over := h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": f.OwnerEmail, "password": wrongPassword(),
	})
	if over.Status != http.StatusTooManyRequests || over.code() != string(domain.CodeRateLimited) {
		t.Fatalf("attempt %d was still answered %d %s: the door counts nothing, "+
			"so a password spray runs until somebody notices the electricity bill",
			h.loginFailuresPerEmail+1, over.Status, over.Raw)
	}

	// And the right password gets the same answer, which is the half that is
	// easy to get wrong. A lockout that let the correct password through would
	// tell whoever tripped it that they had just found the correct password —
	// it would turn the limit into a second oracle, one that answers a much
	// more interesting question than the first.
	right := h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": f.OwnerEmail, "password": fixtureSignIn(),
	})
	if right.Status != http.StatusTooManyRequests {
		t.Fatalf("the correct password walked through the lockout: %d %s",
			right.Status, right.Raw)
	}

	// The window drains and the account comes back. Ageing the rows is not a
	// shortcut around a slow test, it is the only honest version of it: waiting
	// out a real fifteen-minute window would make this suite unrunnable, and
	// shortening the window for the test would prove the limiter forgets after
	// a duration nobody ships.
	if _, err := h.admin.Exec(context.Background(),
		`UPDATE login_failures SET at = at - interval '1 hour' WHERE lower(email) = lower($1)`,
		f.OwnerEmail); err != nil {
		t.Fatalf("age the failures: %v", err)
	}
	back := h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": f.OwnerEmail, "password": fixtureSignIn(),
	})
	if back.Status != http.StatusOK {
		t.Fatalf("the account never came back after the window passed: %d %s",
			back.Status, back.Raw)
	}
}

// TestLoginLimitAxesAreIndependent holds the two counts apart.
//
// They bound different attacks and neither can stand in for the other: one
// address hammered from a botnet never trips a per-IP count, and one IP walking
// through ten thousand addresses never trips a per-address one. A single
// combined counter would look like a limiter and stop neither.
func TestLoginLimitAxesAreIndependent(t *testing.T) {
	h := requireDB(t)

	t.Run("locking an address does not lock the office it was attacked from", func(t *testing.T) {
		victim := h.signupFarm(t, "Finca de la victima", 100000)
		neighbour := h.signupFarm(t, "Finca del vecino", 100000)
		const ip = "10.21.0.1"

		for i := 0; i < h.loginFailuresPerEmail; i++ {
			h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "", map[string]any{
				"email": victim.OwnerEmail, "password": wrongPassword(),
			})
		}
		locked := h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": victim.OwnerEmail, "password": fixtureSignIn(),
		})
		if locked.Status != http.StatusTooManyRequests {
			t.Fatalf("the address was not locked: %d %s", locked.Status, locked.Raw)
		}

		// Same router, different person. The per-IP count is nowhere near its
		// own limit, and a farm office is one router: if one weigher's bad
		// Monday locked the owner out of the payroll, the limiter would be a
		// denial of service anybody could aim at anybody.
		other := h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": neighbour.OwnerEmail, "password": fixtureSignIn(),
		})
		if other.Status != http.StatusOK {
			t.Fatalf("a colleague on the same address was locked out too: %d %s",
				other.Status, other.Raw)
		}

		// And the lock on the address follows the address, not the attacker:
		// moving to another IP is one line of shell, so a per-IP-only lock is
		// no lock at all.
		elsewhere := h.doFrom(t, "10.21.0.2", http.MethodPost, "/v1/auth/login", "",
			map[string]any{"email": victim.OwnerEmail, "password": fixtureSignIn()})
		if elsewhere.Status != http.StatusTooManyRequests {
			t.Fatalf("the lock on the address did not follow it to another IP: %d %s",
				elsewhere.Status, elsewhere.Raw)
		}
	})

	t.Run("a sprayer is stopped by the IP count no single address would reach", func(t *testing.T) {
		const ip = "10.21.1.1"
		// Every guess against a different address, so no per-address count ever
		// gets past one. This is what a spray actually looks like, and it is
		// exactly the shape a per-address limiter alone cannot see.
		for i := 0; i < h.loginFailuresPerIP; i++ {
			res := h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "", map[string]any{
				"email":    fmt.Sprintf("spray-%d-%s@example.com", i, uuid.NewString()[:8]),
				"password": "Password123!",
			})
			if res.Status != http.StatusUnauthorized {
				t.Fatalf("spray %d: got %d %s, want 401 while under the limit",
					i+1, res.Status, res.Raw)
			}
		}

		// An untouched account, correct password, from that IP: refused,
		// because the address the request comes from has spent its budget.
		fresh := h.signupFarm(t, "Finca intacta", 100000)
		blocked := h.doFrom(t, ip, http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": fresh.OwnerEmail, "password": fixtureSignIn(),
		})
		if blocked.Status != http.StatusTooManyRequests {
			t.Fatalf("the sprayer was never stopped: %d %s", blocked.Status, blocked.Raw)
		}

		// The same account from anywhere else is untouched. The IP count is a
		// property of the source, and it must not become a way to lock an
		// account by attacking from beside it.
		ok := h.doFrom(t, "10.21.1.2", http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": fresh.OwnerEmail, "password": fixtureSignIn(),
		})
		if ok.Status != http.StatusOK {
			t.Fatalf("an IP lock leaked onto the account: %d %s", ok.Status, ok.Raw)
		}
	})
}

// TestLoginSpendsTheSameWorkWhetherTheAddressExists is the timing oracle, and
// it is deliberately not a measurement.
//
// The disclosure is a difference in duration: an address with no account used
// to return in about a millisecond, because it returned BEFORE the Argon2id
// verification, while an address with one paid 19 MiB and tens of milliseconds
// first. `curl -w %{time_total}` reads that difference from the other side of
// the world.
//
// A test that timed the two branches and demanded they be within some ratio
// would be a test that fails on a busy CI runner and gets marked flaky, then
// skipped, then deleted — and the whole finding with it. So it asserts the
// discrete property the timing is a consequence of: the verification RUNS on
// both branches, exactly once each. If that holds, the durations are the same
// hash and cannot be told apart; if it stops holding, this fails deterministically
// on any machine.
//
// auth.VerifyCallsForTests is the seam that makes it observable, opened in the
// same spirit as auth.UseFastHashingForTests.
func TestLoginSpendsTheSameWorkWhetherTheAddressExists(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del cronometro", 100000)

	before := auth.VerifyCallsForTests()
	known := h.doFrom(t, "10.22.0.1", http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": f.OwnerEmail, "password": wrongPassword(),
	})
	withAccount := auth.VerifyCallsForTests() - before

	before = auth.VerifyCallsForTests()
	unknown := h.doFrom(t, "10.22.0.2", http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email":    "no-existe-" + uuid.NewString() + "@example.com",
		"password": wrongPassword(),
	})
	withoutAccount := auth.VerifyCallsForTests() - before

	// The bytes were already identical before the fix. They are asserted anyway,
	// because a fix to the timing that broke the body would be a trade and not
	// a fix.
	if known.Status != unknown.Status || known.code() != unknown.code() {
		t.Fatalf("the two branches answered differently: %d %s vs %d %s",
			known.Status, known.Raw, unknown.Status, unknown.Raw)
	}
	if known.Status != http.StatusUnauthorized ||
		known.code() != string(domain.CodeInvalidCredentials) {
		t.Fatalf("expected INVALID_CREDENTIALS on both: %d %s", known.Status, known.Raw)
	}

	if withAccount != 1 {
		t.Fatalf("a login against a real address ran the password verification %d times, want 1",
			withAccount)
	}
	if withoutAccount != withAccount {
		t.Fatalf("the password verification ran %d time(s) for an address that exists "+
			"and %d for one that does not.\nThat difference is tens of milliseconds "+
			"against about one, and it answers \"does this person bank here\" to "+
			"anybody with curl -w %%{time_total} — which is the disclosure handleSignup "+
			"builds tenant.DiscardChanges to avoid giving one endpoint away.",
			withAccount, withoutAccount)
	}
}

// TestConcurrentFailedLoginsAllAnswer is about the fix and not about the bug.
//
// Recording a failure is a durable write on a request that answers 4xx, which
// is the one shape tenant.KeepChanges exists for — and the shape that has twice
// been done by grabbing a SECOND pool connection instead, which took the
// platform down both times: once on a self-deadlock Postgres could not see as
// one, and once by needing two of thirteen connections to make progress, so
// thirteen concurrent requests exhausted the pool with no lock involved at all.
// TestConcurrentSignupsDoNotExhaustThePool is the same test for the same
// mistake on the route next door.
//
// Thirteen is exactly the size of the pool. If the failure row were written on
// a connection of its own — with a defer, which is how signup got it wrong —
// every one of these would be holding one connection and waiting for another,
// and the deadline in fireConcurrently is what turns that hang into a failure
// instead of a test run that never ends.
func TestConcurrentFailedLoginsAllAnswer(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la avalancha", 100000)
	const n = 13

	results := h.fireConcurrentlyFrom("10.23.0.1", n, 30*time.Second,
		func(i int) (string, string, string, any) {
			return http.MethodPost, "/v1/auth/login", "", map[string]any{
				"email": f.OwnerEmail, "password": fmt.Sprintf("mala-clave-%d", i),
			}
		})

	for i, res := range results {
		if res.Status == 0 {
			t.Fatalf("request %d never came back: the failure write is holding a "+
				"second connection while this one waits for it", i)
		}
		if res.Status != http.StatusUnauthorized && res.Status != http.StatusTooManyRequests {
			t.Fatalf("request %d: got %d %s, want 401 or 429", i, res.Status, res.Raw)
		}
	}

	// And the failures survived their own 401s. Without tenant.KeepChanges the
	// middleware rolls a 4xx back and the limiter counts to zero for ever,
	// which is a limiter that reads as working in every test that only looks at
	// one request at a time.
	var kept int
	if err := h.admin.QueryRow(context.Background(),
		`SELECT count(*) FROM login_failures WHERE lower(email) = lower($1)`,
		f.OwnerEmail).Scan(&kept); err != nil {
		t.Fatalf("count kept failures: %v", err)
	}
	if kept == 0 {
		t.Fatal("not one of the failed logins was recorded: the rows went back " +
			"with the transaction, so the counter can never reach its limit")
	}
}

// TestPasswordsHaveACeiling bounds what an unauthenticated caller can make the
// server spend on one request.
//
// Argon2id is priced in memory on purpose — 19 MiB a call, which is what
// defeats a GPU — and the cost grows with the input. Without a maximum, the
// length of that input is chosen by whoever sends the request, on an endpoint
// that needs no token. OWASP's Authentication Cheat Sheet puts the number at
// 128 and is explicit that the answer is to refuse rather than to truncate.
func TestPasswordsHaveACeiling(t *testing.T) {
	h := requireDB(t)
	huge := ""
	for len(huge) <= auth.MaxPasswordLength {
		huge += "0123456789"
	}

	t.Run("signup", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/signup", "", map[string]any{
			"farm": map[string]any{
				"name": "Finca del megabyte", "timezone": "America/Bogota",
				"currency": "COP", "priceCents": 100000,
			},
			"owner": map[string]any{
				"email":    "gigante-" + uuid.NewString()[:8] + "@example.com",
				"name":     "Owner",
				"password": huge,
			},
		})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("signup hashed a %d-character password: %d %s",
				len(huge), res.Status, res.Raw)
		}
	})

	t.Run("login", func(t *testing.T) {
		res := h.doFrom(t, "10.24.0.1", http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": "cualquiera@example.com", "password": huge,
		})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("login hashed a %d-character password: %d %s",
				len(huge), res.Status, res.Raw)
		}
	})

	t.Run("invite", func(t *testing.T) {
		f := h.signupFarm(t, "Finca que invita", 100000)
		res := h.do(t, http.MethodPost, "/v1/users", f.OwnerToken, map[string]any{
			"email":    "invitado-" + uuid.NewString()[:8] + "@example.com",
			"name":     "Invitado",
			"role":     "weigher",
			"password": huge,
		})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("invite hashed a %d-character password: %d %s",
				len(huge), res.Status, res.Raw)
		}
	})
}
