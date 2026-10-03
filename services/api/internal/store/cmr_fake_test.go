package store

import (
	"context"
	"errors"
	"reflect"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// A transaction scripted by SQL fragment, for the store's error branches that
// a live database cannot be made to take on demand: a row that fails to scan
// half-way through a result set, a result set whose iteration ends in an
// error, a unique index that fires between a check and the insert it guarded.
// Anything a test does not script panics through the nil embedded pgx.Tx, so a
// test that wanders onto an unexpected query fails loudly instead of passing.

var errCMR = errors.New("cmr: scripted failure")

type cmrTx struct {
	pgx.Tx
	query map[string]*cmrRows // Query: first fragment contained in the SQL
	row   map[string]cmrRow   // QueryRow
	exec  map[string]error    // Exec
	seen  []string
}

func (t *cmrTx) match(sql string, keys []string) string {
	for _, k := range keys {
		if strings.Contains(sql, k) {
			return k
		}
	}
	return ""
}

func keysOf[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	// Longest first, so a specific fragment wins over a general one.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && len(out[j]) > len(out[j-1]); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func (t *cmrTx) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	k := t.match(sql, keysOf(t.query))
	t.seen = append(t.seen, "Q:"+k)
	if k == "" {
		panic("cmr: unscripted query: " + sql)
	}
	r := t.query[k]
	if r.queryErr != nil {
		return nil, r.queryErr
	}
	r.i = 0
	return r, nil
}

func (t *cmrTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	k := t.match(sql, keysOf(t.row))
	t.seen = append(t.seen, "R:"+k)
	if k == "" {
		panic("cmr: unscripted query row: " + sql)
	}
	return t.row[k]
}

func (t *cmrTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	k := t.match(sql, keysOf(t.exec))
	t.seen = append(t.seen, "E:"+k)
	if k == "" {
		panic("cmr: unscripted exec: " + sql)
	}
	return pgconn.CommandTag{}, t.exec[k]
}

// cmrAssign copies vals onto dest; a nil value leaves the target at its zero.
func cmrAssign(dest, vals []any) {
	for i, v := range vals {
		if v == nil || i >= len(dest) {
			continue
		}
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(v))
	}
}

type cmrRow struct {
	vals []any
	err  error
}

func (r cmrRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	cmrAssign(dest, r.vals)
	return nil
}

// cmrRows is a result set of data rows. scanErr fails the scan of the row
// numbered failAt (1-based; 0 means never); iterErr is what Err reports
// once the rows run out.
type cmrRows struct {
	pgx.Rows
	data     [][]any
	scanErr  error
	failAt   int
	iterErr  error
	queryErr error
	i        int
}

func (r *cmrRows) Close()     {}
func (r *cmrRows) Err() error { return r.iterErr }

func (r *cmrRows) Next() bool {
	if r.i >= len(r.data) {
		return false
	}
	r.i++
	return true
}

func (r *cmrRows) Scan(dest ...any) error {
	if r.scanErr != nil && r.i == r.failAt {
		return r.scanErr
	}
	cmrAssign(dest, r.data[r.i-1])
	return nil
}

// cmrFailing is one row whose scan fails.
func cmrFailing() *cmrRows { return &cmrRows{data: [][]any{{}}, scanErr: errCMR, failAt: 1} }

// cmrEndsBadly is an empty result set whose iteration ends in an error.
func cmrEndsBadly() *cmrRows { return &cmrRows{iterErr: errCMR} }
