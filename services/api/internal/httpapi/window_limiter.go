package httpapi

import (
	"sync"
	"time"
)

// windowLimiter allows at most max events per key in any window. It lives in
// memory, so with several replicas each counts its own share: it bounds
// abuse, it is not an exact quota. A limiter with max <= 0 allows everything.
type windowLimiter struct {
	max    int
	window time.Duration

	mu     sync.Mutex
	events map[string][]time.Time
	swept  time.Time
}

func newWindowLimiter(max int, window time.Duration) *windowLimiter {
	return &windowLimiter{max: max, window: window, events: map[string][]time.Time{}}
}

// allow records an event for key and reports whether it is within the limit.
// A refused event is not recorded, so a caller who keeps knocking after the
// door has shut does not keep it shut.
func (l *windowLimiter) allow(key string, now time.Time) bool {
	if l == nil || l.max <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := now.Add(-l.window)
	if now.Sub(l.swept) > l.window {
		for k, ts := range l.events {
			if len(ts) == 0 || !ts[len(ts)-1].After(cutoff) {
				delete(l.events, k)
			}
		}
		l.swept = now
	}
	ts := l.events[key]
	i := 0
	for i < len(ts) && !ts[i].After(cutoff) {
		i++
	}
	ts = ts[i:]
	if len(ts) >= l.max {
		l.events[key] = ts
		return false
	}
	l.events[key] = append(ts, now)
	return true
}
