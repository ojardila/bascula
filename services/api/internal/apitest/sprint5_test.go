package apitest

import (
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// Sprint 5: the race between previewing and settling, the real sync endpoints,
// and the import of a season that already exists on a handset.

// ---------------------------------------------------------------------------
// §5.5 — the race between the preview and the button
// ---------------------------------------------------------------------------

// TestASettlementCannotComeOutToADifferentFigureThanTheOneThatWasRead is the
// most urgent thing in this sprint, and the reason is not technical.
//
// Somebody opens the settle screen, reads a gross, and between reading it and
// pressing the button the owner reprices the week from the web or a late
// weighing arrives. They then sign for a figure they never saw — and with cash
// that is not something you fix afterwards, because the money is already
// counted out on a table in front of a person.
func TestASettlementCannotComeOutToADifferentFigureThanTheOneThatWasRead(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la carrera", 80000)
	worker := h.createWorker(t, f, "Marta", "7001001001")
	h.createPlot(t, f, "Lote carrera")
	activity := h.harvestActivityID(t, f)
	h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 100)

	body := func() map[string]any {
		return map[string]any{"workerId": worker, "from": "2026-08-24", "to": "2026-08-30"}
	}

	t.Run("omitting the expectation is refused, and the message names the way out", func(t *testing.T) {
		// The decision, spelled out on handleCreateSettlement: the field is
		// required from today rather than optional "for now". A money guard a
		// client may omit is a guard that is off in exactly the moment it
		// matters, and the only callers today are in this repository.
		res := h.do(t, http.MethodPost, "/v1/settlements", f.OwnerToken, body())
		if res.Status != http.StatusBadRequest {
			t.Fatalf("settling with no expectation: got %d %s, want 400", res.Status, res.Raw)
		}
		errObj, _ := res.Body["error"].(map[string]any)
		msg, _ := errObj["message"].(string)
		if !strings.Contains(msg, "expectedGrossCents") || !strings.Contains(msg, "/v1/settlements/preview") {
			t.Fatalf("the refusal has to name the field AND where the figure comes from: %s", res.Raw)
		}
	})

	t.Run("the preview's figure is what the settlement accepts", func(t *testing.T) {
		preview := h.mustDo(t, http.MethodPost, "/v1/settlements/preview", f.OwnerToken,
			body(), http.StatusOK)
		gross := mustInt(t, preview.Body, "grossCents")
		if gross != 8_000_000 {
			t.Fatalf("preview grosses %d, want 8000000 (100 kg at 80000)", gross)
		}
		b := body()
		b["expectedGrossCents"] = gross
		res := h.mustDo(t, http.MethodPost, "/v1/settlements", f.OwnerToken, b, http.StatusCreated)
		if got := mustInt(t, res.Body, "grossCents"); got != gross {
			t.Fatalf("settled for %d after being shown %d", got, gross)
		}
	})

	t.Run("a repriced week is refused, and details say the price moved", func(t *testing.T) {
		f2 := h.signupFarm(t, "Finca del precio movido", 80000)
		w := h.createWorker(t, f2, "Precio", "7001001002")
		h.createPlot(t, f2, "Lote precio")
		act := h.harvestActivityID(t, f2)
		h.createWorkRecord(t, f2, f2.OwnerToken, w, act, "2026-08-25", 100)

		// What the screen showed.
		shown := int64(8_000_000)

		// The owner reprices the week from the web while the screen is open.
		h.mustDo(t, http.MethodPut, "/v1/prices/weeks/2026-08-24", f2.OwnerToken,
			map[string]any{"priceCents": 90000}, http.StatusOK)

		res := h.do(t, http.MethodPost, "/v1/settlements", f2.OwnerToken, map[string]any{
			"workerId": w, "from": "2026-08-24", "to": "2026-08-30",
			"expectedGrossCents": shown,
		})
		if res.code() != string(domain.CodeGrossChanged) {
			t.Fatalf("settling after a reprice: got %d %s, want GROSS_CHANGED", res.Status, res.Raw)
		}
		errObj, _ := res.Body["error"].(map[string]any)
		details, _ := errObj["details"].(map[string]any)
		if int64(details["expectedCents"].(float64)) != shown {
			t.Fatalf("details lost the figure that was read: %s", res.Raw)
		}
		if int64(details["actualCents"].(float64)) != 9_000_000 {
			t.Fatalf("details do not carry the new figure: %s", res.Raw)
		}
		weeks, _ := details["weeksInSettlement"].([]any)
		if len(weeks) != 1 {
			t.Fatalf("details name no week, so the screen cannot say which one moved: %s", res.Raw)
		}
		week := weeks[0].(map[string]any)
		if week["weekStart"] != "2026-08-24" || int64(week["priceCents"].(float64)) != 90000 {
			t.Fatalf("the week in details is not the one that was repriced: %s", res.Raw)
		}

		// And nothing was written. This is the half that matters: a refusal
		// that had already inserted the settlement would be worse than no
		// refusal at all.
		bal := h.mustDo(t, http.MethodGet, "/v1/workers/"+w+"/balance",
			f2.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, bal.Body, "balanceCents"); got != 0 {
			t.Fatalf("a refused settlement moved the balance to %d", got)
		}
	})

	t.Run("a late weighing is refused, and details name what came in", func(t *testing.T) {
		f3 := h.signupFarm(t, "Finca de la pesada tardia", 80000)
		w := h.createWorker(t, f3, "Tardia", "7001001003")
		h.createPlot(t, f3, "Lote tardio")
		act := h.harvestActivityID(t, f3)
		seen := h.createWorkRecord(t, f3, f3.OwnerToken, w, act, "2026-08-25", 100)

		// The screen listed exactly one payable and showed 8 000 000.
		// A second weighing lands before the button is pressed.
		late := h.createWorkRecord(t, f3, f3.OwnerToken, w, act, "2026-08-26", 20)

		res := h.do(t, http.MethodPost, "/v1/settlements", f3.OwnerToken, map[string]any{
			"workerId": w, "from": "2026-08-24", "to": "2026-08-30",
			"payableIds":         []string{seen},
			"expectedGrossCents": int64(9_600_000), // as if the screen had shown both
		})
		if res.code() != string(domain.CodeGrossChanged) {
			t.Fatalf("settling a stale set: got %d %s, want GROSS_CHANGED", res.Status, res.Raw)
		}
		errObj, _ := res.Body["error"].(map[string]any)
		details, _ := errObj["details"].(map[string]any)
		added, _ := details["addedPayableIds"].([]any)
		if len(added) != 1 || added[0] != late {
			t.Fatalf("details do not name the weighing that arrived: %s", res.Raw)
		}
	})

	t.Run("a retry is never refused over a figure that has since moved", func(t *testing.T) {
		// The one call that must not consult the expectation. The settlement
		// exists, the cash has been counted, and answering GROSS_CHANGED to a
		// resend would tell the foreman his payment failed when it did not.
		f4 := h.signupFarm(t, "Finca del reintento", 80000)
		w := h.createWorker(t, f4, "Reintento", "7001001004")
		h.createPlot(t, f4, "Lote reintento")
		act := h.harvestActivityID(t, f4)
		h.createWorkRecord(t, f4, f4.OwnerToken, w, act, "2026-08-25", 100)

		id := uuid.NewString()
		settle := map[string]any{
			"id": id, "workerId": w, "from": "2026-08-24", "to": "2026-08-30",
			"expectedGrossCents": int64(8_000_000),
		}
		h.mustDo(t, http.MethodPost, "/v1/settlements", f4.OwnerToken, settle, http.StatusCreated)

		h.mustDo(t, http.MethodPut, "/v1/prices/weeks/2026-08-24", f4.OwnerToken,
			map[string]any{"priceCents": 95000}, http.StatusOK)

		again := h.mustDo(t, http.MethodPost, "/v1/settlements", f4.OwnerToken, settle, http.StatusOK)
		if mustString(t, again.Body, "id") != id {
			t.Fatalf("the retry answered a different settlement: %s", again.Raw)
		}
		if got := mustInt(t, again.Body, "grossCents"); got != 8_000_000 {
			t.Fatalf("the retry repriced the settlement to %d", got)
		}
	})
}

