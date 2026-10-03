// SPDX-License-Identifier: MIT

package apitest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The activity routes, end to end: what is refused and why, what PATCH can
// and cannot change, archiving and restoring, and the dated rates.
func TestActivityRoutes(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de las labores", 80000)

	units := h.mustDo(t, http.MethodGet, "/v1/catalogs/work-units", f.OwnerToken, nil, http.StatusOK)
	items, _ := units.Body["items"].([]any)
	if len(items) == 0 {
		t.Fatalf("no work units seeded: %s", units.Raw)
	}
	unitID := items[0].(map[string]any)["id"].(string)

	a := activityFixture{h: h, f: f, unitID: unitID}
	t.Run("create is refused when", func(t *testing.T) { activityCreateRefusals(t, a) })

	created := h.mustDo(t, http.MethodPost, "/v1/activities", f.OwnerToken, map[string]any{
		"name": "Plateo", "payScheme": "tiempo", "category": "Labores",
		"rate": map[string]any{"rateCents": 60000, "timeUnit": "jornal"},
	}, http.StatusCreated)
	a.actID = mustString(t, created.Body, "id")

	t.Run("create is idempotent by id and refuses a duplicate name", func(t *testing.T) { activityCreateIdempotent(t, a) })

	t.Run("list on a given day, and a bad day", func(t *testing.T) { activityListByDay(t, a) })

	t.Run("patch", func(t *testing.T) { activityPatch(t, a) })

	t.Run("rates", func(t *testing.T) { activityRates(t, a) })

	t.Run("archive", func(t *testing.T) { activityArchive(t, a) })
}

// activityFixture is what the TestActivityRoutes subtests share: one farm,
// one seeded work unit, and the activity created halfway through.
type activityFixture struct {
	h      *harness
	f      *farmFixture
	unitID string
	actID  string
}

func activityCreateRefusals(t *testing.T, a activityFixture) {
	h, f, unitID := a.h, a.f, a.unitID
	cases := map[string]map[string]any{
		"the body is not JSON":     nil,
		"there is no name":         {"payScheme": "tiempo", "category": "Labores"},
		"the scheme is unknown":    {"name": "x", "payScheme": "a destajo", "category": "Labores"},
		"there is no category":     {"name": "x", "payScheme": "tiempo"},
		"weekly price not by unit": {"name": "x", "payScheme": "tiempo", "category": "Labores", "rateSource": "weekly_price"},
		"explicit rate":            {"name": "x", "payScheme": "tiempo", "category": "Labores", "rateSource": "explicit"},
		"the rate is not positive": {"name": "x", "payScheme": "tiempo", "category": "Labores",
			"rate": map[string]any{"rateCents": 0}},
		"a unit scheme has no unit": {"name": "x", "payScheme": "unidad_trabajo", "category": "Labores",
			"rate": map[string]any{"rateCents": 100}},
		"a time scheme has a unit": {"name": "x", "payScheme": "tiempo", "category": "Labores", "unitId": unitID,
			"rate": map[string]any{"rateCents": 100, "timeUnit": "jornal"}},
		"the custom quantity has too many decimals": {"name": "x", "payScheme": "tiempo", "category": "Labores",
			"rate": map[string]any{"rateCents": 100, "timeUnit": "jornal", "customQty": 1.234}},
		"the valid-from date is not a date": {"name": "x", "payScheme": "tiempo", "category": "Labores",
			"rate": map[string]any{"rateCents": 100, "timeUnit": "jornal", "validFrom": "ayer"}},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			var res response
			if body == nil {
				res = h.doRaw(t, http.MethodPost, "/v1/activities", f.OwnerToken, "{not json")
			} else {
				res = h.do(t, http.MethodPost, "/v1/activities", f.OwnerToken, body)
			}
			if res.Status < 400 || res.Status >= 500 {
				t.Fatalf("want a 4xx, got %d: %s", res.Status, res.Raw)
			}
		})
	}
}

