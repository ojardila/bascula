// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

func cmrCode(t *testing.T, what string, err error, want domain.Code) {
	t.Helper()
	var de *domain.Error
	if !errors.As(err, &de) || de.Code != want {
		t.Errorf("%s: got %v, want %s", what, err, want)
	}
}

const (
	cmrLocalToday = "SELECT (now() AT TIME ZONE f.timezone)::date"
	cmrMembers    = "(SELECT count(*) FROM team_members x"
	cmrEmployee   = "FROM employees WHERE id = $1"
	cmrKind       = "SELECT kind, deleted_at IS NULL FROM employees"
)

func TestCMRSyncFeedScanFailure(t *testing.T) {
	tx := &cmrTx{query: map[string]*cmrRows{"FROM sync_log s": cmrFailing()}}
	if _, err := SyncFeed(context.Background(), tx, 0, 10); !errors.Is(err, errCMR) {
		t.Errorf("SyncFeed with a row that fails to scan: %v", err)
	}
}

// TestCMRSyncComposeGoneRows: a feed entry whose row is gone, or that this
// build does not know, composes to nothing — never to an error that would
// stall the cursor, and never to a body of zeros.
func TestCMRSyncComposeGoneRows(t *testing.T) {
	ctx := context.Background()
	gone := cmrRow{err: pgx.ErrNoRows}
	tx := &cmrTx{row: map[string]cmrRow{
		"FROM farm_config fc": gone, cmrEmployee: gone, "FROM plots WHERE id": gone,
		"FROM plot_crops pc": gone, "FROM week_prices": gone, "FROM work_records l": gone,
		"FROM settlements WHERE id": gone,
	}}
	for _, e := range []SyncEntity{EntityFarmConfig, EntityWorker, EntityPlot, EntityCrop,
		EntityWeekPrice, EntityWorkRecord, EntitySettlement, SyncEntity("fromTheFuture")} {
		body, err := composeSyncRow(ctx, tx, feedRow{seq: 7, entity: e, rowID: "r-1", op: "upsert"})
		if err != nil || body != nil {
			t.Errorf("%s gone: body %v, err %v; want nothing", e, body, err)
		}
	}

	// A record that is not paid by the unit of work is not a weighing: the
	// handset is sent nothing for it.
	tx = &cmrTx{row: map[string]cmrRow{"FROM work_records l": {vals: []any{"w-1", "day_wage", "1"}}}}
	if body, err := composeWorkRecord(ctx, tx, "wr-1"); err != nil || body != nil {
		t.Errorf("a day wage in the feed: %v, %v", body, err)
	}
}

// TestCMRSyncComposeWorkerTeams: a worker's feed body carries its members (as
// a team) and its team (as a member), and the private fields only for an
// administrator.
func TestCMRSyncComposeWorkerTeams(t *testing.T) {
	ctx := context.Background()
	today := time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)
	vals := make([]any, 15)
	vals[0], vals[1], vals[14] = "w-1", "Yorman y Sergio", KindEquipo
	tx := &cmrTx{
		row: map[string]cmrRow{cmrEmployee: {vals: vals}, cmrLocalToday: {vals: []any{today}},
			"SELECT current_role_name()": {vals: []any{"owner"}}},
		query: map[string]*cmrRows{cmrMembers: {data: [][]any{
			{"w-1", "Yorman y Sergio", "m-1", "Yorman", nil, nil, today, nil, 2},
			{"t-9", "Otro", "w-1", "Yorman y Sergio", nil, nil, today, nil, 3},
		}}},
	}
	body, err := composeWorker(ctx, tx, "w-1")
	if err != nil {
		t.Fatal(err)
	}
	row := body.(map[string]any)
	ids := row["memberIds"].([]string)
	team := row["teamId"].(*string)
	if len(ids) != 1 || ids[0] != "m-1" || team == nil || *team != "t-9" {
		t.Errorf("worker feed body: members %v team %v", ids, team)
	}
	if _, ok := row["docId"]; !ok {
		t.Error("an administrator's feed carries the document")
	}
}

func TestCMRSyncOpsRegistryEdges(t *testing.T) {
	ctx := context.Background()
	tx := &cmrTx{row: map[string]cmrRow{"FROM sync_ops": {vals: []any{[]byte("{not json")}}}}
	if out, err := FindSyncOp(ctx, tx, "op-1", ""); err == nil || out != nil {
		t.Errorf("a stored answer that does not decode: %v, %v", out, err)
	}

	// An answer that cannot be encoded is an error, not a row with no answer.
	bad := SyncOpResult{OpID: "op-1", Status: "applied",
		Error: &SyncOpError{Details: map[string]any{"x": make(chan int)}}}
	if err := RecordSyncOp(ctx, &cmrTx{}, "f", "op-1", "d", "fp", bad); err == nil {
		t.Error("RecordSyncOp with an unencodable answer should fail")
	}
}

// TestCMRUpsertSyncWorkerCollisions: the index firing on the phone's insert
// is answered the way the REST route answers it, and an id this farm cannot
// see is a reused key, never a confirmation that it exists elsewhere.
func TestCMRUpsertSyncWorkerCollisions(t *testing.T) {
	ctx := context.Background()
	insert := "INSERT INTO employees (id, farm_id, name"
	for _, c := range []struct {
		constraint string
		want       domain.Code
	}{
		{"ux_employees_doc", domain.CodeDuplicateDocument},
		{"ux_employees_tag", domain.CodeDuplicateTag},
	} {
		tx := &cmrTx{row: map[string]cmrRow{insert: {err: &pgconn.PgError{Code: "23505", ConstraintName: c.constraint}}}}
		_, _, err := UpsertSyncWorker(ctx, tx, "f", Employee{ID: "w-1", Name: "Ana"})
		cmrCode(t, c.constraint, err, c.want)
	}

	tx := &cmrTx{row: map[string]cmrRow{insert: {err: pgx.ErrNoRows}, cmrEmployee: {err: pgx.ErrNoRows}}}
	_, created, err := UpsertSyncWorker(ctx, tx, "f", Employee{ID: "w-other-farm", Name: "Ana"})
	cmrCode(t, "id of another farm", err, domain.CodeIdempotencyKeyReused)
	if created {
		t.Error("a refused upsert reported a created row")
	}
}

