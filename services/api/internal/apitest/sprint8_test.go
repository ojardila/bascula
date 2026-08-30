package apitest

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// Sprint 8: the four findings the two adversarial audits left open, and the
// debt the team opened itself while closing a fifth.
//
// Every test here is written against the script that found the fault, and its
// job is to make that script stop working. Where the script is a Python probe
// in the scratchpad, the assertion below is the same sequence through the same
// door, so the fix cannot be undone without something going red in this
// repository.

// keysOf lists a JSON object's field names in a fixed order, which is how two
// responses are compared for SHAPE rather than for content: the point of the
// signup fix is that the caller cannot tell which branch answered, and a key
// present in one answer and missing from the other tells them.
func keysOf(body map[string]any) []string {
	out := make([]string, 0, len(body))
	for k := range body {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ---------------------------------------------------------------------------
// The debt: a void settlement that still claims a weighing
// ---------------------------------------------------------------------------

// TestAVoidSettlementCannotTrapAWeighingForEver.
//
// The fix to the season import closed the door that CREATED this shape — an
// imported settlement with status `void` whose lines never got a `voidedAt` —
// and left every farm that already had one with no way out:
//
//	POST /v1/settlements/{id}/void answers 409 SETTLEMENT_ALREADY_VOID before
//	it touches a line; ux_items_payable_live holds the payable while the line
//	lives; DELETE is revoked from the application role on both tables.
//
// So the weighing was worked, could never be settled again, and did not appear in
// any pending list — because the lock said it was already claimed. That is
// somebody's day of picking, trapped.
func TestAVoidSettlementCannotTrapAWeighingForEver(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la pesada atrapada", 100000)
	worker := h.createWorker(t, f, "Atrapada", "7007007007")
	activity := h.harvestActivityID(t, f)
	record := h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 50)

	settlement := h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated).Body["id"].(string)

	// The exact damaged shape, produced the only honest way: by hand, as the
	// import used to leave it. Status void, lines alive.
	if err := h.withTenantCommit(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
		func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx,
				`UPDATE settlements SET status = 'void', voided_at = now() WHERE id = $1`,
				settlement)
			return err
		}); err != nil {
		t.Fatalf("could not stage the damaged settlement: %v", err)
	}

	t.Run("the weighing really is trapped before the release exists", func(t *testing.T) {
		// Voiding is the route that would free it, and it leaves without
		// looking at a line.
		res := h.do(t, http.MethodPost, "/v1/settlements/"+settlement+"/void", f.OwnerToken, nil)
		if res.code() != string(domain.CodeSettlementAlreadyVoid) {
			t.Fatalf("void of a void settlement: got %d %s, want SETTLEMENT_ALREADY_VOID",
				res.Status, res.Raw)
		}
		// And the payable is claimed, so nothing can pay it.
		pending := h.mustDo(t, http.MethodGet,
			"/v1/pending?workerId="+worker+"&from=2026-08-24&to=2026-08-30",
			f.OwnerToken, nil, http.StatusOK)
		items, _ := pending.Body["items"].([]any)
		if len(items) != 0 {
			t.Fatalf("the payable should still be claimed by the void settlement: %s", pending.Raw)
		}
	})

	var releaseID string
	t.Run("the owner releases it, and it is recorded", func(t *testing.T) {
		releaseID = uuid.NewString()
		res := h.mustDo(t, http.MethodPost, "/v1/settlements/"+settlement+"/release",
			f.OwnerToken, map[string]any{
				"id":     releaseID,
				"reason": "importada anulada con linea viva (auditoria API, hallazgo 3)",
			}, http.StatusCreated)

		release, _ := res.Body["release"].(map[string]any)
		if release == nil {
			t.Fatalf("no release record in the answer: %s", res.Raw)
		}
		if n, _ := release["itemsReleased"].(float64); n != 1 {
			t.Errorf("itemsReleased = %v, want 1: %s", release["itemsReleased"], res.Raw)
		}
		freed, _ := release["payableIds"].([]any)
		if len(freed) != 1 || freed[0] != record {
			t.Errorf("the record freed is not the one that was trapped: %s", res.Raw)
		}
		// The devengo the original void never reversed is reversed now: the
		// release is the second half of a void that stopped early.
		if got, _ := release["reversedCents"].(float64); int64(got) != 50*100000 {
			t.Errorf("reversedCents = %v, want %d: %s", release["reversedCents"], 50*100000, res.Raw)
		}
		if release["reason"] == "" || release["reason"] == nil {
			t.Errorf("the reason is the point of the record: %s", res.Raw)
		}
	})

	t.Run("the weighing can be paid again", func(t *testing.T) {
		pending := h.mustDo(t, http.MethodGet,
			"/v1/pending?workerId="+worker+"&from=2026-08-24&to=2026-08-30",
			f.OwnerToken, nil, http.StatusOK)
		items, _ := pending.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("the freed weighing is not payable again: %s", pending.Raw)
		}
		// And it settles, which is the whole point of freeing it.
		h.mustSettle(t, f.OwnerToken, map[string]any{
			"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
		}, http.StatusCreated)
	})

	t.Run("a resend with the same id changes nothing", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/settlements/"+settlement+"/release",
			f.OwnerToken, map[string]any{"id": releaseID, "reason": "reintento"},
			http.StatusOK)
		release, _ := res.Body["release"].(map[string]any)
		if n, _ := release["itemsReleased"].(float64); n != 1 {
			t.Errorf("a resend re-released: %s", res.Raw)
		}
		// The record kept its ORIGINAL reason. A resend is the same act, not a
		// second one that gets to rewrite the audit.
		if reason, _ := release["reason"].(string); reason == "reintento" {
			t.Errorf("the resend overwrote the recorded reason: %s", res.Raw)
		}
	})

	t.Run("releasing a live settlement is refused", func(t *testing.T) {
		other := h.signupFarm(t, "Finca del candado vivo", 100000)
		w := h.createWorker(t, other, "Viva", "7007007008")
		a := h.harvestActivityID(t, other)
		h.createWorkRecord(t, other, other.OwnerToken, w, a, "2026-08-25", 10)
		live := h.mustSettle(t, other.OwnerToken, map[string]any{
			"workerId": w, "from": "2026-08-24", "to": "2026-08-30",
		}, http.StatusCreated).Body["id"].(string)

		res := h.do(t, http.MethodPost, "/v1/settlements/"+live+"/release", other.OwnerToken,
			map[string]any{"id": uuid.NewString(), "reason": "no deberia"})
		if res.code() != string(domain.CodeSettlementNotVoid) {
			t.Fatalf("releasing a LIVE settlement would be a second door to double "+
				"payment: got %d %s, want SETTLEMENT_NOT_VOID", res.Status, res.Raw)
		}
	})

	t.Run("a settlement with nothing trapped is not a silent success", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/settlements/"+settlement+"/release",
			f.OwnerToken, map[string]any{"id": uuid.NewString(), "reason": "otra vez"})
		if res.code() != string(domain.CodeNothingToRelease) {
			t.Fatalf("a repair that repaired nothing: got %d %s, want NOTHING_TO_RELEASE",
				res.Status, res.Raw)
		}
	})

	t.Run("reason is required, and the administrator is not the owner", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/settlements/"+settlement+"/release",
			f.OwnerToken, map[string]any{"id": uuid.NewString(), "reason": "   "})
		if res.Status != http.StatusBadRequest {
			t.Errorf("a blank reason: got %d %s, want 400", res.Status, res.Raw)
		}
		for name, token := range map[string]string{
			"admin": f.AdminToken, "weigher": f.WeigherToken,
		} {
			res := h.do(t, http.MethodPost, "/v1/settlements/"+settlement+"/release",
				token, map[string]any{"id": uuid.NewString(), "reason": "x"})
			if res.Status != http.StatusForbidden {
				t.Errorf("%s releasing: got %d %s, want 403 — this puts money back "+
					"into circulation and is the owner's", name, res.Status, res.Raw)
			}
		}
	})
}

