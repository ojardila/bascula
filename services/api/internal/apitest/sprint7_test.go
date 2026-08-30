package apitest

import (
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// Sprint 7. Every test here is a hole an adversarial audit walked through, and
// every one of them passed the suite that shipped before it.
//
// They are grouped by the thing that was actually wrong rather than by
// endpoint, because in each case the endpoint was fine and the RULE was not
// there — which is the only kind of bug a route-shaped test cannot find.

// ---------------------------------------------------------------------------
// The season import reconciles, or it is not a reconciliation
// ---------------------------------------------------------------------------

// season builds a minimal, coherent import that passes, so each subtest can
// break exactly one thing and see the refusal that belongs to it.
func season(mutate func(m map[string]any)) map[string]any {
	m := map[string]any{
		"deviceId":   uuid.NewString(),
		"workers":    []map[string]any{},
		"weekPrices": []map[string]any{},
		"balances":   []map[string]any{},
	}
	mutate(m)
	return m
}

// TestTheImportReconciliationCannotBeChosenByTheCaller is fault (a) of the
// audit, and it is the one that makes every other check here reachable.
//
// The reconciliation compared the ledger it had just written against the
// balance the caller declared, FOR THE WORKERS THE CALLER NAMED. Name nobody
// who moved and the sums are zero against zero; name a uuid that does not
// exist and they are zero against zero again. A file that chooses its own
// examination passes it.
func TestTheImportReconciliationCannotBeChosenByTheCaller(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la reconciliacion", 100000)

	ana := uuid.NewString()
	settlement := uuid.NewString()
	earning := uuid.NewString()
	nobody := "00000000-0000-0000-0000-000000000000"

	t.Run("a worker the file moves money for must be declared", func(t *testing.T) {
		// Half a billion credited to Ana, with `balances` naming only a uuid
		// that does not exist. This answered 200.
		out := h.do(t, http.MethodPost, "/v1/import/season", f.OwnerToken, season(func(m map[string]any) {
			m["workers"] = []map[string]any{{"id": ana, "name": "Ana"}}
			m["settlements"] = []map[string]any{{
				"id": settlement, "workerId": ana, "periodStart": "2026-08-24",
				"periodEnd": "2026-08-30", "grossCents": 1, "status": "open",
				"items": []map[string]any{}}}
			m["ledger"] = []map[string]any{{
				"id": earning, "workerId": ana, "kind": "devengo",
				"amountCents": 500000000, "date": "2026-08-30", "settlementId": settlement}}
			m["balances"] = []map[string]any{{"workerId": nobody, "balanceCents": 0}}
		}))
		if out.code() != string(domain.CodeImportMismatch) {
			t.Fatalf("a file that declares nobody: got %d %s, want IMPORT_MISMATCH", out.Status, out.Raw)
		}
		if got := h.do(t, http.MethodGet, "/v1/workers/"+ana, f.OwnerToken, nil); got.Status != http.StatusNotFound {
			t.Fatalf("a refused import left the worker behind: %d", got.Status)
		}
	})

	t.Run("a balance for somebody who does not exist is not a balance", func(t *testing.T) {
		real := uuid.NewString()
		out := h.do(t, http.MethodPost, "/v1/import/season", f.OwnerToken, season(func(m map[string]any) {
			m["workers"] = []map[string]any{{"id": real, "name": "Existe"}}
			m["balances"] = []map[string]any{
				{"workerId": real, "balanceCents": 0},
				{"workerId": nobody, "balanceCents": 0},
			}
		}))
		if out.code() != string(domain.CodeImportMismatch) {
			t.Fatalf("a balance for a phantom: got %d %s, want IMPORT_MISMATCH", out.Status, out.Raw)
		}
	})

	t.Run("a settlement's gross is the sum of its lines", func(t *testing.T) {
		// The gross was never once compared with the lines underneath it, so
		// a receipt for any figure at all went in with nothing beneath it.
		w := uuid.NewString()
		out := h.do(t, http.MethodPost, "/v1/import/season", f.OwnerToken, season(func(m map[string]any) {
			m["workers"] = []map[string]any{{"id": w, "name": "Sin respaldo"}}
			m["settlements"] = []map[string]any{{
				"id": uuid.NewString(), "workerId": w, "periodStart": "2026-08-24",
				"periodEnd": "2026-08-30", "grossCents": 9_000_000, "status": "open",
				"items": []map[string]any{}}}
			m["balances"] = []map[string]any{{"workerId": w, "balanceCents": 0}}
		}))
		if out.code() != string(domain.CodeImportMismatch) {
			t.Fatalf("a gross with no lines: got %d %s, want IMPORT_MISMATCH", out.Status, out.Raw)
		}
	})
}

// TestOnePersonsWeighingsAreNotPaidToAnother is fault (b), and of the fourteen
// it is the one that takes money off a named individual.
//
// settlement_items.payable_id was never tied to the employee_id of the
// settlement holding it. ux_items_payable_live is on payable_id ALONE, so
// Beto's settlement claiming Ana's three days both paid Beto for them and left
// Ana with nothing pending and no route to recover it.
func TestOnePersonsWeighingsAreNotPaidToAnother(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de las pesadas ajenas", 100000)
	activity := h.harvestActivityID(t, f)

	h.mustDo(t, http.MethodPut, "/v1/prices/weeks/2026-08-24", f.OwnerToken,
		map[string]any{"priceCents": 100000}, http.StatusOK)

	ana := h.createWorker(t, f, "Ana", "1098444444")
	beto := h.createWorker(t, f, "Beto", "1098555555")

	picks := []string{}
	for _, day := range []string{"2026-08-25", "2026-08-26", "2026-08-27"} {
		picks = append(picks, h.createWorkRecord(t, f, f.OwnerToken, ana, activity, day, 10))
	}

	before := h.mustDo(t, http.MethodGet,
		"/v1/pending?workerId="+ana+"&from=2026-01-01&to=2026-12-31", f.OwnerToken, nil, http.StatusOK)
	owed := mustInt(t, before.Body, "totalCents")
	if owed != 3_000_000 {
		t.Fatalf("Ana is owed %d before the import, want 3000000", owed)
	}

	settlement := uuid.NewString()
	items := []map[string]any{}
	for _, p := range picks {
		items = append(items, map[string]any{
			"payableId": p, "weekStart": "2026-08-24", "quantity": 10,
			"priceCents": 100000, "amountCents": 1000000})
	}
	out := h.do(t, http.MethodPost, "/v1/import/season", f.OwnerToken, map[string]any{
		"deviceId": uuid.NewString(),
		"settlements": []map[string]any{{
			"id": settlement, "workerId": beto, "periodStart": "2026-08-24",
			"periodEnd": "2026-08-30", "grossCents": 3000000, "status": "open",
			"items": items}},
		"ledger": []map[string]any{{
			"id": uuid.NewString(), "workerId": beto, "kind": "devengo",
			"amountCents": 3000000, "date": "2026-08-30", "settlementId": settlement}},
		"balances": []map[string]any{
			{"workerId": beto, "balanceCents": 3000000},
			{"workerId": ana, "balanceCents": 0},
		},
	})
	if out.code() != string(domain.CodeImportMismatch) {
		t.Fatalf("Beto's settlement claiming Ana's days: got %d %s, want IMPORT_MISMATCH",
			out.Status, out.Raw)
	}

	// And nothing moved. This is the half that matters: the refusal is only
	// worth having if Ana's three days are still hers to be paid for.
	after := h.mustDo(t, http.MethodGet,
		"/v1/pending?workerId="+ana+"&from=2026-01-01&to=2026-12-31", f.OwnerToken, nil, http.StatusOK)
	if got := mustInt(t, after.Body, "totalCents"); got != 3_000_000 {
		t.Fatalf("Ana is owed %d after the refused import, want 3000000: %s", got, after.Raw)
	}
	bal := h.mustDo(t, http.MethodGet, "/v1/workers/"+beto+"/balance", f.OwnerToken, nil, http.StatusOK)
	if got := mustInt(t, bal.Body, "balanceCents"); got != 0 {
		t.Fatalf("Beto was credited %d by a refused import", got)
	}
}

// TestAVoidSettlementCannotArriveHoldingALiveLine is fault (c): the one shape
// with no way back out.
//
// A `void` header with a line whose voidedAt is null leaves that payable
// claimed by ux_items_payable_live for ever. VoidSettlement answers
// SETTLEMENT_ALREADY_VOID before it reaches the lines, DELETE is revoked on
// settlement_items, and there is no third route. The weighing earns nothing
// and nothing on this server can release it.
func TestAVoidSettlementCannotArriveHoldingALiveLine(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del limbo", 100000)
	activity := h.harvestActivityID(t, f)
	h.mustDo(t, http.MethodPut, "/v1/prices/weeks/2026-08-24", f.OwnerToken,
		map[string]any{"priceCents": 100000}, http.StatusOK)

	carlos := h.createWorker(t, f, "Carlos", "1098666666")
	pick := h.createWorkRecord(t, f, f.OwnerToken, carlos, activity, "2026-08-25", 10)

	line := func(voidedAt any) map[string]any {
		return map[string]any{
			"payableId": pick, "weekStart": "2026-08-24", "quantity": 10,
			"priceCents": 100000, "amountCents": 1000000, "voidedAt": voidedAt}
	}
	body := func(voidedAt any) map[string]any {
		return map[string]any{
			"deviceId": uuid.NewString(),
			"settlements": []map[string]any{{
				"id": uuid.NewString(), "workerId": carlos, "periodStart": "2026-08-24",
				"periodEnd": "2026-08-30", "grossCents": 1000000, "status": "void",
				"voidedAt": "2026-08-28T00:00:00-05:00",
				"items":    []map[string]any{line(voidedAt)}}},
			"balances": []map[string]any{{"workerId": carlos, "balanceCents": 0}},
		}
	}

	out := h.do(t, http.MethodPost, "/v1/import/season", f.OwnerToken, body(nil))
	if out.Status != http.StatusBadRequest {
		t.Fatalf("a void settlement with a live line: got %d %s, want 400", out.Status, out.Raw)
	}

	// The properly void one still goes in, and — the point of voiding at all —
	// releases its payable back to be settled.
	h.mustDo(t, http.MethodPost, "/v1/import/season", f.OwnerToken,
		body("2026-08-28T00:00:00-05:00"), http.StatusOK)
	pending := h.mustDo(t, http.MethodGet,
		"/v1/pending?workerId="+carlos+"&from=2026-01-01&to=2026-12-31", f.OwnerToken, nil, http.StatusOK)
	if got := mustInt(t, pending.Body, "totalCents"); got != 1_000_000 {
		t.Fatalf("a void settlement did not release its payable: %d %s", got, pending.Raw)
	}
}

// TestAnImportedDayIsAPlausibleDay is fault (d). A `pago` dated 1900-01-01
// sorts before every settlement for ever and a 9999-12-31 `anticipo` after
// every one of them, so both sit permanently outside any period a report or a
// settlement asks about — money in the ledger that no window can see.
func TestAnImportedDayIsAPlausibleDay(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de las fechas", 100000)

	for _, day := range []string{"1900-01-01", "9999-12-31"} {
		w := uuid.NewString()
		out := h.do(t, http.MethodPost, "/v1/import/season", f.OwnerToken, map[string]any{
			"deviceId": uuid.NewString(),
			"workers":  []map[string]any{{"id": w, "name": "Fechada"}},
			"ledger": []map[string]any{{
				"id": uuid.NewString(), "workerId": w, "kind": "anticipo",
				"amountCents": -1000, "date": day, "method": "efectivo"}},
			"balances": []map[string]any{{"workerId": w, "balanceCents": -1000}},
		})
		if out.Status != http.StatusBadRequest {
			t.Fatalf("a movement dated %s: got %d %s, want 400", day, out.Status, out.Raw)
		}
	}
}

// ---------------------------------------------------------------------------
// The push is the same door as REST and answers to the same rules
// ---------------------------------------------------------------------------

// TestTheWeigherCannotWriteAWorkerThroughTheSyncPush is fault 2.
//
// ActionWorkersWrite is `admins`, and REST enforced it on all three verbs. The
// push checked the role for ledgerEntry and not for worker, so the handset in
// the field could do what the handset's own screens could not: rename somebody,
// change their document, invent a person, and take one off the payroll.
func TestTheWeigherCannotWriteAWorkerThroughTheSyncPush(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del pesador", 100000)
	device := uuid.NewString()

	ana := h.createWorker(t, f, "Ana", "1098765432")

	push := func(token string, payload map[string]any) response {
		return h.do(t, http.MethodPost, "/v1/sync/push", token, map[string]any{
			"deviceId": device,
			"ops": []map[string]any{{
				"opId": uuid.NewString(), "entity": "worker", "op": "upsert",
				"payload": payload}},
		})
	}
	firstResult := func(res response) map[string]any {
		rows, _ := res.Body["results"].([]any)
		if len(rows) != 1 {
			t.Fatalf("want one result per envelope, got %d: %s", len(rows), res.Raw)
		}
		return rows[0].(map[string]any)
	}
	code := func(res response) string {
		row := firstResult(res)
		errObj, _ := row["error"].(map[string]any)
		c, _ := errObj["code"].(string)
		return c
	}

	for _, c := range []struct {
		what    string
		payload map[string]any
	}{
		{"rename and re-document", map[string]any{
			"id": ana, "name": "NOMBRE CAMBIADO", "docId": "9999999999", "documentType": "CC"}},
		{"invent a person", map[string]any{
			"id": uuid.NewString(), "name": "Fantasma", "docId": "1234509876", "documentType": "CC"}},
		{"take one off the payroll", map[string]any{
			"id": ana, "name": "Ana", "deletedAt": "2026-08-29T00:00:00-05:00"}},
	} {
		res := push(f.WeigherToken, c.payload)
		if res.Status != http.StatusOK {
			t.Fatalf("%s: the batch must still answer 200: %d %s", c.what, res.Status, res.Raw)
		}
		if got := code(res); got != string(domain.CodeForbidden) {
			t.Fatalf("%s as a weigher: got %q, want FORBIDDEN: %s", c.what, got, res.Raw)
		}
	}

	// Nothing of Ana moved, and she is still on the payroll.
	got := h.mustDo(t, http.MethodGet, "/v1/workers/"+ana, f.OwnerToken, nil, http.StatusOK)
	if got.Body["name"] != "Ana" || got.Body["docId"] != "1098765432" {
		t.Fatalf("the weigher's refused push still landed: %s", got.Raw)
	}

	t.Run("and the refusal does not depend on the document", func(t *testing.T) {
		// The unique index on (farm_id, document_type, doc_id) made the push a
		// document-number oracle: a docId in use came back rejected and a free
		// one applied, so a weigher could walk the numbering and learn who is
		// on the payroll. Both answers have to be the same answer.
		taken := code(push(f.WeigherToken, map[string]any{
			"id": uuid.NewString(), "name": "Sonda", "documentType": "CC", "docId": "1098765432"}))
		free := code(push(f.WeigherToken, map[string]any{
			"id": uuid.NewString(), "name": "Sonda", "documentType": "CC", "docId": "5555555555"}))
		if taken != free || taken != string(domain.CodeForbidden) {
			t.Fatalf("the push distinguishes a document in use (%q) from a free one (%q)", taken, free)
		}
	})

	t.Run("an administrator still writes workers through the push", func(t *testing.T) {
		res := push(f.AdminToken, map[string]any{
			"id": uuid.NewString(), "name": "Nueva", "documentType": "CC", "docId": "1098777777"})
		if got := firstResult(res)["status"]; got != "applied" {
			t.Fatalf("the fix closed the door on the administrator too: %s", res.Raw)
		}
	})
}

// ---------------------------------------------------------------------------
// A deactivation does not hide a debt
// ---------------------------------------------------------------------------

// TestTakingSomebodyOffThePayrollDoesNotHideWhatTheyAreOwed is fault 3.
//
// ListBalances filtered `deleted_at IS NULL`, so deactivating a worker took
// their outstanding balance off /v1/balances — and out of the pull's checksum —
// with the money still in the ledger. Nothing was deleted and nothing was paid;
// it simply stopped being visible on the one screen that shows it.
func TestTakingSomebodyOffThePayrollDoesNotHideWhatTheyAreOwed(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la baja", 500000)
	plot := h.createPlot(t, f, "Lote 1")

	ana := h.createWorker(t, f, "Ana", "1098888888")
	h.settleSomething(t, f, ana, plot)

	quiet := h.createWorker(t, f, "Nunca movio un peso", "1098999999")

	owed := func() (int64, bool, bool) {
		res := h.mustDo(t, http.MethodGet, "/v1/balances", f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		var cents int64
		var listed, active bool
		var quietListed bool
		for _, raw := range items {
			row := raw.(map[string]any)
			if row["workerId"] == ana {
				listed = true
				cents = mustInt(t, row, "balanceCents")
				active, _ = row["active"].(bool)
			}
			if row["workerId"] == quiet {
				quietListed = true
			}
		}
		if !listed {
			t.Fatalf("Ana is not on /v1/balances at all: %s", res.Raw)
		}
		return cents, active, quietListed
	}

	before, active, quietListed := owed()
	if before <= 0 || !active || !quietListed {
		t.Fatalf("before the deactivation: %d owed, active=%v, quiet listed=%v",
			before, active, quietListed)
	}

	h.mustDo(t, http.MethodDelete, "/v1/workers/"+ana, f.OwnerToken, nil, http.StatusNoContent)
	h.mustDo(t, http.MethodDelete, "/v1/workers/"+quiet, f.OwnerToken, nil, http.StatusNoContent)

	after, active, quietListed := owed()
	if after != before {
		t.Fatalf("the debt changed on deactivation: %d -> %d", before, after)
	}
	if active {
		t.Fatalf("a deactivated worker is still reported active")
	}
	// The one row that does leave: deactivated AND never moved a peso is a row
	// with nothing in it, and keeping it would be padding the payroll screen
	// with everybody who ever passed through the farm.
	if quietListed {
		t.Fatalf("a deactivated worker with no movements at all is still listed")
	}
}

// ---------------------------------------------------------------------------
// The pull carries what the caller's role may see, and no more
// ---------------------------------------------------------------------------

// TestTheWeighersPullCarriesNoPrices is fault 4.
//
// GET /v1/farm strips priceCents for a weigher and GET /v1/prices/weeks/*
// answers him 403 — and the pull handed him exactly those two things, as
// `farmConfig.priceCents` and as a `weekPrice` row per week of the season,
// through the one endpoint his handset is required to call.
func TestTheWeighersPullCarriesNoPrices(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de los precios", 777777)
	for _, week := range []string{"2026-08-17", "2026-08-24"} {
		h.mustDo(t, http.MethodPut, "/v1/prices/weeks/"+week, f.OwnerToken,
			map[string]any{"priceCents": 654321}, http.StatusOK)
	}

	drain := func(token string) (map[string]int, []any) {
		counts := map[string]int{}
		rows := []any{}
		var cursor int64
		for {
			res := h.mustDo(t, http.MethodGet,
				"/v1/sync/pull?cursor="+strconv.FormatInt(cursor, 10)+"&limit=500",
				token, nil, http.StatusOK)
			changes, _ := res.Body["changes"].([]any)
			for _, raw := range changes {
				ch := raw.(map[string]any)
				counts[ch["entity"].(string)]++
				rows = append(rows, ch["row"])
			}
			cursor = mustInt(t, res.Body, "cursor")
			if more, _ := res.Body["more"].(bool); !more {
				break
			}
		}
		return counts, rows
	}

	counts, rows := drain(f.WeigherToken)
	if counts["weekPrice"] != 0 {
		t.Fatalf("the weigher's feed carried %d weekPrice rows", counts["weekPrice"])
	}
	if counts["farmConfig"] == 0 {
		t.Fatalf("the weigher still needs farmConfig for the timezone and the currency")
	}
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if _, leaked := row["priceCents"]; leaked {
			t.Fatalf("a price reached the weigher through the pull: %v", row)
		}
	}

	// And the owner still gets everything, or the fix has broken the feed.
	counts, _ = drain(f.OwnerToken)
	if counts["weekPrice"] < 2 {
		t.Fatalf("the owner's feed lost its week prices: %v", counts)
	}
}

// ---------------------------------------------------------------------------
// The push keeps its own contract
// ---------------------------------------------------------------------------

// TestThePushContractHolds is fault 6, in its three parts. Each of them is a
// promise the handler's own comment makes and did not keep.
func TestThePushContractHolds(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del contrato", 100000)
	device := uuid.NewString()

	push := func(ops ...map[string]any) response {
		return h.do(t, http.MethodPost, "/v1/sync/push", f.OwnerToken,
			map[string]any{"deviceId": device, "ops": ops})
	}
	results := func(res response) []any {
		rows, _ := res.Body["results"].([]any)
		return rows
	}

	t.Run("an opId reused for a different act does not answer for the first", func(t *testing.T) {
		// The registry stored the answer and not the question, so a second,
		// DIFFERENT weighing sent under an opId already used got back
		// `applied` carrying the FIRST weighing's id. The handset reads
		// `applied`, drops the op from its outbox, and the weighing is gone.
		key := uuid.NewString()
		first, second := uuid.NewString(), uuid.NewString()
		op := func(workerID, name string) map[string]any {
			return map[string]any{"opId": key, "entity": "worker", "op": "upsert",
				"payload": map[string]any{"id": workerID, "name": name}}
		}
		one := results(push(op(first, "Primero")))
		if one[0].(map[string]any)["status"] != "applied" {
			t.Fatalf("the first op did not apply: %v", one)
		}
		two := results(push(op(second, "Segundo")))
		row := two[0].(map[string]any)
		if row["status"] != "rejected" {
			t.Fatalf("a reused opId answered %v with id %v", row["status"], row["id"])
		}
		errObj, _ := row["error"].(map[string]any)
		if errObj["code"] != string(domain.CodeIdempotencyKeyReused) {
			t.Fatalf("want IDEMPOTENCY_KEY_REUSED, got %v", errObj["code"])
		}

		// A genuine resend — the same act, byte for byte — still gets the
		// stored answer, which is the whole point of the registry.
		again := results(push(op(first, "Primero")))
		if again[0].(map[string]any)["id"] != first {
			t.Fatalf("a true resend stopped being idempotent: %v", again)
		}
	})

	t.Run("a malformed opId does not take the batch down", func(t *testing.T) {
		// sync_ops.op_id is a uuid column, so the registry lookup was a cast
		// error, and a cast error aborts the REQUEST transaction — not the
		// savepoint, which had not been opened yet. One bad envelope answered
		// 404 for two hundred good ones, against the "always 200" three lines
		// above the handler.
		good := uuid.NewString()
		res := push(
			map[string]any{"opId": "no-soy-un-uuid", "entity": "worker", "op": "upsert",
				"payload": map[string]any{"id": uuid.NewString(), "name": "Mala"}},
			map[string]any{"opId": uuid.NewString(), "entity": "worker", "op": "upsert",
				"payload": map[string]any{"id": good, "name": "Buena"}},
		)
		if res.Status != http.StatusOK {
			t.Fatalf("one malformed opId took the batch down: %d %s", res.Status, res.Raw)
		}
		rows := results(res)
		if len(rows) != 2 {
			t.Fatalf("want one result per envelope, got %d: %s", len(rows), res.Raw)
		}
		if rows[0].(map[string]any)["status"] != "rejected" {
			t.Fatalf("the malformed envelope was not refused: %s", res.Raw)
		}
		if rows[1].(map[string]any)["status"] != "applied" {
			t.Fatalf("the good envelope in the same batch was lost: %s", res.Raw)
		}
		h.mustDo(t, http.MethodGet, "/v1/workers/"+good, f.OwnerToken, nil, http.StatusOK)
	})
}

// TestACursorAheadOfTheFeedIsRefused is the other half of CURSOR_TOO_OLD.
//
// The sequence only goes up and only this server hands it out, so a cursor
// above the farm's head cannot have come from here. Answering "up to date" to
// a handset holding maxint64 tells it, truthfully and for ever, that it will
// never receive another change — a phone silently and permanently out of sync,
// which is exactly what the bottom end of the same check exists to prevent.
func TestACursorAheadOfTheFeedIsRefused(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del cursor", 100000)
	const maxInt64 = "9223372036854775807"

	pull := h.do(t, http.MethodGet, "/v1/sync/pull?cursor="+maxInt64, f.OwnerToken, nil)
	if pull.code() != string(domain.CodeCursorTooOld) {
		t.Fatalf("a cursor ahead of the feed: got %d %s, want CURSOR_TOO_OLD", pull.Status, pull.Raw)
	}

	shake := h.do(t, http.MethodPost, "/v1/sync/handshake", f.OwnerToken, map[string]any{
		"deviceId": uuid.NewString(), "schemaVersion": 6, "cursor": int64(9223372036854775807)})
	if shake.code() != string(domain.CodeCursorTooOld) {
		t.Fatalf("the handshake reported a phone at maxint64 as up to date: %d %s",
			shake.Status, shake.Raw)
	}

	// The ordinary cursor still works, or this check has broken the feed.
	h.mustDo(t, http.MethodGet, "/v1/sync/pull?cursor=0", f.OwnerToken, nil, http.StatusOK)
}

// ---------------------------------------------------------------------------
// The cap that never fired
// ---------------------------------------------------------------------------

// TestTheFarmsPerEmailCapMovedBehindASession.
//
// CountOwnedFarms runs against `memberships`, whose policy is
// `farm_id = current_farm() OR user_id = current_user_id()`. Inside the public
// signup NEITHER was set — there is no token, no farm id has been generated,
// app.user_id is empty — so RLS answered every count with 0 and the cap never
// once fired. It was the silent zero the README claims to have closed, sitting
// inside the limit that guards the most exposed surface in the system.
//
// Sprint 8 moved the cap rather than repairing it in place, because the endpoint
// it lived on could not be made safe: proving ownership of an existing address
// with a password, on a route that issues no session, is a place to test
// guesses. The cap now lives on POST /v1/farms, behind that account's own token,
// where app.user_id comes from the tenant middleware and the count is a count of
// real rows. What this test pins is that the cap fires there — see
// TestSignupIsNoLongerAnOracleAndTheCapMovedBehindASession for the oracle
// itself.
func TestTheFarmsPerEmailCapMovedBehindASession(t *testing.T) {
	h := requireDB(t)

	email := "cap-" + uuid.NewString() + "@example.com"
	const password = "contrasena-larga-1"

	first := h.mustDo(t, http.MethodPost, "/v1/signup", "", map[string]any{
		"farm": map[string]any{"name": "Finca 1", "timezone": "America/Bogota",
			"currency": "COP", "priceCents": 100000},
		"owner": map[string]any{"email": email, "name": "Duena", "password": password},
	}, http.StatusCreated)
	h.mustDo(t, http.MethodPost, "/v1/auth/verify-email", "",
		map[string]any{"token": first.Body["verificationToken"]}, http.StatusOK)
	login := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": email, "password": password,
	}, http.StatusOK)
	token, _ := login.Body["accessToken"].(string)

	// The signup is no longer a way round it, and no longer says so either: the
	// answer is the one every address gets, and nothing was created. See
	// TestSignupAnswersTheSameWhetherTheAddressIsRegisteredOrNot.
	again := h.mustDo(t, http.MethodPost, "/v1/signup", "", map[string]any{
		"farm": map[string]any{"name": "Finca 2", "timezone": "America/Bogota",
			"currency": "COP", "priceCents": 100000},
		"owner": map[string]any{"email": email, "name": "Duena", "password": password},
	}, http.StatusCreated)
	if _, made := again.Body["farmId"]; made {
		t.Fatalf("the public signup named a farm: %s", again.Raw)
	}

	// The harness caps at three, and one exists.
	for i := 2; i <= 3; i++ {
		res := h.do(t, http.MethodPost, "/v1/farms", token, map[string]any{
			"name": "Finca " + strconv.Itoa(i), "priceCents": 100000})
		if res.Status != http.StatusCreated {
			t.Fatalf("farm %d should still be allowed: %d %s", i, res.Status, res.Raw)
		}
	}
	over := h.do(t, http.MethodPost, "/v1/farms", token, map[string]any{
		"name": "Finca de mas", "priceCents": 100000})
	if over.code() != string(domain.CodeFarmLimitReached) {
		t.Fatalf("the fourth farm on one account: got %d %s, want FARM_LIMIT_REACHED",
			over.Status, over.Raw)
	}
}

