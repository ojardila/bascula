// Command api is the Bascula multi-tenant HTTP service.
//
// It has two jobs and a flag to pick between them: serve, or run the
// migrations. Migrations are a deliberate separate step, run before the
// rollout — five replicas booting at once and all running goose is a race.
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

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
	"github.com/ojardila/bascula/services/api/internal/store"
)

func main() {
	migrateOnly := flag.Bool("migrate", false, "apply pending migrations and exit")
	flag.Parse()

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	if err := run(*migrateOnly); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(migrateOnly bool) error {
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
