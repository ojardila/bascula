// SPDX-License-Identifier: MIT

package apitest

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

type syncCase struct {
	what    string
	entity  string
	op      string
	payload any
	want    string // applied, duplicate or rejected
}

// pushCases sends every case as one envelope of a single batch and checks
// each row's own status: the batch answers 200 whatever its rows say.
func (h *harness) pushCases(t *testing.T, token string, cases []syncCase) {
	t.Helper()
	ops := make([]map[string]any, 0, len(cases))
	for _, c := range cases {
		ops = append(ops, map[string]any{"opId": uuid.NewString(), "entity": c.entity, "op": c.op, "payload": c.payload})
	}
	res := h.mustDo(t, http.MethodPost, "/v1/sync/push", token, map[string]any{
		"deviceId": uuid.NewString(), "ops": ops,
	}, http.StatusOK)
	results, _ := res.Body["results"].([]any)
	if len(results) != len(cases) {
		t.Fatalf("want %d results, got %d: %s", len(cases), len(results), res.Raw)
	}
	for i, c := range cases {
		row, _ := results[i].(map[string]any)
		if row["status"] != c.want {
			t.Errorf("%s: status %v, want %s: %v", c.what, row["status"], c.want, row)
		}
	}
}

func TestSyncPushRefusesMalformedEnvelopes(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de sobres raros", 80000)
	worker := h.createWorker(t, f, "Luz Marina", "43000111")
	h.pushCases(t, f.OwnerToken, []syncCase{
		{"a worker deleted by op", "worker", "delete", map[string]any{"id": worker}, "rejected"},
		{"a work record deleted by op", "workRecord", "delete", map[string]any{"id": uuid.NewString()}, "rejected"},
		{"a ledger movement upserted", "ledgerEntry", "upsert", map[string]any{"id": uuid.NewString()}, "rejected"},
		{"an entity nobody knows", "tractor", "upsert", map[string]any{"id": uuid.NewString()}, "rejected"},
		{"no payload", "worker", "upsert", nil, "rejected"},
		{"a payload that is not an object", "worker", "upsert", "Luz", "rejected"},
		{"a worker without a name", "worker", "upsert", map[string]any{"id": uuid.NewString()}, "rejected"},
		{"a worker taken off by upsert", "worker", "upsert", map[string]any{
			"id": worker, "name": "Luz Marina", "deletedAt": "2026-09-01T00:00:00-05:00"}, "duplicate"},
	})
}

func TestSyncPushRefusesBadWeighings(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de pesadas raras", 80000)
	worker := h.createWorker(t, f, "Jairo", "43000222")
	weighing := func(extra map[string]any) map[string]any {
		p := map[string]any{"id": uuid.NewString(), "workerId": worker, "quantity": "12.5",
			"occurredAt": "2026-09-01T10:00:00-05:00"}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}
	kept := uuid.NewString()
	h.pushCases(t, f.WeigherToken, []syncCase{
		{"no worker", "workRecord", "upsert", weighing(map[string]any{"workerId": ""}), "rejected"},
		{"the deletion of one that never came", "workRecord", "upsert", weighing(map[string]any{"deletedAt": "2026-09-01T11:00:00-05:00"}), "duplicate"},
		{"no instant", "workRecord", "upsert", weighing(map[string]any{"occurredAt": ""}), "rejected"},
		{"a bare day", "workRecord", "upsert", weighing(map[string]any{"occurredAt": "2026-09-01"}), "rejected"},
		{"a negative weight", "workRecord", "upsert", weighing(map[string]any{"quantity": "-3"}), "rejected"},
		{"a fourth decimal", "workRecord", "upsert", weighing(map[string]any{"quantity": "1.2345"}), "rejected"},
		{"a crop that is not here", "workRecord", "upsert", weighing(map[string]any{"cropId": uuid.NewString()}), "rejected"},
		{"a good one", "workRecord", "upsert", weighing(map[string]any{"id": kept}), "applied"},
	})
	h.pushCases(t, f.OwnerToken, []syncCase{
		{"the good one deleted later", "workRecord", "upsert", weighing(map[string]any{"id": kept, "deletedAt": "2026-09-02T08:00:00-05:00"}), "applied"},
	})
}

func TestSyncPushRefusesBadLedgerMovements(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de pagos raros", 80000)
	worker := h.createWorker(t, f, "Mireya", "43000333")
	move := func(extra map[string]any) map[string]any {
		p := map[string]any{"id": uuid.NewString(), "workerId": worker, "kind": "anticipo", "amountCents": 20_000_00}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}
	h.pushCases(t, f.OwnerToken, []syncCase{
		{"no worker", "ledgerEntry", "append", move(map[string]any{"workerId": ""}), "rejected"},
		{"zero", "ledgerEntry", "append", move(map[string]any{"amountCents": 0}), "rejected"},
		{"a devengo from the phone", "ledgerEntry", "append", move(map[string]any{"kind": "devengo"}), "rejected"},
		{"a kind nobody knows", "ledgerEntry", "append", move(map[string]any{"kind": "regalo"}), "rejected"},
		{"a method nobody knows", "ledgerEntry", "append", move(map[string]any{"kind": "pago", "method": "trueque"}), "rejected"},
		{"a deduction paid somehow", "ledgerEntry", "append", move(map[string]any{"kind": "deduccion", "method": "efectivo"}), "rejected"},
		{"a day in the wrong shape", "ledgerEntry", "append", move(map[string]any{"date": "01/09/2026"}), "rejected"},
		{"a negative advance", "ledgerEntry", "append", move(map[string]any{"amountCents": -5_000_00, "date": "2026-09-01"}), "applied"},
		{"an adjustment", "ledgerEntry", "append", move(map[string]any{"kind": "ajuste", "amountCents": 1_000_00}), "applied"},
	})
}

func TestSyncPullRefusesBadParameters(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del cursor raro", 80000)
	for _, q := range []string{"?cursor=-1", "?limit=x", "?deviceId=no-es-uuid"} {
		expectStatus(t, q, h.do(t, http.MethodGet, "/v1/sync/pull"+q, f.WeigherToken, nil), http.StatusBadRequest)
	}
	for _, q := range []string{"?limit=0", "?limit=1000000", "?deviceId=" + uuid.NewString()} {
		expectStatus(t, q, h.do(t, http.MethodGet, "/v1/sync/pull"+q, f.WeigherToken, nil), http.StatusOK)
	}
}