// ---------------------------------------------------------------------------
// Finding 9: what the pull skips by role never comes back
// ---------------------------------------------------------------------------

// TestAPromotedWeigherIsSentBackForWhatHisRoleWasNeverShown is t_weigher2.py's
// last section, through the same door.
//
// The pull consumes a seq even when it composes no body for it — it must, or a
// weigher's cursor would stop at the first payroll of the season — and the skip
// is permanent: sync_log gets one row per write and the ledger's trigger is
// AFTER INSERT on an append-only table, so no second event about that row will
// ever exist. Promote the weigher and his next pull answered `changes: []`,
// `behind: 0`: an incomplete book, and a server insisting it was complete.
func TestAPromotedWeigherIsSentBackForWhatHisRoleWasNeverShown(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del ascenso", 100000)
	worker := h.createWorker(t, f, "Ana", "7008008008")
	activity := h.harvestActivityID(t, f)
	h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 40)
	h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated)

	device := uuid.NewString()
	drain := func(token string, from int64) (int64, map[string]int) {
		counts := map[string]int{}
		cursor := from
		for {
			res := h.mustDo(t, http.MethodGet,
				"/v1/sync/pull?deviceId="+device+"&cursor="+strconv.FormatInt(cursor, 10),
				token, nil, http.StatusOK)
			changes, _ := res.Body["changes"].([]any)
			for _, raw := range changes {
				counts[raw.(map[string]any)["entity"].(string)]++
			}
			cursor = mustInt(t, res.Body, "cursor")
			if more, _ := res.Body["more"].(bool); !more {
				return cursor, counts
			}
		}
	}

	// The weigher catches up. He is sent no settlement and no ledger movement,
	// and his cursor moves past them all the same — which is correct, and is
	// exactly what makes the rest of this test necessary.
	cursor, asWeigher := drain(f.WeigherToken, 0)
	if asWeigher["settlement"] != 0 || asWeigher["ledgerEntry"] != 0 {
		t.Fatalf("the weigher was sent money: %v", asWeigher)
	}

	// Promote him, exactly as the console's PATCH /v1/users/{id} does, and mint
	// the token that promotion would produce.
	if _, err := h.admin.Exec(context.Background(),
		`UPDATE memberships SET role = 'admin' WHERE farm_id = $1 AND user_id = $2`,
		f.FarmID, f.WeigherID); err != nil {
		t.Fatalf("promote: %v", err)
	}
	signer := auth.NewSigner([]byte("test-signing-key"), "bascula")
	promoted, err := signer.Issue(f.WeigherID, f.FarmID, domain.RoleAdmin, device, false)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}

	t.Run("his old cursor is refused instead of answered with silence", func(t *testing.T) {
		res := h.do(t, http.MethodGet,
			"/v1/sync/pull?deviceId="+device+"&cursor="+strconv.FormatInt(cursor, 10),
			promoted, nil)
		if res.code() != string(domain.CodeReplayRequired) {
			t.Fatalf("a cursor served to a weigher, resumed by an administrator: "+
				"got %d %s, want REPLAY_REQUIRED", res.Status, res.Raw)
		}
		details, _ := res.Body["error"].(map[string]any)
		d, _ := details["details"].(map[string]any)
		if d["reason"] != store.ReplayRoleChanged {
			t.Errorf("reason = %v, want role_changed: %s", d["reason"], res.Raw)
		}
		if from, _ := d["replayFrom"].(float64); from != 0 {
			t.Errorf("replayFrom = %v, want 0: %s", d["replayFrom"], res.Raw)
		}
		// A promotion is not a reason to throw anything away: everything this
		// handset holds, the new role may still see.
		if purge, _ := d["purgeMoney"].(bool); purge {
			t.Errorf("a promotion asked the handset to drop rows it may keep: %s", res.Raw)
		}
	})

	t.Run("the handshake says the same thing, and behind is counted from 0", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/sync/handshake", promoted, map[string]any{
			"deviceId": device, "schemaVersion": 6, "cursor": cursor,
		}, http.StatusOK)
		replay, _ := res.Body["replay"].(map[string]any)
		if replay == nil || replay["required"] != true {
			t.Fatalf("the handshake reported nothing to do: %s", res.Raw)
		}
		// This is the half that made the fault invisible. `behind: 0` beside a
		// book with holes in it is the status chip telling somebody they are up
		// to date.
		if behind := mustInt(t, res.Body, "behind"); behind <= 0 {
			t.Fatalf("behind = %d for a handset that owes a full replay: %s", behind, res.Raw)
		}
	})

	t.Run("the replay delivers the money he never got", func(t *testing.T) {
		_, asAdmin := drain(promoted, 0)
		if asAdmin["settlement"] == 0 || asAdmin["ledgerEntry"] == 0 {
			t.Fatalf("the replay carried no money: %v", asAdmin)
		}
	})

	t.Run("and once he has complied, the ordinary pull works again", func(t *testing.T) {
		after, _ := drain(promoted, 0)
		res := h.mustDo(t, http.MethodGet,
			"/v1/sync/pull?deviceId="+device+"&cursor="+strconv.FormatInt(after, 10),
			promoted, nil, http.StatusOK)
		changes, _ := res.Body["changes"].([]any)
		if len(changes) != 0 {
			t.Fatalf("nothing changed and the feed returned %d rows: %s", len(changes), res.Raw)
		}
	})
}

