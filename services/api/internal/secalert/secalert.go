// SPDX-License-Identifier: MIT

// Package secalert turns a handful of security-relevant events into an email
// to an operator, through the mailer the API already has.
//
// It is the thin first slice of issue #312: the limiter in front of the login
// door held during the 200-passwords exercise (docs/audits.md), and nobody
// would have known until they read the table. The events were already there —
// login_failures, mcp_audit, the "server error" log line — what was missing is
// somebody being told while it happens.
//
// # Shape
//
// Callers report events with Observe(signal, key, detail). Each signal has a
// Rule: a threshold within a sliding window, counted per key (an IP, a user,
// a farm). When a key crosses the threshold, one email goes to the operator
// address and one "security alert" line goes to the log.
//
// # Low noise, on purpose
//
//   - Per (signal, key) cooldown: once a key has alerted it stays quiet for
//     Cooldown (1 h by default), however hard the attack keeps knocking. A
//     drill pages once, not two hundred times.
//   - A global budget (MaxPerHour) caps the mail across every key, so a spray
//     from a thousand addresses is a few emails and a log, not a mailbox
//     flood.
//   - SilenceUntil mutes delivery during a planned drill. Crossings are still
//     logged (with silenced=true) so the drill leaves evidence.
//
// # Inert by default
//
// A nil *Alerter accepts every call and does nothing, and New returns nil
// when there is no recipient or no mailer. A stack that never set
// SECURITY_ALERT_EMAIL behaves exactly as it did before this package existed.
//
// The counts live in memory and per process. That is fine for this API (one
// replica per stack), and the thresholds are set far above what a person
// typing produces, so a restart losing a half-filled window costs nothing
// that matters.
package secalert

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/ojardila/bascula/services/api/internal/logsafe"
	"github.com/ojardila/bascula/services/api/internal/mailer"
)

// Signal names one detection. The names are the ones docs/detections.md uses.
type Signal string

// The signals wired in this slice. docs/detections.md lists each with its
// query, threshold and the response expected.
const (
	// LoginRefusals is every refused sign-in (bad password, bad passkey, or
	// refused by the limiter), keyed by client IP.
	LoginRefusals Signal = "login_refusals"
	// MCPFailures is an assistant's write tool ending in "failed" or
	// "refused", keyed by user.
	MCPFailures Signal = "mcp_failures"
	// ServerErrors is a 5xx answered on the API, keyed by farm.
	ServerErrors Signal = "server_errors"
	// OAuthErrors is an OAuth authorize request sent back to the client with
	// an error, keyed by OAuth client.
	OAuthErrors Signal = "oauth_errors"
)

// Rule is when a signal pages, and what the person paged should do.
type Rule struct {
	Threshold int
	Window    time.Duration
	// Summary is the one-line meaning, Response the first thing to do.
	Summary  string
	Response string
}

// DefaultRules are the production thresholds. They are deliberately far above
// ordinary use: a person mistyping a password a few times, an assistant
// retrying a write, a single bad deploy request. See docs/detections.md.
func DefaultRules() map[Signal]Rule {
	return map[Signal]Rule{
		LoginRefusals: {
			Threshold: 30, Window: 5 * time.Minute,
			Summary:  "many refused sign-ins from one IP (password guessing / credential stuffing)",
			Response: "Check login_failures for the IP; the limiter is already refusing it. Block the IP at Cloudflare if it continues; tell the owner of any targeted address.",
		},
		MCPFailures: {
			Threshold: 10, Window: 10 * time.Minute,
			Summary:  "an assistant's writes keep failing or being refused for one user",
			Response: "Read mcp_audit for the user; revoke the connector from Ajustes > Asistentes if the writes are not the owner's intent.",
		},
		ServerErrors: {
			Threshold: 10, Window: 5 * time.Minute,
			Summary:  "a burst of 5xx answers on the API for one farm",
			Response: `Read the API log for "server error" lines (kubectl logs deploy/bascula-api); roll back the last release if it started with a deploy.`,
		},
		OAuthErrors: {
			Threshold: 20, Window: 15 * time.Minute,
			Summary:  "OAuth authorize requests sent back with an error above baseline",
			Response: "Look at the connector log lines (path=/oauth/*) for the client; a probe of redirect URIs or a broken connector both show here.",
		},
	}
}

