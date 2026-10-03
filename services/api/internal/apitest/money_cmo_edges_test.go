package apitest

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// Edge paths of the money ledger that the sprint suites never walk: a
// settlement id taken by another farm, the GROSS_CHANGED details when the
// caller named a payable that is gone and two lines share a week, the
// «¿Quién recibe la plata?» rules on a team, and releases keyed by an id that
// is absent or belongs to another settlement.

// cmoWorker creates a worker with a last name, which the payment receipt
// joins onto receivedByName.
func (h *harness) cmoWorker(t *testing.T, f *farmFixture, name, lastName, docID string) string {
	t.Helper()
	res := h.mustDo(t, http.MethodPost, "/v1/workers", f.OwnerToken, map[string]any{
		"name": name, "lastName": lastName, "documentType": "CC", "docId": docID, "tag": "C" + docID,
	}, http.StatusCreated)
	id, _ := res.Body["id"].(string)
	if id == "" {
		t.Fatalf("worker create returned no id: %s", res.Raw)
	}
	return id
}

// cmoDetails digs error.details out of an error envelope.
func cmoDetails(t *testing.T, res response) map[string]any {
	t.Helper()
	e, _ := res.Body["error"].(map[string]any)
	d, _ := e["details"].(map[string]any)
	if d == nil {
		t.Fatalf("no error.details: %s", res.Raw)
	}
	return d
}

// cmoTrapSettlement settles one weighing and then leaves the settlement in the
// shape the old import produced: status void, lines alive, devengo unreversed.
func (h *harness) cmoTrapSettlement(t *testing.T, f *farmFixture, worker, from, to string) string {
	t.Helper()
	id := h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": worker, "from": from, "to": to,
	}, http.StatusCreated).Body["id"].(string)
	if err := h.withTenantCommit(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
		func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx,
				`UPDATE settlements SET status = 'void', voided_at = now() WHERE id = $1`, id)
			return err
		}); err != nil {
		t.Fatalf("stage the trapped settlement: %v", err)
	}
	return id
}

