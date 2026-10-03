package apitest

import (
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// TestWeighingForAWorkerNotOnTheFarm checks that every route that writes a
// weighing answers 404 for a worker that does not exist, or that belongs to
// another farm, instead of letting the foreign key surface as a 500.
func TestWeighingForAWorkerNotOnTheFarm(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca sin ese trabajador", 80000)
	other := h.signupFarm(t, "Finca vecina", 80000)
	mine := h.createWorker(t, f, "Rosa", "6301")
	theirs := h.createWorker(t, other, "Luz", "6302")

	for name, worker := range map[string]string{"unknown": uuid.NewString(), "another farm's": theirs} {
		t.Run(name+" worker", func(t *testing.T) {
			notHere := func(t *testing.T, path string, body map[string]any) {
				t.Helper()
				res := h.do(t, http.MethodPost, path, f.OwnerToken, body)
				if res.Status != http.StatusNotFound {
					t.Fatalf("POST %s: got %d %s, want 404", path, res.Status, res.Raw)
				}
			}
			notHere(t, "/v1/work-records", map[string]any{
				"activityId": h.harvestActivityID(t, f), "workerId": worker, "quantity": 10, "dateFrom": "2026-08-25",
			})
			notHere(t, "/v1/pickups", map[string]any{"workerId": worker, "weight": "12.5", "date": "2026-08-25"})

			res := h.do(t, http.MethodPost, "/v1/work-records/batch", f.OwnerToken, map[string]any{"items": []any{
				map[string]any{"workerId": mine, "quantity": 10, "dateFrom": "2026-08-25"},
				map[string]any{"workerId": worker, "quantity": 10, "dateFrom": "2026-08-25"},
			}})
			if res.Status != http.StatusNotFound || !strings.Contains(string(res.Raw), `"line":1`) {
				t.Fatalf("batch: got %d %s, want 404 naming line 1", res.Status, res.Raw)
			}
		})
	}

	// The batch is all or nothing: Rosa's good line was not kept either.
	res := h.mustDo(t, http.MethodGet, "/v1/work-records?workerId="+mine, f.OwnerToken, nil, http.StatusOK)
	if items, _ := res.Body["items"].([]any); len(items) != 0 {
		t.Fatalf("a refused batch wrote %d records: %s", len(items), res.Raw)
	}
}
