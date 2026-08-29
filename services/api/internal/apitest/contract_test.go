package apitest

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// routeKey identifies a mounted endpoint.
type routeKey struct{ method, pattern string }

func (k routeKey) String() string { return k.method + " " + k.pattern }

// walkMountedRoutes reads back what is actually on the mux, not what the table
// says should be. That difference is the entire point: a handler mounted by
// some other path would be invisible to a test that only read the table.
func walkMountedRoutes(t *testing.T, r chi.Router) map[routeKey]bool {
	t.Helper()
	out := map[routeKey]bool{}
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		route = strings.TrimSuffix(route, "/")
		if route == "" {
			route = "/"
		}
		out[routeKey{method, route}] = true
		return nil
	})
	if err != nil {
		t.Fatalf("walk router: %v", err)
	}
	return out
}

// TestEveryMountedRouteIsInThePermissionTable is the guard that makes the
// permission table worth having.
//
// It fails when a route exists on the mux without an entry declaring what it
// does, and it fails when a route declares an action nobody wrote a rule for.
// Adding an endpoint therefore cannot be done without answering "who may call
// this", which with nine modules coming is the only defence that scales.
func TestEveryMountedRouteIsInThePermissionTable(t *testing.T) {
	h := requireDB(t)

	declared := map[routeKey]auth.Action{}
	for _, rt := range h.server.Routes() {
		key := routeKey{rt.Method, rt.Pattern}
		if _, dup := declared[key]; dup {
			t.Errorf("%s is declared twice in the route table", key)
		}
		declared[key] = rt.Action

		if _, ok := auth.Matrix[rt.Action]; !ok {
			t.Errorf("%s declares action %q, which has no rule in auth.Matrix.\n"+
				"Add one. An action with no rule is refused at runtime, so this "+
				"would ship as a 403 nobody can explain.", key, rt.Action)
		}
		if rt.Handler == nil {
			t.Errorf("%s has a nil handler", key)
		}
	}

	for mounted := range walkMountedRoutes(t, h.server.Router()) {
		if _, ok := declared[mounted]; !ok {
			t.Errorf("%s is mounted on the router but is not in httpapi.Routes().\n"+
				"Every endpoint must be declared there with an action; a route "+
				"mounted any other way has no permission check at all.", mounted)
		}
	}
}

// TestWeigherIsRefusedEveryMoneyRoute walks the route table and asserts a 403
// for the weigher on every route whose action is marked Money.
//
// It is a live HTTP assertion, not a check of the table against itself: the
// request goes through Auth, Tenant and Require exactly as a real one would.
// A new money route with the wrong action, or an action whose rule quietly
// grew a weigher, fails here.
func TestWeigherIsRefusedEveryMoneyRoute(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del contrato", 80000)
	worker := h.createWorker(t, f, "Carlos", "1122334455")
	settlement := h.settleSomething(t, f, worker, h.createPlot(t, f, "Lote contrato"))

	moneyRoutes := 0
	for _, rt := range h.server.Routes() {
		rule := auth.Matrix[rt.Action]
		if !rule.Money {
			continue
		}
		moneyRoutes++

		path := fillParams(rt.Pattern, map[string]string{
			"id":     pickIDFor(rt.Pattern, worker, settlement),
			"cropId": worker,
			"monday": "2026-08-24",
		})
		if rt.Method == http.MethodGet {
			path += "?workerId=" + worker + "&from=2026-08-24&to=2026-08-30"
		}

		res := h.do(t, rt.Method, path, f.WeigherToken, minimalBodyFor(rt))
		if res.Status != http.StatusForbidden {
			t.Errorf("weigher on %s %s: got %d, want 403.\n"+
				"This route touches money, prices or a worker's private file. "+
				"Response was: %s", rt.Method, path, res.Status, res.Raw)
		}
	}

	if moneyRoutes == 0 {
		t.Fatal("no money routes found; the Money flags have gone missing from auth.Matrix")
	}

	// And the same routes work for somebody who is allowed, so the test above
	// is not passing because everything is broken.
	res := h.do(t, http.MethodGet, "/v1/balances", f.OwnerToken, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("owner on /v1/balances: got %d %s, want 200", res.Status, res.Raw)
	}
}

// TestEveryMoneyActionExcludesTheWeigher checks the table itself, which is
// cheap and catches the case where a money action exists but no route has been
// written for it yet.
func TestEveryMoneyActionExcludesTheWeigher(t *testing.T) {
	for _, action := range auth.MoneyActions() {
		if auth.Allowed("weigher", action) {
			t.Errorf("auth.Matrix lets the weigher perform %q, which is marked Money", action)
		}
	}
	if len(auth.MoneyActions()) == 0 {
		t.Fatal("no actions are marked Money")
	}
}

// TestWeigherKeepsWhatHeNeeds is the other half: a permission table that
// refuses everything is not a permission table. The weigher must still be able
// to do his job, and see no prices while doing it.
func TestWeigherKeepsWhatHeNeeds(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del pesador", 80000)
	worker := h.createWorker(t, f, "Diana", "5566778899")
	h.createPlot(t, f, "Lote pesador")
	activity := h.harvestActivityID(t, f)

	t.Run("records a weighing", func(t *testing.T) {
		h.createWorkRecord(t, f, f.WeigherToken, worker, activity, "2026-08-25", 42.5)
	})

	t.Run("reads workers without their documents", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/workers", f.WeigherToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) == 0 {
			t.Fatalf("weigher sees no workers at all: %s", res.Raw)
		}
		row := items[0].(map[string]any)
		for _, forbidden := range []string{"docId", "documentType", "phone", "address", "photoId"} {
			if _, present := row[forbidden]; present {
				t.Errorf("the weigher's worker projection leaks %q: %s", forbidden, res.Raw)
			}
		}
	})

	t.Run("reads activities without their rates", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/activities", f.WeigherToken, nil, http.StatusOK)
		if strings.Contains(res.Raw, "rateCents") {
			t.Errorf("the weigher's activity list carries a rate: %s", res.Raw)
		}
	})

	t.Run("sees only the work records he recorded", func(t *testing.T) {
		// The owner records one too; the weigher must not see it.
		h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-26", 10)

		res := h.mustDo(t, http.MethodGet, "/v1/work-records", f.WeigherToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("weigher sees %d work records, want only his own 1: %s", len(items), res.Raw)
		}

		ownerRes := h.mustDo(t, http.MethodGet, "/v1/work-records", f.OwnerToken, nil, http.StatusOK)
		ownerItems, _ := ownerRes.Body["items"].([]any)
		if len(ownerItems) != 2 {
			t.Fatalf("owner sees %d work records, want both: %s", len(ownerItems), ownerRes.Raw)
		}
	})
}

func fillParams(pattern string, values map[string]string) string {
	out := pattern
	for k, v := range values {
		out = strings.ReplaceAll(out, "{"+k+"}", v)
	}
	return out
}

func pickIDFor(pattern, worker, settlement string) string {
	if strings.Contains(pattern, "/settlements/") || strings.Contains(pattern, "/ledger/") {
		return settlement
	}
	return worker
}

// minimalBodyFor gives a write route enough of a body to get past decoding.
// It never has to be valid: a 403 must happen before the handler ever looks.
func minimalBodyFor(rt httpapi.Route) any {
	switch rt.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch:
		return map[string]any{}
	default:
		return nil
	}
}

var _ = fmt.Sprintf
