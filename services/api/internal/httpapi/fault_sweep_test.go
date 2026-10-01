package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

var errDBDown = errors.New("database is down")

// brokenTx is a transaction whose every call fails, the way it does when
// Postgres goes away in the middle of a request.
type brokenTx struct{}

type brokenRow struct{}

func (brokenRow) Scan(...any) error { return errDBDown }

func (brokenTx) Begin(context.Context) (pgx.Tx, error) { return nil, errDBDown }
func (brokenTx) Commit(context.Context) error          { return errDBDown }
func (brokenTx) Rollback(context.Context) error        { return errDBDown }
func (brokenTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, errDBDown
}
func (brokenTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return brokenBatch{} }
func (brokenTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }
func (brokenTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, errDBDown
}
func (brokenTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errDBDown
}
func (brokenTx) Query(context.Context, string, ...any) (pgx.Rows, error) { return nil, errDBDown }
func (brokenTx) QueryRow(context.Context, string, ...any) pgx.Row        { return brokenRow{} }
func (brokenTx) Conn() *pgx.Conn                                         { return nil }

type brokenBatch struct{}

func (brokenBatch) Exec() (pgconn.CommandTag, error) { return pgconn.CommandTag{}, errDBDown }
func (brokenBatch) Query() (pgx.Rows, error)         { return nil, errDBDown }
func (brokenBatch) QueryRow() pgx.Row                { return brokenRow{} }
func (brokenBatch) Close() error                     { return errDBDown }

// TestHandlersFailClosed sends every route of the API to a handler whose
// database is gone, and once more with no tenant at all, with a few bodies
// each. It walks the error branches the database-backed suites cannot reach:
// every "if err != nil" after a store call. A route that answers 2xx with the
// database down is reported, except the few that never touch it.
func TestHandlersFailClosed(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	s := New(nil, nil, Config{UploadDir: t.TempDir()})
	const farmID = "0192f3a0-0000-7000-8000-000000000001"
	const id = "0192f3a0-0000-7000-8000-0000000000aa"

	ok2xx := map[string]bool{}
	for _, mode := range []string{"broken-db", "no-tenant"} {
		for _, role := range []domain.Role{domain.RoleOwner, domain.RoleWeigher} {
			r := chi.NewRouter()
			r.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					ctx := auth.WithPrincipal(req.Context(), &auth.Principal{
						UserID: id, FarmID: farmID, Role: role, Email: "dueno@example.com",
					})
					if mode == "broken-db" {
						ctx = tenant.WithTestTx(ctx, brokenTx{}, farmID)
					}
					next.ServeHTTP(w, req.WithContext(ctx))
				})
			})
			for _, rt := range s.Routes() {
				r.MethodFunc(rt.Method, rt.Pattern, rt.Handler)
			}
			for _, rt := range s.Routes() {
				path := strings.NewReplacer("{id}", id, "{slug}", "finca", "{cropId}", id,
					"{workerId}", id, "{plotId}", id, "{token}", "x", "{noteId}", id).Replace(rt.Pattern)
				path = strings.ReplaceAll(path, "*", "x")
				for _, body := range []string{"", "{}", `{"id":"` + id + `","name":"x","workerId":"` + id + `"}`} {
					func() {
						defer func() { _ = recover() }()
						req := httptest.NewRequest(rt.Method, path+"?from=2026-01-01&to=2026-01-31", strings.NewReader(body))
						req.Header.Set("Content-Type", "application/json")
						rec := httptest.NewRecorder()
						r.ServeHTTP(rec, req)
						if mode == "broken-db" && rec.Code < 300 && body == "{}" {
							ok2xx[rt.Method+" "+rt.Pattern] = true
						}
					}()
				}
			}
		}
	}
	// These answer from configuration alone: health, discovery documents,
	// CORS preflights, the slug checker and the "is reset email on" probe.
	dbFree := map[string]bool{"GET /v1/farm-slugs": true, "GET /v1/auth/password-reset": true}
	for k := range ok2xx {
		if strings.HasPrefix(k, "GET /v1/") || strings.HasPrefix(k, "POST /v1/") ||
			strings.HasPrefix(k, "PATCH /v1/") || strings.HasPrefix(k, "PUT /v1/") ||
			strings.HasPrefix(k, "DELETE /v1/") {
			if !dbFree[k] {
				t.Errorf("%s answered 2xx with the database down", k)
			}
		}
	}
}
