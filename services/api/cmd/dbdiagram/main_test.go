package main

import (
	"bytes"
	"context"
	"flag"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/store"
)

// scratchDSN creates a throwaway database with every migration applied and
// returns its DSN. It skips without TEST_ADMIN_DATABASE_URL, like apitest.
func scratchDSN(t *testing.T) string {
	t.Helper()
	base := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if base == "" {
		t.Skip("TEST_ADMIN_DATABASE_URL is not set: run `make up` and use `make test`")
	}
	ctx := context.Background()
	name := "bascula_diagram_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	boot, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer boot.Close(ctx)
	// CREATE DATABASE takes no bind parameters; the name is made above from
	// a UUID, never from input.
	// nosemgrep: go.lang.security.audit.sqli.pgx-sqli.pgx-sqli
	if _, err := boot.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatalf("create database: %v", err)
	}
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), base)
		if err != nil {
			return
		}
		defer c.Close(context.Background())
		// nosemgrep: go.lang.security.audit.sqli.pgx-sqli.pgx-sqli
		_, _ = c.Exec(context.Background(), "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
	})
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	u.Path = "/" + name
	return u.String()
}

// The rendered diagram is exactly the committed docs/database.md, which is
// the same check the api CI job makes with `go run`.
func TestRenderMatchesCommittedDiagram(t *testing.T) {
	dsn := scratchDSN(t)
	ctx := context.Background()
	if err := store.MigrateDev(ctx, dsn); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)

	got, err := render(ctx, conn)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	want, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "database.md"))
	if err != nil {
		t.Fatalf("read committed diagram: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("render differs from docs/database.md (run make db-diagram)")
	}
}

// main writes the file named by -out against ADMIN_DATABASE_URL, migrating
// first when asked to.
func TestMainWritesOutFile(t *testing.T) {
	dsn := scratchDSN(t)
	out := filepath.Join(t.TempDir(), "database.md")
	t.Setenv("ADMIN_DATABASE_URL", dsn)

	oldArgs, oldFlags := os.Args, flag.CommandLine
	t.Cleanup(func() { os.Args, flag.CommandLine = oldArgs, oldFlags })
	flag.CommandLine = flag.NewFlagSet("dbdiagram", flag.ExitOnError)
	os.Args = []string{"dbdiagram", "-migrate", "-out", out}

	main()

	doc, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}
	if !strings.Contains(string(doc), "erDiagram") || !strings.Contains(string(doc), "## Tables") {
		t.Fatalf("unexpected diagram:\n%.400s", doc)
	}
}

// Without migrations there is nothing to draw, and render says so.
func TestRenderRefusesAnEmptyDatabase(t *testing.T) {
	dsn := scratchDSN(t)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	if _, err := render(ctx, conn); err == nil {
		t.Fatal("expected an error without goose_db_version")
	}
	if _, err := conn.Exec(ctx, `CREATE TABLE goose_db_version (version_id bigint, is_applied bool)`); err != nil {
		t.Fatalf("create goose table: %v", err)
	}
	if _, err := render(ctx, conn); err == nil || !strings.Contains(err.Error(), "no migration applied") {
		t.Fatalf("expected no migration applied, got %v", err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO goose_db_version VALUES (99999, true)`); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if got, err := latestMigration(ctx, conn); err != nil || got != "99999" {
		t.Fatalf("latestMigration = %q, %v; want the bare number", got, err)
	}
}

func TestMermaidType(t *testing.T) {
	cases := []struct {
		in, short string
		exact     bool
	}{
		{"uuid", "uuid", false},
		{"timestamp with time zone", "timestamptz", false},
		{"character varying(40)", "varchar", true},
		{"numeric(12,2)", "numeric", true},
		{"geography(Point,4326)", "geography", true},
		{"text[]", "text[]", false},
		{"public.money_kind", "public_money_kind", true},
		{"\"weird type\"", "other", true},
	}
	for _, c := range cases {
		short, exact := mermaidType(c.in)
		if short != c.short || exact != c.exact {
			t.Errorf("mermaidType(%q) = %q, %v; want %q, %v", c.in, short, exact, c.short, c.exact)
		}
	}
}

func TestLabelsAndCells(t *testing.T) {
	if got := fkLabel([]string{"farm_id", "worker_id"}); got != "worker_id" {
		t.Errorf("fkLabel composite = %q", got)
	}
	if got := fkLabel([]string{"farm_id"}); got != "farm_id" {
		t.Errorf("fkLabel farm only = %q", got)
	}
	if got := mdCell("a  |\n b"); got != `a \| b` {
		t.Errorf("mdCell = %q", got)
	}
	long := mdCell(strings.Repeat("palabra ", 40))
	if !strings.HasSuffix(long, " …") || len(long) > 170 {
		t.Errorf("mdCell long = %q", long)
	}
	noSpace := mdCell(strings.Repeat("x", 200))
	if !strings.HasPrefix(noSpace, strings.Repeat("x", 160)+" …") {
		t.Errorf("mdCell unbroken = %q", noSpace)
	}
	pub := &table{schema: "public", name: "farms", kind: "r"}
	reg := &table{schema: "registry", name: "persons", kind: "v"}
	if pub.id() != "farms" || reg.id() != "registry_persons" || reg.qualified() != "registry.persons" {
		t.Errorf("ids: %q %q %q", pub.id(), reg.id(), reg.qualified())
	}
	if !isTable(pub) || isTable(reg) {
		t.Error("isTable")
	}
}
