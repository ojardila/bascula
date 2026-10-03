package secalert

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ojardila/bascula/services/api/internal/mailer"
)

type recorder struct {
	mu   sync.Mutex
	msgs []mailer.Message
}

func (r *recorder) Send(_ context.Context, m mailer.Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs = append(r.msgs, m)
	return nil
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.msgs)
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }
func sync1(f func())                 { f() }
func newTest(t *testing.T, mutate func(*Config)) (*Alerter, *recorder, *clock) {
	t.Helper()
	rec := &recorder{}
	c := &clock{t: time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)}
	cfg := Config{To: "ops@example.com", Stack: "test", Sender: rec, Now: c.now, Go: sync1}
	if mutate != nil {
		mutate(&cfg)
	}
	a := New(cfg)
	if a == nil {
		t.Fatal("New returned nil")
	}
	return a, rec, c
}

func TestNilAndOffAreInert(t *testing.T) {
	var a *Alerter
	a.Observe(LoginRefusals, "1.2.3.4", "x") // must not panic
	if New(Config{Sender: &recorder{}}) != nil {
		t.Fatal("no recipient must be off")
	}
	if New(Config{To: "ops@example.com"}) != nil {
		t.Fatal("no sender must be off")
	}
}

// The docs/audits.md exercise: ~200 wrong passwords from one IP in ~4.5 s.
// It must page exactly once, and say where it came from.
func TestTwoHundredPasswordsReplayPagesOnce(t *testing.T) {
	a, rec, c := newTest(t, nil)
	for i := 0; i < 200; i++ {
		a.Observe(LoginRefusals, "203.0.113.7", "email=owner@finca.co")
		c.add(22 * time.Millisecond)
	}
	if rec.count() != 1 {
		t.Fatalf("want 1 email, got %d", rec.count())
	}
	m := rec.msgs[0]
	if m.To != "ops@example.com" {
		t.Errorf("to = %q", m.To)
	}
	for _, want := range []string{"login_refusals", "203.0.113.7", "test"} {
		if !strings.Contains(m.Subject, want) {
			t.Errorf("subject %q lacks %q", m.Subject, want)
		}
	}
	if !strings.Contains(m.Body, "owner@finca.co") || !strings.Contains(m.Body, "docs/detections.md") {
		t.Errorf("body lacks detail or runbook:\n%s", m.Body)
	}
}

func TestBelowThresholdOrOutsideWindowIsQuiet(t *testing.T) {
	a, rec, c := newTest(t, nil)
	// 29 refusals, then the window passes, then 29 more: never 30 in 5 min.
	for i := 0; i < 29; i++ {
		a.Observe(LoginRefusals, "198.51.100.1", "")
	}
	c.add(6 * time.Minute)
	for i := 0; i < 29; i++ {
		a.Observe(LoginRefusals, "198.51.100.1", "")
	}
	// Other keys do not add up to one.
	for i := 0; i < 29; i++ {
		a.Observe(LoginRefusals, "198.51.100.2", "")
	}
	if rec.count() != 0 {
		t.Fatalf("want no email, got %d", rec.count())
	}
}

func TestCooldownThenPagesAgain(t *testing.T) {
	a, rec, c := newTest(t, nil)
	burst := func() {
		for i := 0; i < 30; i++ {
			a.Observe(ServerErrors, "farm-1", "")
		}
	}
	burst()
	c.add(30 * time.Minute)
	burst()
	if rec.count() != 1 {
		t.Fatalf("inside cooldown: want 1 email, got %d", rec.count())
	}
	c.add(31 * time.Minute)
	burst()
	if rec.count() != 2 {
		t.Fatalf("after cooldown: want 2 emails, got %d", rec.count())
	}
}

func TestHourlyBudgetCapsASpray(t *testing.T) {
	a, rec, _ := newTest(t, func(c *Config) { c.MaxPerHour = 3 })
	for k := 0; k < 50; k++ {
		key := "10.0.0." + string(rune('a'+k%26)) + string(rune('a'+k/26))
		for i := 0; i < 30; i++ {
			a.Observe(LoginRefusals, key, "")
		}
	}
	if rec.count() != 3 {
		t.Fatalf("want 3 emails, got %d", rec.count())
	}
}

func TestSilenceMutesDeliveryUntilItEnds(t *testing.T) {
	var a *Alerter
	var rec *recorder
	var c *clock
	a, rec, c = newTest(t, func(cfg *Config) {
		cfg.SilenceUntil = time.Date(2026, 10, 2, 12, 30, 0, 0, time.UTC)
	})
	for i := 0; i < 30; i++ {
		a.Observe(MCPFailures, "user-1", "")
	}
	if rec.count() != 0 {
		t.Fatalf("silenced: want 0, got %d", rec.count())
	}
	c.add(2 * time.Hour)
	for i := 0; i < 30; i++ {
		a.Observe(MCPFailures, "user-1", "")
	}
	if rec.count() != 1 {
		t.Fatalf("after silence: want 1, got %d", rec.count())
	}
}

func TestKeySprayIsBounded(t *testing.T) {
	a, rec, _ := newTest(t, func(c *Config) { c.MaxKeys = 5 })
	for k := 0; k < 100; k++ {
		a.Observe(LoginRefusals, strings.Repeat("x", k+1), "")
	}
	if len(a.hits) > 6 {
		t.Fatalf("hits grew to %d keys", len(a.hits))
	}
	// The overflow bucket itself crosses the threshold and pages.
	if rec.count() != 1 || !strings.Contains(rec.msgs[0].Subject, "overflow") {
		t.Fatalf("want one overflow page, got %d %v", rec.count(), rec.msgs)
	}
}

func TestFromEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	a, w, err := FromEnv(env(nil), &recorder{}, "s")
	if a != nil || w != nil || err != nil {
		t.Fatalf("unset: %v %v %v", a, w, err)
	}
	if _, _, err := FromEnv(env(map[string]string{"SECURITY_ALERT_EMAIL": "nope"}), &recorder{}, "s"); err == nil {
		t.Fatal("bad address must refuse to boot")
	}
	a, w, err = FromEnv(env(map[string]string{"SECURITY_ALERT_EMAIL": "ops@example.com"}), nil, "s")
	if a != nil || len(w) != 1 || err != nil {
		t.Fatalf("no mailer: %v %v %v", a, w, err)
	}
	a, w, err = FromEnv(env(map[string]string{
		"SECURITY_ALERT_EMAIL": "Ops <ops@example.com>", "SECURITY_ALERT_SILENCE_UNTIL": "tomorrow",
	}), &recorder{}, "s")
	if a == nil || len(w) != 1 || err != nil || a.cfg.To != "ops@example.com" {
		t.Fatalf("bad silence must warn, not fail: %v %v %v", a, w, err)
	}
	a, _, _ = FromEnv(env(map[string]string{
		"SECURITY_ALERT_EMAIL": "ops@example.com", "SECURITY_ALERT_SILENCE_UNTIL": "2026-10-03T00:00:00Z",
	}), &recorder{}, "s")
	if !a.cfg.SilenceUntil.Equal(time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("silence = %v", a.cfg.SilenceUntil)
	}
}
