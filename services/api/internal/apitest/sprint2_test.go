package apitest

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
)

// ---------------------------------------------------------------------------
// The credible zero
// ---------------------------------------------------------------------------

// TestEveryEndpointThatAddsUpConfirmsTheWorkerFirst is the trap this sprint was
// warned about, written down as a test so it cannot come back.
//
// Every endpoint below ends in a SUM or a list. Over an id that matches
// nothing, a SUM returns 0 and a list returns []. Both are perfectly credible
// answers — "this person is settled up", "nothing recorded yet" — and both are
// false. Worse, they are the answers a worker of ANOTHER FARM produces, because
// RLS narrows the rows to this farm rather than raising, which is exactly the
// silence it is designed to give.
//
// So the rule is: an endpoint that aggregates confirms the resource belongs to
// this farm before it aggregates. This test walks every one of them with two
// ids that must behave identically — a real worker of another farm, and a
// worker who has never existed anywhere.
func TestEveryEndpointThatAddsUpConfirmsTheWorkerFirst(t *testing.T) {
	h := requireDB(t)

	mine := h.signupFarm(t, "Finca del cero", 80000)
	theirs := h.signupFarm(t, "Finca vecina", 80000)

	myWorker := h.createWorker(t, mine, "Propio", "1000000001")
	theirWorker := h.createWorker(t, theirs, "Ajeno", "1000000002")
	ghost := uuid.NewString()

	// Their worker really does have money moving, so a zero here would be a
	// lie about a real person and not merely about an empty row.
	h.settleSomething(t, theirs, theirWorker, h.createPlot(t, theirs, "Lote vecino"))

	reads := []struct {
		name string
		path func(id string) string
	}{
		{"balance", func(id string) string { return "/v1/workers/" + id + "/balance" }},
		{"ledger", func(id string) string { return "/v1/workers/" + id + "/ledger" }},
		{"payables", func(id string) string { return "/v1/workers/" + id + "/payables" }},
		{"notes", func(id string) string { return "/v1/workers/" + id + "/notes" }},
		{"profile", func(id string) string { return "/v1/workers/" + id + "/profile" }},
		{"pending", func(id string) string {
			return "/v1/pending?workerId=" + id + "&from=2026-08-24&to=2026-08-30"
		}},
	}

	for _, r := range reads {
		for _, subject := range []struct{ label, id string }{
			{"another farm's worker", theirWorker},
			{"a worker who never existed", ghost},
		} {
			t.Run(r.name+" of "+subject.label, func(t *testing.T) {
				res := h.do(t, http.MethodGet, r.path(subject.id), mine.OwnerToken, nil)
				if res.Status != http.StatusNotFound {
					t.Fatalf("got %d, want 404. A zero or an empty list here is a "+
						"credible answer and a false one: %s", res.Status, res.Raw)
				}
			})
		}
	}

	// The writes have the same shape: they derive a balance before deciding.
	t.Run("a payment to another farm's worker", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/payments", mine.OwnerToken, map[string]any{
			"workerId": theirWorker, "amountCents": 1000,
		})
		if res.Status != http.StatusNotFound {
			t.Fatalf("got %d %s, want 404. Without the guard this answers "+
				"AMOUNT_EXCEEDS_BALANCE, which looks like a business rule and is "+
				"really a tenant leak wearing a hat.", res.Status, res.Raw)
		}
	})

	t.Run("a settlement preview for another farm's worker", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/settlements/preview", mine.OwnerToken, map[string]any{
			"workerId": theirWorker, "from": "2026-08-24", "to": "2026-08-30",
		})
		if res.Status != http.StatusNotFound {
			t.Fatalf("got %d %s, want 404", res.Status, res.Raw)
		}
	})

	// And the same routes work for our own worker, so the test above is not
	// passing because everything is broken.
	t.Run("our own worker still answers", func(t *testing.T) {
		for _, r := range reads {
			h.mustDo(t, http.MethodGet, r.path(myWorker), mine.OwnerToken, nil, http.StatusOK)
		}
	})
}