// ---------------------------------------------------------------------------
// A fixed-scale column is part of the contract, not a detail of storage
// ---------------------------------------------------------------------------

// TestAQuantityIsStoredAsItWasSentOrItIsRefused.
//
// work_records.quantity is numeric(12, 3), and Postgres does not REFUSE a
// fourth decimal place — it rounds it, on the way in, and the request answers
// 200. The mobile pair measured it: 1,0005 kg at $75 is 7504 on the handset and
// 7508 here, and the stored weight is not the weight that was on the scale
// either. Nobody is told. The two databases then hold different money for the
// same act, permanently, with no later moment at which they announce it.
//
// A number the server will not store exactly is a bad request. Rounding it
// belongs in front of the person whose kilos they are, not in a column
// declaration.
func TestAQuantityIsStoredAsItWasSentOrItIsRefused(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la escala", 7500)
	activity := h.harvestActivityID(t, f)
	worker := h.createWorker(t, f, "Pedro", "1098123123")

	post := func(token string, quantity any) response {
		return h.do(t, http.MethodPost, "/v1/work-records", token, map[string]any{
			"id": uuid.NewString(), "activityId": activity, "workerId": worker,
			"quantity": quantity, "dateFrom": "2026-08-25", "dateTo": "2026-08-25"})
	}

	t.Run("a fourth decimal place is refused, not rounded", func(t *testing.T) {
		// The exact figure from the audit. It used to answer 200 and store
		// 1.001, charging 7508 against the handset's 7504.
		res := post(f.OwnerToken, 1.0005)
		if res.Status != http.StatusBadRequest {
			t.Fatalf("1.0005 kg: got %d %s, want 400", res.Status, res.Raw)
		}
		if !strings.Contains(res.Raw, "3 decimal places") {
			t.Fatalf("the refusal has to name the limit: %s", res.Raw)
		}
	})

	t.Run("and the same on the door the handset actually uses", func(t *testing.T) {
		// The push, where a weigher's scale reading arrives. Still 200 for the
		// batch — one result per envelope — with this envelope refused.
		res := h.do(t, http.MethodPost, "/v1/sync/push", f.WeigherToken, map[string]any{
			"deviceId": uuid.NewString(),
			"ops": []map[string]any{{
				"opId": uuid.NewString(), "entity": "workRecord", "op": "upsert",
				"payload": map[string]any{
					"id": uuid.NewString(), "workerId": worker, "quantity": 1.0005,
					"occurredAt": "2026-08-25T14:00:00-05:00"}}},
		})
		if res.Status != http.StatusOK {
			t.Fatalf("the batch must still answer 200: %d %s", res.Status, res.Raw)
		}
		rows, _ := res.Body["results"].([]any)
		row := rows[0].(map[string]any)
		if row["status"] != "rejected" {
			t.Fatalf("the push rounded a fourth decimal place: %s", res.Raw)
		}
		errObj, _ := row["error"].(map[string]any)
		if errObj["code"] != string(domain.CodeBadRequest) {
			t.Fatalf("want BAD_REQUEST — §4.3's never-retry — got %v", errObj["code"])
		}
	})

	t.Run("three decimal places still go in, unchanged", func(t *testing.T) {
		res := post(f.OwnerToken, 1.001)
		if res.Status != http.StatusCreated && res.Status != http.StatusOK {
			t.Fatalf("1.001 kg is exactly representable: %d %s", res.Status, res.Raw)
		}
		if got, _ := res.Body["quantity"].(string); got != "" && !strings.HasPrefix(got, "1.001") {
			t.Fatalf("a legal quantity came back as %q", got)
		}
	})

	t.Run("a number too large for the column is 400, not 500", func(t *testing.T) {
		// numeric(12, 3) holds nine digits before the point. 1e30 used to
		// reach Postgres and come back as an unexplained 500.
		res := post(f.OwnerToken, 1e30)
		if res.Status != http.StatusBadRequest {
			t.Fatalf("1e30: got %d %s, want 400", res.Status, res.Raw)
		}
		if res.code() != string(domain.CodeBadRequest) {
			t.Fatalf("1e30 answered %s", res.code())
		}
	})

	t.Run("exponent notation is read as the decimal it is", func(t *testing.T) {
		// 1e-7 is 0.0000001 and has to be refused for the same reason
		// 0.0000001 is, not accepted because it was spelled differently.
		res := post(f.OwnerToken, 1e-7)
		if res.Status != http.StatusBadRequest {
			t.Fatalf("1e-7: got %d %s, want 400", res.Status, res.Raw)
		}
	})

	t.Run("the rule reaches the season import too", func(t *testing.T) {
		w := uuid.NewString()
		out := h.do(t, http.MethodPost, "/v1/import/season", f.OwnerToken, map[string]any{
			"deviceId": uuid.NewString(),
			"workers":  []map[string]any{{"id": w, "name": "Importada"}},
			"workRecords": []map[string]any{{
				"id": uuid.NewString(), "workerId": w, "quantity": 1.0005,
				"occurredAt": "2026-08-25T14:00:00-05:00"}},
			"balances": []map[string]any{{"workerId": w, "balanceCents": 0}},
		})
		if out.Status != http.StatusBadRequest {
			t.Fatalf("an imported weighing with four decimal places: %d %s", out.Status, out.Raw)
		}
	})

	t.Run("and every other fixed-scale column the client can write", func(t *testing.T) {
		// A rule enforced on one field and not its neighbours is a rule
		// nobody can rely on. area_ha is numeric(10, 3).
		res := h.do(t, http.MethodPost, "/v1/plots", f.OwnerToken, map[string]any{
			"id": uuid.NewString(), "name": "Lote decimal", "areaHa": 1.0005})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("areaHa with four decimal places: got %d %s, want 400", res.Status, res.Raw)
		}
	})
}
