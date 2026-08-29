package apitest

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// TestPayableCannotBePaidTwice is the anti double-pay lock.
//
// It is the one invariant that could not be duplicated, and it is why there is
// a single payable table instead of pickups plus work records. The lock is the
// partial unique index ux_items_payable_live, not a check in Go: a payable belongs
// to exactly one live settlement, and the database is what says so.
func TestPayableCannotBePaidTwice(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del candado", 80000)
	worker := h.createWorker(t, f, "Elena", "9988776655")
	h.createPlot(t, f, "Lote candado")
	activity := h.harvestActivityID(t, f)

	recordID := h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 100)

	first := h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated)
	firstID := mustString(t, first.Body, "id")
	if got := mustInt(t, first.Body, "grossCents"); got != 8_000_000 {
		t.Fatalf("gross is %d, want 8000000 (100 kg at 80000)", got)
	}

	t.Run("a second settlement over the same period finds nothing left", func(t *testing.T) {
		// The record is claimed, so it is not pending any more; there is
		// nothing to settle rather than something to settle twice.
		res := h.doSettle(t, f.OwnerToken, map[string]any{
			"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
		})
		if res.code() != string(domain.CodeNothingToSettle) {
			t.Fatalf("re-settling: got %d %s, want NOTHING_TO_SETTLE", res.Status, res.Raw)
		}
	})

	t.Run("naming the payable explicitly does not get past the lock either", func(t *testing.T) {
		res := h.doSettle(t, f.OwnerToken, map[string]any{
			"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
			"payableIds": []string{recordID},
		})
		if res.code() != string(domain.CodeNothingToSettle) {
			t.Fatalf("re-settling by id: got %d %s, want NOTHING_TO_SETTLE", res.Status, res.Raw)
		}
	})

	t.Run("and the index refuses even when the query layer is bypassed", func(t *testing.T) {
		// Straight at the table, as the API role, with a hand-written line for
		// a record that is already claimed. This is the concurrent-settlement
		// race, and the only thing that can stop it is the index.
		h.withTenant(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
			func(ctx context.Context, tx pgx.Tx) {
				var settlementID string
				err := tx.QueryRow(ctx, `
					INSERT INTO settlements (id, farm_id, employee_id, period_start,
					                         period_end, gross_minor)
					VALUES (gen_random_uuid(), $1, $2, '2026-08-24', '2026-08-30', 1)
					RETURNING id::text`, f.FarmID, worker).Scan(&settlementID)
				if err != nil {
					t.Fatalf("insert rival settlement: %v", err)
				}
				_, err = tx.Exec(ctx, `
					INSERT INTO settlement_items (id, farm_id, settlement_id, payable_id,
					                              week_start, quantity, price_minor, amount_minor)
					VALUES (gen_random_uuid(), $1, $2, $3, '2026-08-24', 100, 80000, 8000000)`,
					f.FarmID, settlementID, recordID)
				if err == nil {
					t.Fatal("a second live settlement item was accepted for the same payable; " +
						"ux_items_payable_live is not doing its job")
				}
				if !store.IsUniqueViolation(err, "ux_items_payable_live") {
					t.Fatalf("expected a violation of ux_items_payable_live, got: %v", err)
				}
			})
	})

	t.Run("voiding releases the payable, and it settles exactly once more", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/settlements/"+firstID+"/void",
			f.OwnerToken, nil, http.StatusOK)

		// Voiding does not delete: the earning is cancelled by a reversal, and
		// the balance goes back to zero rather than the rows disappearing.
		bal := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/balance",
			f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, bal.Body, "balanceCents"); got != 0 {
			t.Fatalf("balance after voiding is %d, want 0", got)
		}

		second := h.mustSettle(t, f.OwnerToken, map[string]any{
			"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
		}, http.StatusCreated)
		if got := mustInt(t, second.Body, "grossCents"); got != 8_000_000 {
			t.Fatalf("re-settled gross is %d, want 8000000", got)
		}

		// And now it is locked again.
		again := h.doSettle(t, f.OwnerToken, map[string]any{
			"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
		})
		if again.code() != string(domain.CodeNothingToSettle) {
			t.Fatalf("third settlement: got %d %s, want NOTHING_TO_SETTLE", again.Status, again.Raw)
		}
	})

	t.Run("voiding twice is a conflict, not a second reversal", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/settlements/"+firstID+"/void", f.OwnerToken, nil)
		if res.code() != string(domain.CodeSettlementAlreadyVoid) {
			t.Fatalf("second void: got %d %s, want SETTLEMENT_ALREADY_VOID", res.Status, res.Raw)
		}
	})

	t.Run("a settled work record cannot be deleted", func(t *testing.T) {
		res := h.do(t, http.MethodDelete, "/v1/work-records/"+recordID, f.OwnerToken, nil)
		if res.code() != string(domain.CodeWorkRecordSettled) {
			t.Fatalf("deleting a settled work record: got %d %s, want WORK_RECORD_SETTLED", res.Status, res.Raw)
		}
	})
}