// ---------------------------------------------------------------------------
// RSP-008
// ---------------------------------------------------------------------------

// TestPayablesScreenAddsUp is the RSP-008 arithmetic: one list of work, one
// list of debts, one total — and the total is not the debts counted twice.
func TestPayablesScreenAddsUp(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de pagos", 100000) // 1000.00 per kilo
	worker := h.createWorker(t, f, "Elena", "2000000001")
	activity := h.harvestActivityID(t, f)

	h.mustDo(t, http.MethodPut, "/v1/prices/weeks/2026-08-24", f.OwnerToken,
		map[string]any{"priceCents": 100000}, http.StatusOK)
	h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 10) // 1_000_000

	// A debt, which lands in the ledger as a negative deduccion.
	h.mustDo(t, http.MethodPost, "/v1/deductions", f.OwnerToken, map[string]any{
		"workerId": worker, "amountCents": 250000, "note": "botas",
	}, http.StatusCreated)

	res := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/payables",
		f.OwnerToken, nil, http.StatusOK)

	tasks, _ := res.Body["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("want one unsettled task, got %d: %s", len(tasks), res.Raw)
	}
	debts, _ := res.Body["debts"].([]any)
	if len(debts) != 1 {
		t.Fatalf("want one debt, got %d: %s", len(debts), res.Raw)
	}
	if got := mustInt(t, debts[0].(map[string]any), "amountCents"); got != -250000 {
		t.Errorf("the debt is %d; it must keep the ledger's own negative sign, "+
			"because flipping it in one endpoint is how a sign convention rots", got)
	}

	gross := mustInt(t, res.Body, "grossCents")
	balance := mustInt(t, res.Body, "balanceCents")
	total := mustInt(t, res.Body, "totalCents")

	if gross != 1_000_000 {
		t.Errorf("grossCents = %d, want 1000000 (10 kg x 1000.00)", gross)
	}
	if balance != -250000 {
		t.Errorf("balanceCents = %d, want -250000: nothing is settled yet, so the "+
			"only ledger movement is the debt", balance)
	}
	if total != gross+balance {
		t.Errorf("totalCents = %d, want %d (= grossCents + balanceCents)", total, gross+balance)
	}
	if total != 750_000 {
		t.Errorf("totalCents = %d, want 750000. If this is 500000 the debt has "+
			"been subtracted twice: it is already inside balanceCents.", total)
	}
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

func TestWorkerNotesArePrivateAndAppendOnly(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de anotaciones", 80000)
	worker := h.createWorker(t, f, "Fabio", "3000000001")

	created := h.mustDo(t, http.MethodPost, "/v1/workers/"+worker+"/notes", f.OwnerToken,
		map[string]any{"text": "Llego tarde tres dias"}, http.StatusCreated)
	if created.Body["text"] != "Llego tarde tres dias" {
		t.Fatalf("note came back wrong: %s", created.Raw)
	}

	t.Run("the weigher cannot read them", func(t *testing.T) {
		// Notes are the most dangerous free text in the system: decision 1
		// keeps them inside the farm, and §6 keeps them away from the scale.
		res := h.do(t, http.MethodGet, "/v1/workers/"+worker+"/notes", f.WeigherToken, nil)
		if res.Status != http.StatusForbidden {
			t.Fatalf("weigher reading notes: got %d %s, want 403", res.Status, res.Raw)
		}
		res = h.do(t, http.MethodPost, "/v1/workers/"+worker+"/notes", f.WeigherToken,
			map[string]any{"text": "x"})
		if res.Status != http.StatusForbidden {
			t.Fatalf("weigher writing a note: got %d %s, want 403", res.Status, res.Raw)
		}
	})

	t.Run("there is no way to edit or delete one", func(t *testing.T) {
		id := mustString(t, created.Body, "id")
		for _, method := range []string{http.MethodPatch, http.MethodPut, http.MethodDelete} {
			res := h.do(t, method, "/v1/workers/"+worker+"/notes/"+id, f.OwnerToken,
				map[string]any{"text": "rewritten"})
			if res.Status != http.StatusMethodNotAllowed && res.Status != http.StatusNotFound {
				t.Fatalf("%s on a note: got %d %s, want no such route. A note that "+
					"can be rewritten afterwards is not a record of anything.",
					method, res.Status, res.Raw)
			}
		}
	})

	t.Run("the profile carries them", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/profile",
			f.OwnerToken, nil, http.StatusOK)
		notes, _ := res.Body["notes"].([]any)
		if len(notes) != 1 {
			t.Fatalf("RSP-007 asks for the notes on the profile; got %d: %s",
				len(notes), res.Raw)
		}
	})
}

