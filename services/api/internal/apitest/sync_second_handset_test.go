// SPDX-License-Identifier: MIT

package apitest

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// TestASecondHandsetDuplicateDoesNotSinkTheBatch: a weighing the owner pushed
// from one phone is invisible to the weigher, so when the weigher's phone
// pushes the same id the lookup misses and the INSERT hits the unique index.
// That is a duplicate, and it used to leave the batch's transaction aborted
// (SQLSTATE 25P02): the whole batch answered 500 and the phone retried it for
// ever, the weighing after it included.
func TestASecondHandsetDuplicateDoesNotSinkTheBatch(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de dos celulares", 80000)
	worker := h.createWorker(t, f, "Doble", "8118118118")
	shared, fresh := uuid.NewString(), uuid.NewString()
	op := func(id string, kg float64, device string) map[string]any {
		return map[string]any{"opId": uuid.NewString(), "entity": "workRecord", "op": "upsert", "payload": map[string]any{
			"id": id, "workerId": worker, "quantity": kg,
			"occurredAt": "2026-08-25T09:15:00-05:00", "deviceId": device,
		}}
	}

	ownerPhone := uuid.NewString()
	h.mustDo(t, http.MethodPost, "/v1/sync/push", f.OwnerToken, map[string]any{
		"deviceId": ownerPhone, "ops": []map[string]any{op(shared, 20, ownerPhone)},
	}, http.StatusOK)

	weigherPhone := uuid.NewString()
	res := h.mustDo(t, http.MethodPost, "/v1/sync/push", f.WeigherToken, map[string]any{
		"deviceId": weigherPhone, "ops": []map[string]any{op(shared, 20, weigherPhone), op(fresh, 15, weigherPhone)},
	}, http.StatusOK)
	rows, _ := res.Body["results"].([]any)
	if len(rows) != 2 {
		t.Fatalf("want two results: %s", res.Raw)
	}
	if st := rows[0].(map[string]any)["status"]; st != "duplicate" {
		t.Fatalf("the second handset's copy should be a duplicate, got %v: %s", st, res.Raw)
	}
	if st := rows[1].(map[string]any)["status"]; st != "applied" {
		t.Fatalf("the weighing after the duplicate was lost, got %v: %s", st, res.Raw)
	}
	var n int
	if err := h.admin.QueryRow(context.Background(),
		`SELECT count(*)::int FROM work_records WHERE id = ANY($1::uuid[])`, []string{shared, fresh}).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 2 {
		t.Fatalf("%d of the two weighings are stored, want 2 (one each, no copy)", n)
	}
}