// TestBalanceIsDerivedAndReversalsAreOnce covers the rest of the money
// vocabulary: payment, advance, deduction, and the reversal that is the only
// way to undo any of them.
func TestBalanceIsDerivedAndReversalsAreOnce(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del diario", 80000)
	worker := h.createWorker(t, f, "Fabio", "1029384756")
	h.createPlot(t, f, "Lote diario")
	activity := h.harvestActivityID(t, f)

	h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 52.5)
	h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-27", 47.5)
	h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated)

	t.Run("paying less than the balance leaves the rest in the worker's favour", func(t *testing.T) {
		// This is golden case 01: a positive balance is the worker's savings
		// held by the farm. Settling it to zero on payment would make that
		// money disappear until somebody complained.
		pay := h.mustDo(t, http.MethodPost, "/v1/payments", f.OwnerToken, map[string]any{
			"workerId": worker, "amountCents": 5_000_000, "method": "efectivo",
			"date": "2026-08-30",
		}, http.StatusCreated)
		if got := mustInt(t, pay.Body, "amountCents"); got != -5_000_000 {
			t.Fatalf("a payment stored as %d; it must be negative in the ledger", got)
		}

		bal := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/balance",
			f.OwnerToken, nil, http.StatusOK)
		for key, want := range map[string]int64{
			"earnedCents":   8_000_000,
			"paidCents":     5_000_000,
			"deductedCents": 0,
			"balanceCents":  3_000_000,
		} {
			if got := mustInt(t, bal.Body, key); got != want {
				t.Errorf("%s = %d, want %d: %s", key, got, want, bal.Raw)
			}
		}
	})

	t.Run("a payment larger than the balance is refused", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/payments", f.OwnerToken, map[string]any{
			"workerId": worker, "amountCents": 9_000_000, "method": "efectivo",
		})
		if res.code() != string(domain.CodeAmountExceedsBalance) {
			t.Fatalf("overpayment: got %d %s, want AMOUNT_EXCEEDS_BALANCE", res.Status, res.Raw)
		}
	})

	t.Run("an advance may exceed the balance, because that is what an advance is", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/advances", f.OwnerToken, map[string]any{
			"workerId": worker, "amountCents": 4_000_000, "method": "efectivo",
		}, http.StatusCreated)
		bal := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/balance",
			f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, bal.Body, "balanceCents"); got != -1_000_000 {
			t.Fatalf("balance after the advance is %d, want -1000000", got)
		}
	})

	t.Run("a deduction is not an expense and lands in its own bucket", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/deductions", f.OwnerToken, map[string]any{
			"workerId": worker, "amountCents": 200_000, "note": "botas",
		}, http.StatusCreated)
		entryID := mustString(t, res.Body, "id")

		bal := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/balance",
			f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, bal.Body, "deductedCents"); got != 200_000 {
			t.Fatalf("deductedCents = %d, want 200000", got)
		}

		t.Run("and it is undone by reversing it, once", func(t *testing.T) {
			rev := h.mustDo(t, http.MethodPost, "/v1/ledger/"+entryID+"/reverse",
				f.OwnerToken, map[string]any{"note": "mal registrado"}, http.StatusCreated)
			if got := mustInt(t, rev.Body, "amountCents"); got != 200_000 {
				t.Fatalf("the reversal is %d, want +200000 to cancel the deduction", got)
			}

			second := h.do(t, http.MethodPost, "/v1/ledger/"+entryID+"/reverse",
				f.OwnerToken, map[string]any{"note": "otra vez"})
			if second.code() != string(domain.CodeAlreadyReversed) {
				t.Fatalf("second reversal: got %d %s, want ALREADY_REVERSED",
					second.Status, second.Raw)
			}
		})
	})

	t.Run("the ledger cannot be edited or deleted at all", func(t *testing.T) {
		h.withTenant(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
			func(ctx context.Context, tx pgx.Tx) {
				_, err := tx.Exec(ctx, `UPDATE ledger SET amount_minor = 1 WHERE farm_id = $1`, f.FarmID)
				if err == nil {
					t.Error("the API role was allowed to UPDATE the ledger")
				}
				_, err = tx.Exec(ctx, `DELETE FROM ledger WHERE farm_id = $1`, f.FarmID)
				if err == nil {
					t.Error("the API role was allowed to DELETE from the ledger")
				}
			})
	})
}

