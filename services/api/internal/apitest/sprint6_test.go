package apitest

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// Sprint 6: the debt declared at the close of sprint 5, paid off.
//
// Four things, in the order they mattered: the owner's decision 8, which was
// written down and not built; the settlements list; user management; and the
// retention sweep.

// ---------------------------------------------------------------------------
// 1. Decision 8 — the automatic reactivation, and the record of it
// ---------------------------------------------------------------------------

// TestDeactivatedWorkerWithNewWorkComesBackOn is the owner's decision, which
// until this sprint the server did the opposite of: the weighing entered and
// the person stayed off the payroll.
func TestDeactivatedWorkerWithNewWorkComesBackOn(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la decision 8", 80000)
	worker := h.createWorker(t, f, "Juan", "1010101010")
	device := uuid.NewString()

	// The web takes Juan off the payroll. That is a decision a person took,
	// and the row remembers who took it.
	h.mustDo(t, http.MethodPatch, "/v1/workers/"+worker, f.OwnerToken,
		map[string]any{"status": "inactive"}, http.StatusOK)
	deactivatedAt := h.workerDeletedAt(t, f, worker)
	if deactivatedAt == nil {
		t.Fatal("the worker was not deactivated at all")
	}

	// A weighing taken AFTER that, pushed from a handset.
	record := uuid.NewString()
	res := h.mustDo(t, http.MethodPost, "/v1/sync/push", f.WeigherToken, map[string]any{
		"deviceId": device,
		"ops": []map[string]any{
			{"opId": uuid.NewString(), "entity": "workRecord", "op": "upsert", "payload": map[string]any{
				"id": record, "workerId": worker, "quantity": 30,
				"occurredAt": deactivatedAt.Add(2 * time.Hour).Format(time.RFC3339),
			}},
		},
	}, http.StatusOK)
	if got := firstOpStatus(t, res); got != "applied" {
		t.Fatalf("the weighing was %s, and it has to enter either way: %s", got, res.Raw)
	}

	t.Run("the worker is active again", func(t *testing.T) {
		one := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker, f.OwnerToken, nil, http.StatusOK)
		if one.Body["deletedAt"] != nil {
			t.Fatalf("decision 8 says he comes back on by himself; he is still off: %s", one.Raw)
		}
	})

	t.Run("and it is recorded, with what caused it and from where", func(t *testing.T) {
		list := h.mustDo(t, http.MethodGet, "/v1/reactivations", f.OwnerToken, nil, http.StatusOK)
		items, _ := list.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("want exactly one reactivation on the audit, got %d: %s", len(items), list.Raw)
		}
		row := items[0].(map[string]any)
		if row["workerId"] != worker {
			t.Errorf("the audit names %v, want %s", row["workerId"], worker)
		}
		// The two things the owner's condition asks for by name.
		if row["workRecordId"] != record {
			t.Errorf("the audit does not name the labour that caused it: %s", list.Raw)
		}
		if row["deviceId"] != device {
			t.Errorf("the audit does not name the handset: %s", list.Raw)
		}
		if row["source"] != "sync" {
			t.Errorf("source is %v, want sync", row["source"])
		}
		// And the half that makes it addressed to somebody: whose decision was
		// undone.
		if row["deactivatedBy"] != f.OwnerUserID {
			t.Errorf("the audit does not say whose decision was undone: %s", list.Raw)
		}
		if row["deactivatedAt"] == nil {
			t.Errorf("the audit does not say which deactivation was undone: %s", list.Raw)
		}
	})

	t.Run("the worker profile carries it too", func(t *testing.T) {
		prof := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"/profile",
			f.OwnerToken, nil, http.StatusOK)
		items, ok := prof.Body["reactivations"].([]any)
		if !ok || len(items) != 1 {
			t.Fatalf("the RSP-007 screen does not show the reactivation: %s", prof.Raw)
		}
	})
}

