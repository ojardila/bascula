// SPDX-License-Identifier: MIT

package apitest

import (
	"math"
	"net/http"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// «Equipos» (migration 00040, docs/use-cases/teams.md): a team is one payee
// with members. Weighings, settlement, balance and payments are the team's;
// the statistics count its members as people.

func pickup(t *testing.T, h *harness, f *farmFixture, workerID, day string, kg float64) response {
	t.Helper()
	return h.do(t, http.MethodPost, "/v1/pickups", f.OwnerToken, map[string]any{
		"workerId": workerID, "weight": kg, "date": day,
	})
}

func errCode(res response) string {
	e, _ := res.Body["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}

func findWorker(t *testing.T, items []any, id string) map[string]any {
	t.Helper()
	for _, raw := range items {
		w, _ := raw.(map[string]any)
		if w["id"] == id {
			return w
		}
	}
	t.Fatalf("worker %s not in list", id)
	return nil
}

func TestTeamsEndToEnd(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de los equipos", 80000)
	s := teamsE2E{h: h, f: f, today: daysAgo(0), weekAgo: daysAgo(7)}

	s.yorman = h.createWorker(t, f, "Yorman", "51000001")
	s.sergio = h.createWorker(t, f, "Sergio", "51000002")
	s.pedro = h.createWorker(t, f, "Pedro", "51000003")
	s.luis = h.createWorker(t, f, "Luis", "51000004")

	// The combined record as it was imported: one "person" for a pair.
	s.pair = h.createWorker(t, f, "Yorman y Sergio", "51000009")

	teamsConvertPairIntoTeam(t, s)
	teamsListCarriesKindMembersAndTeam(t, s)
	teamsOnePerPersonAndMembersCannotWeigh(t, s)
	teamsDashboardAndPerformanceCountHeads(t, s)

	// The MCP: list_workers shows the team; liquidar y pagar on the team.
	sess := h.mcpClient(t, f.OwnerToken)
	teamsMCPSettlesAndPaysTheTeam(t, s, sess)
	teamsMCPMembershipAndHarvestWeek(t, s, sess)
	teamsMCPCreateTeamAndDeactivate(t, s, sess)
}

// teamsE2E is the state TestTeamsEndToEnd carries from one phase to the next.
type teamsE2E struct {
	h                                 *harness
	f                                 *farmFixture
	today, weekAgo                    string
	yorman, sergio, pedro, luis, pair string
}

func teamsNear(t *testing.T, what string, got any, want float64) {
	t.Helper()
	v, ok := got.(float64)
	if !ok || math.Abs(v-want) > 1e-6 {
		t.Errorf("%s: got %v, want %v", what, got, want)
	}
}

func teamsConvertPairIntoTeam(t *testing.T, s teamsE2E) {
	h, f := s.h, s.f
	if res := pickup(t, h, f, s.pair, s.today, 460); res.Status != http.StatusCreated {
		t.Fatalf("pickup for the pair: %d %s", res.Status, res.Raw)
	}

	// Convert it into a team, keeping its id and its weighing; add members.
	conv := h.mustDo(t, http.MethodPatch, "/v1/workers/"+s.pair, f.OwnerToken,
		map[string]any{"kind": "equipo"}, http.StatusOK)
	if conv.Body["kind"] != "equipo" {
		t.Fatalf("kind after PATCH: %v", conv.Body["kind"])
	}
	set := h.mustDo(t, http.MethodPatch, "/v1/workers/"+s.pair, f.OwnerToken, map[string]any{
		"memberIds": []string{s.yorman, s.sergio}, "membersFrom": s.weekAgo,
	}, http.StatusOK)
	if ms, _ := set.Body["members"].([]any); len(ms) != 2 {
		t.Fatalf("members after PATCH: %s", set.Raw)
	}

	// A team with members cannot go back to being a person; a member cannot
	// become a team.
	if res := h.do(t, http.MethodPatch, "/v1/workers/"+s.pair, f.OwnerToken, map[string]any{"kind": "persona"}); res.Status != http.StatusBadRequest {
		t.Errorf("team with members -> persona: %d %s", res.Status, res.Raw)
	}
	if res := h.do(t, http.MethodPatch, "/v1/workers/"+s.yorman, f.OwnerToken, map[string]any{"kind": "equipo"}); res.Status != http.StatusBadRequest {
		t.Errorf("member -> equipo: %d %s", res.Status, res.Raw)
	}
}

func teamsListCarriesKindMembersAndTeam(t *testing.T, s teamsE2E) {
	// The list carries kind, members and team.
	list := s.h.mustDo(t, http.MethodGet, "/v1/workers", s.f.OwnerToken, nil, http.StatusOK)
	items, _ := list.Body["items"].([]any)
	team := findWorker(t, items, s.pair)
	if team["kind"] != "equipo" || len(team["members"].([]any)) != 2 {
		t.Errorf("team in list: %v", team)
	}
	y := findWorker(t, items, s.yorman)
	if tr, _ := y["team"].(map[string]any); tr == nil || tr["id"] != s.pair || tr["members"].(float64) != 2 {
		t.Errorf("member's team in list: %v", y["team"])
	}
	if p := findWorker(t, items, s.pedro); p["kind"] != "persona" || p["team"] != nil {
		t.Errorf("person outside teams: %v", p)
	}
}

func teamsOnePerPersonAndMembersCannotWeigh(t *testing.T, s teamsE2E) {
	h, f := s.h, s.f
	// One team per person; members get no personal weighing or advance.
	if res := h.do(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
		"name": "Otro equipo", "kind": "equipo", "memberIds": []string{s.yorman}, "tag": "T-OTRO",
	}); res.Status != http.StatusConflict || errCode(res) != "WORKER_IN_TEAM" {
		t.Errorf("person in two teams: %d %s", res.Status, res.Raw)
	}
	if res := h.do(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
		"name": "Pedro", "memberIds": []string{s.luis}, "tag": "P-1",
	}); res.Status != http.StatusBadRequest {
		t.Errorf("memberIds on a person: %d %s", res.Status, res.Raw)
	}
	res := pickup(t, h, f, s.yorman, s.today, 50)
	if res.Status != http.StatusConflict || errCode(res) != "WORKER_IN_TEAM" {
		t.Fatalf("weighing for a member: %d %s", res.Status, res.Raw)
	}
	if d, _ := res.Body["error"].(map[string]any)["details"].(map[string]any); d["teamId"] != s.pair {
		t.Errorf("WORKER_IN_TEAM details: %v", res.Body)
	}
	if res := h.do(t, http.MethodPost, "/v1/advances", f.OwnerToken, map[string]any{
		"workerId": s.sergio, "amountCents": 1000000,
	}); res.Status != http.StatusConflict || errCode(res) != "WORKER_IN_TEAM" {
		t.Errorf("advance for a member: %d %s", res.Status, res.Raw)
	}

	for _, p := range []struct {
		who string
		kg  float64
	}{{s.pedro, 200}, {s.luis, 100}} {
		if res := pickup(t, h, f, p.who, s.today, p.kg); res.Status != http.StatusCreated {
			t.Fatalf("pickup: %d %s", res.Status, res.Raw)
		}
	}
}

func teamsDashboardAndPerformanceCountHeads(t *testing.T, s teamsE2E) {
	h, f := s.h, s.f
	// «Modo cosecha»: four people today, 760 kg over four person-days.
	dash := h.mustDo(t, http.MethodGet, "/v1/reports/harvest-dashboard", f.OwnerToken, nil, http.StatusOK)
	sum := dash.Body["summary"].(map[string]any)
	teamsNear(t, "pickersToday", sum["pickersToday"], 4)
	teamsNear(t, "pickersThisWeek", sum["pickersThisWeek"], 4)
	teamsNear(t, "personDays", sum["personDays"], 4)
	teamsNear(t, "kgPerPersonDay", sum["kgPerPersonDay"], 190)
	people := dash.Body["people"].([]any)
	if len(people) != 3 {
		t.Fatalf("ranking rows: %v", people)
	}
	first := people[0].(map[string]any)
	if first["employeeId"] != s.pair || first["kind"] != "equipo" {
		t.Errorf("team should rank first by kilos per member: %v", first)
	}
	teamsNear(t, "team members", first["members"], 2)
	teamsNear(t, "team kg (juntos)", first["kg"], 460)
	teamsNear(t, "team kgEach (c/u)", first["kgEach"], 230)
	teamsNear(t, "team kgPerDay", first["kgPerDay"], 230)
	last := people[2].(map[string]any)
	if last["employeeId"] != s.luis || last["belowAverage"] != true {
		t.Errorf("Luis (100 < 70%% of 190) should be flagged: %v", last)
	}
	if people[1].(map[string]any)["belowAverage"] != false {
		t.Errorf("Pedro should not be flagged: %v", people[1])
	}

	// A member's profile: «su parte», and the team named.
	perf := h.mustDo(t, http.MethodGet, "/v1/workers/"+s.sergio+"/performance", f.OwnerToken, nil, http.StatusOK)
	teamsNear(t, "Sergio's share this week", perf.Body["summary"].(map[string]any)["thisWeekKg"], 230)
	if tr, _ := perf.Body["team"].(map[string]any); tr == nil || tr["id"] != s.pair {
		t.Errorf("member performance team: %v", perf.Body["team"])
	}
	tperf := h.mustDo(t, http.MethodGet, "/v1/workers/"+s.pair+"/performance", f.OwnerToken, nil, http.StatusOK)
	teamsNear(t, "team this week", tperf.Body["summary"].(map[string]any)["thisWeekKg"], 460)
	teamsNear(t, "team members", tperf.Body["members"], 2)
	if tperf.Body["kind"] != "equipo" {
		t.Errorf("team performance kind: %v", tperf.Body["kind"])
	}
	// The farm's average per picker beside the week is per person: 760 / 4.
	weeks := tperf.Body["weeks"].([]any)
	teamsNear(t, "farm avg per picker", weeks[len(weeks)-1].(map[string]any)["farmAvgKg"], 190)

	// Reports count heads.
	rw := h.mustDo(t, http.MethodGet, "/v1/reports/weeks", f.OwnerToken, nil, http.StatusOK)
	wk := rw.Body["items"].([]any)[0].(map[string]any)
	teamsNear(t, "report weeks pickers", wk["pickers"], 4)
}

func teamsMCPSettlesAndPaysTheTeam(t *testing.T, s teamsE2E, sess *mcp.ClientSession) {
	h, f := s.h, s.f
	lw := callTool(t, sess, "list_workers", map[string]any{"q": "Yorman"})
	if txt := toolText(lw); !strings.Contains(txt, `"kind":"equipo"`) || !strings.Contains(txt, `"members"`) {
		t.Errorf("list_workers does not show the team: %s", txt)
	}
	setArgs := map[string]any{"workerId": s.pair, "from": s.today, "to": s.today}
	tok, _ := previewToken(t, sess, "create_settlement", setArgs)
	mustTool(t, sess, "create_settlement", withToken(setArgs, tok))
	if b := balanceOf(t, h, f, s.pair); b != 460*80000 {
		t.Fatalf("team balance after settling: %d", b)
	}
	bad := callTool(t, sess, "register_payment", withToken(map[string]any{
		"workerId": s.pair, "amountCents": 1000000, "receivedBy": s.pedro,
	}, "x"))
	if !bad.IsError && !strings.Contains(toolText(bad), "receivedBy") && !strings.Contains(toolText(bad), "token") {
		t.Errorf("receivedBy outside the team should be refused: %s", toolText(bad))
	}
	payArgs := map[string]any{"workerId": s.pair, "amountCents": 460 * 80000, "method": "efectivo", "receivedBy": s.yorman}
	ptok, prev := previewToken(t, sess, "register_payment", payArgs)
	if sm, _ := prev["summary"].(string); sm != "" && !strings.Contains(sm, "Yorman") {
		t.Errorf("payment preview should name who receives: %v", prev)
	}
	if again := callTool(t, sess, "register_payment", payArgs); !strings.Contains(toolText(again), "Yorman") {
		t.Errorf("payment preview should name who receives: %s", toolText(again))
	}
	paid := resultOf(t, mustTool(t, sess, "register_payment", withToken(payArgs, ptok)))
	if paid["receivedBy"] != s.yorman {
		t.Errorf("payment receivedBy: %v", paid)
	}
	slip := h.mustDo(t, http.MethodGet, "/v1/payments/"+paid["id"].(string), f.OwnerToken, nil, http.StatusOK)
	if slip.Body["receivedByName"] != "Yorman" {
		t.Errorf("receipt receivedByName: %v", slip.Body["receivedByName"])
	}
	if b := balanceOf(t, h, f, s.pair); b != 0 {
		t.Errorf("team balance after paying: %d", b)
	}
	if res := h.do(t, http.MethodPost, "/v1/payments", f.OwnerToken, map[string]any{
		"workerId": s.pedro, "amountCents": 100, "receivedBy": s.yorman, "allowOverpayment": true,
	}); res.Status != http.StatusBadRequest {
		t.Errorf("receivedBy on a person: %d %s", res.Status, res.Raw)
	}
}

func teamsMCPMembershipAndHarvestWeek(t *testing.T, s teamsE2E, sess *mcp.ClientSession) {
	h, f, today := s.h, s.f, s.today
	// set_team_members: Sergio leaves from today; he can then weigh alone.
	mustTool(t, sess, "set_team_members", map[string]any{"teamId": s.pair, "memberIds": []string{s.yorman}, "from": today})
	if res := pickup(t, h, f, s.sergio, today, 40); res.Status != http.StatusCreated {
		t.Errorf("Sergio out of the team should weigh alone: %d %s", res.Status, res.Raw)
	}
	if res := pickup(t, h, f, s.yorman, today, 40); res.Status != http.StatusConflict {
		t.Errorf("Yorman is still in the team: %d %s", res.Status, res.Raw)
	}

	// register_harvest_week goes to the team, never to a member.
	wk2 := mustTool(t, sess, "register_harvest_week", map[string]any{
		"monday":    mondayOf(today),
		"weighings": []any{map[string]any{"workerId": s.pair, "date": today, "kg": 10}},
	})
	if resultOf(t, wk2)["created"].(float64) != 1 {
		t.Errorf("register_harvest_week to the team: %v", wk2)
	}
	refused := callTool(t, sess, "register_harvest_week", map[string]any{
		"monday":    mondayOf(today),
		"weighings": []any{map[string]any{"workerId": s.yorman, "date": today, "kg": 10}},
	})
	if !refused.IsError || !strings.Contains(toolText(refused), "WORKER_IN_TEAM") {
		t.Errorf("register_harvest_week to a member should be refused: %s", toolText(refused))
	}
}

func teamsMCPCreateTeamAndDeactivate(t *testing.T, s teamsE2E, sess *mcp.ClientSession) {
	h, f := s.h, s.f
	// create_team, and the hint on a combined name.
	ana := h.createWorker(t, f, "Ana", "51000005")
	beto := h.createWorker(t, f, "Beto", "51000006")
	ct := mustTool(t, sess, "create_team", map[string]any{"name": "Ana y Beto", "memberIds": []string{ana, beto}, "tag": "12"})
	ctr := resultOf(t, ct)
	if ctr["kind"] != "equipo" || len(ctr["members"].([]any)) != 2 {
		t.Errorf("create_team: %v", ctr)
	}
	hint := callTool(t, sess, "create_worker", map[string]any{"name": "Mauricio y Tatiana", "tag": "MT-1"})
	if !strings.Contains(toolText(hint), "VARIAS personas") {
		t.Errorf("create_worker should warn about a combined name: %s", toolText(hint))
	}

	// Taking a team off the payroll ends its memberships today.
	h.mustDo(t, http.MethodPatch, "/v1/workers/"+ctr["id"].(string), f.OwnerToken, map[string]any{"status": "inactive"}, http.StatusOK)
	tomorrowOK := h.mustDo(t, http.MethodGet, "/v1/workers/"+ana, f.OwnerToken, nil, http.StatusOK)
	if tr, _ := tomorrowOK.Body["team"].(map[string]any); tr == nil || tr["to"] != s.today {
		t.Errorf("membership should end today when the team is deactivated: %v", tomorrowOK.Body["team"])
	}
}