// TestPriceFreezing covers decision 4: when a rate freezes, and the single-day
// rule that follows from deriving a price from a date.
func TestPriceFreezing(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de precios", 80000)
	worker := h.createWorker(t, f, "Gloria", "1213141516")

	t.Run("the weekly price is applied when the settlement runs, not when the work is recorded", func(t *testing.T) {
		activity := h.harvestActivityID(t, f)
		task := h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 10)

		// Recorded at the standing price; the week is then given its own.
		h.mustDo(t, http.MethodPut, "/v1/prices/weeks/2026-08-24", f.OwnerToken,
			map[string]any{"priceCents": 95000}, http.StatusOK)

		res := h.mustDo(t, http.MethodGet,
			"/v1/pending?workerId="+worker+"&from=2026-08-24&to=2026-08-30",
			f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, res.Body, "totalCents"); got != 950_000 {
			t.Fatalf("pending total is %d, want 950000 (10 kg at the week's 95000)", got)
		}
		items, _ := res.Body["items"].([]any)
		if len(items) != 1 || items[0].(map[string]any)["payableId"] != task {
			t.Fatalf("pending did not return the task: %s", res.Raw)
		}
	})

	t.Run("a date-derived price forces a single day", func(t *testing.T) {
		unit := h.mustDo(t, http.MethodPost, "/v1/catalogs/work-units", f.OwnerToken,
			map[string]any{"code": "jornal-u", "label": "Jornal"}, http.StatusOK)

		created := h.mustDo(t, http.MethodPost, "/v1/activities", f.OwnerToken, map[string]any{
			"name": "Guadanada", "category": "mantenimiento", "payScheme": "tiempo",
			"rateSource": "activity_dated",
			"rate":       map[string]any{"rateCents": 60000, "validFrom": "2026-01-01", "timeUnit": "jornal"},
		}, http.StatusCreated)
		activity := mustString(t, created.Body, "id")
		_ = unit

		// One day: fine, and the rate in force freezes onto the record.
		single := h.mustDo(t, http.MethodPost, "/v1/work-records", f.OwnerToken, map[string]any{
			"activityId": activity, "workerId": worker, "quantity": 2, "dateFrom": "2026-08-25",
		}, http.StatusCreated)
		if got := mustInt(t, single.Body, "amountCents"); got != 120_000 {
			t.Fatalf("amount is %d, want 120000 (2 jornales at 60000)", got)
		}
		if got := mustInt(t, single.Body, "rateCents"); got != 60_000 {
			t.Fatalf("the rate did not freeze onto the record: %s", single.Raw)
		}

		// A range: refused, because a wage from Tuesday to Tuesday has no
		// single validity period to derive a price from.
		res := h.do(t, http.MethodPost, "/v1/work-records", f.OwnerToken, map[string]any{
			"activityId": activity, "workerId": worker, "quantity": 5,
			"dateFrom": "2026-08-25", "dateTo": "2026-08-29",
		})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("a multi-day date-derived record was accepted: %d %s", res.Status, res.Raw)
		}

		// The same range with the price named by the caller: accepted,
		// because now the price is frozen and there is nothing to derive.
		ranged := h.mustDo(t, http.MethodPost, "/v1/work-records", f.OwnerToken, map[string]any{
			"activityId": activity, "workerId": worker, "quantity": 5,
			"dateFrom": "2026-08-25", "dateTo": "2026-08-29", "rateCents": 60000,
		}, http.StatusCreated)
		if got := mustInt(t, ranged.Body, "amountCents"); got != 300_000 {
			t.Fatalf("ranged amount is %d, want 300000", got)
		}
	})

	t.Run("a new rate period does not move a price that was already frozen", func(t *testing.T) {
		created := h.mustDo(t, http.MethodPost, "/v1/activities", f.OwnerToken, map[string]any{
			"name": "Poda", "category": "mantenimiento", "payScheme": "tiempo",
			"rate": map[string]any{"rateCents": 50000, "validFrom": "2026-01-01", "timeUnit": "jornal"},
		}, http.StatusCreated)
		activity := mustString(t, created.Body, "id")

		before := h.mustDo(t, http.MethodPost, "/v1/work-records", f.OwnerToken, map[string]any{
			"activityId": activity, "workerId": worker, "quantity": 1, "dateFrom": "2026-06-01",
		}, http.StatusCreated)

		h.mustDo(t, http.MethodPut, "/v1/activities/"+activity+"/rate", f.OwnerToken,
			map[string]any{"rateCents": 70000, "validFrom": "2026-07-01"}, http.StatusOK)

		// Work done before the new period still costs the old rate.
		old := h.mustDo(t, http.MethodPost, "/v1/work-records", f.OwnerToken, map[string]any{
			"activityId": activity, "workerId": worker, "quantity": 1, "dateFrom": "2026-06-15",
		}, http.StatusCreated)
		if got := mustInt(t, old.Body, "amountCents"); got != 50_000 {
			t.Errorf("work in June cost %d, want the June rate 50000", got)
		}
		// Work done after it costs the new one.
		fresh := h.mustDo(t, http.MethodPost, "/v1/work-records", f.OwnerToken, map[string]any{
			"activityId": activity, "workerId": worker, "quantity": 1, "dateFrom": "2026-07-15",
		}, http.StatusCreated)
		if got := mustInt(t, fresh.Body, "amountCents"); got != 70_000 {
			t.Errorf("work in July cost %d, want the July rate 70000", got)
		}
		// And the record written before the change is untouched.
		if got := mustInt(t, before.Body, "amountCents"); got != 50_000 {
			t.Errorf("the already-written record says %d, want 50000", got)
		}
	})
}

