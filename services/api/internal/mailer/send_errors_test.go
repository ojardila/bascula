package mailer

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/mail"
	"strings"
	"testing"
	"time"
)

// refusingSMTP answers like fakeSMTP except for the command that starts with
// refuse, which it answers 554, and the end of DATA, which it always refuses. refuse "GREETING" refuses the greeting; with
// auth the server advertises AUTH PLAIN and accepts it.
func refusingSMTP(t *testing.T, refuse string, auth bool) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go serveRefusing(ln, refuse, auth)
	return ln.Addr().(*net.TCPAddr).Port
}

func serveRefusing(ln net.Listener, refuse string, auth bool) {
	conn, err := ln.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	r := bufio.NewReader(conn)
	w := func(s string) { _, _ = io.WriteString(conn, s+"\r\n") }
	if refuse == "GREETING" {
		w("554 go away")
		return
	}
	w("220 fake ESMTP")
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.ToUpper(strings.TrimSpace(line))
		if refused(cmd, refuse) {
			w("554 refused")
			continue
		}
		answerSMTP(cmd, r, w, auth)
	}
}

// refused matches the command to refuse; refusing EHLO refuses the HELO that
// net/smtp falls back to as well.
func refused(cmd, refuse string) bool {
	if refuse == "" {
		return false
	}
	return strings.HasPrefix(cmd, refuse) || (refuse == "EHLO" && strings.HasPrefix(cmd, "HELO"))
}

func answerSMTP(cmd string, r *bufio.Reader, w func(string), auth bool) {
	switch {
	case strings.HasPrefix(cmd, "EHLO") && auth:
		w("250-fake")
		w("250 AUTH PLAIN")
	case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
		w("250 fake")
	case strings.HasPrefix(cmd, "AUTH"):
		w("235 ok")
	case strings.HasPrefix(cmd, "MAIL FROM"), strings.HasPrefix(cmd, "RCPT TO"):
		w("250 ok")
	case cmd == "DATA":
		w("354 go ahead")
		for {
			l, err := r.ReadString('\n')
			if err != nil || l == ".\r\n" {
				break
			}
		}
		w("554 not today")
	case cmd == "QUIT":
		w("221 bye")
	default:
		w("502 no")
	}
}

func sender(port int, tlsMode, user string) *SMTP {
	return New(Config{
		Host: "localhost", Port: port, TLS: tlsMode, User: user, Password: "x",
		From: mail.Address{Name: "Báscula", Address: "no-responder@example.com"},
	})
}

var msg = Message{To: "dueno@example.com", Subject: "Hola", Body: "Cuerpo\n"}

func TestSendReportsEachRefusal(t *testing.T) {
	for _, c := range []struct {
		refuse, user, tlsMode, want string
	}{
		{"GREETING", "", TLSNone, "greeting"},
		{"EHLO", "", TLSNone, "EHLO"},
		{"", "", TLSStartTLS, "STARTTLS"},
		{"AUTH", "usuario", TLSNone, "AUTH"},
		{"MAIL FROM", "", TLSNone, "MAIL FROM"},
		{"RCPT TO", "", TLSNone, "RCPT TO"},
		{"DATA", "", TLSNone, "DATA"},
		{"", "", TLSNone, "end of data"},
	} {
		port := refusingSMTP(t, c.refuse, c.user != "")
		err := sender(port, c.tlsMode, c.user).Send(context.Background(), msg)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("refuse %q: got %v, want an error about %s", c.refuse, err, c.want)
		}
	}
}

func TestSendRefusesBeforeDialling(t *testing.T) {
	s := sender(1, TLSNone, "")
	if err := s.Send(context.Background(), Message{To: "no es una dirección", Subject: "x"}); err == nil ||
		!strings.Contains(err.Error(), "recipient") {
		t.Fatalf("bad recipient: %v", err)
	}
	if err := s.Send(context.Background(), msg); err == nil || !strings.Contains(err.Error(), "dial") {
		t.Fatalf("closed port: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := sender(1, TLSImplicit, "").Send(ctx, msg); err == nil || !strings.Contains(err.Error(), "dial") {
		t.Fatalf("closed TLS port: %v", err)
	}
}

func TestNewFillsDefaultsAndDescribes(t *testing.T) {
	s := New(Config{Host: "smtp.example.com", Port: 465, From: mail.Address{Address: "a@example.com"}})
	if s.cfg.TLS != TLSImplicit || s.cfg.Timeout != 30*time.Second {
		t.Fatalf("defaults: %+v", s.cfg)
	}
	if got := s.Describe(); !strings.Contains(got, "tls=tls") || !strings.Contains(got, "no auth") {
		t.Fatalf("describe: %q", got)
	}
	s = New(Config{Host: "smtp.example.com", Port: 587, User: "u", From: mail.Address{Address: "a@example.com"}})
	if got := s.Describe(); !strings.Contains(got, "auth as u") || !strings.Contains(got, "tls=starttls") {
		t.Fatalf("describe with auth: %q", got)
	}
}