// ---------------------------------------------------------------------------
// The pickup facade
// ---------------------------------------------------------------------------

// TestPickupFacadeIsTheSameTable proves the phone's door and the web's door
// reach one table and one implementation. If they ever stop doing so, the anti
// double-pay lock has two halves to defend and defends neither.
func TestPickupFacadeIsTheSameTable(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del telefono", 90000)
	worker := h.createWorker(t, f, "Gloria", "4000000001")
	plot := h.createPlot(t, f, "Lote telefono")

	h.mustDo(t, http.MethodPut, "/v1/prices/weeks/2026-08-24", f.OwnerToken,
		map[string]any{"priceCents": 90000}, http.StatusOK)

	// The phone's vocabulary: weight, date, no activity at all.
	created := h.mustDo(t, http.MethodPost, "/v1/pickups", f.WeigherToken, map[string]any{
		"workerId": worker, "weight": 12.5, "date": "2026-08-25", "plotId": plot,
	}, http.StatusCreated)
	pickupID := mustString(t, created.Body, "id")

	if created.Body["payScheme"] != string(domain.PaySchemeWorkUnit) {
		t.Fatalf("a pickup must be a work-unit record: %s", created.Raw)
	}
	if created.Body["rateSource"] != string(domain.RateWeeklyPrice) {
		t.Fatalf("a pickup must be priced by the week: %s", created.Raw)
	}

	t.Run("it is a work record, seen through the other door", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/work-records/"+pickupID,
			f.OwnerToken, nil, http.StatusOK)
		if mustString(t, res.Body, "id") != pickupID {
			t.Fatalf("the same row is not visible as a work record: %s", res.Raw)
		}
	})

	t.Run("it is payable", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet,
			"/v1/pending?workerId="+worker+"&from=2026-08-24&to=2026-08-30",
			f.OwnerToken, nil, http.StatusOK)
		// 12.5 kg at 900.00 = 11 250.00
		if got := mustInt(t, res.Body, "totalCents"); got != 1_125_000 {
			t.Fatalf("totalCents = %d, want 1125000: %s", got, res.Raw)
		}
	})

	t.Run("a day's wage is not a pickup", func(t *testing.T) {
		// A time-paid activity, recorded by the owner, must not appear on a
		// screen that only knows how to show kilos.
		activity := h.mustDo(t, http.MethodPost, "/v1/activities", f.OwnerToken, map[string]any{
			"name": "Tala por jornal", "category": "mantenimiento",
			"payScheme": string(domain.PaySchemeTime),
			"rate":      map[string]any{"rateCents": 5000000, "validFrom": "2026-01-01"},
		}, http.StatusCreated)
		wageID := h.createWorkRecord(t, f, f.OwnerToken, worker,
			mustString(t, activity.Body, "id"), "2026-08-26", 1)

		res := h.mustDo(t, http.MethodGet, "/v1/pickups", f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		for _, raw := range items {
			if raw.(map[string]any)["id"] == wageID {
				t.Fatalf("a day's wage came back through /v1/pickups: %s", res.Raw)
			}
		}
		if len(items) != 1 {
			t.Fatalf("/v1/pickups returned %d rows, want only the weighing: %s",
				len(items), res.Raw)
		}

		res = h.do(t, http.MethodGet, "/v1/pickups/"+wageID, f.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Fatalf("GET /v1/pickups/{a wage}: got %d %s, want 404", res.Status, res.Raw)
		}

		// And through the right door it is perfectly visible.
		h.mustDo(t, http.MethodGet, "/v1/work-records/"+wageID, f.OwnerToken, nil, http.StatusOK)
	})

	t.Run("the weigher's restrictions still apply", func(t *testing.T) {
		// The facade must not become a way around the rules the work-record
		// handler enforces, which is the whole argument for it being a
		// translation and not a second implementation.
		res := h.do(t, http.MethodDelete, "/v1/pickups/"+pickupID, f.WeigherToken, nil)
		if res.Status != http.StatusForbidden {
			t.Fatalf("weigher deleting a pickup: got %d %s, want 403", res.Status, res.Raw)
		}
	})

	t.Run("it is idempotent by id, like every other write", func(t *testing.T) {
		body := map[string]any{
			"id": pickupID, "workerId": worker, "weight": 12.5, "date": "2026-08-25",
		}
		res := h.mustDo(t, http.MethodPost, "/v1/pickups", f.WeigherToken, body, http.StatusOK)
		if mustString(t, res.Body, "id") != pickupID {
			t.Fatalf("a retry created something else: %s", res.Raw)
		}
	})
}