// TestWorkOlderThanTheDeactivationDoesNotUndoIt is the boundary the team drew
// around decision 8 on 2026-08-29: "gana la baja".
//
// The scenario is the ordinary one, not a corner case. A handset spends the
// afternoon without signal; the web deactivates Juan at midday; at six the
// handset pushes a weighing it took at eight in the morning. The weighing is
// older than the decision, so the decision stands.
func TestWorkOlderThanTheDeactivationDoesNotUndoIt(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la baja que gana", 80000)
	worker := h.createWorker(t, f, "Juan", "2020202020")

	h.mustDo(t, http.MethodPatch, "/v1/workers/"+worker, f.OwnerToken,
		map[string]any{"status": "inactive"}, http.StatusOK)
	deactivatedAt := h.workerDeletedAt(t, f, worker)

	record := uuid.NewString()
	res := h.mustDo(t, http.MethodPost, "/v1/sync/push", f.WeigherToken, map[string]any{
		"deviceId": uuid.NewString(),
		"ops": []map[string]any{
			{"opId": uuid.NewString(), "entity": "workRecord", "op": "upsert", "payload": map[string]any{
				"id": record, "workerId": worker, "quantity": 18,
				// Taken four hours BEFORE somebody decided he was off.
				"occurredAt": deactivatedAt.Add(-4 * time.Hour).Format(time.RFC3339),
			}},
		},
	}, http.StatusOK)

	// The work is not lost. That is half the rule, and the more important half:
	// the weighing enters and the person stays inactive.
	if got := firstOpStatus(t, res); got != "applied" {
		t.Fatalf("the weighing was %s; the work registered must not be lost: %s", got, res.Raw)
	}
	one := h.mustDo(t, http.MethodGet, "/v1/workers/"+worker+"?status=all",
		f.OwnerToken, nil, http.StatusOK)
	if one.Body["deletedAt"] == nil {
		t.Fatalf("a decision a person took, after the work happened, was undone "+
			"by an automatism: %s", one.Raw)
	}

	list := h.mustDo(t, http.MethodGet, "/v1/reactivations", f.OwnerToken, nil, http.StatusOK)
	if items, _ := list.Body["items"].([]any); len(items) != 0 {
		t.Fatalf("nothing was reactivated, so nothing may be on the audit: %s", list.Raw)
	}
}

// TestReactivationAuditIsNarrowedToThisFarm keeps the audit from becoming the
// one place a farm can read another farm's personnel decisions.
func TestReactivationAuditIsNarrowedToThisFarm(t *testing.T) {
	h := requireDB(t)
	a := h.signupFarm(t, "Finca A del audit", 80000)
	b := h.signupFarm(t, "Finca B del audit", 90000)
	theirs := h.createWorker(t, b, "Ajeno", "3030303030")

	res := h.do(t, http.MethodGet, "/v1/reactivations?workerId="+theirs, a.OwnerToken, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("filtering by another farm's worker: got %d, want 404 — an empty "+
			"list would read as \"nothing was reactivated for this person\": %s",
			res.Status, res.Raw)
	}
}

// ---------------------------------------------------------------------------
// 2. GET /v1/settlements
// ---------------------------------------------------------------------------

