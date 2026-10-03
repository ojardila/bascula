// SPDX-License-Identifier: MIT

package mailer

import (
	"context"
	"errors"
	"net/mail"
	"strings"
	"testing"
	"time"
)

func TestSendRefusesLineBreaksInHeaders(t *testing.T) {
	// Port 1 is closed: a message that got past the check would fail to dial
	// instead, so the error says which happened.
	s := sender(1, TLSNone, "")
	for _, m := range []Message{
		{To: "a@example.com\r\nBcc: victim@example.com", Subject: "x"},
		{To: "a@example.com\nBcc: victim@example.com", Subject: "x"},
		{To: "a@example.com", Subject: "Hola\r\nBcc: victim@example.com"},
		{To: "a@example.com", Subject: "Hola\nX-Evil: 1"},
		{To: "a@example.com", Subject: "Hola\rX-Evil: 1"},
	} {
		if err := s.Send(context.Background(), m); !errors.Is(err, ErrHeaderLineBreak) {
			t.Errorf("%q / %q: got %v, want ErrHeaderLineBreak", m.To, m.Subject, err)
		}
	}
}

func TestComposeKeepsEveryHeaderOnOneLine(t *testing.T) {
	from := mail.Address{Name: "Báscula", Address: "no-reply@example.com"}
	to := mail.Address{Name: "Ana\r\nBcc: victim@example.com", Address: "ana@example.com"}
	raw := string(Compose(from, to, Message{
		Subject: "Finca «X»\r\nBcc: victim@example.com",
		Body:    "Hola\r\nBcc: not-a-header@example.com\n",
	}, time.Unix(0, 0)))
	head, _, ok := strings.Cut(raw, "\r\n\r\n")
	if !ok {
		t.Fatalf("no header/body separator:\n%s", raw)
	}
	for _, line := range strings.Split(head, "\r\n") {
		k, _, _ := strings.Cut(line, ":")
		switch k {
		case "From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type", "Content-Transfer-Encoding":
		default:
			t.Errorf("unexpected header line %q in:\n%s", line, head)
		}
	}
	if strings.Contains(head, "\n") && strings.Count(head, "\n") != strings.Count(head, "\r\n") {
		t.Errorf("bare line feed in the header:\n%s", head)
	}
}

func TestOneLine(t *testing.T) {
	if got := oneLine("a\r\nb\nc\rd"); got != "a  b c d" {
		t.Fatalf("got %q", got)
	}
}
