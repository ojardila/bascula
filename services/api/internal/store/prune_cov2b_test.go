// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// c2sbScratchDB creates an empty database next to TEST_ADMIN_DATABASE_URL's
// and returns a config pointing at it. The database is dropped at cleanup.
func c2sbScratchDB(t *testing.T) *pgxpool.Config {
	t.Helper()
	base := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if base == "" {
		t.Skip("TEST_ADMIN_DATABASE_URL is not set")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := "c2sb_prune_" + hex.EncodeToString(b)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
		_ = admin.Close(context.Background())
	})
	cfg, err := pgxpool.ParseConfig(base)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Database = name
	return cfg
}

func c2sbPool(t *testing.T, cfg *pgxpool.Config) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// A sweep stops at the first statement that fails and reports nothing past
// it; it never commits half a sweep. Each step below gives the scratch
// database one more of the tables the sweep deletes from.
func TestC2SBPruneSyncStopsAtTheFirstFailure(t *testing.T) {
	cfg := c2sbScratchDB(t)
	ctx := context.Background()
	pool := c2sbPool(t, cfg)

	c2sbCheckMissingTables(ctx, t, pool)
	c2sbCheckCommitFailure(ctx, t, pool)
	c2sbCheckFlagFailure(ctx, t, pool, cfg)
}

// c2sbCheckMissingTables runs the sweep once per missing table, then
// creates that table, so each run fails one statement further along.
func c2sbCheckMissingTables(ctx context.Context, t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	steps := []struct {
		missing string
		ddl     string
	}{
		{"sync_log", `CREATE TABLE sync_log (farm_id int, entity text, row_id text, seq bigint, at timestamptz)`},
		{"sync_ops", `CREATE TABLE sync_ops (at timestamptz)`},
		{"login_failures", `CREATE TABLE login_failures (at timestamptz)`},
		{"passkey_used_challenges", `CREATE TABLE passkey_used_challenges (expires_at timestamptz)`},
	}
	for _, s := range steps {
		// Zero retention windows take the defaults.
		rep, err := PruneSync(ctx, pool, 0, 0, 0)
		if err == nil || !strings.Contains(err.Error(), s.missing) {
			t.Fatalf("without %s: err = %v", s.missing, err)
		}
		if rep.Took != 0 {
			t.Errorf("a failed sweep reported a duration: %v", rep)
		}
		if _, err := pool.Exec(ctx, s.ddl); err != nil {
			t.Fatal(err)
		}
	}
}

// c2sbCheckCommitFailure: everything in place but a commit that fails; the
// sweep is the error.
func c2sbCheckCommitFailure(ctx context.Context, t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO passkey_used_challenges VALUES (now() - interval '1 day');
		CREATE FUNCTION c2sb_boom() RETURNS trigger LANGUAGE plpgsql AS
		  $$BEGIN RAISE EXCEPTION 'c2sb commit refused'; END$$;
		CREATE CONSTRAINT TRIGGER c2sb_boom AFTER DELETE ON passkey_used_challenges
		  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION c2sb_boom();`); err != nil {
		t.Fatal(err)
	}
	rep, err := PruneSync(ctx, pool, 1, 1, 1)
	if err == nil || !strings.Contains(err.Error(), "c2sb commit refused") {
		t.Fatalf("commit failure: err = %v", err)
	}
	if rep.PasskeyChallengesDeleted != 1 || rep.Took != 0 {
		t.Errorf("report of a sweep that did not commit: %+v", rep)
	}
	var left int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM passkey_used_challenges`).Scan(&left); err != nil || left != 1 {
		t.Errorf("rolled-back sweep deleted rows: %d %v", left, err)
	}
}

// c2sbCheckFlagFailure: the session flag itself failing. A set_config that
// shadows the catalogue's (search_path names pg_catalog last) refuses the
// sweep before it deletes anything.
func c2sbCheckFlagFailure(ctx context.Context, t *testing.T, pool *pgxpool.Pool, cfg *pgxpool.Config) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION public.set_config(text, text, boolean) RETURNS text LANGUAGE plpgsql AS
		  $$BEGIN RAISE EXCEPTION 'c2sb flag refused'; END$$`); err != nil {
		t.Fatal(err)
	}
	shadowed := cfg.Copy()
	shadowed.ConnConfig.RuntimeParams["search_path"] = "public, pg_catalog"
	rep, err := PruneSync(ctx, c2sbPool(t, shadowed), 0, 0, 0)
	if err == nil || !strings.Contains(err.Error(), "c2sb flag refused") {
		t.Fatalf("flag failure: err = %v", err)
	}
	if rep != (PruneReport{}) {
		t.Errorf("report of a sweep refused at its flag: %+v", rep)
	}
}

func TestC2SBPruneReportString(t *testing.T) {
	got := PruneReport{SyncLogDeleted: 1, SyncOpsDeleted: 2, LoginFailuresDeleted: 3,
		PasskeyChallengesDeleted: 4, Took: 1500 * time.Microsecond}.String()
	want := "sync_log -1, sync_ops -2, login_failures -3, passkey_used_challenges -4, in 2ms"
	if got != want {
		t.Errorf("String() = %q, want %q", got, want)
	}
}

func TestC2SBConnectionErrors(t *testing.T) {
	ctx := context.Background()
	const bad = "postgres://u@h:notaport/db"

	if err := Migrate(ctx, bad); err == nil || !strings.Contains(err.Error(), "parse admin connection") {
		t.Errorf("Migrate(bad dsn) = %v", err)
	}
	if _, err := Open(ctx, bad); err == nil || !strings.Contains(err.Error(), "parse database url") {
		t.Errorf("Open(bad dsn) = %v", err)
	}
	// Nothing listens on port 1: the rollback fails to reach a database
	// rather than rolling anything back.
	if err := MigrateDown(ctx, "postgres://u@127.0.0.1:1/db?connect_timeout=2&sslmode=disable"); err == nil {
		t.Error("MigrateDown against nothing succeeded")
	}
}

func TestC2SBConstraintClassifiers(t *testing.T) {
	uniq := &pgconn.PgError{Code: "23505", ConstraintName: "farms_slug_key"}
	if !IsUniqueViolation(uniq, "") || !IsUniqueViolation(uniq, "farms_slug_key") {
		t.Error("unique violation not recognised")
	}
	if IsUniqueViolation(uniq, "other_key") {
		t.Error("unique violation matched the wrong constraint")
	}
	check := &pgconn.PgError{Code: "23514", ConstraintName: "farms_timezone_check"}
	if !IsCheckViolation(check, "") || !IsCheckViolation(check, "farms_timezone_check") {
		t.Error("check violation not recognised")
	}
	if IsCheckViolation(check, "other_check") || IsCheckViolation(uniq, "") {
		t.Error("check violation matched the wrong constraint or code")
	}
}
