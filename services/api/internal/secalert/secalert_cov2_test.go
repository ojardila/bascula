// SPDX-License-Identifier: MIT

package secalert

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/ojardila/bascula/services/api/internal/mailer"
)

type c2otFailingSender struct{ calls int }

func (s *c2otFailingSender) Send(context.Context, mailer.Message) error {
	s.calls++
	return errors.New("smtp: connection refused")
}

// c2otLogs captures the default logger for the duration of the test.
func c2otLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

func TestDescribe(t *testing.T) {
	var off *Alerter
	if got := off.Describe(); got != "off" {
		t.Fatalf("nil Describe = %q", got)
	}
	a, _, c := newTest(t, func(cfg *Config) {
		cfg.SilenceUntil = time.Date(2026, 10, 2, 13, 0, 0, 0, time.UTC)
	})
	got := a.Describe()
	for _, want := range []string{"to=ops@example.com", "cooldown=1h0m0s", "max/h=10", "login_refusals>=30/5m0s", "silenced-until=2026-10-02T13:00:00Z"} {
		if !strings.Contains(got, want) {
			t.Errorf("Describe = %q, missing %q", got, want)
		}
	}
	c.add(2 * time.Hour)
	if got := a.Describe(); strings.Contains(got, "silenced-until") {
		t.Fatalf("a silence in the past is not mentioned: %q", got)
	}
}

// A signal without a rule, or with a rule that cannot fire, is ignored.
func TestObserveIgnoresSignalsWithoutAUsableRule(t *testing.T) {
	a, rec, _ := newTest(t, func(cfg *Config) {
		cfg.Rules = map[Signal]Rule{
			LoginRefusals: {Threshold: 0, Window: time.Minute},
			MCPFailures:   {Threshold: 1, Window: 0},
		}
	})
	for i := 0; i < 5; i++ {
		a.Observe(LoginRefusals, "1.2.3.4", "")
		a.Observe(MCPFailures, "user", "")
		a.Observe(ServerErrors, "farm", "")
	}
	if rec.count() != 0 || len(a.hits) != 0 {
		t.Fatalf("sent %d, tracked %d keys; want nothing", rec.count(), len(a.hits))
	}
}

// An empty key is counted under "-", and the default stack name is bascula.
func TestEmptyKeyAndDefaultStack(t *testing.T) {
	a, rec, _ := newTest(t, func(cfg *Config) {
		cfg.Stack = ""
		cfg.Rules = map[Signal]Rule{OAuthErrors: {Threshold: 2, Window: time.Minute, Summary: "s", Response: "r"}}
	})
	a.Observe(OAuthErrors, "", "")
	a.Observe(OAuthErrors, "", "")
	if rec.count() != 1 {
		t.Fatalf("sent %d, want 1", rec.count())
	}
	m := rec.msgs[0]
	if !strings.Contains(m.Subject, ", - (bascula)") {
		t.Fatalf("subject = %q", m.Subject)
	}
	if !strings.Contains(m.Body, "on bascula.") || !strings.Contains(m.Body, "Key:       -\n") || strings.Contains(m.Body, "Last event:") {
		t.Fatalf("body = %q", m.Body)
	}
}

// A mail that fails to send is logged and does not fail the caller.
func TestFailedDeliveryIsLogged(t *testing.T) {
	logs := c2otLogs(t)
	snd := &c2otFailingSender{}
	a, _, _ := newTest(t, func(cfg *Config) {
		cfg.Sender = snd
		cfg.Rules = map[Signal]Rule{ServerErrors: {Threshold: 1, Window: time.Minute}}
	})
	a.Observe(ServerErrors, "farm-1", "GET /v1/x")
	if snd.calls != 1 {
		t.Fatalf("send attempts = %d, want 1", snd.calls)
	}
	out := logs.String()
	if !strings.Contains(out, "security alert email") || !strings.Contains(out, "connection refused") || !strings.Contains(out, "signal=server_errors") {
		t.Fatalf("log = %q", out)
	}
}
