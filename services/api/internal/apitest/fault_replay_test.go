package apitest

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// The fault replay runs every request of this suite again before the real
// one, with the request transaction failing on its 1st call, then its 2nd,
// and so on until a run finishes without reaching the failure. Each failed
// run is rolled back, so the real request that follows sees the same
// database as before. It walks the "if err != nil" after every database call,
// which no ordinary test can reach. Set API_FAULT_REPLAY=0 to skip it.

var errInjected = errors.New("injected database failure")

type faultPlan struct {
	failAt int
	calls  int
	hit    bool
}

type faultKey struct{}

func faultReplayOn() bool { return os.Getenv("API_FAULT_REPLAY") != "0" }

func init() {
	tenant.SetTestTxWrapper(func(ctx context.Context, tx pgx.Tx) pgx.Tx {
		plan, _ := ctx.Value(faultKey{}).(*faultPlan)
		if plan == nil {
			return tx
		}
		return &flakyTx{Tx: tx, plan: plan}
	})
}

type flakyTx struct {
	pgx.Tx
	plan *faultPlan
	// nested is true for a savepoint. The outer transaction of a replay is
	// never committed, even on the run that reached no failure: the real
	// request comes next and has to find the database untouched.
	nested bool
}

// fail counts one database call and says whether this is the one that fails.
func (f *flakyTx) fail() bool {
	if f.plan.hit {
		return true
	}
	f.plan.calls++
	if f.plan.calls == f.plan.failAt {
		f.plan.hit = true
		return true
	}
	return false
}

func (f *flakyTx) Begin(ctx context.Context) (pgx.Tx, error) {
	if f.fail() {
		return nil, errInjected
	}
	inner, err := f.Tx.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &flakyTx{Tx: inner, plan: f.plan, nested: true}, nil
}

func (f *flakyTx) Commit(ctx context.Context) error {
	if !f.nested {
		_ = f.Tx.Rollback(ctx)
		if f.plan.hit {
			return errInjected
		}
		return nil
	}
	if f.plan.hit {
		_ = f.Tx.Rollback(ctx)
		return errInjected
	}
	return f.Tx.Commit(ctx)
}

func (f *flakyTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if f.fail() {
		return pgconn.CommandTag{}, errInjected
	}
	return f.Tx.Exec(ctx, sql, args...)
}

func (f *flakyTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if f.fail() {
		return nil, errInjected
	}
	return f.Tx.Query(ctx, sql, args...)
}

type failedRow struct{}

func (failedRow) Scan(...any) error { return errInjected }

func (f *flakyTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if f.fail() {
		return failedRow{}
	}
	return f.Tx.QueryRow(ctx, sql, args...)
}

func (f *flakyTx) CopyFrom(ctx context.Context, t pgx.Identifier, c []string, src pgx.CopyFromSource) (int64, error) {
	if f.fail() {
		return 0, errInjected
	}
	return f.Tx.CopyFrom(ctx, t, c, src)
}

type failedBatch struct{}

func (failedBatch) Exec() (pgconn.CommandTag, error) { return pgconn.CommandTag{}, errInjected }
func (failedBatch) Query() (pgx.Rows, error)         { return nil, errInjected }
func (failedBatch) QueryRow() pgx.Row                { return failedRow{} }
func (failedBatch) Close() error                     { return errInjected }

func (f *flakyTx) SendBatch(ctx context.Context, b *pgx.Batch) pgx.BatchResults {
	if f.fail() {
		return failedBatch{}
	}
	return f.Tx.SendBatch(ctx, b)
}

// replayWithFaults sends req's twin once per database call it makes, each time
// failing a later call. raw is the body, re-read for every run.
func (h *harness) replayWithFaults(req *http.Request, raw string) {
	if !faultReplayOn() || sideEffectful(req.URL.Path) {
		return
	}
	for n := 1; n <= 60; n++ {
		plan := &faultPlan{failAt: n}
		twin := req.Clone(context.WithValue(req.Context(), faultKey{}, plan))
		twin.Body = httpBody(raw)
		// A twin of its own address, so the replay never spends the per-IP
		// buckets a test is counting on.
		twin.RemoteAddr = "10.250.0.1:12345"
		func() {
			defer func() { _ = recover() }()
			h.server.ServeHTTP(httptest.NewRecorder(), twin)
		}()
		if !plan.hit {
			return
		}
	}
}

func httpBody(raw string) *readCloser { return &readCloser{strings.NewReader(raw)} }

type readCloser struct{ *strings.Reader }

func (readCloser) Close() error { return nil }

// sideEffectful lists the routes whose failed runs would still leave a trace
// outside the transaction (an email in the fake outbox, a login attempt in
// an in-memory limiter), which the real request after the replay would trip
// over. They keep their ordinary tests only.
func sideEffectful(path string) bool {
	for _, p := range []string{"/v1/signup", "/v1/auth/", "/oauth", "/mcp", "/.well-known", "invit"} {
		if strings.Contains(path, p) {
			return true
		}
	}
	return false
}