// ---------------------------------------------------------------------------
// §5.6 — the second file for one person
// ---------------------------------------------------------------------------

func TestASecondFileForOnePersonIsRefused(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de las dos fichas", 80000)

	juan := h.createWorker(t, f, "Juan", "5005005005")
	h.mustDo(t, http.MethodDelete, "/v1/workers/"+juan, f.OwnerToken, nil, http.StatusNoContent)

	// The unique index on the document is partial on deleted_at, so nothing in
	// the database stops this. That is the whole point of the check.
	res := h.do(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
		"name": "Juan", "documentType": "CC", "docId": "5005005005",
	})
	if res.code() != string(domain.CodeEmployeeExistsDeleted) {
		t.Fatalf("re-registering a deactivated worker: got %d %s, want EMPLOYEE_EXISTS_DELETED",
			res.Status, res.Raw)
	}
	errObj, _ := res.Body["error"].(map[string]any)
	details, _ := errObj["details"].(map[string]any)
	if details["employeeId"] != juan {
		t.Fatalf("details do not point at the file to restore: %s", res.Raw)
	}

	// And the offered way out actually works.
	h.mustDo(t, http.MethodPatch, "/v1/workers/"+juan, f.OwnerToken,
		map[string]any{"status": "active"}, http.StatusOK)
	after := h.mustDo(t, http.MethodGet, "/v1/workers/"+juan, f.OwnerToken, nil, http.StatusOK)
	if after.Body["deletedAt"] != nil {
		t.Fatalf("restoring did not bring the file back: %s", after.Raw)
	}
}

// ---------------------------------------------------------------------------
// §3 — handshake, push, pull
// ---------------------------------------------------------------------------

