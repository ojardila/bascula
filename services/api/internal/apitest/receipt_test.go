package apitest

import (
	"net/http"
	"testing"
)

func TestPaymentReceipt(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del recibo", 80000)
	worker := h.createWorker(t, f, "Elena", "recibo-1")
	h.createPlot(t, f, "Lote recibo")
	activity := h.harvestActivityID(t, f)
	h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 100)

	h.mustDo(t, http.MethodPost, "/v1/deductions", f.OwnerToken, map[string]any{
		"workerId": worker, "amountCents": 1_000_000, "note": "Mercado",
	}, http.StatusCreated)

	h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated)

	pay := h.mustDo(t, http.MethodPost, "/v1/payments", f.OwnerToken, map[string]any{
		"workerId": worker, "amountCents": 7_000_000, "method": "efectivo",
	}, http.StatusCreated)
	id := mustString(t, pay.Body, "id")

	slip := h.mustDo(t, http.MethodGet, "/v1/payments/"+id, f.OwnerToken, nil, http.StatusOK)
	if got := mustInt(t, slip.Body, "currentWeekCents"); got != 8_000_000 {
		t.Fatalf("semana actual = %d, want 8000000", got)
	}
	if got := mustInt(t, slip.Body, "deductionsCents"); got != 1_000_000 {
		t.Fatalf("descuentos = %d, want 1000000: %s", got, slip.Raw)
	}
	if got := mustInt(t, slip.Body, "paidCents"); got != 7_000_000 {
		t.Fatalf("pago = %d, want 7000000", got)
	}
	if got := mustInt(t, slip.Body, "remainingCents"); got != 0 {
		t.Fatalf("queda = %d, want 0: %s", got, slip.Raw)
	}
	prev := mustInt(t, slip.Body, "previousBalanceCents")
	week := mustInt(t, slip.Body, "currentWeekCents")
	disc := mustInt(t, slip.Body, "deductionsCents")
	paid := mustInt(t, slip.Body, "paidCents")
	left := mustInt(t, slip.Body, "remainingCents")
	if prev+week-disc-paid != left {
		t.Fatalf("saldo anterior + semana − descuentos − pago = %d, queda %d: %s",
			prev+week-disc-paid, left, slip.Raw)
	}
	items, _ := slip.Body["deductions"].([]any)
	if len(items) != 1 {
		t.Fatalf("deductions: %s", slip.Raw)
	}
	row := items[0].(map[string]any)
	if row["concept"] != "Mercado" {
		t.Fatalf("concepto: %s", slip.Raw)
	}

	t.Run("a weigher cannot read a receipt", func(t *testing.T) {
		res := h.do(t, http.MethodGet, "/v1/payments/"+id, f.WeigherToken, nil)
		if res.Status != http.StatusForbidden {
			t.Fatalf("weigher GET payment: got %d %s, want 403", res.Status, res.Raw)
		}
	})
}