// Config builds an Alerter.
type Config struct {
	// To is the operator address. Empty means off.
	To string
	// Stack names this deployment in the subject (bascula.engp.io, a farm
	// slug, …) so one inbox can tell stacks apart.
	Stack  string
	Sender mailer.Sender
	Rules  map[Signal]Rule
	// Cooldown is how long a (signal, key) that alerted stays quiet.
	Cooldown time.Duration
	// MaxPerHour bounds the emails across all keys.
	MaxPerHour int
	// SilenceUntil mutes delivery (not logging) until then.
	SilenceUntil time.Time
	// MaxKeys bounds the memory a key-spraying caller can make this hold.
	MaxKeys int
	// Now and Go are for tests: the clock, and how a send is started.
	Now func() time.Time
	Go  func(func())
}

// Alerter counts events and sends alerts. The zero of *Alerter (nil) is off.
type Alerter struct {
	cfg Config

	mu    sync.Mutex
	hits  map[string][]time.Time // signal|key -> recent event times
	quiet map[string]time.Time   // signal|key -> last alert
	sent  []time.Time            // emails in the last hour
	swept time.Time
}

// New returns nil — off — when there is no recipient or no sender.
func New(cfg Config) *Alerter {
	if strings.TrimSpace(cfg.To) == "" || cfg.Sender == nil {
		return nil
	}
	if cfg.Rules == nil {
		cfg.Rules = DefaultRules()
	}
	if cfg.Cooldown <= 0 {
		cfg.Cooldown = time.Hour
	}
	if cfg.MaxPerHour <= 0 {
		cfg.MaxPerHour = 10
	}
	if cfg.MaxKeys <= 0 {
		cfg.MaxKeys = 10000
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Go == nil {
		cfg.Go = func(f func()) { go f() }
	}
	return &Alerter{cfg: cfg, hits: map[string][]time.Time{}, quiet: map[string]time.Time{}}
}

// Describe is for the startup log.
func (a *Alerter) Describe() string {
	if a == nil {
		return "off"
	}
	names := make([]string, 0, len(a.cfg.Rules))
	for s, r := range a.cfg.Rules {
		names = append(names, fmt.Sprintf("%s>=%d/%s", s, r.Threshold, r.Window))
	}
	sort.Strings(names)
	d := fmt.Sprintf("to=%s cooldown=%s max/h=%d rules=[%s]", a.cfg.To, a.cfg.Cooldown, a.cfg.MaxPerHour, strings.Join(names, " "))
	if a.cfg.SilenceUntil.After(a.cfg.Now()) {
		d += " silenced-until=" + a.cfg.SilenceUntil.UTC().Format(time.RFC3339)
	}
	return d
}

// Observe records one event. It never blocks on the network and never fails
// the request that reported it.
func (a *Alerter) Observe(sig Signal, key, detail string) {
	if a == nil {
		return
	}
	rule, ok := a.cfg.Rules[sig]
	if !ok || rule.Threshold <= 0 || rule.Window <= 0 {
		return
	}
	// Keys and details come from requests (an IP, a client_id, an email).
	// They go into a log line and an email subject, so they are neutralised
	// and bounded here, once, before anything reads them.
	key, detail = clip(logsafe.Str(key), 120), clip(logsafe.Str(detail), 300)
	if key == "" {
		key = "-"
	}
	now := a.cfg.Now()
	id := string(sig) + "|" + key

	a.mu.Lock()
	a.sweep(now)
	ts, seen := a.hits[id]
	if !seen && len(a.hits) >= a.cfg.MaxKeys {
		// Full: a caller is spraying keys. Fold the overflow into one key so
		// the spray itself still counts instead of being forgotten.
		id = string(sig) + "|overflow"
		key = "overflow"
		ts = a.hits[id]
	}
	cutoff := now.Add(-rule.Window)
	i := 0
	for i < len(ts) && !ts[i].After(cutoff) {
		i++
	}
	ts = append(ts[i:], now)
	// Only the newest Threshold times matter to the decision.
	if len(ts) > rule.Threshold {
		ts = ts[len(ts)-rule.Threshold:]
	}
	a.hits[id] = ts
	if len(ts) < rule.Threshold {
		a.mu.Unlock()
		return
	}
	if last, ok := a.quiet[id]; ok && now.Sub(last) < a.cfg.Cooldown {
		a.mu.Unlock()
		return
	}
	a.quiet[id] = now
	first := ts[0]
	silenced := now.Before(a.cfg.SilenceUntil)
	budget := a.spend(now, silenced)
	a.mu.Unlock()

	slog.Warn("security alert",
		"signal", string(sig), "key", key, "count", len(ts), "window", rule.Window.String(),
		"detail", detail, "silenced", silenced, "mailed", budget)
	if !budget {
		return
	}
	m := mailer.Message{
		To:      a.cfg.To,
		Subject: fmt.Sprintf("[bascula security] %s: %d in %s, %s (%s)", sig, len(ts), rule.Window, key, a.stack()),
		Body:    a.body(sig, rule, key, detail, len(ts), first, now),
	}
	send := a.cfg.Sender
	a.cfg.Go(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		if err := send.Send(ctx, m); err != nil {
			slog.Error("security alert email", "signal", string(sig), "err", err)
		}
	})
}

