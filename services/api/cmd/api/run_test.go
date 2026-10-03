// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// databaseDDL is a CREATE or DROP DATABASE statement, which takes no bind
// parameters: the name is quoted as an identifier, and it is generated from a
// UUID by scratchDSN, never taken from input.
func databaseDDL(verb, name, suffix string) string {
	return strings.TrimSpace(strings.Join([]string{verb, pgx.Identifier{name}.Sanitize(), suffix}, " "))
}

// scratchDSN creates an empty database for one test and returns its admin
// DSN. It skips without TEST_ADMIN_DATABASE_URL, like the apitest suite.
func scratchDSN(t *testing.T) string {
	t.Helper()
	base := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if base == "" {
		t.Skip("TEST_ADMIN_DATABASE_URL is not set: run `make up` and use `make test`")
	}
	ctx := context.Background()
	name := "bascula_run_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	boot, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer boot.Close(ctx)
	if _, err := boot.Exec(ctx, databaseDDL("CREATE DATABASE", name, "")); err != nil {
		t.Fatalf("create database: %v", err)
	}
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), base)
		if err != nil {
			return
		}
		defer c.Close(context.Background())
		_, _ = c.Exec(context.Background(), databaseDDL("DROP DATABASE IF EXISTS", name, "WITH (FORCE)"))
	})
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	u.Path = "/" + name
	return u.String()
}

func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
}

// unreachable is a database nobody listens on, refused at once.
const unreachable = "postgres://postgres@127.0.0.1:1/none?sslmode=disable&connect_timeout=2"

func TestRunMigratesAndPrunes(t *testing.T) {
	dsn := scratchDSN(t)
	t.Setenv("ADMIN_DATABASE_URL", dsn)
	t.Setenv("APP_ENV", appEnvDevelopment)
	if err := run(true, false); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	// A second run finds nothing to do, and the sweep runs on the result.
	if err := run(true, false); err != nil {
		t.Fatalf("migrate again: %v", err)
	}
	if err := run(false, true); err != nil {
		t.Fatalf("prune: %v", err)
	}
}

func TestRunReportsAnUnreachableDatabase(t *testing.T) {
	t.Setenv("ADMIN_DATABASE_URL", unreachable)
	t.Setenv("DATABASE_URL", unreachable)
	t.Setenv("APP_ENV", appEnvDevelopment)
	for _, c := range []struct {
		name             string
		migrate, prune   bool
		wantErrSubstring string
	}{
		{"migrate", true, false, "migrate"},
		{"prune", false, true, "prune"},
		{"serve", false, false, "database"},
	} {
		if err := run(c.migrate, c.prune); err == nil || !strings.Contains(err.Error(), c.wantErrSubstring) {
			t.Errorf("%s: got %v, want an error about %s", c.name, err, c.wantErrSubstring)
		}
	}
}

func TestRunRefusesAnUnconfiguredServer(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("JWT_SECRET", "")
	if err := run(false, false); err == nil || !strings.Contains(err.Error(), "JWT_SECRET") {
		t.Fatalf("got %v, want the JWT_SECRET refusal", err)
	}
}

// The serving path end to end: a dedicated stack with mail on boots, opens
// both listeners, answers /health and stops cleanly on SIGINT. It serves on
// the admin URL: /health needs a pool, not the row policies.
func TestRunServesUntilInterrupted(t *testing.T) {
	admin := scratchDSN(t)
	t.Setenv("ADMIN_DATABASE_URL", admin)
	t.Setenv("APP_ENV", appEnvDevelopment)
	if err := run(true, false); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	port, internalPort := freePort(t), freePort(t)
	for k, v := range map[string]string{
		"DATABASE_URL": admin, "PORT": port, "INTERNAL_PORT": internalPort,
		"TENANT_MODE": "dedicated", "TENANT_SLUG": "finca-de-prueba", "UPLOAD_DIR": t.TempDir(),
		"SMTP_HOST": "127.0.0.1", "SMTP_PORT": "1", "SMTP_FROM": "bascula@example.com", "SMTP_TLS": "none",
		"JWT_SECRET": "", "TRUSTED_PROXY_CIDRS": "",
	} {
		t.Setenv(k, v)
	}

	done := make(chan error, 1)
	go func() { done <- run(false, false) }()

	waitForHealth(t, "http://127.0.0.1:"+port+"/health", done)
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

// waitForHealth polls until the server answers, failing early if run returns.
func waitForHealth(t *testing.T, target string, done <-chan error) {
	t.Helper()
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			t.Fatalf("run returned before serving: %v", err)
		default:
		}
		if res, err := client.Get(target); err == nil {
			res.Body.Close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the server never answered /health")
}
