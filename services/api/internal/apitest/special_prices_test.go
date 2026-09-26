package apitest

import (
	"net/http"
	"testing"
)

// TestSpecialKiloPrices covers per-lote and per-person fixed kilo prices
// (migration 00032): precedence persona > lote > semana > finca, dates, ending
// an exception, and the approved rule that a settled week never changes.
func TestSpecialKiloPrices(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca con precios especiales", 80000)
	ana := h.createWorker(t, f, "Ana", "7001001001")
	beto := h.createWorker(t, f, "Beto", "7001001002")
	alto := h.createPlot(t, f, "Lote alto")
	bajo := h.createPlot(t, f, "Lote bajo")
	act := h.harvestActivityID(t, f)

	weigh := func(worker, plot, day string, kg float64) string {
		res := h.mustDo(t, http.MethodPost, "/v1/work-records", f.OwnerToken, map[string]any{
			"activityId": act, "workerId": worker, "quantity": kg,
			"dateFrom": day, "dateTo": day, "plotIds": []string{plot},
		}, http.StatusCreated)
		return mustString(t, res.Body, "id")
	}
	pending := func(worker, from, to string) map[string]any {
		return h.mustDo(t, http.MethodGet, "/v1/pending?workerId="+worker+"&from="+from+"&to="+to,
			f.OwnerToken, nil, http.StatusOK).Body
	}
	sources := func(body map[string]any) map[string]int {
		out := map[string]int{}
		items, _ := body["items"].([]any)
		for _, raw := range items {
			out[raw.(map[string]any)["priceSource"].(string)]++
		}
		return out
	}

	t.Run("only the owner writes, the weigher cannot read, dates are Mondays, ids must exist", func(t *testing.T) {
		h.mustDo(t, http.MethodGet, "/v1/prices/special", f.WeigherToken, nil, http.StatusForbidden)
		h.mustDo(t, http.MethodGet, "/v1/prices/special", f.AdminToken, nil, http.StatusOK)
		h.mustDo(t, http.MethodPut, "/v1/prices/special/lotes/"+alto+"/2026-08-24", f.AdminToken,
			map[string]any{"priceCents": 90000}, http.StatusForbidden)
		h.mustDo(t, http.MethodPut, "/v1/prices/special/lotes/"+alto+"/2026-08-25", f.OwnerToken,
			map[string]any{"priceCents": 90000}, http.StatusBadRequest)
		h.mustDo(t, http.MethodPut, "/v1/prices/special/lotes/"+alto+"/2026-08-24", f.OwnerToken,
			map[string]any{"priceCents": 0}, http.StatusBadRequest)
		h.mustDo(t, http.MethodPut, "/v1/prices/special/lotes/"+alto+"/2026-08-24", f.OwnerToken,
			map[string]any{}, http.StatusBadRequest)
		h.mustDo(t, http.MethodPut, "/v1/prices/special/lotes/"+ana+"/2026-08-24", f.OwnerToken,
			map[string]any{"priceCents": 90000}, http.StatusNotFound)
		h.mustDo(t, http.MethodPut, "/v1/prices/special/vacas/"+alto+"/2026-08-24", f.OwnerToken,
			map[string]any{"priceCents": 90000}, http.StatusBadRequest)
	})

	t.Run("persona > lote > semana > finca", func(t *testing.T) {
		// Week of 2026-08-24: Ana in lote alto and lote bajo, Beto in lote alto.
		weigh(ana, alto, "2026-08-25", 10)
		weigh(ana, bajo, "2026-08-26", 10)
		weigh(beto, alto, "2026-08-25", 10)
		weigh(beto, bajo, "2026-08-26", 10)

		h.mustDo(t, http.MethodPut, "/v1/prices/weeks/2026-08-24", f.OwnerToken,
			map[string]any{"priceCents": 85000}, http.StatusOK)
		h.mustDo(t, http.MethodPut, "/v1/prices/special/lotes/"+alto+"/2026-08-24", f.OwnerToken,
			map[string]any{"priceCents": 100000}, http.StatusOK)
		h.mustDo(t, http.MethodPut, "/v1/prices/special/personas/"+ana+"/2026-08-17", f.OwnerToken,
			map[string]any{"priceCents": 120000}, http.StatusOK)

		// Ana: her own price everywhere (2 x 10 kg x 1200).
		a := pending(ana, "2026-08-24", "2026-08-30")
		if got := mustInt(t, a, "totalCents"); got != 2_400_000 {
			t.Fatalf("Ana owes %d, want 2400000 at her own price", got)
		}
		if s := sources(a); s["persona"] != 2 {
			t.Fatalf("Ana's lines should come from persona: %v", s)
		}
		// Beto: lote alto 1000, lote bajo takes the week's 850.
		b := pending(beto, "2026-08-24", "2026-08-30")
		if got := mustInt(t, b, "totalCents"); got != 1_000_000+850_000 {
			t.Fatalf("Beto owes %d, want 1850000 (lote alto 1000 + week 850)", got)
		}
		if s := sources(b); s["lote"] != 1 || s["semana"] != 1 {
			t.Fatalf("Beto's lines should be one lote and one semana: %v", s)
		}
		// The list the phone and console read estimates with the same rule.
		list := h.mustDo(t, http.MethodGet, "/v1/work-records?workerId="+beto, f.OwnerToken, nil, http.StatusOK)
		var sum float64
		for _, raw := range list.Body["items"].([]any) {
			sum += raw.(map[string]any)["estimatedAmountCents"].(float64)
		}
		if sum != 1_850_000 {
			t.Fatalf("Beto's records estimate %v, want 1850000", sum)
		}
		// And the harvest reports value the week with the same rule.
		week := h.mustDo(t, http.MethodGet, "/v1/reports/weeks/2026-08-24", f.OwnerToken, nil, http.StatusOK)
		byDay, _ := week.Body["byDay"].(map[string]any)
		total, _ := byDay["total"].(map[string]any)
		if total["valueCents"] != float64(2_400_000+1_850_000) {
			t.Fatalf("the week report values the week at %v, want 4250000", total["valueCents"])
		}
	})

	t.Run("ending an exception from a Monday falls back to the next rule", func(t *testing.T) {
		weigh(ana, alto, "2026-09-01", 10)
		h.mustDo(t, http.MethodPut, "/v1/prices/special/personas/"+ana+"/2026-08-31", f.OwnerToken,
			map[string]any{"priceCents": nil}, http.StatusOK)
		a := pending(ana, "2026-08-31", "2026-09-06")
		if got := mustInt(t, a, "totalCents"); got != 1_000_000 {
			t.Fatalf("Ana after her price ended owes %d, want 1000000 at lote alto", got)
		}
		// Earlier weeks keep her price.
		if got := mustInt(t, pending(ana, "2026-08-24", "2026-08-30"), "totalCents"); got != 2_400_000 {
			t.Fatalf("ending her price rewrote an earlier week: %d", got)
		}
	})

	t.Run("a settled week never changes and the impact warns about it", func(t *testing.T) {
		settled := h.mustSettle(t, f.OwnerToken, map[string]any{
			"workerId": beto, "from": "2026-08-24", "to": "2026-08-30",
		}, http.StatusCreated)
		id := mustString(t, settled.Body, "id")
		if got := mustInt(t, settled.Body, "grossCents"); got != 1_850_000 {
			t.Fatalf("Beto settled %d, want 1850000", got)
		}
		weigh(beto, bajo, "2026-09-02", 10)

		im := h.mustDo(t, http.MethodGet, "/v1/prices/special/lotes/"+bajo+"/2026-08-24/impact",
			f.OwnerToken, nil, http.StatusOK)
		// Lote bajo from 08-24: Ana's 08-26 (unsettled, but her own price
		// wins), Beto's 08-26 (settled) and Beto's 09-02 (unsettled).
		if mustInt(t, im.Body, "unsettledRecords") != 1 || mustInt(t, im.Body, "settledRecords") != 1 ||
			mustInt(t, im.Body, "overriddenByPerson") != 1 {
			t.Fatalf("impact = %s, want 1 unsettled, 1 settled, 1 overridden by person", im.Raw)
		}
		h.mustDo(t, http.MethodPut, "/v1/prices/special/lotes/"+bajo+"/2026-08-24", f.OwnerToken,
			map[string]any{"priceCents": 70000}, http.StatusOK)
		again := h.mustDo(t, http.MethodGet, "/v1/settlements/"+id, f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, again.Body, "grossCents"); got != 1_850_000 {
			t.Fatalf("the settled week changed to %d; a new price must never touch it", got)
		}
		if got := mustInt(t, pending(beto, "2026-08-31", "2026-09-06"), "totalCents"); got != 700_000 {
			t.Fatalf("Beto's unsettled lote bajo work is %d, want 700000", got)
		}
	})

	t.Run("the list shows history newest first and deleting a mistake restores the rule before", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/prices/special", f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) != 3 {
			t.Fatalf("want 3 targets (2 lotes, 1 persona): %s", res.Raw)
		}
		first := items[0].(map[string]any)
		if first["kind"] != "lote" {
			t.Fatalf("lotes come first: %s", res.Raw)
		}
		last := items[2].(map[string]any)
		hist := last["history"].([]any)
		if last["kind"] != "persona" || len(hist) != 2 || hist[0].(map[string]any)["priceCents"] != nil {
			t.Fatalf("Ana's history should be [ended, 1200]: %s", res.Raw)
		}
		h.mustDo(t, http.MethodDelete, "/v1/prices/special/personas/"+ana+"/2026-08-31", f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, pending(ana, "2026-08-31", "2026-09-06"), "totalCents"); got != 1_200_000 {
			t.Fatalf("after deleting the end, Ana owes %d, want 1200000 at her price", got)
		}
		h.mustDo(t, http.MethodDelete, "/v1/prices/special/personas/"+ana+"/2026-08-31", f.OwnerToken, nil, http.StatusNotFound)
	})
}
