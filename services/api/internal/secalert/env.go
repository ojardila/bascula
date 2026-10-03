package secalert

import (
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/ojardila/bascula/services/api/internal/mailer"
)

// FromEnv reads SECURITY_ALERT_EMAIL and SECURITY_ALERT_SILENCE_UNTIL.
//
// It returns nil (off) when no address is set or there is no mailer, an
// error for an address that is set and is not one (the mailer's posture: a
// half-configured pager is a boot problem, not a silent drop), and a warning
// rather than an error for a silence that does not parse — a typo in a drill
// window must not keep the API from starting.
func FromEnv(getenv func(string) string, sender mailer.Sender, stack string) (*Alerter, []string, error) {
	raw := strings.TrimSpace(getenv("SECURITY_ALERT_EMAIL"))
	if raw == "" {
		return nil, nil, nil
	}
	addr, err := mail.ParseAddress(raw)
	if err != nil {
		return nil, nil, fmt.Errorf("SECURITY_ALERT_EMAIL: %q is not an email address: %w", raw, err)
	}
	if sender == nil {
		return nil, []string{"SECURITY_ALERT_EMAIL is set but mail is off (no SMTP_HOST/SMTP_FROM): security alerts are off"}, nil
	}
	var warnings []string
	cfg := Config{To: addr.Address, Stack: stack, Sender: sender}
	if s := strings.TrimSpace(getenv("SECURITY_ALERT_SILENCE_UNTIL")); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("SECURITY_ALERT_SILENCE_UNTIL: %q is not RFC 3339; alerts are NOT silenced", s))
		} else {
			cfg.SilenceUntil = t
		}
	}
	return New(cfg), warnings, nil
}