func activityCreateIdempotent(t *testing.T, a activityFixture) {
	h, f, actID := a.h, a.f, a.actID
	again := h.do(t, http.MethodPost, "/v1/activities", f.OwnerToken, map[string]any{
		"id": actID, "name": "Plateo", "payScheme": "tiempo", "category": "Labores",
		"rate": map[string]any{"rateCents": 60000, "timeUnit": "jornal"},
	})
	if again.Status >= 300 {
		t.Fatalf("replay by id: %d %s", again.Status, again.Raw)
	}
	dup := h.do(t, http.MethodPost, "/v1/activities", f.OwnerToken, map[string]any{
		"name": "Plateo", "payScheme": "tiempo", "category": "Labores",
		"rate": map[string]any{"rateCents": 60000, "timeUnit": "jornal"},
	})
	if dup.Status != http.StatusConflict && dup.Status != http.StatusUnprocessableEntity {
		t.Fatalf("duplicate name: want 409/422, got %d %s", dup.Status, dup.Raw)
	}
}

func activityListByDay(t *testing.T, a activityFixture) {
	h, f := a.h, a.f
	h.mustDo(t, http.MethodGet, "/v1/activities?on=2026-01-05", f.OwnerToken, nil, http.StatusOK)
	h.mustDo(t, http.MethodGet, "/v1/activities?on=hoy", f.OwnerToken, nil, http.StatusBadRequest)
}

func activityPatch(t *testing.T, a activityFixture) {
	h, f, actID := a.h, a.f, a.actID
	path := "/v1/activities/" + actID
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"status": "borrado"}, http.StatusBadRequest)
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"payScheme": "contrato"}, http.StatusBadRequest)
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"rateSource": "explicit"}, http.StatusBadRequest)
	if res := h.doRaw(t, http.MethodPatch, path, f.OwnerToken, "{"); res.Status != http.StatusBadRequest {
		t.Fatalf("bad json: %d", res.Status)
	}
	renamed := h.mustDo(t, http.MethodPatch, path, f.OwnerToken,
		map[string]any{"name": "Plateo y limpia", "category": "Mantenimiento"}, http.StatusOK)
	if renamed.Body["name"] != "Plateo y limpia" {
		t.Fatalf("rename: %s", renamed.Raw)
	}
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"status": "inactive"}, http.StatusOK)
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"status": "active"}, http.StatusOK)

	other := h.mustDo(t, http.MethodPost, "/v1/activities", f.OwnerToken, map[string]any{
		"name": "Guadaña", "payScheme": "contrato", "category": "Labores",
		"rate": map[string]any{"rateCents": 200000},
	}, http.StatusCreated)
	dup := h.do(t, http.MethodPatch, "/v1/activities/"+mustString(t, other.Body, "id"), f.OwnerToken,
		map[string]any{"name": "Plateo y limpia"})
	if dup.Status != http.StatusConflict && dup.Status != http.StatusUnprocessableEntity {
		t.Fatalf("rename onto another: want 409/422, got %d %s", dup.Status, dup.Raw)
	}
	// The weigher's projection of the same activity carries no rate.
	if res := h.do(t, http.MethodPatch, path, f.WeigherToken, map[string]any{"name": "x"}); res.Status != http.StatusForbidden {
		t.Fatalf("weigher patch: want 403, got %d", res.Status)
	}
}

func activityRates(t *testing.T, a activityFixture) {
	h, f, actID := a.h, a.f, a.actID
	path := "/v1/activities/" + actID + "/rate"
	h.mustDo(t, http.MethodPut, path, f.OwnerToken, map[string]any{"rateCents": 0}, http.StatusBadRequest)
	if res := h.doRaw(t, http.MethodPut, path, f.OwnerToken, "{"); res.Status != http.StatusBadRequest {
		t.Fatalf("bad json: %d", res.Status)
	}
	h.mustDo(t, http.MethodPut, path, f.OwnerToken,
		map[string]any{"rateCents": 65000, "timeUnit": "jornal", "validFrom": "2026-02-01"}, http.StatusOK)
	h.mustDo(t, http.MethodPut, path, f.OwnerToken,
		map[string]any{"rateCents": 66000, "timeUnit": "jornal"}, http.StatusOK)
	rates := h.mustDo(t, http.MethodGet, "/v1/activities/"+actID+"/rates", f.OwnerToken, nil, http.StatusOK)
	if list, _ := rates.Body["items"].([]any); len(list) < 2 {
		t.Fatalf("want at least two rates: %s", rates.Raw)
	}
	missing := "/v1/activities/0192f3a0-dead-7000-8000-000000000000/rate"
	if res := h.do(t, http.MethodPut, missing, f.OwnerToken, map[string]any{"rateCents": 1, "timeUnit": "jornal"}); res.Status != http.StatusNotFound {
		t.Fatalf("missing activity: want 404, got %d %s", res.Status, res.Raw)
	}
}

