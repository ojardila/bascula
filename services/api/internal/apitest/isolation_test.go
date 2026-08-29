package apitest

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// TestTwoFarmsCannotSeeEachOther is the isolation test. Two farms are seeded
// with real data, and then farm A is asked for everything it can be asked for
// while holding farm B's rows in the same database.
//
// The point is not that the handlers filter correctly. It is that the API role
// physically cannot read the other farm even when the id is handed to it: the
// pool connects as bascula_api, which has no BYPASSRLS, and every table with a
// farm_id has a FORCE ROW LEVEL SECURITY policy on it.
func TestTwoFarmsCannotSeeEachOther(t *testing.T) {
	h := requireDB(t)

	a := h.signupFarm(t, "La Esperanza", 80000)
	b := h.signupFarm(t, "El Mirador", 90000)

	workerA := h.createWorker(t, a, "Ana", "12345678")
	workerB := h.createWorker(t, b, "Beatriz", "87654321")
	h.createPlot(t, a, "Lote A")
	plotB := h.createPlot(t, b, "Lote B")

	t.Run("a list shows only your own", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/workers", a.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("farm A sees %d workers, want 1: %s", len(items), res.Raw)
		}
		got := items[0].(map[string]any)["id"].(string)
		if got != workerA {
			t.Fatalf("farm A sees worker %s, want its own %s", got, workerA)
		}
	})

	t.Run("naming the other farm's id gets you nothing", func(t *testing.T) {
		// This is the case a WHERE clause forgets: the id is valid, it exists,
		// and it belongs to somebody else.
		res := h.do(t, http.MethodGet, "/v1/workers/"+workerB, a.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Fatalf("farm A reading farm B's worker: got %d %s, want 404",
				res.Status, res.Raw)
		}
		res = h.do(t, http.MethodGet, "/v1/plots/"+plotB, a.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Fatalf("farm A reading farm B's plot: got %d %s, want 404",
				res.Status, res.Raw)
		}

		// A balance is a sum, so an id that matches nothing sums to zero and
		// comes back as a believable "owes nothing". That is a worse answer
		// than an error: it says the worker is settled up when the truth is
		// that this farm has never heard of them.
		res = h.do(t, http.MethodGet, "/v1/workers/"+workerB+"/balance", a.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Fatalf("farm A reading farm B's balance: got %d %s, want 404",
				res.Status, res.Raw)
		}
		res = h.do(t, http.MethodGet,
			"/v1/workers/00000000-0000-7000-8000-000000000000/balance", a.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Fatalf("balance of a worker who does not exist: got %d %s, want 404",
				res.Status, res.Raw)
		}
	})

	t.Run("money does not cross either", func(t *testing.T) {
		h.settleSomething(t, b, workerB, plotB)

		res := h.mustDo(t, http.MethodGet, "/v1/balances", a.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		for _, raw := range items {
			row := raw.(map[string]any)
			if row["workerId"] == workerB {
				t.Fatalf("farm A can see farm B's balances: %s", res.Raw)
			}
		}
		if len(items) != 1 {
			t.Fatalf("farm A sees %d balances, want only its own worker: %s", len(items), res.Raw)
		}

		// Not an empty list: an empty ledger reads as "this person has no
		// movements yet", which is a believable and false answer about
		// somebody else's employee. 404 is the only honest one.
		res = h.do(t, http.MethodGet, "/v1/workers/"+workerB+"/ledger", a.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Fatalf("farm A reading farm B's ledger: got %d %s, want 404",
				res.Status, res.Raw)
		}
	})

	t.Run("the database itself refuses, not just the handler", func(t *testing.T) {
		// Straight at the store, bypassing every handler: farm A's context, a
		// direct query for farm B's row. RLS is the only thing standing here.
		h.withTenant(t, a.FarmID, a.OwnerUserID, domain.RoleOwner,
			func(ctx context.Context, tx pgx.Tx) {
				var n int
				err := tx.QueryRow(ctx,
					`SELECT count(*) FROM employees WHERE id = $1`, workerB).Scan(&n)
				if err != nil {
					t.Fatalf("query: %v", err)
				}
				if n != 0 {
					t.Fatalf("RLS let farm A count %d of farm B's employees", n)
				}

				// And it cannot write across the border either.
				_, err = tx.Exec(ctx, `
					INSERT INTO employees (id, farm_id, name)
					VALUES (gen_random_uuid(), $1, 'smuggled')`, b.FarmID)
				if err == nil {
					t.Fatal("farm A inserted a row into farm B; the WITH CHECK is not doing its job")
				}
			})
	})

	t.Run("without a tenant the answer is loud, not empty", func(t *testing.T) {
		// The dangerous failure: RLS returns zero rows and no error when
		// app.farm_id is unset, and an empty worker list looks exactly like a
		// new farm. A token with no farm must produce TENANT_NOT_SET.
		token := h.tokenWithoutFarm(t, a.OwnerUserID)
		res := h.do(t, http.MethodGet, "/v1/workers", token, nil)
		if res.Status != http.StatusInternalServerError {
			t.Fatalf("tenantless request: got %d %s, want 500", res.Status, res.Raw)
		}
		if res.code() != string(domain.CodeTenantNotSet) {
			t.Fatalf("tenantless request: got code %q, want TENANT_NOT_SET: %s",
				res.code(), res.Raw)
		}
	})
}
