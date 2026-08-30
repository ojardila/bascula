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

// The pool is sized for two different kinds of request, and the second kind is
// why the first number is not the whole number.
//
// OrdinaryConns is what everything except the season import shares: 117 routes
// that hold a connection for a handful of milliseconds. Ten is generous for
// them and always was.
//
// The season import is the exception, and it is a large one. Its transaction is
// opened by the tenant middleware BEFORE the handler reads a byte of the body,
// and the body is a season uploaded over a rural connection — up to 25 minutes
// of it, by this service's own deadline. So an import does not hold a
// connection for milliseconds; it holds one for as long as the phone takes to
// finish talking, `idle in transaction` the whole time.
//
// Measured, on this laptop, with the upload trickled to make the shape visible:
//
//	 2 imports at once → 2 of 10 held; ordinary traffic median 2.9 ms, no failures
//	11 imports at once → 10 of 10 held; ordinary traffic still answered, but
//	                     the slowest waited 17.8 SECONDS for a connection
//
// Nothing errors. pgx queues, so the pool going dry looks like the whole
// service getting slower, on every route, for every farm — with /health
// answering throughout, because it touches no database. At the real deadline
// that 17.8 s is 25 minutes, and it is the same outage the note on
// tenant.KeepChanges describes, arrived at from the other direction.
//
// Two numbers fix it together, and neither would do it alone. MaxImportsAtOnce
// caps how many of these long holds can exist; the pool is that many
// connections LARGER than the ordinary ten, so the imports borrow their own and
// never the ones a settlement screen is waiting on. Raising MaxConns without
// the cap would only move the cliff; capping without the extra connections
// would make an import and a payroll compete for the same ten.
const (
	OrdinaryConns = 10
	// MaxImportsAtOnce is deliberately small. An import is a once-in-a-farm's-
	// life act by an owner moving from the phone to the server, and three at
	// the same time across the whole platform is already more than the shape
	// of the thing predicts. The fourth is refused immediately — in
	// milliseconds, holding nothing — and told to come back, which is a far
	// better minute than being served at the price of everybody else's.
	MaxImportsAtOnce = 3
)

// Open builds the pool the API serves from. The DSN must point at a role
// without BYPASSRLS: row level security is the isolation boundary, and a
// superuser DSN quietly removes it.
func Open(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConns = OrdinaryConns + MaxImportsAtOnce
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

// IsCheckViolation reports whether err is a CHECK constraint violation,
// optionally a specific one. It is how a rule the database owns — a valid IANA
// timezone, a line that adds up — becomes a message a form can show instead of
// a 500.
func IsCheckViolation(err error, constraint string) bool {
	pe, ok := PgErr(err)
	if !ok || pe.Code != "23514" {
		return false
	}
	return constraint == "" || pe.ConstraintName == constraint
}

// NoRows is pgx.ErrNoRows, re-exported so handlers need not import pgx.
var NoRows = pgx.ErrNoRows