// The history in a worker's profile opens every payment, settlement and
// advance and shows it as it stood that day. Three things have to hold for
// that: the settlement lines name the lote, the payment's week is exactly the
// sum of the settlements it lists, and a reversal written later does not
// rewrite an old receipt.
func TestHistoricalReceipts(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del historial", 80000)
	worker := h.createWorker(t, f, "Rosa", "historial-1")
	plot := h.createPlot(t, f, "La Cumbre")
	activity := h.harvestActivityID(t, f)
	h.mustDo(t, http.MethodPost, "/v1/work-records", f.OwnerToken, map[string]any{
		"activityId": activity, "workerId": worker, "quantity": 50,
		"dateFrom": "2026-08-25", "plotIds": []string{plot},
	}, http.StatusCreated)

	payables := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/payables", f.OwnerToken, nil, http.StatusOK)
	tasks, _ := payables.Body["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("payables: %s", payables.Raw)
	}
	if names, _ := tasks[0].(map[string]any)["plotNames"].([]any); len(names) != 1 || names[0] != "La Cumbre" {
		t.Fatalf("pending line does not name its lote: %s", payables.Raw)
	}

	settled := h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated)
	settlementID := mustString(t, settled.Body, "id")
	st := h.mustDo(t, http.MethodGet, "/v1/settlements/"+settlementID, f.OwnerToken, nil, http.StatusOK)
	items, _ := st.Body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("settlement items: %s", st.Raw)
	}
	if names, _ := items[0].(map[string]any)["plotNames"].([]any); len(names) != 1 || names[0] != "La Cumbre" {
		t.Fatalf("settlement line does not name its lote: %s", st.Raw)
	}
	gross := mustInt(t, st.Body, "grossCents")

	adv := h.mustDo(t, http.MethodPost, "/v1/advances", f.OwnerToken, map[string]any{
		"workerId": worker, "amountCents": 500_000, "method": "efectivo", "note": "Mercado",
	}, http.StatusCreated)
	advID := mustString(t, adv.Body, "id")

	pay := h.mustDo(t, http.MethodPost, "/v1/payments", f.OwnerToken, map[string]any{
		"workerId": worker, "amountCents": gross - 500_000, "method": "efectivo",
	}, http.StatusCreated)
	payID := mustString(t, pay.Body, "id")

	slip := h.mustDo(t, http.MethodGet, "/v1/payments/"+payID, f.OwnerToken, nil, http.StatusOK)
	if slip.Body["kind"] != "pago" {
		t.Fatalf("kind: %s", slip.Raw)
	}
	ids, _ := slip.Body["settlementIds"].([]any)
	if len(ids) != 1 || ids[0] != settlementID {
		t.Fatalf("settlementIds: %s", slip.Raw)
	}
	if got := mustInt(t, slip.Body, "currentWeekCents"); got != gross {
		t.Fatalf("week %d, settlement gross %d", got, gross)
	}
	if got := mustInt(t, slip.Body, "remainingCents"); got != 0 {
		t.Fatalf("remaining: %s", slip.Raw)
	}
	before := slip.Raw

	advSlip := h.mustDo(t, http.MethodGet, "/v1/payments/"+advID, f.OwnerToken, nil, http.StatusOK)
	if advSlip.Body["kind"] != "anticipo" {
		t.Fatalf("advance kind: %s", advSlip.Raw)
	}
	if got := mustInt(t, advSlip.Body, "paidCents"); got != 500_000 {
		t.Fatalf("advance amount: %s", advSlip.Raw)
	}
	if prev, left := mustInt(t, advSlip.Body, "previousBalanceCents"), mustInt(t, advSlip.Body, "remainingCents"); prev-500_000 != left {
		t.Fatalf("advance identity: %s", advSlip.Raw)
	}
	if got := mustInt(t, advSlip.Body, "currentWeekCents"); got != 0 {
		t.Fatalf("an advance has no week: %s", advSlip.Raw)
	}

	t.Run("voiding the settlement later does not rewrite the payment's receipt", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/settlements/"+settlementID+"/void", f.OwnerToken,
			map[string]any{}, http.StatusOK)
		again := h.mustDo(t, http.MethodGet, "/v1/payments/"+payID, f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, again.Body, "currentWeekCents"); got != gross {
			t.Fatalf("week moved after a later void: %s (was %s)", again.Raw, before)
		}
		if got := mustInt(t, again.Body, "remainingCents"); got != 0 {
			t.Fatalf("remaining moved after a later void: %s (was %s)", again.Raw, before)
		}
		// The settlement still carries its lines, as frozen.
		st := h.mustDo(t, http.MethodGet, "/v1/settlements/"+settlementID, f.OwnerToken, nil, http.StatusOK)
		if items, _ := st.Body["items"].([]any); len(items) != 1 {
			t.Fatalf("void settlement lost its lines: %s", st.Raw)
		}
	})

	t.Run("a devengo is not a receipt", func(t *testing.T) {
		ledger := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/ledger", f.OwnerToken, nil, http.StatusOK)
		rows, _ := ledger.Body["items"].([]any)
		for _, raw := range rows {
			row := raw.(map[string]any)
			if row["kind"] == "devengo" {
				res := h.do(t, http.MethodGet, "/v1/payments/"+row["id"].(string), f.OwnerToken, nil)
				if res.Status != http.StatusNotFound {
					t.Fatalf("devengo as receipt: got %d %s", res.Status, res.Raw)
				}
				return
			}
		}
		t.Fatalf("no devengo in ledger: %s", ledger.Raw)
	})
}