func TestHandshakeTellsTheHandsetWhatItMayDoAndHowFarBehindItIs(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del saludo", 80000)
	device := uuid.NewString()

	t.Run("a handset below user_version 6 is turned away before it pushes a byte", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/sync/handshake", f.OwnerToken, map[string]any{
			"deviceId": device, "appVersion": "1.6.0", "schemaVersion": 5, "cursor": 0,
		})
		if res.code() != string(domain.CodeSchemaTooOld) {
			t.Fatalf("old schema: got %d %s, want SCHEMA_TOO_OLD", res.Status, res.Raw)
		}
	})

	res := h.mustDo(t, http.MethodPost, "/v1/sync/handshake", f.OwnerToken, map[string]any{
		"deviceId": device, "appVersion": "1.7.0", "schemaVersion": 6, "cursor": 0,
	}, http.StatusOK)

	if res.Body["timezone"] != "America/Bogota" {
		t.Fatalf("the handshake has to carry the farm's zone; without it the handset "+
			"computes a different local day from the server: %s", res.Raw)
	}
	// A brand new farm already has a feed. A cursor of zero and a behind of
	// zero would tell the handset the farm is empty, which is the single most
	// dangerous answer this endpoint can give.
	//
	// `cursor` is NOT a count: the sequence is one bigserial for the whole
	// server, so a farm's first change can perfectly well be seq 35. What the
	// handset compares is its own number against this one, never against a
	// total.
	if mustInt(t, res.Body, "cursor") <= 0 {
		t.Fatalf("a farm that exists has a feed: %s", res.Raw)
	}
	if mustInt(t, res.Body, "behind") <= 0 {
		t.Fatalf("a handset at cursor 0 is behind by everything this farm has: %s", res.Raw)
	}

	// And once it has caught up, it is behind by nothing.
	caught := h.mustDo(t, http.MethodGet, "/v1/sync/pull?cursor=0", f.OwnerToken, nil, http.StatusOK)
	after := h.mustDo(t, http.MethodPost, "/v1/sync/handshake", f.OwnerToken, map[string]any{
		"deviceId": device, "schemaVersion": 6, "cursor": mustInt(t, caught.Body, "cursor"),
	}, http.StatusOK)
	if mustInt(t, after.Body, "behind") != 0 {
		t.Fatalf("a handset that pulled everything is still behind: %s", after.Raw)
	}

	caps, _ := res.Body["capabilities"].(map[string]any)
	for _, k := range []string{"settleOffline", "writePlots", "writeWeekPrices"} {
		if caps[k] != false {
			t.Fatalf("%s should be off by decisions 5 and 6: %s", k, res.Raw)
		}
	}

	t.Run("the weigher handshakes too", func(t *testing.T) {
		// The person who spends days without signal is the weigher. A handset
		// that cannot synchronise is a scale that stops.
		w := h.mustDo(t, http.MethodPost, "/v1/sync/handshake", f.WeigherToken, map[string]any{
			"deviceId": uuid.NewString(), "schemaVersion": 6, "cursor": 0,
		}, http.StatusOK)
		if w.Body["role"] != string(domain.RoleWeigher) {
			t.Fatalf("the handshake has to say what this token can do: %s", w.Raw)
		}
	})
}

