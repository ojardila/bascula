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
	"crypto/rand"
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

	rc, err := resolveConfig(os.Getenv)
	if err != nil {
		return err
	}
	for _, w := range rc.warnings {
		slog.Warn(w)
	}

	pool, err := store.Open(ctx, appDSN)
	if err != nil {
		return fmt.Errorf("database: %w", err)
	}
	defer pool.Close()

	cfg := rc.http

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
		Addr:              ":" + rc.port,
		Handler:           httpapi.New(pool, auth.NewSigner(rc.secret, "bascula"), cfg),
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

// appEnvDevelopment is the one and only value of APP_ENV that unlocks the
// development posture. Anything else — "production", "staging", a typo, and
// above all NOTHING AT ALL — is production.
//
// The direction of that default is the whole point, and it used to run the
// other way. `env("APP_ENV", "development")` made the omission of the variable
// mean development, which put the guard "JWT_SECRET is required outside
// development" behind the very variable whose absence should have fired it: a
// process started with no environment at all took the development branch,
// signed its access tokens with a constant that is committed to this
// repository, echoed the email verification token out of signup, and dropped
// uploads in the system temp directory. Every one of those is a decision that
// must be TAKEN, never inherited from a missing line in a unit file.
//
// A misconfigured deployment now refuses to boot, which is a page at three in
// the morning. The alternative was a deployment that boots and hands anybody
// who can read this file an owner token for any farm on the platform, which is
// the payroll of everybody picking coffee this week.
const appEnvDevelopment = "development"

// minSecretBytes is the floor for JWT_SECRET, and it is not arbitrary.
//
// The tokens are HS256, and RFC 7518 §3.2 says of HMAC with SHA-2: "A key of
// the same size as the hash output (for instance, 256 bits for HS256) or
// larger MUST be used with this algorithm." Shorter than the digest and the
// key, not the hash, is what an attacker attacks — and an HS256 token is an
// offline oracle, so the guessing costs them no request to this server and
// leaves nothing in these logs.
const minSecretBytes = 32

// leakedDevSigningKey is the constant this program used to fall back to. It is
// kept for exactly one purpose: to refuse it.
//
// It is in the git history of a public repository, so it is not a secret and
// cannot be made into one by pasting it into JWT_SECRET — which is precisely
// what somebody does when a boot fails and the error says a signing key is
// missing and this string is the nearest one to hand. Refusing it in EVERY
// environment, development included, is what keeps that from being a workable
// shortcut.
const leakedDevSigningKey = "development-only-signing-key-not-for-production"

// resolved is what the serving path takes from the environment.
//
// The two database URLs stay in run(): -migrate and -prune reach for
// ADMIN_DATABASE_URL and exit before ever coming here, and they must keep
// booting without a signing key, because a job that applies migrations signs
// nothing.
type resolved struct {
	port     string
	secret   []byte
	http     httpapi.Config
	warnings []string
}

// resolveConfig reads the environment and decides whether this process is
// allowed to serve. It takes getenv rather than calling os.Getenv so that the
// refusals below can be tested — the old code made these decisions inline in
// run(), between a signal handler and a listening socket, where no test could
// reach them and where they went four sprints without one.
func resolveConfig(getenv func(string) string) (resolved, error) {
	or := func(key, fallback string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return fallback
	}

	development := getenv("APP_ENV") == appEnvDevelopment
	rc := resolved{port: or("PORT", "8080"), http: httpapi.DefaultConfig()}

	secret := getenv("JWT_SECRET")
	switch {
	case secret == leakedDevSigningKey:
		return resolved{}, errors.New(
			"JWT_SECRET is the old built-in development key, which is public: " +
				"generate one with `openssl rand -base64 48`")
	case secret == "":
		if !development {
			return resolved{}, errors.New(
				"JWT_SECRET is required unless APP_ENV=development: " +
					"generate one with `openssl rand -base64 48`")
		}
		// Development gets a key, but a DIFFERENT key on every boot.
		//
		// A constant here was worse than the missing environment variable it
		// covered for: it made one forged token work against every laptop,
		// every branch deployment and every machine that ever started without
		// APP_ENV set, forever, because a value that ships in the source can
		// never be rotated. Random-per-boot is the same convenience with none
		// of that — no key to configure, and the tokens it signs are worth
		// nothing anywhere but the process that minted them.
		//
		// The cost is that a restart invalidates the access tokens handed out
		// before it. That is 15 minutes of them (auth.AccessTTL), and both
		// clients answer a 401 by refreshing exactly once: refresh tokens are
		// rows in Postgres hashed with sha256, not signatures, so a session
		// survives the restart even though the access token does not.
		buf := make([]byte, minSecretBytes)
		if _, err := rand.Read(buf); err != nil {
			return resolved{}, fmt.Errorf("generate a development signing key: %w", err)
		}
		secret = string(buf)
		rc.warnings = append(rc.warnings,
			"development mode: signing key generated at random for this process only; "+
				"tokens issued before a restart stop working after it")
	case len(secret) < minSecretBytes:
		return resolved{}, fmt.Errorf(
			"JWT_SECRET is %d bytes; HS256 needs at least %d (RFC 7518 §3.2)",
			len(secret), minSecretBytes)
	}
	rc.secret = []byte(secret)

	rc.http.DevEcho = development
	if development {
		// The signup response echoes the email verification token, because
		// there is no mail sender yet. Saying so out loud beats discovering it
		// in production.
		rc.warnings = append(rc.warnings,
			"development mode: signup echoes the email verification token")
	}

	// Where uploaded photos and receipts land. There is no object storage in
	// this environment, so internal/blob writes to disk and this is the
	// directory. It must be a volume that survives a restart and is shared by
	// every replica; the default under /tmp is a development convenience and
	// nothing else, which is why it is warned about.
	rc.http.UploadDir = getenv("UPLOAD_DIR")
	if rc.http.UploadDir == "" && !development {
		return resolved{}, errors.New(
			"UPLOAD_DIR is required unless APP_ENV=development: " +
				"uploads go to a directory, and the default one is temporary")
	}
	if n, err := strconv.Atoi(getenv("SIGNUPS_PER_IP_PER_HOUR")); err == nil && n > 0 {
		rc.http.SignupsPerIPPerHour = n
	}
	// The login limiter's two axes. They are tunable because the right number
	// for a farm office behind one router and the right number for a platform
	// serving a hundred of them are not the same number, and the operator who
	// finds that out at four in the morning should not need a build to act on
	// it. A zero or a negative value keeps the default rather than disabling
	// the limit: "0" in an environment file is far more often a mistake than a
	// decision to turn the front door's lock off.
	if n, err := strconv.Atoi(getenv("LOGIN_FAILURES_PER_EMAIL")); err == nil && n > 0 {
		rc.http.LoginFailuresPerEmail = n
	}
	if n, err := strconv.Atoi(getenv("LOGIN_FAILURES_PER_IP")); err == nil && n > 0 {
		rc.http.LoginFailuresPerIP = n
	}
	if d, err := time.ParseDuration(getenv("LOGIN_FAILURE_WINDOW")); err == nil && d > 0 {
		rc.http.LoginFailureWindow = d
	}
	return rc, nil
}
