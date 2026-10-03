package apitest

import (
	"net/http"
	"strings"
	"testing"
)

// TestWorkRecordBatchRefusals covers the checks a batch of weighings meets
// before anything is written, and the line number a bad line is reported on.
func TestWorkRecordBatchRefusals(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca lote de pesadas", 80000)
	worker := h.createWorker(t, f, "Rosa", "6101")
	item := func(date string) map[string]any {
		return map[string]any{"workerId": worker, "quantity": 10, "dateFrom": date}
	}
	bad := func(t *testing.T, what string, body map[string]any, want string) {
		t.Helper()
		res := h.do(t, http.MethodPost, "/v1/work-records/batch", f.OwnerToken, body)
		if res.Status < 400 || !strings.Contains(string(res.Raw), want) {
			t.Fatalf("%s: got %d %s, want a refusal mentioning %q", what, res.Status, res.Raw, want)
		}
	}

	t.Run("too many lines", func(t *testing.T) {
		items := make([]any, 1001)
		for i := range items {
			items[i] = item("2026-08-25")
		}
		bad(t, "1001 lines", map[string]any{"items": items}, "at most 1000 items")
	})
	t.Run("a week that does not start on Monday", func(t *testing.T) {
		bad(t, "tuesday", map[string]any{"weekStart": "2026-08-25", "items": []any{item("2026-08-25")}}, "weekStart must be a Monday")
	})
	t.Run("a batch id that is not a UUID", func(t *testing.T) {
		bad(t, "id", map[string]any{"id": "lote-1", "items": []any{item("2026-08-25")}}, "id must be a UUID")
	})
	t.Run("a line whose date cannot be read", func(t *testing.T) {
		bad(t, "date", map[string]any{"weekStart": "2026-08-24", "items": []any{item("2026-08-25"), item("25/08/2026")}}, `"line":1`)
	})

	// None of the refused batches left a weighing behind.
	res := h.mustDo(t, http.MethodGet, "/v1/work-records?workerId="+worker, f.OwnerToken, nil, http.StatusOK)
	if items, _ := res.Body["items"].([]any); len(items) != 0 {
		t.Fatalf("a refused batch wrote %d records: %s", len(items), res.Raw)
	}
}

// TestPickupRoutes covers the weighing-shaped routes over work records.
func TestPickupRoutes(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de pesadas sueltas", 80000)
	worker := h.createWorker(t, f, "Rosa", "6201")

	res := h.do(t, http.MethodPost, "/v1/pickups", f.OwnerToken, map[string]any{"workerId": worker, "weight": "12.5"})
	if res.Status != http.StatusBadRequest || !strings.Contains(string(res.Raw), "date is required") {
		t.Fatalf("a pickup with no date: got %d %s", res.Status, res.Raw)
	}

	pickup := h.mustDo(t, http.MethodPost, "/v1/pickups", f.OwnerToken, map[string]any{
		"workerId": worker, "weight": "12.5", "date": "2026-08-25",
	}, http.StatusCreated)
	id := mustString(t, pickup.Body, "id")
	h.mustDo(t, http.MethodDelete, "/v1/pickups/"+id, f.OwnerToken, nil, http.StatusNoContent)
	// The delete is logical: the record is still there to audit, marked.
	gone := h.mustDo(t, http.MethodGet, "/v1/pickups/"+id, f.OwnerToken, nil, http.StatusOK)
	if gone.Body["deletedAt"] == nil {
		t.Fatalf("a deleted pickup should carry deletedAt: %s", gone.Raw)
	}

	// A day-rate record is a work record but not a weighing: the pickup
	// route does not see it, and so cannot delete it.
	activity := h.mustDo(t, http.MethodPost, "/v1/activities", f.OwnerToken, map[string]any{
		"name": "Plateo", "payScheme": "tiempo", "category": "Labores",
		"rate": map[string]any{"rateCents": 60000, "timeUnit": "jornal"},
	}, http.StatusCreated)
	day := h.mustDo(t, http.MethodPost, "/v1/work-records", f.OwnerToken, map[string]any{
		"activityId": mustString(t, activity.Body, "id"), "workerId": worker, "quantity": 1, "dateFrom": "2026-08-25", "rateCents": 60000,
	}, http.StatusCreated)
	h.mustDo(t, http.MethodDelete, "/v1/pickups/"+mustString(t, day.Body, "id"), f.OwnerToken, nil, http.StatusNotFound)
}

func TestSaveTourRefusesAStepOutOfRange(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del recorrido", 80000)
	for _, step := range []int{-1, 101} {
		res := h.do(t, http.MethodPut, "/v1/me/tours/owner", f.OwnerToken, map[string]any{"step": step, "status": "active"})
		if res.Status != http.StatusBadRequest {
			t.Errorf("step %d: got %d %s, want 400", step, res.Status, res.Raw)
		}
	}
	h.mustDo(t, http.MethodPut, "/v1/me/tours/owner", f.OwnerToken, map[string]any{"step": 100, "status": "done"}, http.StatusOK)
}
