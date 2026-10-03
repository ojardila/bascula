// SPDX-License-Identifier: MIT

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

// c3gGreeter accepts one session, answers every command with 250 (354 for
// DATA) and hands back the EHLO line it was greeted with.
func c3gGreeter(t *testing.T) (port int, ehlo chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	ehlo = make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		c3gAnswer(conn, ehlo)
	}()
	return ln.Addr().(*net.TCPAddr).Port, ehlo
}

func c3gAnswer(conn net.Conn, ehlo chan<- string) {
	r := bufio.NewReader(conn)
	w := func(s string) { _, _ = io.WriteString(conn, s+"\r\n") }
	w("220 fake ESMTP")
	inData := false
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.TrimSpace(line)
		switch {
		case inData && cmd == ".":
			inData = false
			w("250 queued")
		case inData:
		case strings.HasPrefix(cmd, "EHLO "):
			ehlo <- cmd
			w("250 fake")
		case cmd == "DATA":
			inData = true
			w("354 go ahead")
		case cmd == "QUIT":
			w("221 bye")
			return
		default:
			w("250 ok")
		}
	}
}

// A machine that cannot name itself still greets the relay, as localhost,
// and the message goes out.
func TestSendGreetsAsLocalhostWithoutAHostname(t *testing.T) {
	old := hostname
	t.Cleanup(func() { hostname = old })
	hostname = func() (string, error) { return "", nil }

	port, ehlo := c3gGreeter(t)
	s := New(Config{Host: "127.0.0.1", Port: port, TLS: TLSNone, Timeout: 5 * time.Second,
		From: mail.Address{Address: "bascula@example.com"}})
	if err := s.Send(context.Background(), Message{To: "dueno@example.com", Subject: "Hola", Body: "Hola\n"}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	select {
	case got := <-ehlo:
		if got != "EHLO localhost" {
			t.Fatalf("greeting %q, want EHLO localhost", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the relay was never greeted")
	}
}