func TestPushAppliesWhatItCanAndRejectsOnlyWhatItMust(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del envio", 80000)
	device := uuid.NewString()

	workerID := uuid.NewString()
	recordA := uuid.NewString()
	recordB := uuid.NewString()
	advance := uuid.NewString()

	opWorker := uuid.NewString()
	opRecordA := uuid.NewString()

	push := func(token string, ops []map[string]any) response {
		return h.do(t, http.MethodPost, "/v1/sync/push", token,
			map[string]any{"deviceId": device, "ops": ops})
	}

	res := h.mustDo(t, http.MethodPost, "/v1/sync/push", f.OwnerToken, map[string]any{
		"deviceId": device,
		"ops": []map[string]any{
			{"opId": opWorker, "entity": "worker", "op": "upsert", "payload": map[string]any{
				"id": workerID, "name": "Ana", "lastName": "Rodríguez",
				"documentType": "CC", "docId": "1098000001", "tag": "17",
			}},
			{"opId": opRecordA, "entity": "workRecord", "op": "upsert", "payload": map[string]any{
				"id": recordA, "workerId": workerID, "quantity": 12.5,
				"occurredAt": "2026-08-24T19:30:00-05:00",
			}},
			// One bad envelope in the middle. It must not take the batch down.
			{"opId": uuid.NewString(), "entity": "workRecord", "op": "upsert", "payload": map[string]any{
				"id": uuid.NewString(), "workerId": uuid.NewString(), "quantity": 3,
				"occurredAt": "2026-08-24T19:30:00-05:00",
			}},
			{"opId": uuid.NewString(), "entity": "workRecord", "op": "upsert", "payload": map[string]any{
				"id": recordB, "workerId": workerID, "quantity": 7.25,
				"occurredAt": "2026-08-25T15:00:00-05:00",
			}},
			{"opId": uuid.NewString(), "entity": "ledgerEntry", "op": "append", "payload": map[string]any{
				"id": advance, "workerId": workerID, "kind": "anticipo",
				"amountCents": 5000000, "date": "2026-08-24", "method": "efectivo",
			}},
		},
	}, http.StatusOK)

	results, _ := res.Body["results"].([]any)
	if len(results) != 5 {
		t.Fatalf("a result per envelope or the handset cannot clear its outbox: %s", res.Raw)
	}
	statuses := make([]string, 0, 5)
	for _, raw := range results {
		statuses = append(statuses, raw.(map[string]any)["status"].(string))
	}
	want := []string{"applied", "applied", "rejected", "applied", "applied"}
	for i := range want {
		if statuses[i] != want[i] {
			t.Fatalf("op %d is %q, want %q: %s", i, statuses[i], want[i], res.Raw)
		}
	}

	// The rejected one names a worker this farm has never had. That is not a
	// conflict, it is an incomplete pull, and NOT_FOUND is what tells the
	// handset to retry once the references have come down.
	bad := results[2].(map[string]any)["error"].(map[string]any)
	if bad["code"] != string(domain.CodeNotFound) {
		t.Fatalf("an absent reference should be NOT_FOUND: %s", res.Raw)
	}

	t.Run("the surviving envelopes really landed", func(t *testing.T) {
		list := h.mustDo(t, http.MethodGet, "/v1/work-records?workerId="+workerID,
			f.OwnerToken, nil, http.StatusOK)
		items, _ := list.Body["items"].([]any)
		if len(items) != 2 {
			t.Fatalf("one rejection took the batch down: %s", list.Raw)
		}
	})

	t.Run("the instant decides the day, in the farm's zone and not the server's", func(t *testing.T) {
		// Golden case 04. 19:30 in Bogotá is already the next day in UTC, and
		// a server that computed the day itself would file the weighing in the
		// following week.
		one := h.mustDo(t, http.MethodGet, "/v1/work-records/"+recordA, f.OwnerToken, nil, http.StatusOK)
		if !strings.Contains(mustString(t, one.Body, "dateFrom"), "2026-08-24") {
			t.Fatalf("the local day is not the farm's: %s", one.Raw)
		}
	})

	t.Run("the same batch sent again applies nothing twice", func(t *testing.T) {
		again := h.mustDo(t, http.MethodPost, "/v1/sync/push", f.OwnerToken, map[string]any{
			"deviceId": device,
			"ops": []map[string]any{
				{"opId": opWorker, "entity": "worker", "op": "upsert", "payload": map[string]any{
					"id": workerID, "name": "Ana", "lastName": "Rodríguez",
					"documentType": "CC", "docId": "1098000001", "tag": "17",
				}},
				{"opId": opRecordA, "entity": "workRecord", "op": "upsert", "payload": map[string]any{
					"id": recordA, "workerId": workerID, "quantity": 12.5,
					"occurredAt": "2026-08-24T19:30:00-05:00",
				}},
			},
		}, http.StatusOK)
		rows, _ := again.Body["results"].([]any)
		for i, raw := range rows {
			row := raw.(map[string]any)
			// The registry answers with the RECORDED result, literally. Both
			// were `applied` the first time, so both are `applied` again — and
			// nothing ran.
			if row["status"] != "applied" {
				t.Fatalf("op %d on the resend is %v, want the recorded answer: %s", i, row["status"], again.Raw)
			}
		}
		list := h.mustDo(t, http.MethodGet, "/v1/work-records?workerId="+workerID,
			f.OwnerToken, nil, http.StatusOK)
		items, _ := list.Body["items"].([]any)
		if len(items) != 2 {
			t.Fatalf("the resend wrote %d records; a retry cannot create a second weighing", len(items))
		}
	})

	t.Run("a new opId for a row that is already here is a duplicate, not a second row", func(t *testing.T) {
		out := push(f.OwnerToken, []map[string]any{
			{"opId": uuid.NewString(), "entity": "workRecord", "op": "upsert", "payload": map[string]any{
				"id": recordB, "workerId": workerID, "quantity": 7.25,
				"occurredAt": "2026-08-25T15:00:00-05:00",
			}},
		})
		rows, _ := out.Body["results"].([]any)
		if rows[0].(map[string]any)["status"] != "duplicate" {
			t.Fatalf("a resent row with a fresh opId should be a duplicate: %s", out.Raw)
		}
	})

	t.Run("the read-only half of the protocol is refused with its reason", func(t *testing.T) {
		for _, entity := range []string{"weekPrice", "plot", "crop", "settlement"} {
			out := push(f.OwnerToken, []map[string]any{
				{"opId": uuid.NewString(), "entity": entity, "op": "upsert",
					"payload": map[string]any{"id": uuid.NewString()}},
			})
			rows, _ := out.Body["results"].([]any)
			row := rows[0].(map[string]any)
			if row["status"] != "rejected" {
				t.Fatalf("%s is read-only on the handset and must not be silently accepted: %s",
					entity, out.Raw)
			}
		}
	})

	t.Run("a devengo cannot be pushed", func(t *testing.T) {
		out := push(f.OwnerToken, []map[string]any{
			{"opId": uuid.NewString(), "entity": "ledgerEntry", "op": "append", "payload": map[string]any{
				"id": uuid.NewString(), "workerId": workerID, "kind": "devengo",
				"amountCents": 100, "date": "2026-08-24",
			}},
		})
		rows, _ := out.Body["results"].([]any)
		if rows[0].(map[string]any)["status"] != "rejected" {
			t.Fatalf("a handset that could write an earning could pay a week the server "+
				"never agreed to: %s", out.Raw)
		}
	})

	t.Run("outgoing money is taken without a balance check", func(t *testing.T) {
		// §2.3. Cash left somebody's pocket; refusing its arrival does not undo
		// the fact, it only makes the database lie. The balance goes negative
		// and the excess behaves as an advance, exactly as on the handset.
		bal := h.mustDo(t, http.MethodGet, "/v1/workers/"+workerID+"/balance",
			f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, bal.Body, "balanceCents"); got != -5_000_000 {
			t.Fatalf("balance after an advance of 5 000 000 is %d, want -5000000: %s", got, bal.Raw)
		}
	})

	t.Run("a batch over the ceiling is refused as a batch", func(t *testing.T) {
		ops := make([]map[string]any, 0, 201)
		for i := 0; i < 201; i++ {
			ops = append(ops, map[string]any{
				"opId": uuid.NewString(), "entity": "worker", "op": "upsert",
				"payload": map[string]any{"id": uuid.NewString(), "name": "X"},
			})
		}
		out := push(f.OwnerToken, ops)
		if out.Status != http.StatusBadRequest {
			t.Fatalf("201 envelopes: got %d, want 400: %s", out.Status, out.Raw)
		}
	})
}