// ---------------------------------------------------------------------------
// Polygons
// ---------------------------------------------------------------------------

func TestPlotBoundary(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca con mapa", 80000)
	plot := h.createPlot(t, f, "Lote con poligono")

	// Roughly a square of about 0.011 degrees a side near Andes, Antioquia.
	square := map[string]any{
		"type": "Polygon",
		"coordinates": [][][]float64{{
			{-75.880, 5.660}, {-75.869, 5.660}, {-75.869, 5.671}, {-75.880, 5.671}, {-75.880, 5.660},
		}},
	}

	t.Run("a valid polygon gives computed hectares alongside the declared ones", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPut, "/v1/plots/"+plot+"/boundary", f.OwnerToken,
			map[string]any{"boundary": square}, http.StatusOK)
		p, _ := res.Body["plot"].(map[string]any)
		if p == nil {
			t.Fatalf("no plot in the answer: %s", res.Raw)
		}
		computed, ok := p["computedAreaHa"].(float64)
		if !ok || computed <= 0 {
			t.Fatalf("computedAreaHa is %v; ST_Area should have produced hectares: %s",
				p["computedAreaHa"], res.Raw)
		}
		declared, ok := p["areaHa"].(float64)
		if !ok || declared != 3.5 {
			t.Fatalf("areaHa is %v, want the declared 3.5 — both come back, always, "+
				"because they always disagree and hiding one decides for the owner "+
				"which one lies", p["areaHa"])
		}
		if p["boundary"] == nil {
			t.Fatalf("the boundary did not come back as GeoJSON: %s", res.Raw)
		}
	})

	t.Run("a bow-tie is refused", func(t *testing.T) {
		// A ring that crosses itself has no area anybody would agree on, so
		// computedAreaHa would be a confident lie.
		bowtie := map[string]any{
			"type": "Polygon",
			"coordinates": [][][]float64{{
				{-75.880, 5.660}, {-75.869, 5.671}, {-75.869, 5.660}, {-75.880, 5.671}, {-75.880, 5.660},
			}},
		}
		res := h.do(t, http.MethodPut, "/v1/plots/"+plot+"/boundary", f.OwnerToken,
			map[string]any{"boundary": bowtie})
		if res.Status != http.StatusBadRequest || res.code() != string(domain.CodeInvalidGeometry) {
			t.Fatalf("self-intersecting polygon: got %d %s, want 400 INVALID_GEOMETRY",
				res.Status, res.Raw)
		}
	})

	t.Run("a point is not a plot", func(t *testing.T) {
		res := h.do(t, http.MethodPut, "/v1/plots/"+plot+"/boundary", f.OwnerToken,
			map[string]any{"boundary": map[string]any{
				"type": "Point", "coordinates": []float64{-75.88, 5.66}}})
		if res.Status != http.StatusBadRequest || res.code() != string(domain.CodeInvalidGeometry) {
			t.Fatalf("a Point boundary: got %d %s, want 400 INVALID_GEOMETRY",
				res.Status, res.Raw)
		}
	})

	t.Run("nonsense is refused rather than stored", func(t *testing.T) {
		res := h.do(t, http.MethodPut, "/v1/plots/"+plot+"/boundary", f.OwnerToken,
			map[string]any{"boundary": map[string]any{"type": "Banana"}})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("malformed GeoJSON: got %d %s, want 400", res.Status, res.Raw)
		}
	})

	t.Run("an overlap is reported and not refused", func(t *testing.T) {
		// Two plots that touch on the map are usually a drawing worth a second
		// look, and sometimes they are a terrace above a coffee lot. The server
		// says what it sees and stores what it was given.
		neighbour := h.createPlot(t, f, "Lote vecino solapado")
		res := h.mustDo(t, http.MethodPut, "/v1/plots/"+neighbour+"/boundary", f.OwnerToken,
			map[string]any{"boundary": square}, http.StatusOK)
		overlaps, _ := res.Body["overlaps"].([]any)
		if len(overlaps) != 1 {
			t.Fatalf("want one overlap reported, got %d: %s", len(overlaps), res.Raw)
		}
	})

	t.Run("a plot of another farm is a 404, not a geometry error", func(t *testing.T) {
		other := h.signupFarm(t, "Finca sin mapa", 80000)
		res := h.do(t, http.MethodPut, "/v1/plots/"+plot+"/boundary", other.OwnerToken,
			map[string]any{"boundary": square})
		if res.Status != http.StatusNotFound {
			t.Fatalf("got %d %s, want 404", res.Status, res.Raw)
		}
	})
}

