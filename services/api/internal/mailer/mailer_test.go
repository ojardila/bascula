package mailer

import (
	"bufio"
	"context"
	"errors"
	"io"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"strconv"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestFromEnvIsInertWhenUnconfigured(t *testing.T) {
	for _, m := range []map[string]string{
		{},
		{"SMTP_HOST": "smtp.mail.svc.cluster.local"},
		{"SMTP_FROM": "Báscula <no-responder@bascula.engp.io>"},
	} {
		s, err := FromEnv(env(m))
		if err != nil || s != nil {
			t.Fatalf("FromEnv(%v) = %v, %v; want nil, nil", m, s, err)
		}
	}
}

func TestFromEnvDefaultsAndValidation(t *testing.T) {
	s, err := FromEnv(env(map[string]string{
		"SMTP_HOST": "smtp.mail.svc.cluster.local", "SMTP_FROM": "Báscula <no-responder@bascula.engp.io>",
	}))
	if err != nil || s == nil {
		t.Fatalf("FromEnv: %v %v", s, err)
	}
	if s.cfg.Port != 25 || s.cfg.TLS != TLSNone || s.cfg.User != "" {
		t.Fatalf("defaults: %+v", s.cfg)
	}
	s, _ = FromEnv(env(map[string]string{"SMTP_HOST": "h", "SMTP_FROM": "a@b.co", "SMTP_PORT": "587", "SMTP_USER": "u"}))
	if s == nil || s.cfg.TLS != TLSStartTLS {
		t.Fatalf("587 should default to starttls: %+v", s)
	}
	bad := []map[string]string{
		{"SMTP_HOST": "h", "SMTP_FROM": "not an address"},
		{"SMTP_HOST": "h", "SMTP_FROM": "a@b.co", "SMTP_PORT": "nope"},
		{"SMTP_HOST": "h", "SMTP_FROM": "a@b.co", "SMTP_TLS": "maybe"},
		{"SMTP_HOST": "h", "SMTP_FROM": "a@b.co", "SMTP_USER": "u", "SMTP_TLS": "none"},
	}
	for _, m := range bad {
		if _, err := FromEnv(env(m)); err == nil {
			t.Errorf("FromEnv(%v) should fail", m)
		}
	}
}

// fakeSMTP is the smallest server that net/smtp will talk to: no TLS, no
// auth. It hands back the DATA it received.
func fakeSMTP(t *testing.T) (port int, got chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got = make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		w := func(s string) { _, _ = io.WriteString(conn, s+"\r\n") }
		w("220 fake ESMTP")
		var rcpt string
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			cmd := strings.ToUpper(strings.TrimSpace(line))
			switch {
			case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
				w("250 fake")
			case strings.HasPrefix(cmd, "MAIL FROM"):
				w("250 ok")
			case strings.HasPrefix(cmd, "RCPT TO"):
				rcpt = strings.TrimSpace(line)
				w("250 ok")
			case cmd == "DATA":
				w("354 go ahead")
				var data strings.Builder
				for {
					l, err := r.ReadString('\n')
					if err != nil {
						return
					}
					if l == ".\r\n" {
						break
					}
					data.WriteString(l)
				}
				got <- rcpt + "\n" + data.String()
				w("250 queued")
			case cmd == "QUIT":
				w("221 bye")
				return
			default:
				w("502 no")
			}
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, got
}

func TestSendDeliversPlainSpanishText(t *testing.T) {
	port, got := fakeSMTP(t)
	s, err := FromEnv(env(map[string]string{
		"SMTP_HOST": "127.0.0.1", "SMTP_PORT": strconv.Itoa(port),
		"SMTP_FROM": "Báscula <no-responder@bascula.engp.io>",
	}))
	if err != nil {
		t.Fatal(err)
	}
	err = s.Send(context.Background(), Message{
		To: "dueno@example.com", Subject: "Su finca ya está lista",
		Body: "Hola,\n\nEntre aquí: https://lapalma.bascula.engp.io/entrar\n",
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	var raw string
	select {
	case raw = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("no message received")
	}
	rcpt, data, _ := strings.Cut(raw, "\n")
	if !strings.Contains(rcpt, "<dueno@example.com>") {
		t.Fatalf("RCPT = %q", rcpt)
	}
	msg, err := mail.ReadMessage(strings.NewReader(data))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	subj, _ := new(mime.WordDecoder).DecodeHeader(msg.Header.Get("Subject"))
	if subj != "Su finca ya está lista" {
		t.Fatalf("subject = %q", subj)
	}
	body, _ := io.ReadAll(quotedprintable.NewReader(msg.Body))
	if !strings.Contains(string(body), "https://lapalma.bascula.engp.io/entrar") {
		t.Fatalf("body = %q", body)
	}
	from, _ := msg.Header.AddressList("From")
	if len(from) != 1 || from[0].Name != "Báscula" || from[0].Address != "no-responder@bascula.engp.io" {
		t.Fatalf("from = %v", from)
	}
}

func TestSendRefusesHeaderInjection(t *testing.T) {
	// Port 1 is closed: a message that got past validation would fail with
	// "dial", so ErrHeaderInjection proves it was refused before any I/O.
	s := sender(1, TLSNone, "")
	cases := []Message{
		{To: "victim@example.com\r\nBcc: evil@x", Subject: "hola"},
		{To: "\"Ana\r\nBcc: evil@x\" <ana@example.com>", Subject: "hola"},
		{To: "ana@example.com", Subject: "hola\r\nBcc: evil@x"},
		{To: "ana@example.com", Subject: "hola\nBcc: evil@x"},
	}
	for _, m := range cases {
		if err := s.Send(context.Background(), m); !errors.Is(err, ErrHeaderInjection) {
			t.Errorf("Send(%q, %q) = %v; want ErrHeaderInjection", m.To, m.Subject, err)
		}
	}
	bad := New(Config{Host: "127.0.0.1", Port: 1, From: mail.Address{Name: "B\r\nBcc: evil@x", Address: "a@example.com"}})
	if err := bad.Send(context.Background(), msg); !errors.Is(err, ErrHeaderInjection) {
		t.Errorf("From with a line break: %v", err)
	}
}

func TestComposeNeutralisesLineBreaks(t *testing.T) {
	raw := Compose(
		mail.Address{Name: "B\r\nBcc: evil@x", Address: "a@example.com"},
		mail.Address{Name: "Ana\r\nBcc: evil@x", Address: "ana@example.com"},
		Message{Subject: "hola\r\nBcc: evil@x", Body: "x"},
		time.Unix(0, 0),
	)
	m, err := mail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if v, ok := m.Header["Bcc"]; ok {
		t.Fatalf("injected Bcc header: %q", v)
	}
	if strings.Contains(string(raw), "\r\nBcc:") {
		t.Fatalf("raw message carries a Bcc line:\n%s", raw)
	}
}

func TestSendBodyDotLineDoesNotEndData(t *testing.T) {
	port, got := fakeSMTP(t)
	s := sender(port, TLSNone, "")
	body := "first\n.\nafter the dot\n.\r\nMAIL FROM:<evil@x>\nlast\n"
	if err := s.Send(context.Background(), Message{To: "ana@example.com", Subject: "x", Body: body}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	var raw string
	select {
	case raw = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("no message received")
	}
	_, data, _ := strings.Cut(raw, "\n")
	// The fake server stops at the first lone "." line, so the whole body
	// arriving proves its "." lines were dot-stuffed; undo that to compare.
	data = strings.ReplaceAll(data, "\r\n..", "\r\n.")
	m, err := mail.ReadMessage(strings.NewReader(data))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	gotBody, _ := io.ReadAll(quotedprintable.NewReader(m.Body))
	want := strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n")
	if string(gotBody) != want {
		t.Fatalf("body = %q; want %q", gotBody, want)
	}
}