func activityArchive(t *testing.T, a activityFixture) {
	h, f, actID := a.h, a.f, a.actID
	h.mustDo(t, http.MethodDelete, "/v1/activities/"+actID, f.OwnerToken, nil, http.StatusNoContent)
}

// Work units: create, idempotent by code, rename, factor, archive and delete.
func TestWorkUnitRoutes(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de las canecas", 80000)
	base := "/v1/catalogs/work-units"

	if res := h.doRaw(t, http.MethodPost, base, f.OwnerToken, "{"); res.Status != http.StatusBadRequest {
		t.Fatalf("bad json: %d", res.Status)
	}
	h.mustDo(t, http.MethodPost, base, f.OwnerToken, map[string]any{"label": "sin código"}, http.StatusBadRequest)
	h.mustDo(t, http.MethodPost, base, f.OwnerToken, map[string]any{"code": "x", "kgFactor": 1.23456}, http.StatusBadRequest)

	made := h.mustDo(t, http.MethodPost, base, f.OwnerToken, map[string]any{"code": "caneca", "kgFactor": 12.5}, http.StatusOK)
	id := mustString(t, made.Body, "id")
	if made.Body["label"] != "caneca" {
		t.Fatalf("label defaults to code: %s", made.Raw)
	}
	other := h.mustDo(t, http.MethodPost, base, f.OwnerToken, map[string]any{"code": "bulto"}, http.StatusOK)

	path := base + "/" + id
	if res := h.doRaw(t, http.MethodPatch, path, f.OwnerToken, "{"); res.Status != http.StatusBadRequest {
		t.Fatalf("bad json: %d", res.Status)
	}
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"kgFactor": "doce"}, http.StatusBadRequest)
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"kgFactor": 1.23456}, http.StatusBadRequest)
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"label": "Caneca grande", "kgFactor": 13}, http.StatusOK)
	h.mustDo(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"kgFactor": nil}, http.StatusOK)
	dup := h.do(t, http.MethodPatch, path, f.OwnerToken, map[string]any{"code": "bulto"})
	if dup.Status != http.StatusConflict && dup.Status != http.StatusUnprocessableEntity {
		t.Fatalf("code collision: want 409/422, got %d %s", dup.Status, dup.Raw)
	}

	h.mustDo(t, http.MethodDelete, base+"/"+mustString(t, other.Body, "id"), f.OwnerToken, nil, http.StatusOK)
	h.mustDo(t, http.MethodDelete, path, f.OwnerToken, nil, http.StatusOK)

	// A unit an activity still uses is archived, not deleted.
	list := h.mustDo(t, http.MethodGet, base, f.OwnerToken, nil, http.StatusOK)
	archived := false
	for _, it := range list.Body["items"].([]any) {
		res := h.mustDo(t, http.MethodDelete, base+"/"+it.(map[string]any)["id"].(string), f.OwnerToken, nil, http.StatusOK)
		if res.Body["archived"] == true {
			archived = true
		}
	}
	if !archived {
		t.Fatal("no unit in use was archived")
	}
}

// doRaw sends a body exactly as given, for the requests that are not JSON.
func (h *harness) doRaw(t *testing.T, method, path, token, raw string) response {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(raw))
	req.RemoteAddr = "10.0.0.1:12345"
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.server.ServeHTTP(rec, req)
	out := response{Status: rec.Code, Raw: rec.Body.String()}
	if out.Raw != "" {
		_ = json.Unmarshal([]byte(out.Raw), &out.Body)
	}
	return out
}