// A settlement id already used by ANOTHER farm is invisible to this one, so
// the idempotency lookup finds nothing and the INSERT's ON CONFLICT is what
// notices. That must be a refusal, never a settlement of the wrong farm handed
// back, and nothing of this farm's may be claimed by it.
func TestCmoSettlementIDTakenByAnotherFarm(t *testing.T) {
	h := requireDB(t)
	a := h.signupFarm(t, "Finca cmo A", 100000)
	b := h.signupFarm(t, "Finca cmo B", 100000)

	wa := h.createWorker(t, a, "Ana", "8100000001")
	h.createWorkRecord(t, a, a.OwnerToken, wa, h.harvestActivityID(t, a), "2026-08-25", 10)
	shared := uuid.NewString()
	h.mustSettle(t, a.OwnerToken, map[string]any{
		"id": shared, "workerId": wa, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated)

	wb := h.createWorker(t, b, "Beto", "8100000002")
	h.createWorkRecord(t, b, b.OwnerToken, wb, h.harvestActivityID(t, b), "2026-08-26", 7)
	res := h.doSettle(t, b.OwnerToken, map[string]any{
		"id": shared, "workerId": wb, "from": "2026-08-24", "to": "2026-08-30",
	})
	if res.Status != http.StatusConflict || res.code() != string(domain.CodeIdempotencyKeyReused) {
		t.Fatalf("an id another farm owns: got %d %s, want 409 IDEMPOTENCY_KEY_REUSED", res.Status, res.Raw)
	}

	// Farm B's weighing is still pending at its full price: the refusal wrote
	// no line and no devengo.
	pending := h.mustDo(t, http.MethodGet, "/v1/pending?workerId="+wb+"&from=2026-08-24&to=2026-08-30",
		b.OwnerToken, nil, http.StatusOK)
	if got := mustInt(t, pending.Body, "totalCents"); got != 7*100000 {
		t.Errorf("farm B pending after the refusal: %d, want %d", got, 7*100000)
	}
	if bal := balanceOf(t, h, b, wb); bal != 0 {
		t.Errorf("farm B balance after the refusal: %d, want 0", bal)
	}
	// Farm A's settlement is untouched and still its own.
	got := h.mustDo(t, http.MethodGet, "/v1/settlements/"+shared, a.OwnerToken, nil, http.StatusOK)
	if got.Body["workerId"] != wa || mustInt(t, got.Body, "grossCents") != 10*100000 {
		t.Errorf("farm A settlement changed: %s", got.Raw)
	}
	// And farm B cannot read it.
	if res := h.do(t, http.MethodGet, "/v1/settlements/"+shared, b.OwnerToken, nil); res.Status != http.StatusNotFound {
		t.Errorf("farm B reading farm A's settlement: %d %s", res.Status, res.Raw)
	}
}

// GROSS_CHANGED names exactly what moved: a payable the caller saw that is no
// longer pending is in removedPayableIds, a pending one it did not name is in
// addedPayableIds, and two lines in one week give ONE week at today's price.
func TestCmoGrossChangedDetailsNameTheMovedPayables(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca cmo gross", 100000)
	w := h.createWorker(t, f, "Carla", "8100000003")
	act := h.harvestActivityID(t, f)
	r1 := h.createWorkRecord(t, f, f.OwnerToken, w, act, "2026-08-24", 10)
	r2 := h.createWorkRecord(t, f, f.OwnerToken, w, act, "2026-08-26", 2.5)
	r3 := h.createWorkRecord(t, f, f.OwnerToken, w, act, "2026-08-27", 1)
	gone := uuid.NewString()

	res := h.do(t, http.MethodPost, "/v1/settlements", f.OwnerToken, map[string]any{
		"workerId": w, "from": "2026-08-24", "to": "2026-08-30",
		"payableIds": []string{r1, r2, gone}, "expectedGrossCents": 1,
	})
	if res.Status != http.StatusConflict || res.code() != string(domain.CodeGrossChanged) {
		t.Fatalf("got %d %s, want 409 GROSS_CHANGED", res.Status, res.Raw)
	}
	d := cmoDetails(t, res)
	if mustInt(t, d, "expectedCents") != 1 || mustInt(t, d, "actualCents") != 125*10000 {
		t.Errorf("figures: %v", d)
	}
	if rm, _ := d["removedPayableIds"].([]any); len(rm) != 1 || rm[0] != gone {
		t.Errorf("removedPayableIds: %v, want [%s]", d["removedPayableIds"], gone)
	}
	if ad, _ := d["addedPayableIds"].([]any); len(ad) != 1 || ad[0] != r3 {
		t.Errorf("addedPayableIds: %v, want [%s]", d["addedPayableIds"], r3)
	}
	weeks, _ := d["weeksInSettlement"].([]any)
	if len(weeks) != 1 {
		t.Fatalf("two lines in one week must give one week: %v", d["weeksInSettlement"])
	}
	wk := weeks[0].(map[string]any)
	if wk["weekStart"] != "2026-08-24" || mustInt(t, wk, "priceCents") != 100000 {
		t.Errorf("week: %v", wk)
	}
	if d["payableIdsProvided"] != true {
		t.Errorf("payableIdsProvided: %v", d["payableIdsProvided"])
	}

	// Nothing was written: all three weighings are still pending.
	p := h.mustDo(t, http.MethodGet, "/v1/pending?workerId="+w+"&from=2026-08-24&to=2026-08-30",
		f.OwnerToken, nil, http.StatusOK)
	if items, _ := p.Body["items"].([]any); len(items) != 3 {
		t.Errorf("a refused settlement claimed something: %s", p.Raw)
	}
}

// «¿Quién recibe la plata?»: the receipt names the member with their last
// name, and a worker who is not in the team on that day is refused.
func TestCmoTeamReceivedByRules(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca cmo equipos", 100000)
	member := h.cmoWorker(t, f, "Yorman", "Ruiz", "8100000004")
	outsider := h.cmoWorker(t, f, "Pedro", "Gil", "8100000005")
	team := h.createWorker(t, f, "Cuadrilla", "8100000006")
	h.mustDo(t, http.MethodPatch, "/v1/workers/"+team, f.OwnerToken,
		map[string]any{"kind": "equipo"}, http.StatusOK)
	h.mustDo(t, http.MethodPatch, "/v1/workers/"+team, f.OwnerToken, map[string]any{
		"memberIds": []string{member}, "membersFrom": daysAgo(7),
	}, http.StatusOK)

	res := h.do(t, http.MethodPost, "/v1/advances", f.OwnerToken, map[string]any{
		"workerId": team, "amountCents": 5000, "receivedBy": outsider,
	})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("receivedBy outside the team: got %d %s, want 400", res.Status, res.Raw)
	}
	if bal := balanceOf(t, h, f, team); bal != 0 {
		t.Errorf("a refused advance moved the balance: %d", bal)
	}

	adv := h.mustDo(t, http.MethodPost, "/v1/advances", f.OwnerToken, map[string]any{
		"workerId": team, "amountCents": 5000, "receivedBy": member, "method": "efectivo",
	}, http.StatusCreated)
	if mustInt(t, adv.Body, "amountCents") != -5000 {
		t.Errorf("an advance is stored negative: %s", adv.Raw)
	}
	slip := h.mustDo(t, http.MethodGet, "/v1/payments/"+mustString(t, adv.Body, "id"),
		f.OwnerToken, nil, http.StatusOK)
	if slip.Body["receivedByName"] != "Yorman Ruiz" {
		t.Errorf("receivedByName: %v, want \"Yorman Ruiz\"", slip.Body["receivedByName"])
	}
	if slip.Body["receivedBy"] != member {
		t.Errorf("receivedBy: %v", slip.Body["receivedBy"])
	}
	// The balance is the team's, not the member's.
	if bal := balanceOf(t, h, f, team); bal != -5000 {
		t.Errorf("team balance: %d, want -5000", bal)
	}
	if bal := balanceOf(t, h, f, member); bal != 0 {
		t.Errorf("member balance: %d, want 0", bal)
	}
}

