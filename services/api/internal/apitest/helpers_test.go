package apitest

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

func (h *harness) createWorker(t *testing.T, f *farmFixture, name, docID string) string {
	t.Helper()
	res := h.mustDo(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
		"name": name, "documentType": "CC", "docId": docID,
	}, http.StatusCreated)
	id, _ := res.Body["id"].(string)
	if id == "" {
		t.Fatalf("worker create returned no id: %s", res.Raw)
	}
	return id
}

func (h *harness) createPlot(t *testing.T, f *farmFixture, name string) string {
	t.Helper()
	res := h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken, map[string]any{
		"name": name, "areaHa": 3.5, "department": "Antioquia", "municipality": "Andes",
		"crops": []map[string]any{{"cropType": "Cafe", "variety": "Castillo"}},
	}, http.StatusCreated)
	id, _ := res.Body["id"].(string)
	if id == "" {
		t.Fatalf("plot create returned no id: %s", res.Raw)
	}
	return id
}

// harvestActivityID finds the "Recoleccion" activity every farm is seeded with:
// work unit, priced by the week, which is the shape a coffee weighing takes.
func (h *harness) harvestActivityID(t *testing.T, f *farmFixture) string {
	t.Helper()
	res := h.mustDo(t, http.MethodGet, "/v1/activities", f.OwnerToken, nil, http.StatusOK)
	items, _ := res.Body["items"].([]any)
	for _, raw := range items {
		row := raw.(map[string]any)
		if row["rateSource"] == string(domain.RateWeeklyPrice) {
			return row["id"].(string)
		}
	}
	t.Fatalf("no seeded weekly-priced activity: %s", res.Raw)
	return ""
}

// createWorkRecord records a weighing: a work record of the seeded harvest
// activity, one day, quantity in kilos, priced from the week at settlement.
func (h *harness) createWorkRecord(t *testing.T, f *farmFixture, token, workerID, activityID, date string, quantity float64) string {
	t.Helper()
	res := h.mustDo(t, http.MethodPost, "/v1/work-records", token, map[string]any{
		"activityId": activityID,
		"workerId":   workerID,
		"quantity":   quantity,
		"dateFrom":   date,
	}, http.StatusCreated)
	id, _ := res.Body["id"].(string)
	if id == "" {
		t.Fatalf("work record create returned no id: %s", res.Raw)
	}
	return id
}

// settleSomething gives a farm one weighing and one settlement, so a test that
// only needs "this farm has money in it" does not have to spell it out.
func (h *harness) settleSomething(t *testing.T, f *farmFixture, workerID, plotID string) string {
	t.Helper()
	activity := h.harvestActivityID(t, f)
	h.createWorkRecord(t, f, f.OwnerToken, workerID, activity, "2026-08-25", 100)
	res := h.mustDo(t, http.MethodPost, "/v1/settlements", f.OwnerToken, map[string]any{
		"workerId": workerID, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated)
	id, _ := res.Body["id"].(string)
	return id
}

// tokenWithoutFarm mints a valid, correctly signed access token whose farm_id
// claim is empty. It stands in for the shapes that would otherwise reach a
// handler with no tenant: a token issued before a farm was chosen, or a bug in
// the issuing path.
func (h *harness) tokenWithoutFarm(t *testing.T, userID string) string {
	t.Helper()
	signer := auth.NewSigner([]byte("test-signing-key"), "bascula")
	token, err := signer.Issue(userID, "", domain.RoleOwner, "", false)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	return token
}

func mondayOf(s string) string {
	return domain.MondayOf(day(s)).Format("2006-01-02")
}

func isoDate(t time.Time) string { return t.Format("2006-01-02") }

func mustString(t *testing.T, m map[string]any, key string) string {
	t.Helper()
	v, ok := m[key].(string)
	if !ok {
		t.Fatalf("%s is not a string in %v", key, m)
	}
	return v
}

func mustInt(t *testing.T, m map[string]any, key string) int64 {
	t.Helper()
	v, ok := m[key].(float64)
	if !ok {
		t.Fatalf("%s is not a number in %v", key, m)
	}
	return int64(v)
}

func describe(v any) string { return fmt.Sprintf("%v", v) }
