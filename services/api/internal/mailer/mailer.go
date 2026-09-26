// Package mailer sends plain-text email over SMTP.
//
// It is configured entirely from the environment (SMTP_HOST, SMTP_PORT,
// SMTP_FROM, optional SMTP_USER / SMTP_PASSWORD, SMTP_TLS) and it is INERT
// when SMTP_HOST or SMTP_FROM is missing: FromEnv returns nil, the server
// sees no mailer, and nothing that depends on one is offered. That is the
// same posture as CF_SAAS_TOKEN — a deployment that never set the variables
// behaves exactly as it did before this package existed.
//
// The planned relay is smtp.mail.svc.cluster.local:25 inside the cluster,
// without authentication and without TLS (SMTP_TLS=none, the default on any
// port but 465 and 587).
package mailer

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"
)

// TLS modes.
const (
	TLSNone     = "none"     // plain SMTP; an in-cluster relay on port 25
	TLSStartTLS = "starttls" // upgrade after EHLO, and refuse to send if the server cannot
	TLSImplicit = "tls"      // TLS from the first byte (SMTPS, usually port 465)
)

// Config is where and as whom to send.
type Config struct {
	Host     string
	Port     int
	From     mail.Address
	User     string
	Password string
	TLS      string
	// Timeout bounds one whole delivery: dial, conversation and data.
	Timeout time.Duration
}

// Message is one plain-text email to one recipient.
type Message struct {
	To      string
	Subject string
	Body    string
}

// Sender is what the rest of the service depends on, so tests can record
// instead of dialling.
type Sender interface {
	Send(ctx context.Context, m Message) error
}

// SMTP sends through a real server.
type SMTP struct{ cfg Config }

// FromEnv reads the SMTP_* variables. It returns (nil, nil) when SMTP_HOST or
// SMTP_FROM is unset — mail is simply off — and an error only for a value
// that was set and is wrong, because a relay that is half configured should
// be an operator's problem at boot, not a silent drop at the first signup.
func FromEnv(getenv func(string) string) (*SMTP, error) {
	host := strings.TrimSpace(getenv("SMTP_HOST"))
	from := strings.TrimSpace(getenv("SMTP_FROM"))
	if host == "" || from == "" {
		return nil, nil
	}
	addr, err := mail.ParseAddress(from)
	if err != nil {
		return nil, fmt.Errorf("SMTP_FROM: %q is not an email address: %w", from, err)
	}
	port := 25
	if raw := strings.TrimSpace(getenv("SMTP_PORT")); raw != "" {
		port, err = strconv.Atoi(raw)
		if err != nil || port <= 0 || port > 65535 {
			return nil, fmt.Errorf("SMTP_PORT: %q is not a port", raw)
		}
	}
	mode := strings.ToLower(strings.TrimSpace(getenv("SMTP_TLS")))
	switch mode {
	case "":
		mode = defaultTLS(port)
	case TLSNone, TLSStartTLS, TLSImplicit:
	default:
		return nil, fmt.Errorf("SMTP_TLS: %q is not one of none, starttls, tls", mode)
	}
	cfg := Config{
		Host: host, Port: port, From: *addr, TLS: mode,
		User: getenv("SMTP_USER"), Password: getenv("SMTP_PASSWORD"),
		Timeout: 30 * time.Second,
	}
	if cfg.User != "" && cfg.TLS == TLSNone {
		return nil, errors.New("SMTP_USER is set but SMTP_TLS=none: refusing to send a password in the clear")
	}
	return New(cfg), nil
}

func defaultTLS(port int) string {
	switch port {
	case 465:
		return TLSImplicit
	case 587:
		return TLSStartTLS
	}
	return TLSNone
}

// New builds a sender from an explicit configuration.
func New(cfg Config) *SMTP {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 30 * time.Second
	}
	if cfg.TLS == "" {
		cfg.TLS = defaultTLS(cfg.Port)
	}
	return &SMTP{cfg: cfg}
}

