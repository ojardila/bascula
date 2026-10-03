// SPDX-License-Identifier: MIT

package apitest

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// TestCMRWorkerAndTeamEdges walks the worker routes' edges that ordinary use
// does not: a create replayed with the same id, a reactivation of somebody
// who never left, and a team's member list from a day that is not a date.
func TestCMRWorkerAndTeamEdges(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca cmr equipos", 250000)

	// Same id twice: the second answer is the first worker, not a second one
	// and not a conflict.
	id := uuid.NewString()
	body := map[string]any{"id": id, "name": "Rosa", "tag": "CMR-1"}
	first := h.mustDo(t, http.MethodPost, "/v1/workers", f.OwnerToken, body, http.StatusCreated)
	again := h.mustDo(t, http.MethodPost, "/v1/workers", f.OwnerToken, body, http.StatusOK)
	if again.Body["id"] != first.Body["id"] || again.Body["kind"] != "persona" {
		t.Errorf("a replayed create should answer the same worker: %s", again.Raw)
	}
	if _, ok := again.Body["members"]; !ok {
		t.Errorf("the replayed answer carries the team fields like the first: %s", again.Raw)
	}

	// "active" on somebody active is a no-op, not a 409 about their own tag.
	res := h.mustDo(t, http.MethodPatch, "/v1/workers/"+id, f.OwnerToken, map[string]any{"status": "active"}, http.StatusOK)
	if res.Body["deletedAt"] != nil || res.Body["tag"] != "CMR-1" {
		t.Errorf("reactivating an active worker changed it: %s", res.Raw)
	}

	// A team, then its members from a day that is not a date: refused on
	// create and on update, and nothing about the team changes.
	other := h.createWorker(t, f, "Sergio", "990001")
	bad := h.do(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
		"kind": "equipo", "name": "Rosa y Sergio", "tag": "CMR-2", "memberIds": []string{id, other},
		"membersFrom": "el lunes",
	})
	if bad.Status != http.StatusBadRequest || bad.code() != "BAD_REQUEST" {
		t.Errorf("team create with a bad membersFrom: %d %s", bad.Status, bad.Raw)
	}
	team := h.mustDo(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
		"kind": "equipo", "name": "Rosa y Sergio", "tag": "CMR-2", "memberIds": []string{id, other},
	}, http.StatusCreated)
	teamID := team.Body["id"].(string)
	bad = h.do(t, http.MethodPatch, "/v1/workers/"+teamID, f.OwnerToken, map[string]any{
		"memberIds": []string{id}, "membersFrom": "2026-02-30",
	})
	if bad.Status != http.StatusBadRequest || bad.code() != "BAD_REQUEST" {
		t.Errorf("team update with a bad membersFrom: %d %s", bad.Status, bad.Raw)
	}
	got := h.mustDo(t, http.MethodGet, "/v1/workers/"+teamID, f.OwnerToken, nil, http.StatusOK)
	if m, _ := got.Body["members"].([]any); len(m) != 2 {
		t.Errorf("a refused member change left the team with %d members: %s", len(m), got.Raw)
	}

	// A member taken out from the day they joined (they had not started
	// yet, as far as the farm's today is concerned, when the change starts
	// on their first day) leaves no membership behind, and the remaining one
	// stays.
	res = h.mustDo(t, http.MethodPatch, "/v1/workers/"+teamID, f.OwnerToken, map[string]any{
		"memberIds": []string{id}, "membersFrom": "2000-01-01",
	}, http.StatusOK)
	if m, _ := res.Body["members"].([]any); len(m) != 1 || m[0].(map[string]any)["id"] != id {
		t.Errorf("members after dropping Sergio: %s", res.Raw)
	}
	so := h.mustDo(t, http.MethodGet, "/v1/workers/"+other, f.OwnerToken, nil, http.StatusOK)
	if so.Body["team"] != nil {
		t.Errorf("Sergio still reads as in a team: %s", so.Raw)
	}
}

// TestCMRHarvestCurveForOneCrop: the curve for a crop of this farm is that
// crop's (echoed back), with the window it covers; another farm's crop is the
// ordinary 404 and never a flat season.
func TestCMRHarvestCurveForOneCrop(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca cmr curva", 250000)
	g := h.signupFarm(t, "Finca cmr curva ajena", 250000)

	cropOf := func(ff *farmFixture, name string) (string, string) {
		res := h.mustDo(t, http.MethodPost, "/v1/plots", ff.OwnerToken, map[string]any{
			"name": name, "crops": []map[string]any{{"cropType": "Cafe"}},
		}, http.StatusCreated)
		crops, _ := res.Body["crops"].([]any)
		if len(crops) != 1 {
			t.Fatalf("plot create: %s", res.Raw)
		}
		return res.Body["id"].(string), crops[0].(map[string]any)["id"].(string)
	}
	plotID, crop := cropOf(f, "Lote curva")
	_, theirs := cropOf(g, "Lote ajeno")

	worker := h.createWorker(t, f, "Curva", "990101")
	for _, d := range []string{"2026-08-04", "2026-08-11"} {
		h.mustDo(t, http.MethodPost, "/v1/pickups", f.OwnerToken, map[string]any{
			"workerId": worker, "weight": 20, "date": d, "plotId": plotID, "cropId": crop,
		}, http.StatusCreated)
	}

	res := h.mustDo(t, http.MethodGet, "/v1/reports/harvest-curve?weeks=1&plotCropId="+crop, f.OwnerToken, nil, http.StatusOK)
	if res.Body["plotCropId"] != crop {
		t.Errorf("the curve should name the crop it was asked for: %s", res.Raw)
	}
	weeks, _ := res.Body["weeks"].([]any)
	if len(weeks) != 1 || res.Body["partialWindow"] != true {
		t.Errorf("weeks=1 over two weeks of picking is one week and a partial window: %s", res.Raw)
	}
	if res.Body["coveredFrom"] == nil || res.Body["coveredTo"] == nil {
		t.Errorf("a curve with weeks says which days it covers: %s", res.Raw)
	}

	other := h.do(t, http.MethodGet, "/v1/reports/harvest-curve?plotCropId="+theirs, f.OwnerToken, nil)
	if other.Status != http.StatusNotFound {
		t.Errorf("another farm's crop: %d %s", other.Status, other.Raw)
	}
}