func TestListSettlements(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de las liquidaciones", 80000)
	activity := h.harvestActivityID(t, f)
	plot := h.createPlot(t, f, "Lote liquidaciones")
	_ = plot

	ana := h.createWorker(t, f, "Ana", "4040404040")
	beto := h.createWorker(t, f, "Beto", "5050505050")

	// Ana: one settlement in the week of the 24th, one in the week of the 31st.
	h.createWorkRecord(t, f, f.OwnerToken, ana, activity, "2026-08-25", 100)
	anaFirst := h.settle(t, f, ana, "2026-08-24", "2026-08-30")
	h.createWorkRecord(t, f, f.OwnerToken, ana, activity, "2026-09-01", 50)
	anaSecond := h.settle(t, f, ana, "2026-08-31", "2026-09-06")
	// Beto: one, in the first week, and then voided.
	h.createWorkRecord(t, f, f.OwnerToken, beto, activity, "2026-08-26", 80)
	betoOne := h.settle(t, f, beto, "2026-08-24", "2026-08-30")
	h.mustDo(t, http.MethodPost, "/v1/settlements/"+betoOne+"/void", f.OwnerToken,
		map[string]any{"id": uuid.NewString()}, http.StatusOK)

	t.Run("everything, newest first, with the worker's name on the row", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/settlements", f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) != 3 {
			t.Fatalf("want 3 settlements, got %d: %s", len(items), res.Raw)
		}
		if total := mustInt(t, res.Body, "total"); total != 3 {
			t.Errorf("total is %d, want 3", total)
		}
		row := items[0].(map[string]any)
		if row["workerName"] == nil || row["workerName"] == "" {
			t.Errorf("the row carries no worker name, so the console needs a "+
				"second request per row: %s", res.Raw)
		}
		if _, ok := row["itemCount"]; !ok {
			t.Errorf("the row carries no itemCount: %s", res.Raw)
		}
	})

	t.Run("by worker", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/settlements?workerId="+ana,
			f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) != 2 {
			t.Fatalf("want Ana's 2, got %d: %s", len(items), res.Raw)
		}
		for _, raw := range items {
			if raw.(map[string]any)["workerId"] != ana {
				t.Fatalf("somebody else's settlement came back: %s", res.Raw)
			}
		}
	})

	t.Run("by status", func(t *testing.T) {
		voided := h.mustDo(t, http.MethodGet, "/v1/settlements?status=void",
			f.OwnerToken, nil, http.StatusOK)
		items, _ := voided.Body["items"].([]any)
		if len(items) != 1 || items[0].(map[string]any)["id"] != betoOne {
			t.Fatalf("want only the voided one: %s", voided.Raw)
		}
		// A voided settlement's lines keep their rows. Counting them would say
		// a cancelled document still claims a weighing.
		if n := mustInt(t, items[0].(map[string]any), "itemCount"); n != 0 {
			t.Errorf("a void settlement reports %d live lines, want 0", n)
		}

		open := h.mustDo(t, http.MethodGet, "/v1/settlements?status=open",
			f.OwnerToken, nil, http.StatusOK)
		if items, _ := open.Body["items"].([]any); len(items) != 2 {
			t.Fatalf("want the 2 open ones, got %d: %s", len(items), open.Raw)
		}
	})

	t.Run("by the period covered", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet,
			"/v1/settlements?from=2026-08-24&to=2026-08-30", f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) != 2 {
			t.Fatalf("want the 2 settlements of that week, got %d: %s", len(items), res.Raw)
		}
		for _, raw := range items {
			if raw.(map[string]any)["id"] == anaSecond {
				t.Fatalf("a settlement of the following week is in range: %s", res.Raw)
			}
		}
	})

	t.Run("paged, and the total is the whole filtered set", func(t *testing.T) {
		first := h.mustDo(t, http.MethodGet, "/v1/settlements?limit=2",
			f.OwnerToken, nil, http.StatusOK)
		items, _ := first.Body["items"].([]any)
		if len(items) != 2 || mustInt(t, first.Body, "total") != 3 {
			t.Fatalf("page 1 should be 2 rows of 3: %s", first.Raw)
		}
		second := h.mustDo(t, http.MethodGet, "/v1/settlements?limit=2&offset=2",
			f.OwnerToken, nil, http.StatusOK)
		rest, _ := second.Body["items"].([]any)
		if len(rest) != 1 {
			t.Fatalf("page 2 should be the last row: %s", second.Raw)
		}
		if mustInt(t, second.Body, "total") != 3 {
			t.Errorf("the total changed between pages: %s", second.Raw)
		}

		// The page past the end. The total must still be the truth, not the
		// zero that an empty page would otherwise imply.
		past := h.mustDo(t, http.MethodGet, "/v1/settlements?limit=2&offset=10",
			f.OwnerToken, nil, http.StatusOK)
		if items, _ := past.Body["items"].([]any); len(items) != 0 {
			t.Fatalf("page 6 of a 2-page result is not empty: %s", past.Raw)
		}
		if total := mustInt(t, past.Body, "total"); total != 3 {
			t.Errorf("an empty page reports total %d; that is a guess, and it is "+
				"wrong: %s", total, past.Raw)
		}
	})

	t.Run("an unrecognised status is a 400, not an empty list", func(t *testing.T) {
		res := h.do(t, http.MethodGet, "/v1/settlements?status=Void", f.OwnerToken, nil)
		if res.Status != http.StatusBadRequest {
			t.Fatalf("got %d, want 400: a filter that quietly matches nothing is "+
				"how a screen ships broken: %s", res.Status, res.Raw)
		}
	})

	t.Run("half a range is a 400", func(t *testing.T) {
		res := h.do(t, http.MethodGet, "/v1/settlements?from=2026-08-24", f.OwnerToken, nil)
		if res.Status != http.StatusBadRequest {
			t.Fatalf("got %d, want 400: an unbounded window somebody thought they "+
				"had bounded: %s", res.Status, res.Raw)
		}
	})

	t.Run("another farm's worker is a 404", func(t *testing.T) {
		other := h.signupFarm(t, "Finca ajena de liquidaciones", 70000)
		theirs := h.createWorker(t, other, "Ajena", "6060606060")
		res := h.do(t, http.MethodGet, "/v1/settlements?workerId="+theirs, f.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Fatalf("got %d, want 404: an empty list would read as \"this person "+
				"has never been settled\": %s", res.Status, res.Raw)
		}
	})

	_ = anaFirst
}

