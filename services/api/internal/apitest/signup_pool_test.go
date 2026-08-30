package apitest

import (
	"fmt"
	"net/http"
	"testing"
	"time"
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

	n := 13 // store.OrdinaryConns + store.MaxImportsAtOnce
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
	// Without it the test proves only that thirteen requests finished. A fix
	// that moved the second connection somewhere else in the same request —
	// out of the defer and into the handler body, say — would keep them
	// finishing while a fourteenth caller still found no connection left, and
	// this test would pass through it. The sentence below is the one that does
	// not.
	other := h.signupFarm(t, "Finca vecina del pool", 90000)
	after := h.fireConcurrently(1, 10*time.Second, func(int) (string, string, string, any) {
		return http.MethodGet, "/v1/workers", other.OwnerToken, nil
	})
	if after[0].Status != http.StatusOK {
		t.Fatalf("another farm's worker list answered %d while thirteen signups "+
			"were in flight: %s", after[0].Status, after[0].Raw)
	}
}