func TestPullIsAFeedAndTheWeigherGetsNoMoneyOutOfIt(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del feed", 80000)
	worker := h.createWorker(t, f, "Feed", "6006006006")
	h.createPlot(t, f, "Lote feed")
	activity := h.harvestActivityID(t, f)
	h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 100)
	settlementID := h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated).Body["id"].(string)

	res := h.mustDo(t, http.MethodGet, "/v1/sync/pull?cursor=0", f.OwnerToken, nil, http.StatusOK)
	changes, _ := res.Body["changes"].([]any)
	if len(changes) == 0 {
		t.Fatalf("cursor 0 has to be a full bootstrap, never an empty farm: %s", res.Raw)
	}

	byEntity := map[string][]map[string]any{}
	var lastSeq int64
	for _, raw := range changes {
		row := raw.(map[string]any)
		seq := int64(row["seq"].(float64))
		if seq <= lastSeq {
			t.Fatalf("the feed came back out of order at seq %d", seq)
		}
		lastSeq = seq
		e := row["entity"].(string)
		byEntity[e] = append(byEntity[e], row["row"].(map[string]any))
	}

	for _, want := range []string{"farmConfig", "worker", "plot", "crop", "workRecord",
		"settlement", "ledgerEntry"} {
		if len(byEntity[want]) == 0 {
			t.Fatalf("the feed carries no %s; the handset would never learn about it", want)
		}
	}

	t.Run("a settlement travels whole, with its lines", func(t *testing.T) {
		// Never a header without its rows: a document for millions with
		// nothing underneath it is what user_version = 4 existed to repair.
		var found map[string]any
		for _, s := range byEntity["settlement"] {
			if s["id"] == settlementID {
				found = s
			}
		}
		if found == nil {
			t.Fatalf("the settlement is not in the feed")
		}
		items, _ := found["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("the settlement travelled without its lines: %v", found)
		}
		if int64(found["grossCents"].(float64)) != 8_000_000 {
			t.Fatalf("the settlement's gross came down wrong: %v", found)
		}
	})

	t.Run("balances arrive only in the last batch, and as a checksum", func(t *testing.T) {
		if res.Body["more"] != false {
			t.Fatalf("expected the whole feed in one batch here")
		}
		balances, ok := res.Body["balances"].([]any)
		if !ok || len(balances) == 0 {
			t.Fatalf("the last batch carries the balances checksum: %s", res.Raw)
		}
		// And not in a batch that is not the last.
		partial := h.mustDo(t, http.MethodGet, "/v1/sync/pull?cursor=0&limit=1",
			f.OwnerToken, nil, http.StatusOK)
		if partial.Body["more"] != true {
			t.Fatalf("limit=1 should leave more to come: %s", partial.Raw)
		}
		if _, present := partial.Body["balances"]; present {
			t.Fatalf("a total compared against a half-applied feed reports a mismatch "+
				"that is not one: %s", partial.Raw)
		}
	})

	t.Run("the weigher's feed carries no money, and his cursor still moves", func(t *testing.T) {
		w := h.mustDo(t, http.MethodGet, "/v1/sync/pull?cursor=0", f.WeigherToken, nil, http.StatusOK)
		rows, _ := w.Body["changes"].([]any)
		for _, raw := range rows {
			row := raw.(map[string]any)
			switch row["entity"] {
			case "settlement", "ledgerEntry":
				t.Fatalf("the weigher received %v: %s", row["entity"], w.Raw)
			}
		}
		if _, present := w.Body["balances"]; present {
			t.Fatalf("the weigher received the balances: %s", w.Raw)
		}
		// The cursor is the whole point: stranded behind the first payroll of
		// the season it would never move again.
		if mustInt(t, w.Body, "cursor") < lastSeq {
			t.Fatalf("the weigher's cursor stopped at %d, the feed is at %d: %s",
				mustInt(t, w.Body, "cursor"), lastSeq, w.Raw)
		}
	})

	t.Run("the cursor advances and a second pull is empty", func(t *testing.T) {
		cursor := mustInt(t, res.Body, "cursor")
		next := h.mustDo(t, http.MethodGet,
			"/v1/sync/pull?cursor="+strconv.FormatInt(cursor, 10), f.OwnerToken, nil, http.StatusOK)
		rows, _ := next.Body["changes"].([]any)
		if len(rows) != 0 {
			t.Fatalf("nothing changed and the feed returned %d rows: %s", len(rows), next.Raw)
		}
	})

	t.Run("a cursor older than the retained feed says so instead of skipping the gap", func(t *testing.T) {
		// Retention has not pruned anything on this farm, so the gap is
		// simulated the only honest way: by pruning.
		//
		// Three things here were wrong for a long time and none of them was
		// visible, because the assertion passed for an unrelated reason. The
		// DELETE ran on `h.admin` rather than on `tx`, so it was a different
		// session; it never set `app.sync_prune`, which migration 00014 makes
		// the ONE exception the append-only trigger honours and which must be
		// set on the same session; and `withTenantCommit`'s error was thrown
		// away, so the refusal was silent. Nothing was ever pruned.
		//
		// What made it green: `seq` is one global bigserial for the whole
		// table, so in a full-package run this farm is created late, MIN(seq)
		// is large, and `cursor=1` is legitimately too old. Run the package
		// with a -run filter and MIN(seq) is 2, `1 < 1` is false, and the
		// endpoint answers 200 with every row still there. Measured, exactly
		// that: `got 200 {... "changes":[{"seq":2 ...}], "cursor":8}`.
		//
		// So this test asserted nothing about retention on any PR that ever
		// ran it.
		// And it has to run the way the prune job runs: one transaction on the
		// SCHEMA OWNER's pool, with `app.sync_prune` set LOCAL on that same
		// transaction. Not the tenant pool -- `bascula_api` carries the REVOKE
		// and answers `permission denied for table sync_log`, so the trigger's
		// exception is not even reachable from there. Measured while fixing
		// this, which is the other half of why the original never pruned.
		before := h.oldestSeq(t, f.FarmID)
		h.pruneSyncLog(t, f.FarmID)

		// And it actually removed rows, rather than reporting success over a
		// DELETE that matched nothing.
		after := h.oldestSeq(t, f.FarmID)
		if after <= before {
			t.Fatalf("the oldest retained seq did not move: %d -> %d", before, after)
		}

		// Now the cursor is below the retained feed BECAUSE of retention, not
		// because of where the global sequence happened to land. `cursor=1` is
		// kept only when it is genuinely below `oldest-1`; otherwise the
		// assertion would be about the boundary's arithmetic again.
		cursor := after - 2
		if cursor < 1 {
			cursor = 1
		}
		if cursor >= after-1 {
			t.Fatalf("not enough was pruned to put a cursor below the feed: oldest=%d", after)
		}
		out := h.do(t, http.MethodGet,
			"/v1/sync/pull?cursor="+strconv.FormatInt(cursor, 10), f.OwnerToken, nil)
		if out.code() != string(domain.CodeCursorTooOld) {
			t.Fatalf("a cursor below the retained feed: got %d %s, want CURSOR_TOO_OLD",
				out.Status, out.Raw)
		}
	})
}

