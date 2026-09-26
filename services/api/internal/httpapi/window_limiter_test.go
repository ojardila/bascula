package httpapi

import (
	"testing"
	"time"
)

func TestWindowLimiter(t *testing.T) {
	l := newWindowLimiter(2, time.Hour)
	t0 := time.Date(2026, 9, 26, 10, 0, 0, 0, time.UTC)
	if !l.allow("a", t0) || !l.allow("a", t0.Add(time.Minute)) {
		t.Fatal("the first two must pass")
	}
	if l.allow("a", t0.Add(2*time.Minute)) {
		t.Fatal("the third inside the window must be refused")
	}
	if !l.allow("b", t0.Add(2*time.Minute)) {
		t.Fatal("another key has its own count")
	}
	// Refusals are not counted: once the first event leaves the window, one
	// more is allowed even though the caller kept knocking.
	for i := 0; i < 10; i++ {
		l.allow("a", t0.Add(30*time.Minute))
	}
	if !l.allow("a", t0.Add(time.Hour+time.Second)) {
		t.Fatal("the window must drain")
	}
	if newWindowLimiter(0, time.Hour).allow("x", t0) != true {
		t.Fatal("zero means no cap")
	}
}
