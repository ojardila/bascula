// SPDX-License-Identifier: MIT

package httpapi

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// buildTenantSeed and seedTenant read the farm through a transaction of their
// own on the pool, not the request's, so the tx fault hooks never reach them.
// These tests point a pool at a scratch schema shaped like the tables the seed
// reads, and change that shape between calls: a table missing, a farm with no
// members, a member row that does not scan, and finally a good seed sent to an
// address that cannot be a URL.

func c2hbSeedPool(t *testing.T) (*pgxpool.Pool, func(sql string)) {
	t.Helper()
	dsn := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_ADMIN_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	schema := "c2hb_seed_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("admin pool: %v", err)
	}
	exec := func(sql string) {
		t.Helper()
		if _, err := admin.Exec(context.Background(), sql); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	exec(`CREATE SCHEMA ` + schema)
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), `DROP SCHEMA `+schema+` CASCADE`)
		admin.Close()
	})
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool, func(sql string) { exec(strings.ReplaceAll(sql, "{s}", schema+".")) }
}

func TestC2hbTenantSeedFailures(t *testing.T) {
	pool, exec := c2hbSeedPool(t)
	const farmID = "0192f3a0-0000-7000-8000-00000000c2f1"
	const ownerID = "0192f3a0-0000-7000-8000-00000000c2f2"
	const slug = "finca-c2hb-seed"
	exec(`CREATE TABLE {s}farms (id uuid PRIMARY KEY, name text, slug text, timezone text,
	        currency text, created_at timestamptz DEFAULT now())`)
	exec(`CREATE TABLE {s}farm_config (farm_id uuid, price_minor bigint, price_confirmed_at timestamptz)`)
	exec(`CREATE TABLE {s}users (id uuid, email text, name text, phone text, password_hash text,
	        email_verified_at timestamptz)`)
	exec(`CREATE TABLE {s}farm_owner_credentials (farm_id uuid, user_id uuid, name text, phone text,
	        password_hash text, created_at timestamptz)`)
	exec(`CREATE FUNCTION {s}farm_by_slug(p_slug text)
	        RETURNS TABLE (farm_id uuid, owner_id uuid, created_at timestamptz)
	        LANGUAGE sql AS $$ SELECT f.id, '` + ownerID + `'::uuid, f.created_at
	        FROM {s}farms f WHERE f.slug = p_slug $$`)
	exec(`INSERT INTO {s}farms (id, name, slug, timezone, currency)
	        VALUES ('` + farmID + `', 'Finca Semilla', '` + slug + `', 'America/Bogota', 'COP')`)
	s := &Server{pool: pool, cfg: Config{TenantInternalURL: "http://[::1"}}
	ctx := context.Background()

	// No memberships table: the member query cannot even be prepared.
	if _, err := s.buildTenantSeed(ctx, slug); err == nil || !strings.Contains(err.Error(), "memberships") {
		t.Fatalf("missing table: %v", err)
	}

	// A farm whose owner lookup answers but whose member list is empty.
	exec(`CREATE TABLE {s}memberships (farm_id uuid, user_id uuid, role text)`)
	if _, err := s.buildTenantSeed(ctx, slug); err == nil || err.Error() != "farm has no members" {
		t.Fatalf("no members: %v", err)
	}

	// A member row that does not scan: an account with no address.
	exec(`INSERT INTO {s}users (id, name, phone, password_hash) VALUES ('` + ownerID + `', 'Duena', '3000000000', 'h')`)
	exec(`INSERT INTO {s}memberships VALUES ('` + farmID + `', '` + ownerID + `', 'owner')`)
	if _, err := s.buildTenantSeed(ctx, slug); err == nil || strings.Contains(err.Error(), "no members") {
		t.Fatalf("unscannable member: %v", err)
	}

	// A good seed, and nowhere it can be sent.
	exec(`UPDATE {s}users SET email = 'duena-c2hb@example.com'`)
	seed, err := s.buildTenantSeed(ctx, slug)
	if err != nil || len(seed.Members) != 1 || seed.Members[0].Email != "duena-c2hb@example.com" {
		t.Fatalf("good seed: %+v %v", seed, err)
	}
	err = s.seedTenant(ctx, slug)
	var ue *url.Error
	if !errors.As(err, &ue) {
		t.Fatalf("an unparseable stack address: %v", err)
	}
}
