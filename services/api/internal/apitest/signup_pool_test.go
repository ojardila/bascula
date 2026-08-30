package apitest

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/ojardila/bascula/services/api/internal/store"
)

// TestConcurrentSignupsDoNotExhaustThePool is the failure tenant.go warns
// about, on the one route that needs no credential at all.
//
// handleSignup runs inside the request transaction — so it is holding one of
// the pool's connections — and registers a defer that asks s.pool for a
// SECOND one to write the attempt row. The defer runs before the middleware
// commits, so both are wanted at once. With MaxConns at
// OrdinaryConns+MaxImportsAtOnce, that many concurrent signups take every
// connection and then all wait for one more.
func TestConcurrentSignupsDoNotExhaustThePool(t *testing.T) {
	h := requireDB(t)

	// The neighbour farm is created BEFORE the storm, not after. signupFarm
	// goes through ServeHTTP with no deadline of its own, so in the exact state
	// this test exists to report — the thirteen leaking their connections
	// instead of returning them — a signup issued afterwards blocks forever,
	// the go-test timeout kills the run, and the assertion below is never
	// reached. Created first, it costs nothing and it always reports.
	other := h.signupFarm(t, "Finca vecina del pool", 90000)

	// Not a literal. The claim this test makes is EXACT — that the pool's whole
	// capacity is what thirteen unauthenticated requests take — so it has to
	// keep being the capacity when somebody changes the capacity. A comment
	// saying 13 is a comment; this is the number.
	n := store.OrdinaryConns + store.MaxImportsAtOnce
	res := h.fireConcurrently(n, 20*time.Second, func(i int) (string, string, string, any) {
		return "POST", "/v1/signup", "", map[string]any{
			"farm": map[string]any{"name": fmt.Sprintf("Finca %d", i), "priceCents": 1000},
			"owner": map[string]any{
				"email":    fmt.Sprintf("pool%d@example.com", i),
				"name":     "Owner",
				"password": "0123456789",
			},
		}
	})

	for i, r := range res {
		if r.Status == 0 {
			t.Fatalf("signup %d of %d never came back; the pool is gone and with "+
				"it every farm's everything", i, n)
		}
	}

	// And the rest of the API is still there, from a farm that had nothing to
	// do with any of this, which is the part that makes this a platform outage
	// rather than thirteen strangers' problem.
	//
	// Without it the test proves only that thirteen requests finished, and
	// there is a real state where all thirteen finish and the platform is
	// still gone: a LEAKED connection. If the attempt-row write acquires off
	// the request goroutine and never releases — the callback returning while
	// its connection stays out — every signup answers 201 in milliseconds and
	// the pool is empty behind them. Measured: the loop above passes in 0.05s
	// with nothing left to serve anybody. (A connection merely MOVED within
	// the request — out of the defer into the handler body — deadlocks all
	// thirteen and the loop above already catches it. That is not the gap.)
	// The sentence below is the one that closes the real one.
	after := h.fireConcurrently(1, 10*time.Second, func(int) (string, string, string, any) {
		return http.MethodGet, "/v1/workers", other.OwnerToken, nil
	})
	if after[0].Status != http.StatusOK {
		t.Fatalf("another farm's worker list answered %d after %d concurrent "+
			"signups: %s", after[0].Status, n, after[0].Raw)
	}
}
