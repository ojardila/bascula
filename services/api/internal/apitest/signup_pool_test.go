package apitest

import (
	"fmt"
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

	stuck := 0
	for i, r := range res {
		if r.Status == 0 {
			stuck++
			t.Logf("request %d never came back", i)
		}
	}
	if stuck > 0 {
		t.Fatalf("%d of %d concurrent signups never answered: the pool is deadlocked", stuck, n)
	}
}
