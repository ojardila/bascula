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