// TestAHandsetThatChangesHandsDoesNotInheritACursor is the other half of
// finding 9: not a promotion but a new person holding the same phone.
//
// The cursor lives on the handset, so the new session presents the previous
// holder's number — and under it, everything that session was ever shown counts
// as delivered. It is also the one case where a replay is not enough on its own:
// what the previous holder downloaded is still in the phone's database.
func TestAHandsetThatChangesHandsDoesNotInheritACursor(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del telefono prestado", 100000)
	worker := h.createWorker(t, f, "Beto", "7009009009")
	activity := h.harvestActivityID(t, f)
	h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 30)
	h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated)

	device := uuid.NewString()
	signer := auth.NewSigner([]byte("test-signing-key"), "bascula")

	// The foreman's phone, caught up.
	adminSession, err := signer.Issue(f.OwnerUserID, f.FarmID, domain.RoleOwner, device, false)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	res := h.mustDo(t, http.MethodGet, "/v1/sync/pull?deviceId="+device+"&cursor=0",
		adminSession, nil, http.StatusOK)
	cursor := mustInt(t, res.Body, "cursor")

	// The same handset, the weigher's session on it.
	weigherSession, err := signer.Issue(f.WeigherID, f.FarmID, domain.RoleWeigher, device, false)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	out := h.do(t, http.MethodGet,
		"/v1/sync/pull?deviceId="+device+"&cursor="+strconv.FormatInt(cursor, 10),
		weigherSession, nil)
	if out.code() != string(domain.CodeReplayRequired) {
		t.Fatalf("a handset that changed hands resumed the previous holder's cursor: "+
			"got %d %s, want REPLAY_REQUIRED", out.Status, out.Raw)
	}
	errBody, _ := out.Body["error"].(map[string]any)
	d, _ := errBody["details"].(map[string]any)
	if d["reason"] != store.ReplayDeviceReassigned {
		t.Errorf("reason = %v, want device_reassigned: %s", d["reason"], out.Raw)
	}
	// This one MUST purge: the settlements on that phone belong to the session
	// before it, and no replay can take back what was already delivered.
	if purge, _ := d["purgeMoney"].(bool); !purge {
		t.Fatalf("the previous holder's payroll stays on the phone: %s", out.Raw)
	}

	// And the instruction survives to the pull that performs the replay, which
	// is the only moment at which dropping those rows is safe.
	done := h.mustDo(t, http.MethodGet, "/v1/sync/pull?deviceId="+device+"&cursor=0",
		weigherSession, nil, http.StatusOK)
	replay, _ := done.Body["replay"].(map[string]any)
	if replay == nil || replay["purgeMoney"] != true {
		t.Fatalf("the purge instruction did not travel with the replay: %s", done.Raw)
	}
	changes, _ := done.Body["changes"].([]any)
	for _, raw := range changes {
		switch raw.(map[string]any)["entity"] {
		case "settlement", "ledgerEntry":
			t.Fatalf("the weigher's replay carried money: %s", done.Raw)
		}
	}
}