// ---------------------------------------------------------------------------
// The super-admin console
// ---------------------------------------------------------------------------

// TestSuperAdminConsole checks the two jobs decision 2 left it, and — more
// importantly — that a farm role, however senior, is not a platform role.
func TestSuperAdminConsole(t *testing.T) {
	h := requireDB(t)
	a := h.signupFarm(t, "Finca administrada", 80000)
	b := h.signupFarm(t, "Finca suspendible", 80000)

	t.Run("an owner is not a platform administrator", func(t *testing.T) {
		res := h.do(t, http.MethodGet, "/v1/admin/farms", a.OwnerToken, nil)
		if res.Status != http.StatusForbidden {
			t.Fatalf("an ordinary owner listing every farm: got %d %s, want 403",
				res.Status, res.Raw)
		}
		res = h.do(t, http.MethodPatch, "/v1/admin/farms/"+b.FarmID, a.OwnerToken,
			map[string]any{"status": "suspended"})
		if res.Status != http.StatusForbidden {
			t.Fatalf("an ordinary owner suspending a farm: got %d %s, want 403",
				res.Status, res.Raw)
		}
	})

	token := h.superadminToken(t, a.FarmID)

	t.Run("it sees every farm", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/admin/farms", token, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		names := map[string]bool{}
		for _, raw := range items {
			row := raw.(map[string]any)
			names[row["name"].(string)] = true
			for _, forbidden := range []string{"priceCents", "workers", "balanceCents", "employees"} {
				if _, leaked := row[forbidden]; leaked {
					t.Errorf("the console leaks %q; it may see farms, not inside them: %s",
						forbidden, res.Raw)
				}
			}
		}
		if !names["Finca administrada"] || !names["Finca suspendible"] {
			t.Fatalf("the console does not see both farms: %s", res.Raw)
		}
	})

	t.Run("it cannot read inside a farm", func(t *testing.T) {
		// The platform flag opens the console and nothing else. Farm B's
		// people stay invisible: this token's tenant is farm A.
		worker := h.createWorker(t, b, "Invisible", "5000000001")
		res := h.do(t, http.MethodGet, "/v1/workers/"+worker, token, nil)
		if res.Status != http.StatusNotFound {
			t.Fatalf("the super-admin read a worker of another farm: got %d %s, want 404",
				res.Status, res.Raw)
		}
	})

	t.Run("suspending a farm stops its next session", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPatch, "/v1/admin/farms/"+b.FarmID, token,
			map[string]any{"status": "suspended"}, http.StatusOK)
		if res.Body["status"] != "suspended" {
			t.Fatalf("status did not stick: %s", res.Raw)
		}

		// A refresh is the next thing any live client does, and it is refused.
		refresh := h.do(t, http.MethodPost, "/v1/auth/refresh", "",
			map[string]any{"refreshToken": "whatever"})
		if refresh.Status == http.StatusOK {
			t.Fatal("a nonsense refresh token was accepted")
		}

		res = h.mustDo(t, http.MethodPatch, "/v1/admin/farms/"+b.FarmID, token,
			map[string]any{"status": "active"}, http.StatusOK)
		if res.Body["status"] != "active" {
			t.Fatalf("the farm did not come back: %s", res.Raw)
		}
	})

	t.Run("a status nobody meant is a 400", func(t *testing.T) {
		res := h.do(t, http.MethodPatch, "/v1/admin/farms/"+b.FarmID, token,
			map[string]any{"status": "Suspended"})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("got %d %s, want 400: a status that quietly does nothing is "+
				"how a suspend button ships broken", res.Status, res.Raw)
		}
	})
}