// ---------------------------------------------------------------------------
// 3. /v1/users
// ---------------------------------------------------------------------------

func TestUserManagement(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de los usuarios", 80000)

	t.Run("the farm starts with the owner and the two seeded members", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/users", f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) != 3 {
			t.Fatalf("want owner, admin and weigher, got %d: %s", len(items), res.Raw)
		}
	})

	var invitedID, invitedEmail, invitedPassword string

	t.Run("inviting somebody hands back a password once", func(t *testing.T) {
		invitedEmail = fmt.Sprintf("pesador-%s@example.com", uuid.NewString()[:8])
		res := h.mustDo(t, http.MethodPost, "/v1/users", f.OwnerToken, map[string]any{
			"email": invitedEmail, "name": "Pesador nuevo", "role": "weigher",
		}, http.StatusCreated)
		invitedID = mustString(t, res.Body, "id")
		invitedPassword, _ = res.Body["temporaryPassword"].(string)
		if invitedPassword == "" {
			t.Fatalf("no password came back, so the administrator has nothing to "+
				"hand over and there is no mail sender: %s", res.Raw)
		}
		if res.Body["role"] != "weigher" {
			t.Errorf("role is %v, want weigher", res.Body["role"])
		}
	})

	t.Run("and that password opens a session on this farm", func(t *testing.T) {
		login := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": invitedEmail, "password": invitedPassword,
		}, http.StatusOK)
		if login.Body["farmId"] != f.FarmID {
			t.Fatalf("logged in somewhere else: %s", login.Raw)
		}
		if login.Body["role"] != "weigher" {
			t.Fatalf("logged in as %v: %s", login.Body["role"], login.Raw)
		}
	})

	t.Run("inviting the same address again is a retry, not a re-role", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/users", f.OwnerToken, map[string]any{
			"email": invitedEmail, "name": "Pesador nuevo", "role": "admin",
		}, http.StatusOK)
		if res.Body["role"] != "weigher" {
			t.Fatalf("a repeated invite silently changed the role to %v; that is a "+
				"promotion nobody asked for: %s", res.Body["role"], res.Raw)
		}
	})

	t.Run("changing a role is a PATCH", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPatch, "/v1/users/"+invitedID, f.OwnerToken,
			map[string]any{"role": "admin"}, http.StatusOK)
		if res.Body["role"] != "admin" {
			t.Fatalf("role is %v, want admin: %s", res.Body["role"], res.Raw)
		}
	})

	t.Run("nobody raises their own role", func(t *testing.T) {
		// The seeded administrator tries to make himself owner.
		me := h.mustDo(t, http.MethodGet, "/v1/me", f.AdminToken, nil, http.StatusOK)
		adminID := mustString(t, me.Body, "id")
		res := h.do(t, http.MethodPatch, "/v1/users/"+adminID, f.AdminToken,
			map[string]any{"role": "owner"})
		if res.Status != http.StatusForbidden {
			t.Fatalf("got %d, want 403: %s", res.Status, res.Raw)
		}
	})

	t.Run("nor grants one above their own, which is the same rule", func(t *testing.T) {
		// The bypass the self-check alone would leave open: promote a SECOND
		// account to owner, then log into it.
		res := h.do(t, http.MethodPatch, "/v1/users/"+invitedID, f.AdminToken,
			map[string]any{"role": "owner"})
		if res.Status != http.StatusForbidden {
			t.Fatalf("an administrator made somebody else an owner (%d); the "+
				"self-check is then a lock on a door with no wall beside it: %s",
				res.Status, res.Raw)
		}
	})

	t.Run("a user of another farm is a 404, never a role change", func(t *testing.T) {
		other := h.signupFarm(t, "Finca ajena de usuarios", 70000)
		otherMe := h.mustDo(t, http.MethodGet, "/v1/me", other.AdminToken, nil, http.StatusOK)
		res := h.do(t, http.MethodPatch, "/v1/users/"+mustString(t, otherMe.Body, "id"),
			f.OwnerToken, map[string]any{"role": "weigher"})
		if res.Status != http.StatusNotFound {
			t.Fatalf("got %d, want 404: %s", res.Status, res.Raw)
		}
	})

	t.Run("the farm keeps at least one owner", func(t *testing.T) {
		demote := h.do(t, http.MethodPatch, "/v1/users/"+f.OwnerUserID, f.OwnerToken,
			map[string]any{"role": "admin"})
		if demote.Status != http.StatusConflict || demote.code() != string(domain.CodeLastOwner) {
			t.Fatalf("demoting the last owner: got %d %s, want 409 LAST_OWNER",
				demote.Status, demote.Raw)
		}
		// Same rule on the other door.
		remove := h.do(t, http.MethodDelete, "/v1/users/"+f.OwnerUserID, f.AdminToken, nil)
		if remove.Status != http.StatusConflict || remove.code() != string(domain.CodeLastOwner) {
			t.Fatalf("removing the last owner: got %d %s, want 409 LAST_OWNER",
				remove.Status, remove.Raw)
		}
	})

	t.Run("with a second owner named, the first may step down", func(t *testing.T) {
		second := fmt.Sprintf("duena-%s@example.com", uuid.NewString()[:8])
		res := h.mustDo(t, http.MethodPost, "/v1/users", f.OwnerToken, map[string]any{
			"email": second, "name": "Segunda", "role": "owner",
		}, http.StatusCreated)
		if _, err := uuid.Parse(mustString(t, res.Body, "id")); err != nil {
			t.Fatalf("no id came back: %s", res.Raw)
		}
		down := h.mustDo(t, http.MethodPatch, "/v1/users/"+f.OwnerUserID, f.OwnerToken,
			map[string]any{"role": "admin"}, http.StatusOK)
		if down.Body["role"] != "admin" {
			t.Fatalf("role is %v: %s", down.Body["role"], down.Raw)
		}
	})

	t.Run("removing access also ends the sessions it had", func(t *testing.T) {
		// The invited account has a live refresh token from the login above.
		login := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
			"email": invitedEmail, "password": invitedPassword,
		}, http.StatusOK)
		refresh := mustString(t, login.Body, "refreshToken")

		h.mustDo(t, http.MethodDelete, "/v1/users/"+invitedID, f.OwnerToken, nil,
			http.StatusNoContent)

		after := h.do(t, http.MethodPost, "/v1/auth/refresh", "",
			map[string]any{"refreshToken": refresh})
		if after.Status == http.StatusOK {
			t.Fatalf("access was removed and the handset kept refreshing; that is "+
				"\"removed eventually\", not removed: %s", after.Raw)
		}
		list := h.mustDo(t, http.MethodGet, "/v1/users", f.OwnerToken, nil, http.StatusOK)
		if strings.Contains(list.Raw, invitedEmail) {
			t.Fatalf("the removed member is still listed: %s", list.Raw)
		}
	})

	t.Run("nobody removes their own access", func(t *testing.T) {
		me := h.mustDo(t, http.MethodGet, "/v1/me", f.AdminToken, nil, http.StatusOK)
		res := h.do(t, http.MethodDelete, "/v1/users/"+mustString(t, me.Body, "id"),
			f.AdminToken, nil)
		if res.Status != http.StatusConflict {
			t.Fatalf("got %d, want 409: locking yourself out of the farm you "+
				"administer has no undo from inside the product: %s", res.Status, res.Raw)
		}
	})

	t.Run("the weigher reaches none of it", func(t *testing.T) {
		for _, call := range []struct {
			method, path string
			body         any
		}{
			{http.MethodGet, "/v1/users", nil},
			{http.MethodPost, "/v1/users", map[string]any{"email": "x@y.z", "role": "owner"}},
			{http.MethodPatch, "/v1/users/" + f.OwnerUserID, map[string]any{"role": "weigher"}},
			{http.MethodDelete, "/v1/users/" + f.OwnerUserID, nil},
		} {
			res := h.do(t, call.method, call.path, f.WeigherToken, call.body)
			if res.Status != http.StatusForbidden {
				t.Errorf("%s %s as a weigher: got %d, want 403: %s",
					call.method, call.path, res.Status, res.Raw)
			}
		}
	})
}