// TestARoleChangeReachesEveryHandsetTheAccountHolds.
//
// The order is a fact about an ACCOUNT, so it has to be written onto every
// device that account reads with. Marking only the handset that noticed would
// let the phone clear the flag and leave the tablet in the office with the book
// it already had — the original fault, with one more step in front of it.
func TestARoleChangeReachesEveryHandsetTheAccountHolds(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de dos aparatos", 100000)
	worker := h.createWorker(t, f, "Cira", "7010010010")
	activity := h.harvestActivityID(t, f)
	h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-25", 20)
	h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": worker, "from": "2026-08-24", "to": "2026-08-30",
	}, http.StatusCreated)

	signer := auth.NewSigner([]byte("test-signing-key"), "bascula")
	phone, tablet := uuid.NewString(), uuid.NewString()
	weigherOn := func(device string) string {
		tok, err := signer.Issue(f.WeigherID, f.FarmID, domain.RoleWeigher, device, false)
		if err != nil {
			t.Fatalf("issue: %v", err)
		}
		return tok
	}
	cursorOf := func(token, device string) int64 {
		res := h.mustDo(t, http.MethodGet, "/v1/sync/pull?deviceId="+device+"&cursor=0",
			token, nil, http.StatusOK)
		return mustInt(t, res.Body, "cursor")
	}
	phoneCursor := cursorOf(weigherOn(phone), phone)
	tabletCursor := cursorOf(weigherOn(tablet), tablet)

	if _, err := h.admin.Exec(context.Background(),
		`UPDATE memberships SET role = 'admin' WHERE farm_id = $1 AND user_id = $2`,
		f.FarmID, f.WeigherID); err != nil {
		t.Fatalf("promote: %v", err)
	}
	adminOn := func(device string) string {
		tok, err := signer.Issue(f.WeigherID, f.FarmID, domain.RoleAdmin, device, false)
		if err != nil {
			t.Fatalf("issue: %v", err)
		}
		return tok
	}

	// The phone notices first and complies.
	if res := h.do(t, http.MethodGet,
		"/v1/sync/pull?deviceId="+phone+"&cursor="+strconv.FormatInt(phoneCursor, 10),
		adminOn(phone), nil); res.code() != string(domain.CodeReplayRequired) {
		t.Fatalf("the phone was not sent back: got %d %s", res.Status, res.Raw)
	}
	h.mustDo(t, http.MethodGet, "/v1/sync/pull?deviceId="+phone+"&cursor=0",
		adminOn(phone), nil, http.StatusOK)

	// The tablet, which was nowhere near any of that, still owes its replay.
	res := h.do(t, http.MethodGet,
		"/v1/sync/pull?deviceId="+tablet+"&cursor="+strconv.FormatInt(tabletCursor, 10),
		adminOn(tablet), nil)
	if res.code() != string(domain.CodeReplayRequired) {
		t.Fatalf("the second handset kept an incomplete book because the first one "+
			"cleared the order: got %d %s, want REPLAY_REQUIRED", res.Status, res.Raw)
	}
}

// ---------------------------------------------------------------------------
// Finding 14: suspending a farm did not stop the session already open
// ---------------------------------------------------------------------------

// TestSuspendingAFarmStopsTheSessionsAlreadyOpen.
//
// Login and refresh refused a suspended farm and nothing else did, so an access
// token minted a minute before the suspension went on working until it expired.
// Fifteen minutes of settling, paying and voiding after somebody decided the
// farm must not — longer than a payroll run.
func TestSuspendingAFarmStopsTheSessionsAlreadyOpen(t *testing.T) {
	h := requireDB(t)
	console := h.signupFarm(t, "Finca de la consola", 80000)
	victim := h.signupFarm(t, "Finca suspendida en caliente", 80000)
	worker := h.createWorker(t, victim, "Dario", "7011011011")
	activity := h.harvestActivityID(t, victim)
	h.createWorkRecord(t, victim, victim.OwnerToken, worker, activity, "2026-08-25", 10)

	// The token is minted BEFORE the suspension and never refreshed. That is
	// the whole scenario.
	live := victim.OwnerToken
	h.mustDo(t, http.MethodGet, "/v1/workers", live, nil, http.StatusOK)

	token := h.superadminToken(t, console.FarmID)
	h.mustDo(t, http.MethodPatch, "/v1/admin/farms/"+victim.FarmID, token,
		map[string]any{"status": "suspended"}, http.StatusOK)

	t.Run("the very next request is refused, on every role and every route", func(t *testing.T) {
		for _, probe := range []struct {
			method, path string
			body         any
			token        string
		}{
			{http.MethodGet, "/v1/workers", nil, live},
			{http.MethodGet, "/v1/balances", nil, live},
			{http.MethodGet, "/v1/work-records", nil, victim.WeigherToken},
			{http.MethodPost, "/v1/settlements/preview", map[string]any{
				"workerId": worker, "from": "2026-08-24", "to": "2026-08-30"}, live},
			{http.MethodPost, "/v1/payments", map[string]any{
				"workerId": worker, "amountCents": 1000}, victim.AdminToken},
			{http.MethodGet, "/v1/sync/pull?cursor=0", nil, victim.WeigherToken},
		} {
			res := h.do(t, probe.method, probe.path, probe.token, probe.body)
			if res.code() != string(domain.CodeFarmSuspended) {
				t.Errorf("%s %s on a suspended farm: got %d %s, want FARM_SUSPENDED",
					probe.method, probe.path, res.Status, res.Raw)
			}
		}
	})

	t.Run("the platform administrator can still work, or the lever is in the locked room", func(t *testing.T) {
		h.mustDo(t, http.MethodGet, "/v1/admin/farms", token, nil, http.StatusOK)
	})

	t.Run("the neighbouring farm never noticed", func(t *testing.T) {
		h.mustDo(t, http.MethodGet, "/v1/workers", console.OwnerToken, nil, http.StatusOK)
	})

	t.Run("bringing it back works on the next request too", func(t *testing.T) {
		h.mustDo(t, http.MethodPatch, "/v1/admin/farms/"+victim.FarmID, token,
			map[string]any{"status": "active"}, http.StatusOK)
		h.mustDo(t, http.MethodGet, "/v1/workers", live, nil, http.StatusOK)
	})
}