// Describe is for the startup log: where mail goes, never the password.
func (s *SMTP) Describe() string {
	auth := "no auth"
	if s.cfg.User != "" {
		auth = "auth as " + s.cfg.User
	}
	return fmt.Sprintf("%s:%d tls=%s %s from=%s", s.cfg.Host, s.cfg.Port, s.cfg.TLS, auth, s.cfg.From.Address)
}

// Send delivers one message.
func (s *SMTP) Send(ctx context.Context, m Message) error {
	to, err := mail.ParseAddress(m.To)
	if err != nil {
		return fmt.Errorf("mailer: recipient %q: %w", m.To, err)
	}
	ctx, cancel := context.WithTimeout(ctx, s.cfg.Timeout)
	defer cancel()
	addr := net.JoinHostPort(s.cfg.Host, strconv.Itoa(s.cfg.Port))
	d := &net.Dialer{}
	var conn net.Conn
	if s.cfg.TLS == TLSImplicit {
		td := &tls.Dialer{NetDialer: d, Config: &tls.Config{ServerName: s.cfg.Host, MinVersion: tls.VersionTLS12}}
		conn, err = td.DialContext(ctx, "tcp", addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("mailer: dial %s: %w", addr, err)
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	c, err := smtp.NewClient(conn, s.cfg.Host)
	if err != nil {
		return fmt.Errorf("mailer: greeting: %w", err)
	}
	defer c.Close()
	helo, _ := os.Hostname()
	if helo == "" {
		helo = "localhost"
	}
	if err := c.Hello(helo); err != nil {
		return fmt.Errorf("mailer: EHLO: %w", err)
	}
	if s.cfg.TLS == TLSStartTLS {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("mailer: SMTP_TLS=starttls but the server does not offer STARTTLS")
		}
		if err := c.StartTLS(&tls.Config{ServerName: s.cfg.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("mailer: STARTTLS: %w", err)
		}
	}
	if s.cfg.User != "" {
		if err := c.Auth(smtp.PlainAuth("", s.cfg.User, s.cfg.Password, s.cfg.Host)); err != nil {
			return fmt.Errorf("mailer: AUTH: %w", err)
		}
	}
	if err := c.Mail(s.cfg.From.Address); err != nil {
		return fmt.Errorf("mailer: MAIL FROM: %w", err)
	}
	if err := c.Rcpt(to.Address); err != nil {
		return fmt.Errorf("mailer: RCPT TO: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("mailer: DATA: %w", err)
	}
	if _, err := w.Write(Compose(s.cfg.From, *to, m, time.Now())); err != nil {
		return fmt.Errorf("mailer: write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("mailer: end of data: %w", err)
	}
	return c.Quit()
}

// Compose renders the RFC 5322 message: UTF-8 plain text, quoted-printable,
// with the subject and names encoded so accents survive every mail client.
func Compose(from, to mail.Address, m Message, now time.Time) []byte {
	var b bytes.Buffer
	domain := "localhost"
	if at := strings.LastIndex(from.Address, "@"); at >= 0 {
		domain = from.Address[at+1:]
	}
	hdr := func(k, v string) { fmt.Fprintf(&b, "%s: %s\r\n", k, v) }
	hdr("From", from.String())
	hdr("To", to.String())
	hdr("Subject", mime.QEncoding.Encode("utf-8", m.Subject))
	hdr("Date", now.Format(time.RFC1123Z))
	hdr("Message-ID", fmt.Sprintf("<%d.%s@%s>", now.UnixNano(), strconv.Itoa(os.Getpid()), domain))
	hdr("MIME-Version", "1.0")
	hdr("Content-Type", `text/plain; charset="utf-8"`)
	hdr("Content-Transfer-Encoding", "quoted-printable")
	b.WriteString("\r\n")
	qp := quotedprintable.NewWriter(&b)
	body := strings.ReplaceAll(strings.ReplaceAll(m.Body, "\r\n", "\n"), "\n", "\r\n")
	_, _ = qp.Write([]byte(body))
	_ = qp.Close()
	return b.Bytes()
}
