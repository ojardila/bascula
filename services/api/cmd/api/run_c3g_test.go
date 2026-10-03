// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"flag"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// c3gLog is a slog destination the serving goroutines can write to while the
// test reads it.
type c3gLog struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *c3gLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *c3gLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// c3gCaptureLog routes slog to a buffer for the rest of the test.
func c3gCaptureLog(t *testing.T) *c3gLog {
	t.Helper()
	old := slog.Default()
	t.Cleanup(func() { slog.SetDefault(old) })
	l := &c3gLog{}
	slog.SetDefault(slog.New(slog.NewJSONHandler(l, nil)))
	return l
}

// c3gHold takes a loopback port and keeps it for the test: the API's own
// listen on that port (every interface) then fails with "address in use".
func c3gHold(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	return strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
}

func c3gSetenv(t *testing.T, envs map[string]string) {
	t.Helper()
	for k, v := range envs {
		t.Setenv(k, v)
	}
}

// c3gMigrated is a scratch database with every migration applied, set as
// both URLs: /health needs a pool, not the row policies.
func c3gMigrated(t *testing.T) {
	t.Helper()
	admin := scratchDSN(t)
	c3gSetenv(t, map[string]string{
		"ADMIN_DATABASE_URL": admin, "DATABASE_URL": admin, "APP_ENV": appEnvDevelopment,
		"JWT_SECRET": "", "TRUSTED_PROXY_CIDRS": "", "UPLOAD_DIR": t.TempDir(),
	})
	if err := run(true, false); err != nil {
		t.Fatalf("migrate: %v", err)
	}
}

// main exits 1 when run fails, and returns without exiting when it succeeds.
func TestMainExitCode(t *testing.T) {
	oldArgs, oldFlags, oldExit := os.Args, flag.CommandLine, exit
	oldLog := slog.Default()
	t.Cleanup(func() {
		os.Args, flag.CommandLine, exit = oldArgs, oldFlags, oldExit
		slog.SetDefault(oldLog)
	})
	code := -1
	exit = func(c int) { code = c }
	t.Setenv("APP_ENV", appEnvDevelopment)

	t.Run("failure", func(t *testing.T) {
		t.Setenv("ADMIN_DATABASE_URL", unreachable)
		flag.CommandLine = flag.NewFlagSet("api", flag.ContinueOnError)
		os.Args = []string{"api", "-migrate"}
		code = -1
		main()
		if code != 1 {
			t.Fatalf("exit code %d, want 1", code)
		}
	})
	t.Run("success", func(t *testing.T) {
		t.Setenv("ADMIN_DATABASE_URL", scratchDSN(t))
		flag.CommandLine = flag.NewFlagSet("api", flag.ContinueOnError)
		os.Args = []string{"api", "-migrate"}
		code = -1
		main()
		if code != -1 {
			t.Fatalf("exit(%d) after a successful migration", code)
		}
	})
}

// A DSN that does not parse never reaches the database, on the prune path
// and on the server's mail settings alike.
func TestRunRefusesMalformedSettings(t *testing.T) {
	t.Run("prune dsn", func(t *testing.T) {
		t.Setenv("ADMIN_DATABASE_URL", "postgres://%zz")
		err := run(false, true)
		if err == nil || !strings.Contains(err.Error(), "prune: connect:") {
			t.Fatalf("got %v, want the prune connect refusal", err)
		}
	})
	t.Run("smtp from", func(t *testing.T) {
		envs := map[string]string{
			"APP_ENV": appEnvDevelopment, "UPLOAD_DIR": "/srv/uploads",
			"SMTP_HOST": "127.0.0.1", "SMTP_FROM": "not an address",
		}
		_, err := resolveConfig(getenvFrom(envs))
		if err == nil || !strings.Contains(err.Error(), "SMTP_FROM") {
			t.Fatalf("got %v, want the SMTP_FROM refusal", err)
		}
	})
}

// A port somebody else holds is a failed boot, said as such.
func TestRunFailsWhenThePortIsTaken(t *testing.T) {
	c3gMigrated(t)
	port := c3gHold(t)
	t.Setenv("PORT", port)
	t.Setenv("TENANT_MODE", "")
	t.Setenv("TENANT_SLUG", "")
	t.Setenv("SMTP_HOST", "")

	done := make(chan error, 1)
	go func() { done <- run(false, false) }()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "address already in use") {
			t.Fatalf("run = %v, want the port refusal", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("run kept going on a taken port")
	}
}

// With mail on and an alert address, the boot log says alerts are on. When
// the internal port is taken the public listener still serves, and the
// failure is logged rather than swallowed.
func TestRunLogsAlertsAndAnInternalListenerFailure(t *testing.T) {
	c3gMigrated(t)
	logs := c3gCaptureLog(t)
	port := freePort(t)
	c3gSetenv(t, map[string]string{
		"PORT": port, "INTERNAL_PORT": c3gHold(t),
		"TENANT_MODE": "dedicated", "TENANT_SLUG": "finca-de-prueba",
		"SMTP_HOST": "127.0.0.1", "SMTP_PORT": "1", "SMTP_FROM": "bascula@example.com", "SMTP_TLS": "none",
		"PUBLIC_BASE_URL": "https://finca-de-prueba.bascula.example.com", "SECURITY_ALERT_EMAIL": "ops@example.com",
	})

	done := make(chan error, 1)
	go func() { done <- run(false, false) }()
	waitForHealth(t, "http://127.0.0.1:"+port+"/health", done)
	c3gWaitLog(t, logs, `"msg":"internal listener","err"`)
	if !strings.Contains(logs.String(), `"msg":"security alerts on"`) {
		t.Errorf("no alerts line in the boot log:\n%s", logs.String())
	}

	if err := syscall.Kill(os.Getpid(), syscall.SIGINT); err != nil {
		t.Fatalf("signal: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("run did not stop after SIGINT")
	}
}

func c3gWaitLog(t *testing.T, logs *c3gLog, want string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(logs.String(), want) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("log never had %s:\n%s", want, logs.String())
}