func TestCMRAttachTeamsEdges(t *testing.T) {
	ctx := context.Background()
	today := time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)
	tx := &cmrTx{row: map[string]cmrRow{cmrLocalToday: {vals: []any{today}}},
		query: map[string]*cmrRows{cmrMembers: {}}}
	list := []Employee{{ID: "w-1"}}
	if err := AttachTeams(ctx, tx, list); err != nil {
		t.Fatal(err)
	}
	if list[0].Kind != KindPersona || list[0].Members == nil || list[0].Team != nil {
		t.Errorf("a row read without a kind is a person with no team: %+v", list[0])
	}

	tx.query[cmrMembers] = cmrFailing()
	if err := AttachTeams(ctx, tx, list); !errors.Is(err, errCMR) {
		t.Errorf("AttachTeams with a row that fails to scan: %v", err)
	}
}

func TestCMRTeamMembershipStoreEdges(t *testing.T) {
	ctx := context.Background()
	from := time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)

	// The team id is not a row of this farm.
	tx := &cmrTx{row: map[string]cmrRow{cmrKind: {err: pgx.ErrNoRows}}}
	if err := SetTeamMembers(ctx, tx, "f", "t-1", nil, from, ""); !errors.Is(err, NoRows) {
		t.Errorf("members on a missing team: %v", err)
	}
	// An inactive team takes no members.
	tx = &cmrTx{row: map[string]cmrRow{cmrKind: {vals: []any{KindEquipo, false}}}}
	err := SetTeamMembers(ctx, tx, "f", "t-1", nil, from, "")
	cmrCode(t, "inactive team", err, domain.CodeBadRequest)

	live := "SELECT id::text, employee_id::text, from_day FROM team_members"
	active := cmrRow{vals: []any{KindEquipo, true}}
	for _, rows := range []*cmrRows{cmrFailing(), cmrEndsBadly()} {
		tx = &cmrTx{row: map[string]cmrRow{cmrKind: active}, query: map[string]*cmrRows{live: rows}}
		if err := SetTeamMembers(ctx, tx, "f", "t-1", nil, from, ""); !errors.Is(err, errCMR) {
			t.Errorf("reading the live members failed, got %v", err)
		}
	}

	// A member leaving: one whose membership had not started is taken off,
	// one who was already in leaves the day before. Each write failing is
	// the error.
	current := func() *cmrRows {
		return &cmrRows{data: [][]any{{"tm-future", "m-1", from.AddDate(0, 0, 3)}, {"tm-old", "m-2", from.AddDate(0, 0, -30)}}}
	}
	for _, c := range []struct {
		name       string
		del, close error
		want       []string
	}{
		{"both written", nil, nil, []string{"E:DELETE", "E:UPDATE"}},
		{"the drop fails", errCMR, nil, []string{"E:DELETE"}},
		{"the close fails", nil, errCMR, []string{"E:DELETE", "E:UPDATE"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			tx := &cmrTx{row: map[string]cmrRow{cmrKind: active}, query: map[string]*cmrRows{live: current()},
				exec: map[string]error{"DELETE": c.del, "UPDATE": c.close}}
			err := SetTeamMembers(ctx, tx, "f", "t-1", nil, from, "")
			if (c.del != nil || c.close != nil) != (err != nil) {
				t.Errorf("err = %v", err)
			}
			var execs []string
			for _, s := range tx.seen {
				if s[0] == 'E' {
					execs = append(execs, s)
				}
			}
			if len(execs) != len(c.want) {
				t.Errorf("writes %v, want %v", execs, c.want)
			}
		})
	}

	// The trigger, not the pre-check, saw the person in another team (two
	// saves racing): the same 409 the pre-check gives.
	tx = &cmrTx{row: map[string]cmrRow{"SELECT t.id::text, t.name FROM team_members": {err: pgx.ErrNoRows}},
		exec: map[string]error{"INSERT INTO team_members": &pgconn.PgError{Code: "23P01", ConstraintName: "team_members_one_team"}}}
	err = addTeamMember(ctx, tx, "f", "t-1", "m-1", from, "")
	cmrCode(t, "racing membership", err, domain.CodeWorkerInTeam)
}

func TestCMRSetEmployeeKindEdges(t *testing.T) {
	ctx := context.Background()
	cmrCode(t, "unknown kind", SetEmployeeKind(ctx, &cmrTx{}, "w-1", "cuadrilla"), domain.CodeBadRequest)

	tx := &cmrTx{row: map[string]cmrRow{cmrKind: {err: pgx.ErrNoRows}}}
	if err := SetEmployeeKind(ctx, tx, "w-1", KindEquipo); !errors.Is(err, NoRows) {
		t.Errorf("kind of a missing worker: %v", err)
	}

	// Already that kind: nothing is counted and nothing is written.
	tx = &cmrTx{row: map[string]cmrRow{cmrKind: {vals: []any{KindPersona, true}}}}
	if err := SetEmployeeKind(ctx, tx, "w-1", KindPersona); err != nil || len(tx.seen) != 1 {
		t.Errorf("same kind: %v, queries %v", err, tx.seen)
	}
}