// ---------------------------------------------------------------------------
// §8 phases 3–4 — the season that already exists on a handset
// ---------------------------------------------------------------------------

// TestTheSeasonOnTheHandsetMovesWithoutChangingAnIdentifier is the one that
// unblocks everything else: until the history is here, a settlement created on
// the server would claim payables the server has never seen.
func TestTheSeasonOnTheHandsetMovesWithoutChangingAnIdentifier(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la temporada", 80000)

	device := uuid.NewString()
	ana := uuid.NewString()
	juan := uuid.NewString()
	crop := uuid.NewString()
	pickA := uuid.NewString() // Ana, settled
	pickB := uuid.NewString() // Ana, still pending
	pickJuan := uuid.NewString()
	settlement := uuid.NewString()
	earning := uuid.NewString()
	payment := uuid.NewString()
	advance := uuid.NewString()

	// Ana: 100 kg at 80 000 = 8 000 000 earned, 3 000 000 paid.
	// Juan: nothing settled, one advance of 500 000 against him.
	season := map[string]any{
		"deviceId": device,
		"workers": []map[string]any{
			{"id": ana, "name": "Ana", "lastName": "Rodríguez", "documentType": "CC", "docId": "1098111111"},
			{"id": juan, "name": "Juan", "documentType": "CC", "docId": "1098222222"},
		},
		"plots": []map[string]any{
			{"cropId": crop, "name": "Lote 1", "cropType": "Cafe", "variety": "Castillo"},
		},
		"weekPrices": []map[string]any{
			{"weekStart": "2026-08-24", "priceCents": 80000},
		},
		"workRecords": []map[string]any{
			{"id": pickA, "workerId": ana, "cropId": crop, "quantity": 100,
				"occurredAt": "2026-08-25T14:00:00-05:00", "deviceId": device},
			{"id": pickB, "workerId": ana, "cropId": crop, "quantity": 40,
				"occurredAt": "2026-08-27T14:00:00-05:00", "deviceId": device},
			{"id": pickJuan, "workerId": juan, "cropId": crop, "quantity": 10,
				"occurredAt": "2026-08-26T14:00:00-05:00", "deviceId": device},
		},
		"settlements": []map[string]any{
			{"id": settlement, "workerId": ana, "periodStart": "2026-08-24",
				"periodEnd": "2026-08-30", "grossCents": 8000000, "status": "open",
				"items": []map[string]any{
					{"payableId": pickA, "weekStart": "2026-08-24", "quantity": 100,
						"priceCents": 80000, "amountCents": 8000000},
				}},
		},
		"ledger": []map[string]any{
			{"id": earning, "workerId": ana, "kind": "devengo", "amountCents": 8000000,
				"date": "2026-08-30", "settlementId": settlement},
			{"id": payment, "workerId": ana, "kind": "pago", "amountCents": -3000000,
				"date": "2026-08-30", "method": "efectivo"},
			{"id": advance, "workerId": juan, "kind": "anticipo", "amountCents": -500000,
				"date": "2026-08-26", "method": "efectivo"},
		},
		"balances": []map[string]any{
			{"workerId": ana, "balanceCents": 5000000},
			{"workerId": juan, "balanceCents": -500000},
		},
	}

	report := h.mustDo(t, http.MethodPost, "/v1/import/season", f.OwnerToken, season, http.StatusOK)
	if got := mustInt(t, report.Body["workRecords"].(map[string]any), "written"); got != 3 {
		t.Fatalf("wrote %d weighings, want 3: %s", got, report.Raw)
	}
	if got := mustInt(t, report.Body, "balancesChecked"); got != 2 {
		t.Fatalf("checked %d balances, want 2: %s", got, report.Raw)
	}

	t.Run("the handset's uuids are the server's ids", func(t *testing.T) {
		// Not "the same data" — the SAME IDENTIFIERS. The whole point is that
		// settlement_items.payable_id still points at the weighing's own uuid,
		// so the anti double-pay lock protects the imported history from the
		// first day rather than from a remapping script.
		h.mustDo(t, http.MethodGet, "/v1/workers/"+ana, f.OwnerToken, nil, http.StatusOK)
		h.mustDo(t, http.MethodGet, "/v1/work-records/"+pickA, f.OwnerToken, nil, http.StatusOK)
		got := h.mustDo(t, http.MethodGet, "/v1/settlements/"+settlement, f.OwnerToken, nil, http.StatusOK)
		items, _ := got.Body["items"].([]any)
		if len(items) != 1 || items[0].(map[string]any)["payableId"] != pickA {
			t.Fatalf("the money was remapped: %s", got.Raw)
		}
	})

	t.Run("the derived balance comes out to the cent", func(t *testing.T) {
		bal := h.mustDo(t, http.MethodGet, "/v1/workers/"+ana+"/balance",
			f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, bal.Body, "balanceCents"); got != 5_000_000 {
			t.Fatalf("Ana's balance is %d, want 5000000: %s", got, bal.Raw)
		}
	})

	t.Run("the imported lock holds: the settled weighing is not pending", func(t *testing.T) {
		pending := h.mustDo(t, http.MethodGet,
			"/v1/pending?workerId="+ana+"&from=2026-08-24&to=2026-08-30",
			f.OwnerToken, nil, http.StatusOK)
		items, _ := pending.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("want exactly the unsettled weighing pending, got %d: %s", len(items), pending.Raw)
		}
		if items[0].(map[string]any)["payableId"] != pickB {
			t.Fatalf("the wrong weighing is pending: %s", pending.Raw)
		}
	})

	t.Run("running it again writes nothing and refuses nothing", func(t *testing.T) {
		// Phase 3 is meant to be run over and over against a copy until it
		// comes out clean, and phase 4 has to survive a dropped connection.
		again := h.mustDo(t, http.MethodPost, "/v1/import/season", f.OwnerToken, season, http.StatusOK)
		for _, table := range []string{"workers", "workRecords", "settlements", "ledger", "crops"} {
			counts := again.Body[table].(map[string]any)
			if mustInt(t, counts, "written") != 0 {
				t.Fatalf("the re-run wrote %v rows into %s: %s", counts["written"], table, again.Raw)
			}
		}
		bal := h.mustDo(t, http.MethodGet, "/v1/workers/"+ana+"/balance",
			f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, bal.Body, "balanceCents"); got != 5_000_000 {
			t.Fatalf("the re-run moved the balance to %d", got)
		}
	})

	t.Run("and the imported season is now settleable on the server", func(t *testing.T) {
		// This is what the import was for. 40 kg at 80 000.
		res := h.mustSettle(t, f.OwnerToken, map[string]any{
			"workerId": ana, "from": "2026-08-24", "to": "2026-08-30",
		}, http.StatusCreated)
		if got := mustInt(t, res.Body, "grossCents"); got != 3_200_000 {
			t.Fatalf("settling the rest grosses %d, want 3200000: %s", got, res.Raw)
		}
	})
}

