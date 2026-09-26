package apitest

import (
	"net/http"
	"testing"
	"time"
)

// TestBasePriceHistory covers the effective-dated farm base price
// (migration 00030) and the approved rule that a new price never changes a
// settled week: it only moves unsettled work.
func TestBasePriceHistory(t *testing.T) {
	h := requireDB(t)

	t.Run("a landing signup leaves the default price unconfirmed", func(t *testing.T) {
		g := h.signupFarm(t, "Finca sin precio", 0)
		res := h.mustDo(t, http.MethodGet, "/v1/prices/base", g.OwnerToken, nil, http.StatusOK)
		if res.Body["confirmed"] != false {
			t.Fatalf("a default price nobody chose reads as confirmed: %s", res.Raw)
		}
		if got := mustInt(t, res.Body, "currentCents"); got != 80000 {
			t.Fatalf("current price is %d, want the 80000 default", got)
		}
		h.mustDo(t, http.MethodPut, "/v1/prices/base/"+mondayOf(isoDate(time.Now())), g.OwnerToken,
			map[string]any{"priceCents": 80000}, http.StatusOK)
		res = h.mustDo(t, http.MethodGet, "/v1/prices/base", g.OwnerToken, nil, http.StatusOK)
		if res.Body["confirmed"] != true {
			t.Fatalf("saving the price did not confirm it: %s", res.Raw)
		}
	})

	f := h.signupFarm(t, "Finca con historia", 80000)
	worker := h.createWorker(t, f, "Rosalba", "5566778899")
	activity := h.harvestActivityID(t, f)

	t.Run("a chosen price starts confirmed, with one row since always", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/prices/base", f.OwnerToken, nil, http.StatusOK)
		if res.Body["confirmed"] != true {
			t.Fatalf("a price chosen at signup reads as unconfirmed: %s", res.Raw)
		}
		hist, _ := res.Body["history"].([]any)
		if len(hist) != 1 || hist[0].(map[string]any)["validFrom"] != "2000-01-03" {
			t.Fatalf("history is not one row since always: %s", res.Raw)
		}
	})

	t.Run("only the owner writes it, the weigher cannot read it, and it starts on a Monday", func(t *testing.T) {
		h.mustDo(t, http.MethodGet, "/v1/prices/base", f.WeigherToken, nil, http.StatusForbidden)
		h.mustDo(t, http.MethodGet, "/v1/prices/base", f.AdminToken, nil, http.StatusOK)
		h.mustDo(t, http.MethodPut, "/v1/prices/base/2026-08-24", f.AdminToken,
			map[string]any{"priceCents": 90000}, http.StatusForbidden)
		h.mustDo(t, http.MethodPut, "/v1/prices/base/2026-08-25", f.OwnerToken,
			map[string]any{"priceCents": 90000}, http.StatusBadRequest)
		h.mustDo(t, http.MethodPut, "/v1/prices/base/2026-08-24", f.OwnerToken,
			map[string]any{"priceCents": 0}, http.StatusBadRequest)
	})

	t.Run("a new price moves unsettled work and never a settled week", func(t *testing.T) {
		h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 10)
		h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-09-01", 10)
		settled := h.mustSettle(t, f.OwnerToken, map[string]any{
			"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
		}, http.StatusCreated)
		settlementID := mustString(t, settled.Body, "id")
		if got := mustInt(t, settled.Body, "grossCents"); got != 800_000 {
			t.Fatalf("settled gross is %d, want 800000", got)
		}

		im := h.mustDo(t, http.MethodGet, "/v1/prices/base/2026-08-24/impact", f.OwnerToken, nil, http.StatusOK)
		if mustInt(t, im.Body, "unsettledRecords") != 1 || mustInt(t, im.Body, "settledRecords") != 1 {
			t.Fatalf("impact should be 1 unsettled and 1 settled: %s", im.Raw)
		}

		h.mustDo(t, http.MethodPut, "/v1/prices/base/2026-08-24", f.OwnerToken,
			map[string]any{"priceCents": 90000}, http.StatusOK)

		// The week before keeps the old price, the weeks from the Monday take
		// the new one.
		if got := mustInt(t, h.mustDo(t, http.MethodGet, "/v1/prices/weeks/2026-08-17", f.OwnerToken,
			nil, http.StatusOK).Body, "priceCents"); got != 80000 {
			t.Fatalf("the week before the new price reads %d, want 80000", got)
		}
		if got := mustInt(t, h.mustDo(t, http.MethodGet, "/v1/prices/weeks/2026-08-31", f.OwnerToken,
			nil, http.StatusOK).Body, "priceCents"); got != 90000 {
			t.Fatalf("a week after the new price reads %d, want 90000", got)
		}

		pending := h.mustDo(t, http.MethodGet,
			"/v1/pending?workerId="+worker+"&from=2026-08-31&to=2026-09-06",
			f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, pending.Body, "totalCents"); got != 900_000 {
			t.Fatalf("unsettled work is %d, want 900000 at the new price", got)
		}
		again := h.mustDo(t, http.MethodGet, "/v1/settlements/"+settlementID, f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, again.Body, "grossCents"); got != 800_000 {
			t.Fatalf("the settled week changed to %d; a new price must never touch it", got)
		}
	})

	t.Run("a week with its own price keeps it, and a later row does not rewrite earlier weeks", func(t *testing.T) {
		h.mustDo(t, http.MethodPut, "/v1/prices/weeks/2026-08-31", f.OwnerToken,
			map[string]any{"priceCents": 95000}, http.StatusOK)
		h.mustDo(t, http.MethodPut, "/v1/prices/base/2026-09-07", f.OwnerToken,
			map[string]any{"priceCents": 100000}, http.StatusOK)
		for week, want := range map[string]int64{
			"2026-08-24": 90000, "2026-08-31": 95000, "2026-09-07": 100000, "2026-09-14": 100000,
		} {
			got := mustInt(t, h.mustDo(t, http.MethodGet, "/v1/prices/weeks/"+week, f.OwnerToken,
				nil, http.StatusOK).Body, "priceCents")
			if got != want {
				t.Errorf("week %s reads %d, want %d", week, got, want)
			}
		}
		res := h.mustDo(t, http.MethodGet, "/v1/prices/base", f.OwnerToken, nil, http.StatusOK)
		hist, _ := res.Body["history"].([]any)
		if len(hist) != 3 || hist[0].(map[string]any)["validFrom"] != "2026-09-07" {
			t.Fatalf("history should be three rows, newest first: %s", res.Raw)
		}
	})
}