// ---------------------------------------------------------------------------
// 4. The retention sweep
// ---------------------------------------------------------------------------

// TestPruneRemovesOnlySupersededFeedRows is the property the whole design of
// the sweep rests on.
//
// The feed row carries identity only; the body is composed at pull time from
// the real table. So a row that has a NEWER row for the same (farm, entity,
// row_id) carries exactly the same information as that newer row, for ever.
// Those are the rows the sweep takes, and only those — which is why cursor 0
// stays a complete bootstrap and /v1/sync/bootstrap is still not needed.
func TestPruneRemovesOnlySupersededFeedRows(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la poda", 80000)
	worker := h.createWorker(t, f, "Podado", "7070707070")
	ctx := context.Background()

	// Two aged feed rows for the same worker, written directly so they can be
	// old: the ones the trigger writes are, by construction, from today.
	old := time.Now().Add(-200 * 24 * time.Hour)
	var supersededSeq, survivingSeq int64
	for _, target := range []*int64{&supersededSeq, &survivingSeq} {
		if err := h.admin.QueryRow(ctx, `
			INSERT INTO sync_log (farm_id, entity, row_id, op, at)
			VALUES ($1, 'worker', $2, 'upsert', $3) RETURNING seq`,
			f.FarmID, worker, old).Scan(target); err != nil {
			t.Fatalf("seed feed row: %v", err)
		}
	}

	// The row the trigger wrote when the worker was created: superseded by both
	// of the above, and NOT old.
	var recentSeq int64
	if err := h.admin.QueryRow(ctx, `
		SELECT min(seq) FROM sync_log
		 WHERE farm_id = $1 AND entity = 'worker' AND row_id = $2`,
		f.FarmID, worker).Scan(&recentSeq); err != nil {
		t.Fatalf("read the trigger's row: %v", err)
	}

	rep, err := store.PruneSync(ctx, h.admin, store.SyncLogRetentionDays, store.SyncOpsRetentionDays)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if rep.SyncLogDeleted == 0 {
		t.Fatalf("the sweep took nothing at all: %s", rep)
	}

	if h.feedRowExists(t, supersededSeq) {
		t.Errorf("seq %d is old and superseded and is still there", supersededSeq)
	}
	if !h.feedRowExists(t, survivingSeq) {
		t.Errorf("seq %d is the newest row for that worker and was deleted. "+
			"Cursor 0 is no longer a complete bootstrap, and a handset pulling "+
			"from zero will conclude the farm is empty.", survivingSeq)
	}
	if !h.feedRowExists(t, recentSeq) {
		t.Errorf("seq %d is superseded but inside the retention horizon and was "+
			"deleted. The horizon is what stops a handset that was away two "+
			"weeks from being sent through a full bootstrap.", recentSeq)
	}
}