// TestAnImportThatDoesNotReconcileWritesNothingAtAll is the property that makes
// the endpoint safe to point at production at all.
func TestAnImportThatDoesNotReconcileWritesNothingAtAll(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del descuadre", 80000)

	worker := uuid.NewString()
	entry := uuid.NewString()

	res := h.do(t, http.MethodPost, "/v1/import/season", f.OwnerToken, map[string]any{
		"deviceId": uuid.NewString(),
		"workers": []map[string]any{
			{"id": worker, "name": "Descuadrada", "documentType": "CC", "docId": "1098333333"},
		},
		"ledger": []map[string]any{
			{"id": entry, "workerId": worker, "kind": "anticipo",
				"amountCents": -700000, "date": "2026-08-26", "method": "efectivo"},
		},
		// The handset says the balance is one peso off what the ledger above
		// derives. One cent is enough.
		"balances": []map[string]any{
			{"workerId": worker, "balanceCents": -700001},
		},
	})
	if res.code() != string(domain.CodeImportMismatch) {
		t.Fatalf("a balance that does not reconcile: got %d %s, want IMPORT_MISMATCH",
			res.Status, res.Raw)
	}
	errObj, _ := res.Body["error"].(map[string]any)
	details, _ := errObj["details"].(map[string]any)
	rows, _ := details["balances"].([]any)
	if len(rows) != 1 {
		t.Fatalf("the refusal has to name the worker who does not add up: %s", res.Raw)
	}
	row := rows[0].(map[string]any)
	if row["workerId"] != worker || int64(row["differenceCents"].(float64)) != 1 {
		t.Fatalf("the difference is not reported: %s", res.Raw)
	}

	// Nothing at all. Not the ledger, not even the worker written three
	// hundred lines earlier: a 4xx never commits.
	if got := h.do(t, http.MethodGet, "/v1/workers/"+worker, f.OwnerToken, nil); got.Status != http.StatusNotFound {
		t.Fatalf("a refused import left rows behind: %d %s", got.Status, got.Raw)
	}

	t.Run("a file with no balances is refused before it writes anything", func(t *testing.T) {
		out := h.do(t, http.MethodPost, "/v1/import/season", f.OwnerToken, map[string]any{
			"deviceId": uuid.NewString(),
			"workers": []map[string]any{
				{"id": uuid.NewString(), "name": "Sin comprobacion"},
			},
		})
		if out.Status != http.StatusBadRequest {
			t.Fatalf("an import with no reconciliation: got %d %s, want 400", out.Status, out.Raw)
		}
	})

	t.Run("an administrator cannot import a season", func(t *testing.T) {
		out := h.do(t, http.MethodPost, "/v1/import/season", f.AdminToken,
			map[string]any{"deviceId": uuid.NewString(), "balances": []map[string]any{}})
		if out.Status != http.StatusForbidden {
			t.Fatalf("import is the owner's alone: got %d %s", out.Status, out.Raw)
		}
	})
}

