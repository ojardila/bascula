package apitest

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// TestPlotListFilters lists plots live, by search, with the removed ones and
// only the removed ones.
func TestPlotListFilters(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca lista lotes", 250000)
	live := h.createPlot(t, f, "Lote Alto")
	gone := h.createPlot(t, f, "Lote Bajo")
	crops, _ := h.mustDo(t, http.MethodGet, "/v1/plots/"+gone, f.OwnerToken, nil, http.StatusOK).Body["crops"].([]any)
	for _, raw := range crops {
		crop := raw.(map[string]any)["id"].(string)
		h.mustDo(t, http.MethodDelete, "/v1/plots/"+gone+"/crops/"+crop, f.OwnerToken, nil, http.StatusNoContent)
	}
	h.mustDo(t, http.MethodPatch, "/v1/plots/"+gone, f.OwnerToken, map[string]any{"status": "inactive"}, http.StatusOK)

	ids := func(q string) map[string]bool {
		t.Helper()
		res := h.mustDo(t, http.MethodGet, "/v1/plots"+q, f.OwnerToken, nil, http.StatusOK)
		out := map[string]bool{}
		items, _ := res.Body["items"].([]any)
		for _, raw := range items {
			row := raw.(map[string]any)
			out[row["id"].(string)] = true
			if crops, _ := row["crops"].([]any); row["id"] == live && len(crops) == 0 {
				t.Errorf("plot %v listed without its crop", row["name"])
			}
		}
		return out
	}
	if got := ids(""); !got[live] || got[gone] {
		t.Errorf("the default list is the live plots: %v", got)
	}
	if got := ids("?q=alto"); !got[live] || len(got) != 1 {
		t.Errorf("search by name: %v", got)
	}
	if got := ids("?status=all"); !got[live] || !got[gone] {
		t.Errorf("status=all lists both: %v", got)
	}
	if got := ids("?status=inactive"); got[live] || !got[gone] {
		t.Errorf("status=inactive lists only the removed one: %v", got)
	}
}

// TestTeamMemberRefusals covers the rules on who can be a team's member.
func TestTeamMemberRefusals(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca equipos bordes", 250000)
	ana := h.createWorker(t, f, "Ana", "72000001")
	beto := h.createWorker(t, f, "Beto", "72000002")
	idle := h.createWorker(t, f, "Ciro", "72000003")
	dora := h.createWorker(t, f, "Dora", "72000004")
	h.mustDo(t, http.MethodPatch, "/v1/workers/"+idle, f.OwnerToken, map[string]any{"status": "inactive"}, http.StatusOK)

	team := mustString(t, h.mustDo(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
		"name": "Ana y Beto", "kind": "equipo", "tag": "E-1", "memberIds": []string{ana, beto, ana},
	}, http.StatusCreated).Body, "id")
	other := mustString(t, h.mustDo(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
		"name": "Otro equipo", "kind": "equipo", "tag": "E-2", "memberIds": []string{dora},
	}, http.StatusCreated).Body, "id")

	members := func(id string, ids ...string) response {
		return h.do(t, http.MethodPatch, "/v1/workers/"+id, f.OwnerToken, map[string]any{"memberIds": ids})
	}
	for name, res := range map[string]response{
		"a person":        members(ana, beto),
		"itself":          members(team, team),
		"a stranger":      members(team, uuid.NewString()),
		"another team":    members(team, other),
		"inactive member": members(team, idle),
	} {
		if res.Status != http.StatusBadRequest {
			t.Errorf("members %s: got %d %s, want 400", name, res.Status, res.Raw)
		}
	}

}