// TestPruneKeepsEveryLedgerRowInTheFeed is the consequence worth asserting on
// its own, because it is the one that would be silently wrong.
//
// Ledger feed rows are `append` and there is exactly one per entry, so none is
// ever superseded and none is ever swept — whatever the horizon says. That is
// correct rather than unfortunate: a bootstrap has to carry every movement.
func TestPruneKeepsEveryLedgerRowInTheFeed(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del libro podado", 80000)
	worker := h.createWorker(t, f, "Libro", "8080808080")
	ctx := context.Background()

	h.mustDo(t, http.MethodPost, "/v1/advances", f.OwnerToken, map[string]any{
		"id": uuid.NewString(), "workerId": worker, "amountCents": 500000,
		"date": "2026-08-25", "method": "efectivo",
	}, http.StatusCreated)

	// Age every ledger feed row of this farm past the horizon.
	if _, err := h.admin.Exec(ctx, `
		INSERT INTO sync_log (farm_id, entity, row_id, op, at)
		SELECT farm_id, 'ledgerEntry', id, 'append', now() - interval '400 days'
		  FROM ledger WHERE farm_id = $1`, f.FarmID); err != nil {
		t.Fatalf("seed aged ledger feed rows: %v", err)
	}
	var before int64
	if err := h.admin.QueryRow(ctx, `
		SELECT count(*) FROM sync_log WHERE farm_id = $1 AND entity = 'ledgerEntry'`,
		f.FarmID).Scan(&before); err != nil {
		t.Fatalf("count: %v", err)
	}

	if _, err := store.PruneSync(ctx, h.admin,
		store.SyncLogRetentionDays, store.SyncOpsRetentionDays); err != nil {
		t.Fatalf("prune: %v", err)
	}

	var after int64
	if err := h.admin.QueryRow(ctx, `
		SELECT count(*) FROM sync_log WHERE farm_id = $1 AND entity = 'ledgerEntry'`,
		f.FarmID).Scan(&after); err != nil {
		t.Fatalf("count: %v", err)
	}
	// One of the two rows for the same entry IS superseded — that is what
	// seeding a duplicate did — so exactly the duplicates go and every entry
	// keeps one row.
	var entries int64
	if err := h.admin.QueryRow(ctx,
		`SELECT count(*) FROM ledger WHERE farm_id = $1`, f.FarmID).Scan(&entries); err != nil {
		t.Fatalf("count ledger: %v", err)
	}
	if after < entries {
		t.Fatalf("the feed keeps %d rows for %d ledger entries; a bootstrap can no "+
			"longer carry every movement (was %d before the sweep)", after, entries, before)
	}
}