// TestTheWeigherCanSynchroniseHisOwnWork is the path that actually matters in
// the field: the person who spends days without signal is the weigher, and a
// handset that cannot push is a scale whose day is stuck in a phone.
//
// He pushes weighings and he pulls references. What he must not get is
// anybody's money, and that is checked in the pull test above.
func TestTheWeigherCanSynchroniseHisOwnWork(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del pesador", 80000)
	worker := h.createWorker(t, f, "Pesado", "8008008008")
	device := uuid.NewString()
	record := uuid.NewString()

	res := h.mustDo(t, http.MethodPost, "/v1/sync/push", f.WeigherToken, map[string]any{
		"deviceId": device,
		"ops": []map[string]any{
			{"opId": uuid.NewString(), "entity": "workRecord", "op": "upsert", "payload": map[string]any{
				"id": record, "workerId": worker, "quantity": 33.5,
				"occurredAt": "2026-08-25T09:15:00-05:00", "deviceId": device,
			}},
		},
	}, http.StatusOK)
	rows, _ := res.Body["results"].([]any)
	if rows[0].(map[string]any)["status"] != "applied" {
		t.Fatalf("the weigher could not push a weighing: %s", res.Raw)
	}

	// And the money half is still closed to him, through the ordinary door as
	// well as through the feed.
	out := h.do(t, http.MethodPost, "/v1/sync/push", f.WeigherToken, map[string]any{
		"deviceId": device,
		"ops": []map[string]any{
			{"opId": uuid.NewString(), "entity": "ledgerEntry", "op": "append", "payload": map[string]any{
				"id": uuid.NewString(), "workerId": worker, "kind": "pago",
				"amountCents": 1000, "date": "2026-08-25", "method": "efectivo",
			}},
		},
	})
	rows, _ = out.Body["results"].([]any)
	row := rows[0].(map[string]any)
	if row["status"] != "rejected" {
		t.Fatalf("a weigher pushed a payment: %s", out.Raw)
	}
	// And it is FORBIDDEN and not INTERNAL. The difference is what the handset
	// does next: §4.3 retries an INTERNAL with backoff for ever, and a handset
	// retrying a forbidden write until the battery dies is worse than the
	// refusal itself.
	if row["error"].(map[string]any)["code"] != string(domain.CodeForbidden) {
		t.Fatalf("the refusal has to tell the handset to stop, not to retry: %s", out.Raw)
	}
}