// spend takes one email from the hourly budget. Called with mu held.
func (a *Alerter) spend(now time.Time, silenced bool) bool {
	if silenced {
		return false
	}
	cutoff := now.Add(-time.Hour)
	i := 0
	for i < len(a.sent) && !a.sent[i].After(cutoff) {
		i++
	}
	a.sent = a.sent[i:]
	if len(a.sent) >= a.cfg.MaxPerHour {
		return false
	}
	a.sent = append(a.sent, now)
	return true
}

// sweep drops keys with nothing left in any window. Called with mu held.
func (a *Alerter) sweep(now time.Time) {
	if now.Sub(a.swept) < time.Minute {
		return
	}
	a.swept = now
	var longest time.Duration
	for _, r := range a.cfg.Rules {
		if r.Window > longest {
			longest = r.Window
		}
	}
	for id, ts := range a.hits {
		if len(ts) == 0 || now.Sub(ts[len(ts)-1]) > longest {
			delete(a.hits, id)
		}
	}
	for id, t := range a.quiet {
		if now.Sub(t) >= a.cfg.Cooldown {
			delete(a.quiet, id)
		}
	}
}

func (a *Alerter) stack() string {
	if a.cfg.Stack == "" {
		return "bascula"
	}
	return a.cfg.Stack
}

func (a *Alerter) body(sig Signal, rule Rule, key, detail string, n int, first, now time.Time) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Security signal %q crossed its threshold on %s.\n\n", sig, a.stack())
	fmt.Fprintf(&b, "What:      %s\n", rule.Summary)
	fmt.Fprintf(&b, "Key:       %s\n", key)
	fmt.Fprintf(&b, "Count:     %d events within %s (threshold %d)\n", n, rule.Window, rule.Threshold)
	fmt.Fprintf(&b, "First/last: %s / %s\n", first.UTC().Format(time.RFC3339), now.UTC().Format(time.RFC3339))
	if detail != "" {
		fmt.Fprintf(&b, "Last event: %s\n", detail)
	}
	fmt.Fprintf(&b, "\nResponse: %s\n", rule.Response)
	fmt.Fprintf(&b, "\nThis key stays quiet for %s; at most %d alert emails per hour leave this stack.\n", a.cfg.Cooldown, a.cfg.MaxPerHour)
	b.WriteString("To silence a planned drill, set SECURITY_ALERT_SILENCE_UNTIL (RFC 3339) on the API. Runbook: docs/detections.md\n")
	return b.String()
}

// clip bounds s to n runes.
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}