// TestSundayEveningBelongsToTheFarmsDay is golden case 04, and it is a bug
// that already happened once: a 19:30 weighing in Colombia is 00:30 UTC the
// next day, which is Monday in UTC and Sunday on the farm. The business day
// comes from farms.timezone, and Go never writes it.
func TestSundayEveningBelongsToTheFarmsDay(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del domingo", 80000)
	worker := h.createWorker(t, f, "Hector", "1718192021")
	activity := h.harvestActivityID(t, f)

	// 2026-08-30 is a Sunday; its week starts on Monday 2026-08-24.
	task := h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-30", 10)

	res := h.mustDo(t, http.MethodGet, "/v1/work-records/"+task, f.OwnerToken, nil, http.StatusOK)
	if got := mustString(t, res.Body, "dateFrom"); got[:10] != "2026-08-30" {
		t.Fatalf("local day is %s, want 2026-08-30", got)
	}
	if got := mustString(t, res.Body, "weekStart"); got[:10] != "2026-08-24" {
		t.Fatalf("week is %s, want the Monday 2026-08-24", got)
	}
	if want := mondayOf("2026-08-30"); want != "2026-08-24" {
		t.Fatalf("domain.MondayOf disagrees with Postgres: %s", want)
	}

	// It settles in the week that is paid, at that week's rate.
	h.mustDo(t, http.MethodPut, "/v1/prices/weeks/2026-08-24", f.OwnerToken,
		map[string]any{"priceCents": 95000}, http.StatusOK)
	settled := h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated)
	if got := mustInt(t, settled.Body, "grossCents"); got != 950_000 {
		t.Fatalf("gross is %d, want 950000 at the Sunday's own week rate", got)
	}
}

var _ = store.NoRows
var _ = isoDate
var _ = describe