// TestPruneExpiresTheOperationRegistry. sync_ops is not the feed and its
// horizon is its own: it exists so that RESENDING an envelope returns the same
// answer instead of performing the act twice, and a resend thirty days after
// the fact is not a resend.
func TestPruneExpiresTheOperationRegistry(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del registro de ops", 80000)
	ctx := context.Background()

	stale, fresh := uuid.NewString(), uuid.NewString()
	for id, at := range map[string]time.Time{
		stale: time.Now().Add(-60 * 24 * time.Hour),
		fresh: time.Now(),
	} {
		if _, err := h.admin.Exec(ctx, `
			INSERT INTO sync_ops (op_id, farm_id, device_id, status, result, at)
			VALUES ($1, $2, $3, 'applied', '{}'::jsonb, $4)`,
			id, f.FarmID, uuid.NewString(), at); err != nil {
			t.Fatalf("seed op: %v", err)
		}
	}

	if _, err := store.PruneSync(ctx, h.admin,
		store.SyncLogRetentionDays, store.SyncOpsRetentionDays); err != nil {
		t.Fatalf("prune: %v", err)
	}

	if h.opExists(t, stale) {
		t.Errorf("a sixty-day-old op is still in the registry")
	}
	if !h.opExists(t, fresh) {
		t.Errorf("today's op was swept; a handset's retry would now be executed " +
			"a second time")
	}
}

