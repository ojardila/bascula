package store

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
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
	return migrate(ctx, adminDSN, false)
}

// MigrateDev is Migrate for a local database: `make migrate`, CI and the test
// suite. The one difference is that migration 00001 also creates the login
// role bascula_api with the development password committed to this
// repository. Migrate never does, because on a cluster that role is a CNPG
// managed role with a password minted in-cluster, and a migration that ran
// before CNPG reconciled it used to create it first with the known password.
func MigrateDev(ctx context.Context, adminDSN string) error {
	return migrate(ctx, adminDSN, true)
}

// DevRoleSetting is the session setting 00001 reads to decide whether to
// create bascula_api. It travels as a startup parameter, so it is set on every
// connection goose opens and nothing in SQL has to remember to set it.
const DevRoleSetting = "bascula.dev_role"

func migrate(ctx context.Context, adminDSN string, devRole bool) error {
	cfg, err := pgx.ParseConfig(adminDSN)
	if err != nil {
		return fmt.Errorf("parse admin connection: %w", err)
	}
	if devRole {
		cfg.RuntimeParams[DevRoleSetting] = "on"
	}
	db := stdlib.OpenDB(*cfg)
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