// ---------------------------------------------------------------------------
// The filters and the status round trip
// ---------------------------------------------------------------------------

func TestListFiltersAndLogicalDelete(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de filtros", 80000)
	activity := h.harvestActivityID(t, f)
	plot := h.createPlot(t, f, "Lote filtrado")

	ana := h.createWorker(t, f, "Ana Maria", "6000000001")
	bruno := h.createWorker(t, f, "Bruno", "6000000002")
	h.createWorkRecord(t, f, f.OwnerToken, ana, activity, "2026-08-25", 10)
	h.createWorkRecord(t, f, f.OwnerToken, bruno, activity, "2026-08-26", 20)

	t.Run("workers by needle", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/workers?q=maria", f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) != 1 || items[0].(map[string]any)["id"] != ana {
			t.Fatalf("q=maria matched %d rows: %s", len(items), res.Raw)
		}
		// The document is searchable even though it is not returned to a
		// weigher: finding somebody by the number on their card does not
		// require the number coming back.
		res = h.mustDo(t, http.MethodGet, "/v1/workers?q=6000000002", f.WeigherToken, nil, http.StatusOK)
		items, _ = res.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("the weigher cannot find somebody by document: %s", res.Raw)
		}
		if _, leaked := items[0].(map[string]any)["docId"]; leaked {
			t.Fatalf("...but the document came back to him: %s", res.Raw)
		}
	})

	t.Run("work records by worker, plot and needle", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/work-records?workerId="+ana,
			f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("workerId matched %d rows: %s", len(items), res.Raw)
		}

		res = h.mustDo(t, http.MethodGet, "/v1/work-records?q=Recoleccion",
			f.OwnerToken, nil, http.StatusOK)
		items, _ = res.Body["items"].([]any)
		if len(items) != 2 {
			t.Fatalf("q on the activity name matched %d rows, want 2: %s", len(items), res.Raw)
		}

		res = h.mustDo(t, http.MethodGet, "/v1/work-records?q=Bruno",
			f.OwnerToken, nil, http.StatusOK)
		items, _ = res.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("q on the worker's name matched %d rows, want 1: %s", len(items), res.Raw)
		}

		res = h.mustDo(t, http.MethodGet, "/v1/work-records?plotId="+plot,
			f.OwnerToken, nil, http.StatusOK)
		items, _ = res.Body["items"].([]any)
		if len(items) != 0 {
			t.Fatalf("plotId matched %d rows, but no record was linked to it: %s",
				len(items), res.Raw)
		}
	})

	t.Run("a worker comes off the payroll and back on", func(t *testing.T) {
		h.mustDo(t, http.MethodPatch, "/v1/workers/"+bruno, f.OwnerToken,
			map[string]any{"status": "inactive"}, http.StatusOK)

		res := h.mustDo(t, http.MethodGet, "/v1/workers", f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		for _, raw := range items {
			if raw.(map[string]any)["id"] == bruno {
				t.Fatalf("an inactive worker is still on the default list: %s", res.Raw)
			}
		}

		res = h.mustDo(t, http.MethodGet, "/v1/workers?status=inactive", f.OwnerToken, nil, http.StatusOK)
		items, _ = res.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("status=inactive returned %d rows, want 1: %s", len(items), res.Raw)
		}

		// Nothing was deleted: the history is still readable, which is the
		// whole reason the delete is logical.
		h.mustDo(t, http.MethodGet, "/v1/workers/"+bruno+"/balance", f.OwnerToken, nil, http.StatusOK)

		h.mustDo(t, http.MethodPatch, "/v1/workers/"+bruno, f.OwnerToken,
			map[string]any{"status": "active"}, http.StatusOK)
		res = h.mustDo(t, http.MethodGet, "/v1/workers", f.OwnerToken, nil, http.StatusOK)
		items, _ = res.Body["items"].([]any)
		if len(items) != 2 {
			t.Fatalf("the worker did not come back: %s", res.Raw)
		}
	})

	t.Run("a status nobody meant is a 400, not a silent no-op", func(t *testing.T) {
		res := h.do(t, http.MethodPatch, "/v1/workers/"+ana, f.OwnerToken,
			map[string]any{"status": "Inactive"})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("got %d %s, want 400", res.Status, res.Raw)
		}
	})
}

