// Package store is the only place that speaks SQL. The money queries in
// money.go are ports of apps/mobile/src/schema.ts, kept as close to the
// original text as Postgres allows: a rewrite would prove nothing about what
// the phone actually executes.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Open builds the pool the API serves from. The DSN must point at a role
// without BYPASSRLS: row level security is the isolation boundary, and a
// superuser DSN quietly removes it.
func Open(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConns = 10
	cfg.MaxConnLifetime = time.Hour
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// PgErr digs a *pgconn.PgError out of a wrapped chain so callers can branch on
// a constraint name instead of on a message.
func PgErr(err error) (*pgconn.PgError, bool) {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		return pe, true
	}
	return nil, false
}

// IsUniqueViolation reports whether err is a unique violation, optionally on a
// specific constraint.
func IsUniqueViolation(err error, constraint string) bool {
	pe, ok := PgErr(err)
	if !ok || pe.Code != "23505" {
		return false
	}
	return constraint == "" || pe.ConstraintName == constraint
}

// NoRows is pgx.ErrNoRows, re-exported so handlers need not import pgx.
var NoRows = pgx.ErrNoRows
