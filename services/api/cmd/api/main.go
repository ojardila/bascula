// Command api is the Bascula multi-tenant HTTP service.
//
// It has three jobs and a flag to pick between them: serve, run the
// migrations, or sweep the sync feed. The two out-of-band jobs are deliberate
// separate steps — five replicas booting at once and all running goose is a
// race, and pruning an append-only table is not something a request-serving
// process should be able to do at all.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
	"github.com/ojardila/bascula/services/api/internal/store"
)

func main() {
	migrateOnly := flag.Bool("migrate", false, "apply pending migrations and exit")
	pruneOnly := flag.Bool("prune", false,
		"sweep the superseded rows out of sync_log and the expired rows out of sync_ops, then exit")
	flag.Parse()

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	if err := run(*migrateOnly, *pruneOnly); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(migrateOnly, pruneOnly bool) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// ADMIN_DATABASE_URL owns the schema; DATABASE_URL is the application
	// role, which must not have BYPASSRLS. Two URLs, on purpose: the process
	// that serves requests cannot alter the tables whose policies protect it.
	adminDSN := env("ADMIN_DATABASE_URL",
		"postgres://postgres:postgres@localhost:5433/bascula?sslmode=disable")
	appDSN := env("DATABASE_URL",
		"postgres://bascula_api:bascula_api_dev@localhost:5433/bascula?sslmode=disable")

	if migrateOnly {
		migCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		if err := store.Migrate(migCtx, adminDSN); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
		slog.Info("migrations applied")
		return nil
	}

	// The sweep of docs/sincronizacion.md §3.4. It runs on the ADMIN url for
	// the same reason migrations do: sync_log is append-only and DELETE is
	// revoked from the application role, so the process that serves requests
	// cannot prune the feed even by accident. A scheduler runs this nightly;
	// it is idempotent and there is nothing to co-ordinate if two run at once.
	if pruneOnly {
		pruneCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
		admin, err := pgxpool.New(pruneCtx, adminDSN)
		if err != nil {
			return fmt.Errorf("prune: connect: %w", err)
		}
		defer admin.Close()
		rep, err := store.PruneSync(pruneCtx, admin,
			store.SyncLogRetentionDays, store.SyncOpsRetentionDays)
		if err != nil {
			return fmt.Errorf("prune: %w", err)
		}
		slog.Info("sync feed pruned",
			"syncLogDeleted", rep.SyncLogDeleted,
			"syncOpsDeleted", rep.SyncOpsDeleted,
			"syncLogRetentionDays", store.SyncLogRetentionDays,
			"syncOpsRetentionDays", store.SyncOpsRetentionDays,
			"took", rep.Took.String())
		return nil
	}

	secret := os.Getenv("JWT_SECRET")
	devEcho := env("APP_ENV", "development") == "development"
	if secret == "" {
		if !devEcho {
			return errors.New("JWT_SECRET is required outside development")
		}
		secret = "development-only-signing-key-not-for-production"
		slog.Warn("using the development signing key; set JWT_SECRET before deploying")
	}
	if devEcho {
		// The signup response echoes the email verification token, because
		// there is no mail sender yet. Saying so out loud beats discovering it
		// in production.
		slog.Warn("development mode: signup echoes the email verification token")
	}

	pool, err := store.Open(ctx, appDSN)
	if err != nil {
		return fmt.Errorf("database: %w", err)
	}
	defer pool.Close()

	cfg := httpapi.DefaultConfig()
	cfg.DevEcho = devEcho
	// Where uploaded photos and receipts land. There is no object storage in
	// this environment, so internal/blob writes to disk and this is the
	// directory. It must be a volume that survives a restart and is shared by
	// every replica; the default under /tmp is a development convenience and
	// nothing else, which is why it is warned about.
	cfg.UploadDir = os.Getenv("UPLOAD_DIR")
	if cfg.UploadDir == "" && !devEcho {
		return errors.New("UPLOAD_DIR is required outside development: " +
			"uploads go to a directory, and the default one is temporary")
	}
	if n, err := strconv.Atoi(os.Getenv("SIGNUPS_PER_IP_PER_HOUR")); err == nil && n > 0 {
		cfg.SignupsPerIPPerHour = n
	}

	// The timeouts, and the reason they stay where they are.
	//
	// These are the numbers that protect the process from a connection that
	// dribbles: a body read with no deadline is a goroutine, a socket and a
	// file descriptor held for as long as somebody cares to hold them, on any
	// of the 117 routes, by anybody who can open a socket.
	//
	// ONE route legitimately needs more than 30 seconds of body: POST
	// /v1/import/season carries a whole season — 11,7 MB in the rehearsal —
	// and on a farm's connection that is minutes, not seconds. It would be a
	// mistake to buy that here. Raising ReadTimeout to 25 minutes globally
	// gives every anonymous caller the same 25 minutes and turns the one
	// exception into the rule.
	//
	// So the exception is bought where it applies: the import handler extends
	// this connection's own read and write deadlines with
	// http.ResponseController, after the permission table has established that
	// the caller is the owner of a real farm, and it extends them only while
	// the upload keeps making progress. See importReadBudget in
	// internal/httpapi/handlers_import.go. Everything else keeps these.
	srv := &http.Server{
		Addr:              ":" + env("PORT", "8080"),
		Handler:           httpapi.New(pool, auth.NewSigner([]byte(secret), "bascula"), cfg),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()

	slog.Info("listening", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	slog.Info("stopped")
	return nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
