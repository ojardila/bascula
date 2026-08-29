package store

import (
	"context"
	"database/sql"
	"fmt"

	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver, goose needs one
	"github.com/pressly/goose/v3"

	"github.com/ojardila/bascula/services/api/migrations"
)

// Migrate applies every pending migration. It runs as its own step before the
// rollout, never at process start: five replicas booting at once and all
// running migrations is a race.
//
// The DSN handed here is the owner's, not the API's: the API role must not be
// able to alter the tables whose policies protect it.
func Migrate(ctx context.Context, adminDSN string) error {
	db, err := sql.Open("pgx", adminDSN)
	if err != nil {
		return fmt.Errorf("open admin connection: %w", err)
	}
	defer db.Close()

	goose.SetBaseFS(migrations.FS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set dialect: %w", err)
	}
	if err := goose.UpContext(ctx, db, "."); err != nil {
		return fmt.Errorf("goose up: %w", err)
	}
	return nil
}

// MigrateDown rolls back one migration. It exists for local work; production
// moves forward.
func MigrateDown(ctx context.Context, adminDSN string) error {
	db, err := sql.Open("pgx", adminDSN)
	if err != nil {
		return fmt.Errorf("open admin connection: %w", err)
	}
	defer db.Close()

	goose.SetBaseFS(migrations.FS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set dialect: %w", err)
	}
	return goose.DownContext(ctx, db, ".")
}
