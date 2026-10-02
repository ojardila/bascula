package apitest

import (
	"net/http"
	"testing"
)

// The money routes refuse a malformed request before it reaches the ledger:
// a wrong sign is normalised, but a missing worker, a zero amount, a bad
// method, a bad date or a half-open range is a 400 the phone can show.
func TestMoneyValidation(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de las cuentas", 80000)
	worker := h.createWorker(t, f, "Rosa Cardona", "71000111")

	bad := []struct {
		name, method, path string
		body               map[string]any
	}{
		{"payment without a worker", http.MethodPost, "/v1/payments", map[string]any{"amountCents": 1000}},
		{"advance of zero", http.MethodPost, "/v1/advances", map[string]any{"workerId": worker, "amountCents": 0}},
		{"advance with an unknown method", http.MethodPost, "/v1/advances",
			map[string]any{"workerId": worker, "amountCents": 1000, "method": "cheque"}},
		{"deduction with a method", http.MethodPost, "/v1/deductions",
			map[string]any{"workerId": worker, "amountCents": 1000, "method": "efectivo"}},
		{"advance with a bad date", http.MethodPost, "/v1/advances",
			map[string]any{"workerId": worker, "amountCents": 1000, "date": "02/10/2026"}},
		{"adjustment with a receiver", http.MethodPost, "/v1/adjustments",
			map[string]any{"workerId": worker, "amountCents": 1000, "receivedBy": "Pedro"}},
		{"week price that is not positive", http.MethodPut, "/v1/prices/weeks/2026-09-28", map[string]any{"priceCents": 0}},
		{"week price on a Tuesday", http.MethodPut, "/v1/prices/weeks/2026-09-29", map[string]any{"priceCents": 900}},
		{"week price on a bad date", http.MethodPut, "/v1/prices/weeks/semana-40", map[string]any{"priceCents": 900}},
		{"settlement preview without a worker", http.MethodPost, "/v1/settlements/preview",
			map[string]any{"from": "2026-09-28", "to": "2026-10-04"}},
		{"settlement preview with to before from", http.MethodPost, "/v1/settlements/preview",
			map[string]any{"workerId": worker, "from": "2026-10-04", "to": "2026-09-28"}},
		{"settlement preview with a bad from", http.MethodPost, "/v1/settlements/preview",
			map[string]any{"workerId": worker, "from": "ayer", "to": "2026-09-28"}},
		{"settlement preview with a bad to", http.MethodPost, "/v1/settlements/preview",
			map[string]any{"workerId": worker, "from": "2026-09-28", "to": "hoy"}},
		{"settlement preview without dates", http.MethodPost, "/v1/settlements/preview",
			map[string]any{"workerId": worker}},
		{"pending without a worker", http.MethodGet, "/v1/pending?from=2026-09-28&to=2026-10-04", nil},
		{"pending with half a range", http.MethodGet, "/v1/pending?workerId=" + worker + "&from=2026-09-28", nil},
		{"settlements with an unknown status", http.MethodGet, "/v1/settlements?status=Void", nil},
		{"settlements with half a range", http.MethodGet, "/v1/settlements?from=2026-09-28", nil},
	}
	for _, c := range bad {
		t.Run(c.name, func(t *testing.T) {
			var body any
			if c.body != nil {
				body = c.body
			}
			if res := h.do(t, c.method, c.path, f.OwnerToken, body); res.Status != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d %s", res.Status, res.Raw)
			}
		})
	}

	t.Run("a negative advance is read as money handed over", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/advances", f.OwnerToken,
			map[string]any{"workerId": worker, "amountCents": -5000, "method": "efectivo",
				"date": "2026-09-30", "receivedBy": ""}, http.StatusCreated)
		if got, _ := res.Body["amountCents"].(float64); got != -5000 {
			t.Fatalf("an advance is stored as money out: %s", res.Raw)
		}
	})

	t.Run("a positive week price is saved for that Monday", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPut, "/v1/prices/weeks/2026-09-28", f.OwnerToken,
			map[string]any{"priceCents": 95000}, http.StatusOK)
		if res.Body["weekStart"] != "2026-09-28" || res.Body["priceCents"] != float64(95000) {
			t.Fatalf("unexpected week price: %s", res.Raw)
		}
	})

	t.Run("listing settlements accepts all and a full range", func(t *testing.T) {
		h.mustDo(t, http.MethodGet, "/v1/settlements?status=all&from=2026-09-01&to=2026-10-31&limit=500",
			f.OwnerToken, nil, http.StatusOK)
	})
}