// A release without an id still writes a record with an id of its own, and a
// release id that already names the release of another settlement is refused
// without freeing anything.
func TestCmoReleaseKeys(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca cmo release", 100000)
	act := h.harvestActivityID(t, f)
	w1 := h.createWorker(t, f, "Uno", "8100000007")
	w2 := h.createWorker(t, f, "Dos", "8100000008")
	h.createWorkRecord(t, f, f.OwnerToken, w1, act, "2026-08-25", 4)
	h.createWorkRecord(t, f, f.OwnerToken, w2, act, "2026-08-25", 3)
	s1 := h.cmoTrapSettlement(t, f, w1, "2026-08-24", "2026-08-30")
	s2 := h.cmoTrapSettlement(t, f, w2, "2026-08-24", "2026-08-30")

	res := h.mustDo(t, http.MethodPost, "/v1/settlements/"+s1+"/release", f.OwnerToken,
		map[string]any{"reason": "sin id"}, http.StatusCreated)
	rel, _ := res.Body["release"].(map[string]any)
	relID, _ := rel["id"].(string)
	if _, err := uuid.Parse(relID); err != nil {
		t.Fatalf("a release without a client id has no id of its own: %s", res.Raw)
	}
	if mustInt(t, rel, "reversedCents") != 4*100000 {
		t.Errorf("reversedCents: %s", res.Raw)
	}
	if bal := balanceOf(t, h, f, w1); bal != 0 {
		t.Errorf("w1 balance after the release: %d, want 0", bal)
	}

	again := h.do(t, http.MethodPost, "/v1/settlements/"+s2+"/release", f.OwnerToken,
		map[string]any{"id": relID, "reason": "otra"})
	if again.Status != http.StatusConflict || again.code() != string(domain.CodeIdempotencyKeyReused) {
		t.Fatalf("a release id of another settlement: got %d %s, want 409 IDEMPOTENCY_KEY_REUSED",
			again.Status, again.Raw)
	}
	// s2 is still trapped and its devengo still stands.
	p := h.mustDo(t, http.MethodGet, "/v1/pending?workerId="+w2+"&from=2026-08-24&to=2026-08-30",
		f.OwnerToken, nil, http.StatusOK)
	if items, _ := p.Body["items"].([]any); len(items) != 0 {
		t.Errorf("the refused release freed s2's weighing: %s", p.Raw)
	}
	if bal := balanceOf(t, h, f, w2); bal != 3*100000 {
		t.Errorf("w2 balance after the refused release: %d, want %d", bal, 3*100000)
	}
}