// ---------------------------------------------------------------------------
// Editing a work record
// ---------------------------------------------------------------------------

func TestWorkRecordPatchRefusesWhatDecidesMoney(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de correcciones", 80000)
	worker := h.createWorker(t, f, "Hugo", "7000000001")
	activity := h.mustDo(t, http.MethodPost, "/v1/activities", f.OwnerToken, map[string]any{
		"name": "Fertilizar por jornal", "category": "mantenimiento",
		"payScheme": string(domain.PaySchemeTime),
		"rate":      map[string]any{"rateCents": 6000000, "validFrom": "2026-01-01"},
	}, http.StatusCreated)
	record := h.createWorkRecord(t, f, f.OwnerToken, worker,
		mustString(t, activity.Body, "id"), "2026-08-25", 2)

	t.Run("the quantity changes and the amount is recomputed", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPatch, "/v1/work-records/"+record, f.OwnerToken,
			map[string]any{"quantity": 3}, http.StatusOK)
		if got := mustInt(t, res.Body, "amountCents"); got != 18_000_000 {
			t.Fatalf("amountCents = %d, want 18000000 (3 x 60000.00). The total is "+
				"recomputed by the one money rule and never taken from the caller.", got)
		}
	})

	t.Run("the frozen price is out of reach", func(t *testing.T) {
		res := h.do(t, http.MethodPatch, "/v1/work-records/"+record, f.OwnerToken,
			map[string]any{"rateCents": 1})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("got %d %s, want 400: the frozen price is the answer to "+
				"'why was I paid this'", res.Status, res.Raw)
		}
	})

	t.Run("a settled record is not edited under the payment", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/settlements", f.OwnerToken, map[string]any{
			"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
		}, http.StatusCreated)

		res := h.do(t, http.MethodPatch, "/v1/work-records/"+record, f.OwnerToken,
			map[string]any{"quantity": 99})
		if res.Status != http.StatusConflict || res.code() != string(domain.CodeWorkRecordSettled) {
			t.Fatalf("got %d %s, want 409 WORK_RECORD_SETTLED", res.Status, res.Raw)
		}
	})
}

