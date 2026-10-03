// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/store"
)

var errC3gInjected = errors.New("c3g: injected")

// c3gConn is a real connection whose nth Query fails in a chosen way.
type c3gConn struct {
	querier
	n    int
	at   int
	mode string // "query", "scan" or "rows"
}

func (c *c3gConn) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	c.n++
	if c.n != c.at {
		return c.querier.Query(ctx, sql, args...)
	}
	if c.mode == "query" {
		return nil, errC3gInjected
	}
	rows, err := c.querier.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return &c3gRows{Rows: rows, mode: c.mode}, nil
}

// c3gRows fails every Scan ("scan"), or ends at once with an error ("rows").
type c3gRows struct {
	pgx.Rows
	mode string
}

func (r *c3gRows) Scan(...any) error { return errC3gInjected }

func (r *c3gRows) Next() bool {
	if r.mode == "rows" {
		r.Rows.Close()
		return false
	}
	return r.Rows.Next()
}

func (r *c3gRows) Err() error {
	if r.mode == "rows" {
		return errC3gInjected
	}
	return r.Rows.Err()
}

func c3gMigratedConn(t *testing.T) *pgx.Conn {
	t.Helper()
	dsn := scratchDSN(t)
	ctx := context.Background()
	if err := store.MigrateDev(ctx, dsn); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	return conn
}

// Every read of the schema that fails stops render with that failure: a
// diagram missing its relations is worse than no diagram.
func TestRenderStopsOnEachSchemaReadFailure(t *testing.T) {
	conn := c3gMigratedConn(t)
	cases := []struct {
		name, mode, want string
		at               int
	}{
		{"tables query", "query", "read tables", 1},
		{"tables scan", "scan", "", 1},
		{"foreign keys query", "query", "read foreign keys", 2},
		{"foreign keys scan", "scan", "", 2},
		{"foreign keys rows", "rows", "", 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			doc, err := render(context.Background(), &c3gConn{querier: conn, at: c.at, mode: c.mode})
			if !errors.Is(err, errC3gInjected) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("render = %v, want the injected error wrapped with %q", err, c.want)
			}
			if doc != nil {
				t.Fatalf("a failed render returned %d bytes", len(doc))
			}
		})
	}
}

// Without -out the diagram goes to stdout, byte for byte what render makes.
func TestRunWritesToStdoutWithoutOut(t *testing.T) {
	conn := c3gMigratedConn(t)
	want, err := render(context.Background(), conn)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	var stdout bytes.Buffer
	if err := run(conn.Config().ConnString(), "", false, &stdout); err != nil {
		t.Fatalf("run: %v", err)
	}
	if !bytes.Equal(stdout.Bytes(), want) {
		t.Fatalf("stdout differs from render (%d vs %d bytes)", stdout.Len(), len(want))
	}
}

func TestRunReportsEachFailure(t *testing.T) {
	const refused = "postgres://postgres@127.0.0.1:1/none?sslmode=disable&connect_timeout=2"
	t.Run("no dsn", func(t *testing.T) {
		c3gWantErr(t, run("", "", false, &bytes.Buffer{}), "ADMIN_DATABASE_URL is not set")
	})
	t.Run("migrate", func(t *testing.T) {
		c3gWantErr(t, run(refused, "", true, &bytes.Buffer{}), "migrate:")
	})
	t.Run("connect", func(t *testing.T) {
		c3gWantErr(t, run(refused, "", false, &bytes.Buffer{}), "connect:")
	})
	t.Run("empty database", func(t *testing.T) {
		var stdout bytes.Buffer
		c3gWantErr(t, run(scratchDSN(t), "", false, &stdout), "goose_db_version")
		if stdout.Len() != 0 {
			t.Fatalf("a failed render wrote %d bytes", stdout.Len())
		}
	})
	t.Run("unwritable out", func(t *testing.T) {
		out := filepath.Join(t.TempDir(), "missing", "database.md")
		err := run(c3gMigratedConn(t).Config().ConnString(), out, false, &bytes.Buffer{})
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("run = %v, want the missing directory", err)
		}
	})
}

func c3gWantErr(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("got %v, want an error containing %q", err, want)
	}
}

// main hands run's failure to fatal, which in the binary exits non-zero.
func TestMainFailsWithoutADatabase(t *testing.T) {
	t.Setenv("ADMIN_DATABASE_URL", "")
	oldArgs, oldFlags, oldFatal := os.Args, flag.CommandLine, fatal
	t.Cleanup(func() { os.Args, flag.CommandLine, fatal = oldArgs, oldFlags, oldFatal })
	flag.CommandLine = flag.NewFlagSet("dbdiagram", flag.ContinueOnError)
	os.Args = []string{"dbdiagram"}
	var got string
	fatal = func(v ...any) { got = fmt.Sprint(v...) }

	main()

	if got != "ADMIN_DATABASE_URL is not set" {
		t.Fatalf("fatal(%q), want the missing URL", got)
	}
}

// writeEntity names an entity outside public by its schema too, and writeViews
// writes nothing at all when there are only tables.
func TestEntityAndViewsEdges(t *testing.T) {
	var b bytes.Buffer
	w := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }
	writeEntity(w, &table{schema: "registry", name: "persons", kind: "r",
		columns: []*column{{name: "id", typ: "uuid", notNull: true, pk: true}}})
	want := "    registry_persons[\"registry.persons\"] {\n        uuid id PK\n    }\n"
	if b.String() != want {
		t.Fatalf("entity:\n%s\nwant:\n%s", b.String(), want)
	}
	b.Reset()
	writeViews(w, []*table{{schema: "public", name: "farms", kind: "r"}})
	if b.Len() != 0 {
		t.Fatalf("views section without views: %q", b.String())
	}
}
