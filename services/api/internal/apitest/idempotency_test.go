package apitest

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// TestEveryMoneyWriteIsIdempotent is the test for the bug that shipped.
//
// openapi.yaml declares, as a property of the contract and not as advice:
// "Every write accepts a client-generated id (UUIDv7) and is idempotent by
// (farm_id, id): retrying after a timeout returns 200 with the existing
// resource, not 409." The ledger did not do that. store.AddLedgerEntry ran a
// bare INSERT, so a resent payment hit the primary key, aborted the
// transaction and came back as a 500 with no information in it.
//
// That is not a theoretical edge. A farm with two bars of signal times out
// constantly, every client retries on its own, and the person retrying has
// already handed over the cash. A 500 tells him nothing about whether the
// payment landed, and the only way to find out is to go and look — which,
// mid-payday with a queue of pickers waiting, nobody does.
//
// So: the same write twice leaves ONE row and answers the same both times.
func TestEveryMoneyWriteIsIdempotent(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del reintento", 100_000)
	worker := h.createWorker(t, f, "Reintento", "9000000001")
	plot := h.createPlot(t, f, "Lote reintento")
	activity := h.harvestActivityID(t, f)

	// Something to pay for: 100 kg at 1000.00 the kilo.
	h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 100)
	_ = plot

	balanceOf := func(t *testing.T) int64 {
		t.Helper()
		res := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/balance",
			f.OwnerToken, nil, http.StatusOK)
		return mustInt(t, res.Body, "balanceCents")
	}
	ledgerLen := func(t *testing.T) int {
		t.Helper()
		res := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/ledger",
			f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		return len(items)
	}

	// ---------------------------------------------------------------------
	// The settlement, which is what puts money on the balance in the first
	// place. Its id is the client's, and resending it must not produce a
	// second earning — nor NOTHING_TO_SETTLE, which is what a naive retry
	// gets, because the retry finds its own payables already locked.
	// ---------------------------------------------------------------------
	settlementID := uuid.NewString()
	settleBody := map[string]any{
		"id": settlementID, "workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
	}

	first := h.mustSettle(t, f.OwnerToken,
		settleBody, http.StatusCreated)
	gross := mustInt(t, first.Body, "grossCents")
	if gross != 10_000_000 {
		t.Fatalf("gross is %d, want 10000000", gross)
	}
	afterFirst := balanceOf(t)

	t.Run("a resent settlement returns the same one, not a second earning", func(t *testing.T) {
		again := h.mustSettle(t, f.OwnerToken,
			settleBody, http.StatusOK)
		if mustString(t, again.Body, "id") != settlementID {
			t.Fatalf("the retry answered a different settlement: %s", again.Raw)
		}
		if got := mustInt(t, again.Body, "grossCents"); got != gross {
			t.Fatalf("the retry grosses %d, want %d: %s", got, gross, again.Raw)
		}
		if got := balanceOf(t); got != afterFirst {
			t.Fatalf("balance moved from %d to %d on a retry; the earning was written twice",
				afterFirst, got)
		}
	})

	t.Run("the same settlement id for another worker is refused", func(t *testing.T) {
		other := h.createWorker(t, f, "Otro", "9000000002")
		res := h.doSettle(t, f.OwnerToken, map[string]any{
			"id": settlementID, "workerId": other, "from": "2026-08-24", "to": "2026-08-30",
		})
		if res.code() != string(domain.CodeIdempotencyKeyReused) {
			t.Fatalf("reused id for another worker: got %d %s, want IDEMPOTENCY_KEY_REUSED",
				res.Status, res.Raw)
		}
	})

	// ---------------------------------------------------------------------
	// The four ledger movements. Table-driven, because the guarantee has to
	// hold for every one of them and not for whichever one somebody
	// remembered: a deduction resent twice is a debt somebody did not incur.
	// ---------------------------------------------------------------------
	movements := []struct {
		name  string
		path  string
		body  map[string]any
		delta int64 // what one of them does to the balance
	}{
		{"payment", "/v1/payments", map[string]any{
			"workerId": worker, "amountCents": 500_000, "method": "efectivo",
		}, -500_000},
		{"advance", "/v1/advances", map[string]any{
			"workerId": worker, "amountCents": 300_000, "method": "efectivo",
		}, -300_000},
		{"deduction", "/v1/deductions", map[string]any{
			"workerId": worker, "amountCents": 200_000,
		}, -200_000},
		{"adjustment", "/v1/adjustments", map[string]any{
			"workerId": worker, "amountCents": 100_000,
		}, 100_000},
	}

	for _, m := range movements {
		t.Run(m.name+" resent leaves one row", func(t *testing.T) {
			id := uuid.NewString()
			body := map[string]any{"id": id}
			for k, v := range m.body {
				body[k] = v
			}

			before := balanceOf(t)
			rows := ledgerLen(t)

			created := h.mustDo(t, http.MethodPost, m.path, f.OwnerToken, body, http.StatusCreated)
			if mustString(t, created.Body, "id") != id {
				t.Fatalf("the server ignored the client's id: %s", created.Raw)
			}
			if got := balanceOf(t); got != before+m.delta {
				t.Fatalf("balance %d, want %d after one %s", got, before+m.delta, m.name)
			}

			// The retry: 200, the same row, and nothing added.
			retry := h.mustDo(t, http.MethodPost, m.path, f.OwnerToken, body, http.StatusOK)
			if mustString(t, retry.Body, "id") != id {
				t.Fatalf("the retry answered a different row: %s", retry.Raw)
			}
			if got := balanceOf(t); got != before+m.delta {
				t.Fatalf("balance %d after resending the %s, want %d. It was written twice.",
					got, m.name, before+m.delta)
			}
			if got := ledgerLen(t); got != rows+1 {
				t.Fatalf("%d ledger rows after resending the %s, want %d", got, m.name, rows+1)
			}

			// A note that reads differently on the second attempt is still the
			// same movement. It decides no money, and refusing here would turn
			// the safety net into the outage it exists to prevent.
			withNote := map[string]any{"note": "reintento"}
			for k, v := range body {
				withNote[k] = v
			}
			h.mustDo(t, http.MethodPost, m.path, f.OwnerToken, withNote, http.StatusOK)
			if got := ledgerLen(t); got != rows+1 {
				t.Fatalf("a differing note produced a second row: %d, want %d", got, rows+1)
			}

			// A different AMOUNT under the same id is a client bug, and
			// answering 200 would tell the foreman a payment he never made
			// went through.
			mismatched := map[string]any{}
			for k, v := range body {
				mismatched[k] = v
			}
			mismatched["amountCents"] = 999_999
			res := h.do(t, http.MethodPost, m.path, f.OwnerToken, mismatched)
			if res.code() != string(domain.CodeIdempotencyKeyReused) {
				t.Fatalf("same id, different amount: got %d %s, want IDEMPOTENCY_KEY_REUSED",
					res.Status, res.Raw)
			}
			if got := ledgerLen(t); got != rows+1 {
				t.Fatalf("the refused write still left a row: %d, want %d", got, rows+1)
			}
		})
	}

	// ---------------------------------------------------------------------
	// Reversal and void. Neither writes a row the caller names by default, so
	// both take the reversal's id as their idempotency key — and both keep
	// refusing a SECOND, distinct attempt, which is not the same thing as a
	// retry and would hand the money back twice.
	// ---------------------------------------------------------------------
	t.Run("a resent reversal returns the same reversal", func(t *testing.T) {
		entry := h.mustDo(t, http.MethodPost, "/v1/deductions", f.OwnerToken, map[string]any{
			"id": uuid.NewString(), "workerId": worker, "amountCents": 50_000,
		}, http.StatusCreated)
		entryID := mustString(t, entry.Body, "id")

		revID := uuid.NewString()
		before := balanceOf(t)
		rev := h.mustDo(t, http.MethodPost, "/v1/ledger/"+entryID+"/reverse", f.OwnerToken,
			map[string]any{"id": revID, "note": "mal registrado"}, http.StatusCreated)
		if mustString(t, rev.Body, "id") != revID {
			t.Fatalf("the server ignored the client's reversal id: %s", rev.Raw)
		}
		afterReversal := balanceOf(t)
		if afterReversal != before+50_000 {
			t.Fatalf("balance %d after the reversal, want %d", afterReversal, before+50_000)
		}

		retry := h.mustDo(t, http.MethodPost, "/v1/ledger/"+entryID+"/reverse", f.OwnerToken,
			map[string]any{"id": revID, "note": "mal registrado"}, http.StatusOK)
		if mustString(t, retry.Body, "id") != revID {
			t.Fatalf("the retry answered a different reversal: %s", retry.Raw)
		}
		if got := balanceOf(t); got != afterReversal {
			t.Fatalf("balance moved on a resent reversal: %d, want %d", got, afterReversal)
		}

		// A NEW id against a movement that is already reversed is a second
		// attempt, not a retry, and giving the money back twice is exactly
		// what ux_ledger_reverses exists to prevent.
		second := h.do(t, http.MethodPost, "/v1/ledger/"+entryID+"/reverse", f.OwnerToken,
			map[string]any{"id": uuid.NewString()})
		if second.code() != string(domain.CodeAlreadyReversed) {
			t.Fatalf("a second distinct reversal: got %d %s, want ALREADY_REVERSED",
				second.Status, second.Raw)
		}
		if got := balanceOf(t); got != afterReversal {
			t.Fatalf("the refused reversal still moved the balance: %d", got)
		}
	})

	t.Run("a resent void returns the same void", func(t *testing.T) {
		// A settlement of its own to void, so this does not disturb the one
		// the rest of the test is built on.
		w2 := h.createWorker(t, f, "Anulable", "9000000003")
		h.createWorkRecord(t, f, f.OwnerToken, w2, activity, "2026-08-26", 10)
		s := h.mustSettle(t, f.OwnerToken, map[string]any{
			"id": uuid.NewString(), "workerId": w2, "from": "2026-08-24", "to": "2026-08-30",
		}, http.StatusCreated)
		sid := mustString(t, s.Body, "id")

		voidID := uuid.NewString()
		h.mustDo(t, http.MethodPost, "/v1/settlements/"+sid+"/void", f.OwnerToken,
			map[string]any{"id": voidID}, http.StatusOK)

		res := h.mustDo(t, http.MethodGet, "/v1/workers/"+w2+"/ledger", f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		rowsAfterVoid := len(items)

		retry := h.mustDo(t, http.MethodPost, "/v1/settlements/"+sid+"/void", f.OwnerToken,
			map[string]any{"id": voidID}, http.StatusOK)
		if mustString(t, retry.Body, "status") != "void" {
			t.Fatalf("the retry did not answer a void settlement: %s", retry.Raw)
		}

		res = h.mustDo(t, http.MethodGet, "/v1/workers/"+w2+"/ledger", f.OwnerToken, nil, http.StatusOK)
		items, _ = res.Body["items"].([]any)
		if len(items) != rowsAfterVoid {
			t.Fatalf("resending the void wrote %d extra ledger rows", len(items)-rowsAfterVoid)
		}

		// Without the key there is nothing to recognise a retry by, so a
		// second void is still a conflict. Guessing "it was probably a retry"
		// is guessing with somebody's wages.
		bare := h.do(t, http.MethodPost, "/v1/settlements/"+sid+"/void", f.OwnerToken, nil)
		if bare.code() != string(domain.CodeSettlementAlreadyVoid) {
			t.Fatalf("a keyless second void: got %d %s, want SETTLEMENT_ALREADY_VOID",
				bare.Status, bare.Raw)
		}
	})

	// ---------------------------------------------------------------------
	// The other half of the guarantee: a payment that pays a balance off in
	// full and is then resent. Before the fix, the retry did not even reach
	// the primary key — the balance check got there first and answered 409
	// AMOUNT_EXCEEDS_BALANCE, a business rule refusing a payment that had
	// already been made. The idempotency check has to run BEFORE the
	// derivation, and this is what says so.
	// ---------------------------------------------------------------------
	t.Run("a full payment resent does not become AMOUNT_EXCEEDS_BALANCE", func(t *testing.T) {
		w3 := h.createWorker(t, f, "Saldado", "9000000004")
		h.createWorkRecord(t, f, f.OwnerToken, w3, activity, "2026-08-27", 5)
		h.mustSettle(t, f.OwnerToken, map[string]any{
			"id": uuid.NewString(), "workerId": w3, "from": "2026-08-24", "to": "2026-08-30",
		}, http.StatusCreated)

		bal := h.mustDo(t, http.MethodGet, "/v1/workers/"+w3+"/balance", f.OwnerToken, nil, http.StatusOK)
		owed := mustInt(t, bal.Body, "balanceCents")
		if owed <= 0 {
			t.Fatalf("nothing owed to pay off: %s", bal.Raw)
		}

		payID := uuid.NewString()
		body := map[string]any{"id": payID, "workerId": w3, "amountCents": owed, "method": "efectivo"}
		h.mustDo(t, http.MethodPost, "/v1/payments", f.OwnerToken, body, http.StatusCreated)

		retry := h.do(t, http.MethodPost, "/v1/payments", f.OwnerToken, body)
		if retry.Status != http.StatusOK {
			t.Fatalf("resending a full payment: got %d %s, want 200 with the existing row.\n"+
				"AMOUNT_EXCEEDS_BALANCE here is a business rule standing in for a "+
				"dropped connection, and it tells the foreman nothing about "+
				"whether the cash he handed over went in.", retry.Status, retry.Raw)
		}
		if mustString(t, retry.Body, "id") != payID {
			t.Fatalf("the retry answered a different payment: %s", retry.Raw)
		}
	})
}
