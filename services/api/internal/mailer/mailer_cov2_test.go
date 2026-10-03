// SPDX-License-Identifier: MIT

package mailer

import (
	"bufio"
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// c2otSMTP serves one connection: it greets, answers EHLO with the given
// extension lines, and hands every later command to answer, which returns the
// reply or "" to drop the connection. With stall set, it stops reading after
// answering DATA and waits for stall to close.
func c2otSMTP(t *testing.T, ehlo []string, answer func(cmd string) string, stall chan struct{}) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		w := func(s string) { _, _ = io.WriteString(conn, s+"\r\n") }
		w("220 fake ESMTP")
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			cmd := strings.ToUpper(strings.TrimSpace(line))
			if strings.HasPrefix(cmd, "EHLO") {
				for i, l := range ehlo {
					sep := "-"
					if i == len(ehlo)-1 {
						sep = " "
					}
					w("250" + sep + l)
				}
				continue
			}
			reply := answer(cmd)
			if reply == "" {
				return
			}
			w(reply)
			if cmd == "DATA" && stall != nil {
				<-stall
				return
			}
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// A server that offers STARTTLS and then refuses it stops the send before
// anything (a password above all) goes over the plain connection.
func TestSendStopsWhenStartTLSIsRefused(t *testing.T) {
	sawAuth := false
	port := c2otSMTP(t, []string{"fake", "STARTTLS", "AUTH PLAIN"}, func(cmd string) string {
		switch {
		case cmd == "STARTTLS":
			return "454 TLS not available due to temporary reason"
		case strings.HasPrefix(cmd, "AUTH"):
			sawAuth = true
			return "235 ok"
		}
		return "250 ok"
	}, nil)
	err := sender(port, TLSStartTLS, "usuario").Send(context.Background(), msg)
	if err == nil || !strings.Contains(err.Error(), "STARTTLS") {
		t.Fatalf("Send = %v, want a STARTTLS error", err)
	}
	if sawAuth {
		t.Fatal("credentials must not be sent after a refused STARTTLS")
	}
}

// A server that accepts DATA and then stops reading cannot take the message:
// the write fails at the deadline and Send reports it instead of hanging.
func TestSendReportsAMessageThatCannotBeWritten(t *testing.T) {
	stalled := make(chan struct{})
	t.Cleanup(func() { close(stalled) })
	port := c2otSMTP(t, []string{"fake"}, func(cmd string) string {
		if cmd == "DATA" {
			return "354 go ahead"
		}
		return "250 ok"
	}, stalled)
	// The fake stops reading after the 354, so a message far larger than any
	// socket buffer blocks until the send's own deadline cuts it off.
	s := sender(port, TLSNone, "")
	s.cfg.Timeout = 2 * time.Second
	big := Message{To: msg.To, Subject: msg.Subject, Body: strings.Repeat("a", 64<<20)}
	start := time.Now()
	err := s.Send(context.Background(), big)
	if err == nil || !strings.Contains(err.Error(), "write") {
		t.Fatalf("Send = %v, want a write error", err)
	}
	if time.Since(start) > 30*time.Second {
		t.Fatalf("Send took %s", time.Since(start))
	}
}