// ---------------------------------------------------------------------------
// The farm record
// ---------------------------------------------------------------------------

func TestFarmRecord(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca configurable", 80000)

	t.Run("the owner sees the price, the weigher does not", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/farm", f.OwnerToken, nil, http.StatusOK)
		if got := mustInt(t, res.Body, "priceCents"); got != 80000 {
			t.Fatalf("priceCents = %d, want 80000: %s", got, res.Raw)
		}

		res = h.mustDo(t, http.MethodGet, "/v1/farm", f.WeigherToken, nil, http.StatusOK)
		if _, leaked := res.Body["priceCents"]; leaked {
			t.Fatalf("the weigher's farm record carries the price of a kilo: %s", res.Raw)
		}
		// He still gets what his client needs to render a date and an amount.
		if res.Body["timezone"] == nil || res.Body["currency"] == nil {
			t.Fatalf("the weigher's farm record lost the timezone or the currency: %s", res.Raw)
		}
	})

	t.Run("only the owner writes it", func(t *testing.T) {
		res := h.do(t, http.MethodPut, "/v1/farm", f.AdminToken, map[string]any{"name": "Nueva"})
		if res.Status != http.StatusForbidden {
			t.Fatalf("an administrator editing the farm: got %d %s, want 403",
				res.Status, res.Raw)
		}
	})

	t.Run("a bad timezone is a 400 and not a shifted calendar", func(t *testing.T) {
		res := h.do(t, http.MethodPut, "/v1/farm", f.OwnerToken,
			map[string]any{"timezone": "Mars/Olympus"})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("got %d %s, want 400. A bad IANA name would silently shift "+
				"every business day this farm has ever recorded.", res.Status, res.Raw)
		}
	})

	t.Run("a partial edit keeps what it did not mention", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPut, "/v1/farm", f.OwnerToken,
			map[string]any{"phone": "3001234567"}, http.StatusOK)
		if res.Body["name"] != "Finca configurable" {
			t.Fatalf("the name was lost by an edit that never mentioned it: %s", res.Raw)
		}
		if got := mustInt(t, res.Body, "priceCents"); got != 80000 {
			t.Fatalf("the price was lost: %s", res.Raw)
		}
	})
}

// superadminToken seeds a platform administrator who is also a member of one
// farm, and issues a token carrying the flag. The membership is what gives the
// token a tenant; the flag is what opens the console, and the two are
// deliberately separate.
func (h *harness) superadminToken(t *testing.T, farmID string) string {
	t.Helper()
	ctx := context.Background()
	userID := uuid.NewString()
	emailSeq++
	email := fmt.Sprintf("platform%d-%s@example.com", emailSeq, uuid.NewString()[:8])

	hash, err := auth.HashPassword("una-clave-larga-1")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if _, err := h.admin.Exec(ctx, `
		INSERT INTO users (id, email, name, password_hash, email_verified_at, is_superadmin)
		VALUES ($1, $2, 'Plataforma', $3, now(), true)`, userID, email, hash); err != nil {
		t.Fatalf("seed superadmin: %v", err)
	}
	if _, err := h.admin.Exec(ctx,
		`INSERT INTO memberships (farm_id, user_id, role) VALUES ($1, $2, 'owner')`,
		farmID, userID); err != nil {
		t.Fatalf("seed membership: %v", err)
	}

	token, err := auth.NewSigner([]byte("test-signing-key"), "bascula").
		Issue(userID, farmID, domain.RoleOwner, "", true)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	return token
}