// ---------------------------------------------------------------------------
// Finding 12: the public signup was an oracle for accounts and passwords
// ---------------------------------------------------------------------------

// TestSignupIsNoLongerAnOracleAndTheCapMovedBehindASession.
//
// Same address, wrong password: 409. Same address, RIGHT password: 201, with a
// farm created. An unauthenticated caller could confirm that an address is
// registered and that a guessed password is the real one — a login without a
// login, and without any of a login's traces.
//
// The fix is not a quieter password check. It is that adding a farm to an
// account that exists is an action BY that account, and an account proves who it
// is by opening a session.
func TestSignupIsNoLongerAnOracleAndTheCapMovedBehindASession(t *testing.T) {
	h := requireDB(t)

	email := "oraculo-" + uuid.NewString() + "@example.com"
	const password = "contrasena-larga-1"
	signup := func(name, pass string) response {
		return h.do(t, http.MethodPost, "/v1/signup", "", map[string]any{
			"farm": map[string]any{"name": name, "timezone": "America/Bogota",
				"currency": "COP", "priceCents": 100000},
			"owner": map[string]any{"email": email, "name": "Duena", "password": pass},
		})
	}

	first := h.mustDo(t, http.MethodPost, "/v1/signup", "", map[string]any{
		"farm": map[string]any{"name": "Finca uno", "timezone": "America/Bogota",
			"currency": "COP", "priceCents": 100000},
		"owner": map[string]any{"email": email, "name": "Duena", "password": password},
	}, http.StatusCreated)
	verified := h.mustDo(t, http.MethodPost, "/v1/auth/verify-email", "",
		map[string]any{"token": first.Body["verificationToken"]}, http.StatusOK)
	firstFarm := mustString(t, verified.Body, "farmId")

	t.Run("the right password and a wrong one are the same answer", func(t *testing.T) {
		right := signup("Finca dos", password)
		wrong := signup("Finca dos", "esta-no-es-la-clave")
		if right.Status != wrong.Status || right.code() != wrong.code() {
			t.Fatalf("the guess is still readable off the answer:\n  right: %d %s\n  wrong: %d %s",
				right.Status, right.Raw, wrong.Status, wrong.Raw)
		}
		// And no farm was created for the correct guess.
		if _, made := right.Body["farmId"]; made {
			t.Fatalf("a farm came out of a signup that should have refused: %s", right.Raw)
		}
	})

	// The half that was still open when the two above closed: the answer no
	// longer depends on the ACCOUNT either. Same status, same keys, same time.
	t.Run("a registered address and an unknown one are the same answer", func(t *testing.T) {
		fresh := h.do(t, http.MethodPost, "/v1/signup", "", map[string]any{
			"farm": map[string]any{"name": "Finca nueva", "timezone": "America/Bogota",
				"currency": "COP", "priceCents": 100000},
			"owner": map[string]any{"email": "nadie-" + uuid.NewString() + "@example.com",
				"name": "Nadie", "password": password},
		})
		taken := signup("Finca dos", password)

		if fresh.Status != taken.Status {
			t.Fatalf("status still says whether the address is registered: %d vs %d",
				fresh.Status, taken.Status)
		}
		if fresh.Status != http.StatusCreated {
			t.Fatalf("signup answered %d: %s", fresh.Status, fresh.Raw)
		}
		if got, want := keysOf(taken.Body), keysOf(fresh.Body); !reflect.DeepEqual(got, want) {
			t.Fatalf("the two answers have different shapes: %v vs %v\n  %s\n  %s",
				got, want, taken.Raw, fresh.Raw)
		}
		if taken.Body["verificationRequired"] != true {
			t.Fatalf("a registered address got a different body: %s", taken.Raw)
		}
	})

	t.Run("nothing survives the answer that created nothing", func(t *testing.T) {
		// The branch runs the whole creation against a synthetic address so
		// that the clock cannot tell the two apart, and throws it away. If the
		// discard ever stopped working, this is where it shows: rows claiming
		// a reserved domain that no mailbox can ever answer for.
		var shadows int
		if err := h.admin.QueryRow(context.Background(),
			`SELECT count(*)::int FROM users WHERE email LIKE '%@shadow.invalid'`).
			Scan(&shadows); err != nil {
			t.Fatalf("count: %v", err)
		}
		if shadows != 0 {
			t.Fatalf("%d discarded signups were committed after all", shadows)
		}

		// And the token it echoed in development names nothing.
		tok, _ := signup("Finca dos", password).Body["verificationToken"].(string)
		if tok == "" {
			t.Fatal("development stopped echoing a token for a registered address, " +
				"which is the difference an attacker reads")
		}
		bad := h.do(t, http.MethodPost, "/v1/auth/verify-email", "",
			map[string]any{"token": tok})
		if bad.Status != http.StatusBadRequest {
			t.Fatalf("a discarded verification token verified something: %d %s",
				bad.Status, bad.Raw)
		}
	})

	t.Run("and the clock does not tell them apart either", func(t *testing.T) {
		// The disclosure this replaced was 26 ms against 2 ms: a thirteenfold
		// difference readable from anywhere on the internet, with no body to
		// read at all. The tolerance here is deliberately loose — a laptop
		// running Postgres in Docker is not a quiet machine, and a test that
		// fails on a noisy afternoon gets deleted — but it is nowhere near
		// loose enough to let that ratio back in.
		median := func(f func()) time.Duration {
			const n = 9
			out := make([]time.Duration, 0, n)
			for i := 0; i < n; i++ {
				start := time.Now()
				f()
				out = append(out, time.Since(start))
			}
			sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
			return out[n/2]
		}
		fresh := median(func() {
			h.do(t, http.MethodPost, "/v1/signup", "", map[string]any{
				"farm": map[string]any{"name": "F", "timezone": "America/Bogota",
					"currency": "COP", "priceCents": 100000},
				"owner": map[string]any{"email": "reloj-" + uuid.NewString() + "@example.com",
					"name": "N", "password": password},
			})
		})
		taken := median(func() { signup("Finca dos", password) })

		ratio := float64(fresh) / float64(taken)
		if ratio < 0.4 || ratio > 2.5 {
			t.Fatalf("the answer's timing says which branch it took: "+
				"unknown address %v, registered address %v (ratio %.2f)",
				fresh, taken, ratio)
		}
	})

	login := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": email, "password": password,
	}, http.StatusOK)
	token, _ := login.Body["accessToken"].(string)

	t.Run("a second farm is created through the session instead", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/farms", token, map[string]any{
			"name": "Finca dos", "priceCents": 90000,
		}, http.StatusCreated)
		if res.Body["role"] != string(domain.RoleOwner) {
			t.Errorf("the caller is not the owner of the farm they just made: %s", res.Raw)
		}
		newFarm, _ := res.Body["farmId"].(string)
		if newFarm == "" || newFarm == firstFarm {
			t.Fatalf("no new farm: %s", res.Raw)
		}
		// The old token still points at the old farm — the tenant travels in
		// the token and this route mints none. Logging in with the new farmId
		// is how the console switches.
		next := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": email, "password": password, "farmId": newFarm,
		}, http.StatusOK)
		if next.Body["farmId"] != newFarm {
			t.Fatalf("cannot log in to the new farm: %s", next.Raw)
		}
	})

	t.Run("the cap applies to the account, and it is a real count", func(t *testing.T) {
		// The harness caps at three, and two exist.
		h.mustDo(t, http.MethodPost, "/v1/farms", token, map[string]any{
			"name": "Finca tres", "priceCents": 90000,
		}, http.StatusCreated)
		over := h.do(t, http.MethodPost, "/v1/farms", token, map[string]any{
			"name": "Finca de mas", "priceCents": 90000,
		})
		if over.code() != string(domain.CodeFarmLimitReached) {
			t.Fatalf("the fourth farm on one account: got %d %s, want FARM_LIMIT_REACHED",
				over.Status, over.Raw)
		}
	})

	t.Run("a double click makes one farm, not two", func(t *testing.T) {
		// The account is at the cap by now, which is the point: an id that is
		// already this account's answers with the farm it named, and is not
		// refused by a limit its own first attempt filled.
		id := uuid.NewString()
		// Free a slot by using a fresh account for the click itself.
		other := h.signupFarm(t, "Finca del doble clic", 80000)
		first := h.mustDo(t, http.MethodPost, "/v1/farms", other.OwnerToken, map[string]any{
			"id": id, "name": "Finca clicada", "priceCents": 1000,
		}, http.StatusCreated)
		second := h.mustDo(t, http.MethodPost, "/v1/farms", other.OwnerToken, map[string]any{
			"id": id, "name": "Finca clicada", "priceCents": 1000,
		}, http.StatusOK)
		if first.Body["farmId"] != second.Body["farmId"] || second.Body["farmId"] != id {
			t.Fatalf("a double click made a second farm: %s / %s", first.Raw, second.Raw)
		}
		// And somebody else's id is never handed over — to an account with
		// room to spare, so it is the id and not the cap that refuses.
		stranger := h.signupFarm(t, "Finca del extrano", 80000)
		theirs := h.do(t, http.MethodPost, "/v1/farms", stranger.OwnerToken, map[string]any{
			"id": id, "name": "Ajena", "priceCents": 1000,
		})
		if theirs.code() != string(domain.CodeIdempotencyKeyReused) {
			t.Fatalf("another account's farm id: got %d %s, want IDEMPOTENCY_KEY_REUSED",
				theirs.Status, theirs.Raw)
		}
	})

	t.Run("and it needs a token", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/farms", "", map[string]any{
			"name": "Finca anonima", "priceCents": 1000,
		})
		if res.Status != http.StatusUnauthorized {
			t.Fatalf("an anonymous caller made a farm: got %d %s", res.Status, res.Raw)
		}
	})
}