// TestTheServingRoleStillCannotTouchTheFeed. The sweep needed one exception in
// the append-only trigger; this is the assertion that the exception did not
// become a door. The application role can set the flag — any session can set a
// GUC — and still cannot delete a feed row, because the REVOKE is untouched.
func TestTheServingRoleStillCannotTouchTheFeed(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del feed intacto", 80000)

	err := h.withTenantCommit(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
		func(ctx context.Context, tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SELECT set_config('app.sync_prune', 'on', true)`); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `DELETE FROM sync_log WHERE farm_id = current_farm()`)
			return err
		})
	if err == nil {
		t.Fatal("the request-serving role deleted from sync_log after setting the " +
			"prune flag. The flag is then a hole, not an exception.")
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func firstOpStatus(t *testing.T, res response) string {
	t.Helper()
	results, _ := res.Body["results"].([]any)
	if len(results) == 0 {
		t.Fatalf("no results at all: %s", res.Raw)
	}
	status, _ := results[0].(map[string]any)["status"].(string)
	return status
}

// workerDeletedAt reads the instant somebody was taken off the payroll, from
// the row rather than from the clock: the comparison the reactivation rule
// makes is against that exact timestamp.
func (h *harness) workerDeletedAt(t *testing.T, f *farmFixture, workerID string) *time.Time {
	t.Helper()
	var at *time.Time
	if err := h.admin.QueryRow(context.Background(),
		`SELECT deleted_at FROM employees WHERE id = $1`, workerID).Scan(&at); err != nil {
		t.Fatalf("read deleted_at: %v", err)
	}
	return at
}

func (h *harness) feedRowExists(t *testing.T, seq int64) bool {
	t.Helper()
	var ok bool
	if err := h.admin.QueryRow(context.Background(),
		`SELECT EXISTS (SELECT 1 FROM sync_log WHERE seq = $1)`, seq).Scan(&ok); err != nil {
		t.Fatalf("read sync_log: %v", err)
	}
	return ok
}

func (h *harness) opExists(t *testing.T, opID string) bool {
	t.Helper()
	var ok bool
	if err := h.admin.QueryRow(context.Background(),
		`SELECT EXISTS (SELECT 1 FROM sync_ops WHERE op_id = $1)`, opID).Scan(&ok); err != nil {
		t.Fatalf("read sync_ops: %v", err)
	}
	return ok
}

// settle records the whole preview-then-settle dance and returns the id.
func (h *harness) settle(t *testing.T, f *farmFixture, workerID, from, to string) string {
	t.Helper()
	res := h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": workerID, "from": from, "to": to,
	}, http.StatusCreated)
	return mustString(t, res.Body, "id")
}
