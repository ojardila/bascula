// Fixture for .semgrep/bascula-go.yml: `semgrep --test .semgrep`.
// Not compiled; Semgrep only parses it.
package fixture

import (
	"context"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Server struct{ pool *pgxpool.Pool }

func (s *Server) poolQueries(ctx context.Context, tx pgx.Tx, admin *pgxpool.Pool, id string) {
	// ruleid: bascula-pool-query-outside-tenant-tx
	s.pool.QueryRow(ctx, `SELECT name FROM workers WHERE id = $1`, id)
	// ruleid: bascula-pool-query-outside-tenant-tx
	s.pool.Exec(ctx, `DELETE FROM workers WHERE id = $1`, id)
	// ruleid: bascula-pool-query-outside-tenant-tx
	admin.Begin(ctx)
	// ok: bascula-pool-query-outside-tenant-tx
	tx.QueryRow(ctx, `SELECT name FROM workers WHERE id = $1`, id)
	// ok: bascula-pool-query-outside-tenant-tx
	s.pool.Stat()
}

func (s *Server) routes(mux *http.ServeMux, r chiRouter, h http.HandlerFunc) {
	// ruleid: bascula-route-outside-auth-chain
	mux.HandleFunc("GET /v1/secret", h)
	// ruleid: bascula-route-outside-auth-chain
	r.Post("/v1/workers", h)
	// ok: bascula-route-outside-auth-chain
	r.Method(rt.Method, rt.Pattern, h)
	// ok: bascula-route-outside-auth-chain
	r.Header.Get("Authorization")
}

const workerCols = `w.id, w.name`

func sql(ctx context.Context, tx pgx.Tx, table, order string) {
	// ruleid: bascula-sql-built-with-sprintf
	q := fmt.Sprintf("SELECT * FROM %s WHERE farm_id = $1", table)
	// ruleid: bascula-sql-built-with-sprintf
	tx.Query(ctx, fmt.Sprintf("DELETE FROM %s", table))
	// ruleid: bascula-sql-built-with-sprintf
	tx.Query(ctx, `SELECT id FROM workers ORDER BY `+strings.ToLower(order))
	// ok: bascula-sql-built-with-sprintf
	tx.Query(ctx, `SELECT `+workerCols+` FROM workers w WHERE w.id = $1`, order)
	// ok: bascula-sql-built-with-sprintf
	_ = fmt.Sprintf("worker %s selected from the list", table)
	_ = q
}

type Payable struct {
	ID string
	// ruleid: bascula-money-as-float
	AmountMinor float64
	// ok: bascula-money-as-float
	Kilos float64
}

func money(rateMinor int64, kilos float64) {
	// ruleid: bascula-money-as-float
	total := float64(rateMinor) * kilos
	// ok: bascula-money-as-float
	perHa := float64(kilos) / 3
	// ruleid: bascula-money-as-float
	var balance float64
	_, _, _ = total, perHa, balance
}