// TestTourProgress covers the per-user guided tour state.
func TestTourProgress(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del recorrido", 80000)

	res := h.mustDo(t, http.MethodGet, "/v1/me/tours", f.OwnerToken, nil, http.StatusOK)
	if items, _ := res.Body["items"].([]any); len(items) != 0 {
		t.Fatalf("a new owner already has tour progress: %s", res.Raw)
	}
	saved := h.mustDo(t, http.MethodPut, "/v1/me/tours/owner", f.OwnerToken,
		map[string]any{"step": 3, "status": "active"}, http.StatusOK)
	if mustInt(t, saved.Body, "step") != 3 || saved.Body["status"] != "active" {
		t.Fatalf("saved progress reads back wrong: %s", saved.Raw)
	}
	h.mustDo(t, http.MethodPut, "/v1/me/tours/owner", f.OwnerToken,
		map[string]any{"step": 11, "status": "done"}, http.StatusOK)
	res = h.mustDo(t, http.MethodGet, "/v1/me/tours", f.OwnerToken, nil, http.StatusOK)
	items, _ := res.Body["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["status"] != "done" {
		t.Fatalf("the owner's tour did not update in place: %s", res.Raw)
	}

	// Somebody else's progress is not yours.
	res = h.mustDo(t, http.MethodGet, "/v1/me/tours", f.WeigherToken, nil, http.StatusOK)
	if items, _ := res.Body["items"].([]any); len(items) != 0 {
		t.Fatalf("the weigher sees the owner's tour: %s", res.Raw)
	}
	h.mustDo(t, http.MethodPut, "/v1/me/tours/weigher", f.WeigherToken,
		map[string]any{"step": 1, "status": "later"}, http.StatusOK)

	h.mustDo(t, http.MethodPut, "/v1/me/tours/owner", f.OwnerToken,
		map[string]any{"step": 1, "status": "maybe"}, http.StatusBadRequest)
	h.mustDo(t, http.MethodPut, "/v1/me/tours/Owner!", f.OwnerToken,
		map[string]any{"step": 1, "status": "active"}, http.StatusBadRequest)
}