// ---------------------------------------------------------------------------
// Finding 11: an absence painted as adjacency
// ---------------------------------------------------------------------------

// TestAWeekWithNoHarvestIsInTheSeriesRatherThanMissingFromIt is t_reports.py's
// first three sections.
//
// A week with no weighing at all vanished from the list, `weeksWithoutKilos`
// said 0, and the curve joined the weeks either side of it into a straight
// line — so the peak and the end-of-season warning were computed over weeks
// that are not consecutive.
func TestAWeekWithNoHarvestIsInTheSeriesRatherThanMissingFromIt(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del hueco", 100000)
	worker := h.createWorker(t, f, "Elsa", "7012012012")
	crop := h.createPlotCrop(t, f, "Lote del hueco", "Cafe")

	// Four consecutive weeks with the third one deliberately empty.
	weeks := []string{
		mondayOf(daysAgo(28)), mondayOf(daysAgo(21)),
		mondayOf(daysAgo(14)), mondayOf(daysAgo(7)),
	}
	h.seedWeighings(t, f, []weighing{
		{worker: worker, plotCrop: crop, day: weeks[0], qty: 100},
		{worker: worker, plotCrop: crop, day: weeks[1], qty: 90},
		// weeks[2]: nothing. Rain, or a lot left to rest.
		{worker: worker, plotCrop: crop, day: weeks[3], qty: 80},
	})

	type weekRow struct {
		WeekStart     string `json:"weekStart"`
		CoveredFrom   string `json:"coveredFrom"`
		CoveredTo     string `json:"coveredTo"`
		PartialWindow bool   `json:"partialWindow"`
		Finished      bool   `json:"finished"`
		PriceCents    *int64 `json:"priceCents"`
		reportTotals
	}

	t.Run("the weekly list has a row for the week nobody worked", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet,
			"/v1/reports/weeks?from="+weeks[0]+"&to="+weeks[3], f.OwnerToken, nil, http.StatusOK)
		var body struct {
			Items []weekRow `json:"items"`
		}
		if err := json.Unmarshal([]byte(res.Raw), &body); err != nil {
			t.Fatalf("decode: %v\n%s", err, res.Raw)
		}
		var empty *weekRow
		for i := range body.Items {
			if body.Items[i].WeekStart == weeks[2] {
				empty = &body.Items[i]
			}
		}
		if empty == nil {
			t.Fatalf("the empty week vanished from the list: %s", res.Raw)
		}
		if empty.Records != 0 {
			t.Errorf("records = %d for a week nobody worked", empty.Records)
		}
		// The pairing is the whole point. Zero records is a fact; null kilos is
		// the honest consequence, because "nobody picked" and "nobody wrote it
		// down" are not the same thing and this database cannot tell them apart.
		if empty.Kg != nil {
			t.Errorf("kg = %v for a week with no weighings; a 0.0 there is the "+
				"reading choosing one of two answers in silence", *empty.Kg)
		}
		// And the price of that week is still the price of that week.
		if empty.PriceCents == nil || *empty.PriceCents != f.PriceCents {
			t.Errorf("priceCents = %v for an empty week, want the standing price %d",
				empty.PriceCents, f.PriceCents)
		}
	})

	t.Run("a truncated window says which days it summed", func(t *testing.T) {
		// Three days of the first week, asked for as three days.
		from := weeks[0]
		to := isoDate(day(weeks[0]).AddDate(0, 0, 2))
		res := h.mustDo(t, http.MethodGet,
			"/v1/reports/weeks?from="+from+"&to="+to, f.OwnerToken, nil, http.StatusOK)
		var body struct {
			Items []weekRow `json:"items"`
		}
		if err := json.Unmarshal([]byte(res.Raw), &body); err != nil {
			t.Fatalf("decode: %v\n%s", err, res.Raw)
		}
		if len(body.Items) != 1 {
			t.Fatalf("want one week in a three-day window: %s", res.Raw)
		}
		row := body.Items[0]
		if !row.PartialWindow {
			t.Errorf("three days of a week came back as a whole week: %s", res.Raw)
		}
		if row.CoveredFrom != from || row.CoveredTo != to {
			t.Errorf("coveredFrom/coveredTo = %s..%s, want %s..%s",
				row.CoveredFrom, row.CoveredTo, from, to)
		}
		// A full week is not marked, or the flag would mean nothing.
		full := h.mustDo(t, http.MethodGet,
			"/v1/reports/weeks?from="+weeks[0]+"&to="+weeks[3], f.OwnerToken, nil, http.StatusOK)
		var all struct {
			Items []weekRow `json:"items"`
		}
		if err := json.Unmarshal([]byte(full.Raw), &all); err != nil {
			t.Fatalf("decode: %v\n%s", err, full.Raw)
		}
		for _, w := range all.Items {
			if w.WeekStart == weeks[1] && w.PartialWindow {
				t.Errorf("a whole week marked partial: %s", full.Raw)
			}
		}
	})

	t.Run("the curve carries the hole and counts it", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/reports/harvest-curve?weeks=26",
			f.OwnerToken, nil, http.StatusOK)
		var curve struct {
			Weeks []struct {
				WeekStart string   `json:"weekStart"`
				Kg        *float64 `json:"kg"`
				Records   int      `json:"records"`
			} `json:"weeks"`
			WeeksWithoutKilos   int `json:"weeksWithoutKilos"`
			WeeksWithoutRecords int `json:"weeksWithoutRecords"`
		}
		if err := json.Unmarshal([]byte(res.Raw), &curve); err != nil {
			t.Fatalf("decode: %v\n%s", err, res.Raw)
		}
		if curve.WeeksWithoutRecords != 1 {
			t.Errorf("weeksWithoutRecords = %d, want 1: %s", curve.WeeksWithoutRecords, res.Raw)
		}
		// The other counter keeps its own meaning: these weighings converted
		// perfectly well.
		if curve.WeeksWithoutKilos != 0 {
			t.Errorf("weeksWithoutKilos = %d, want 0: %s", curve.WeeksWithoutKilos, res.Raw)
		}
		// Contiguous, newest first: every step is exactly seven days.
		for i := 0; i+1 < len(curve.Weeks); i++ {
			a := day(curve.Weeks[i+1].WeekStart).AddDate(0, 0, 7)
			if !a.Equal(day(curve.Weeks[i].WeekStart)) {
				t.Fatalf("the series is not contiguous at %s -> %s: %s",
					curve.Weeks[i+1].WeekStart, curve.Weeks[i].WeekStart, res.Raw)
			}
		}
		var hole bool
		for _, w := range curve.Weeks {
			if w.WeekStart == weeks[2] {
				hole = true
				if w.Records != 0 || w.Kg != nil {
					t.Errorf("the empty week is not empty: %+v", w)
				}
			}
		}
		if !hole {
			t.Fatalf("the empty week is not in the curve: %s", res.Raw)
		}
	})

	t.Run("the crop's own weeks are drawn on a calendar too", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/reports/crops/"+crop+"?weeks=26",
			f.OwnerToken, nil, http.StatusOK)
		var report struct {
			ByWeek []struct {
				WeekStart string `json:"weekStart"`
				reportTotals
			} `json:"byWeek"`
		}
		if err := json.Unmarshal([]byte(res.Raw), &report); err != nil {
			t.Fatalf("decode: %v\n%s", err, res.Raw)
		}
		if len(report.ByWeek) != 4 {
			t.Fatalf("byWeek has %d weeks, want 4 with the empty one in it: %s",
				len(report.ByWeek), res.Raw)
		}
	})
}

// TestTheSeasonReadingWillNotStepOverAHole is the consequence the finding is
// actually about: `fallingWeeks` is what tells an owner his harvest is over and
// to move his crew somewhere else.
//
// Computed over the rows that survived a filter, two weeks either side of a gap
// were compared as neighbours. Here the gap is a week with no work between two
// steep falls: with the hole hidden it reads as a collapsing season, and with
// the hole visible the run stops where the evidence stops.
func TestTheSeasonReadingWillNotStepOverAHole(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la lectura", 100000)
	worker := h.createWorker(t, f, "Fabio", "7013013013")
	crop := h.createPlotCrop(t, f, "Lote de la lectura", "Cafe")

	// 1000 -> (nothing) -> 300 -> 100, newest last. Read as adjacent, the last
	// two are drops of 70% and 67%: two falls past the peak, which is the
	// sentence "your season is ending".
	h.seedWeighings(t, f, []weighing{
		{worker: worker, plotCrop: crop, day: mondayOf(daysAgo(28)), qty: 1000},
		{worker: worker, plotCrop: crop, day: mondayOf(daysAgo(14)), qty: 300},
		{worker: worker, plotCrop: crop, day: mondayOf(daysAgo(7)), qty: 100},
	})

	res := h.mustDo(t, http.MethodGet, "/v1/reports/harvest-curve?weeks=26",
		f.OwnerToken, nil, http.StatusOK)
	var curve struct {
		Shape struct {
			FallingWeeks    int  `json:"fallingWeeks"`
			WindingDown     bool `json:"windingDown"`
			ContiguousWeeks int  `json:"contiguousWeeks"`
			Peak            *struct {
				Kg        float64 `json:"kg"`
				WeekStart string  `json:"weekStart"`
			} `json:"peak"`
		} `json:"shape"`
		WeeksWithoutRecords int `json:"weeksWithoutRecords"`
	}
	if err := json.Unmarshal([]byte(res.Raw), &curve); err != nil {
		t.Fatalf("decode: %v\n%s", err, res.Raw)
	}

	// One fall is real: the 300 week to the 100 week are consecutive. The step
	// from 1000 to 300 crosses a week nobody worked, and is not evidence of
	// anything.
	if curve.Shape.FallingWeeks != 1 {
		t.Errorf("fallingWeeks = %d, want 1: the run may not step over a week "+
			"nobody worked. %s", curve.Shape.FallingWeeks, res.Raw)
	}
	if curve.Shape.WindingDown {
		t.Errorf("a season declared over on the strength of a gap: %s", res.Raw)
	}
	if curve.WeeksWithoutRecords != 1 {
		t.Errorf("weeksWithoutRecords = %d, want 1: %s", curve.WeeksWithoutRecords, res.Raw)
	}
	// And the peak stops at the same hole the run stops at, which is the half
	// of this finding that was left open.
	//
	// This assertion used to want the 1000 kg week — the one on the FAR side of
	// the gap — and it was wrong for the reason the rest of this test is right.
	// The falling run refuses to compare across a week nobody worked; the peak
	// was reading straight over it, so the same response said "your best week
	// was 1000 kg" and "I will not compare these weeks to each other" at the
	// same time. What this farm knows about its unbroken stretch is two weeks
	// long and peaks at 300; the 1000 kg week is still in `weeks` for the chart
	// to draw, and `contiguousWeeks` says how much of it the reading used.
	if curve.Shape.Peak == nil || math.Abs(curve.Shape.Peak.Kg-300) > 1e-9 {
		t.Errorf("peak = %+v, want the 300 week: the peak may not step over a "+
			"week nobody worked either. %s", curve.Shape.Peak, res.Raw)
	}
	if curve.Shape.ContiguousWeeks != 2 {
		t.Errorf("contiguousWeeks = %d, want 2 (the 300 week and the 100 week): %s",
			curve.Shape.ContiguousWeeks, res.Raw)
	}
}

var _ = time.Now
