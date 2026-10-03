package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// ---------------------------------------------------------------------------
// «Equipos» (migration 00040, docs/use-cases/teams.md).
//
// A team is an employee with kind = 'equipo'. It is the payee: weighings,
// settlements, the ledger balance, advances, payments and its special kilo
// price are the team's, keyed by its id like anybody's. Its members are
// people (kind = 'persona') listed in team_members, with the days they
// belong. While somebody is in a team they have no personal paid work: the
// weighing goes to the team.
//
// The statistics count heads, not accounts: picker_ids()/team_heads() turn a
// team-day into as many person-days as it had members.
// ---------------------------------------------------------------------------

const (
	KindPersona = "persona"
	KindEquipo  = "equipo"
)

// TeamMember is one live member of a team, as listed on the team.
type TeamMember struct {
	ID       string      `json:"id"`
	Name     string      `json:"name"`
	LastName *string     `json:"lastName"`
	Tag      *string     `json:"tag"`
	From     domain.Day  `json:"from"`
	To       *domain.Day `json:"to"`
}

// TeamRef is the team a person currently belongs to, as listed on the person.
type TeamRef struct {
	ID      string      `json:"id"`
	Name    string      `json:"name"`
	From    domain.Day  `json:"from"`
	To      *domain.Day `json:"to"`
	Members int         `json:"members"`
}

// AttachTeams fills Members (on teams) and Team (on people) for the given
// employees, as of the farm's today: a membership counts while it has not
// ended (to_day NULL or today or later), including one that starts later.
func AttachTeams(ctx context.Context, tx pgx.Tx, list []Employee) error {
	if len(list) == 0 {
		return nil
	}
	today, err := LocalToday(ctx, tx)
	if err != nil {
		return err
	}
	ids := make([]string, 0, len(list))
	idx := map[string]int{}
	for i := range list {
		ids = append(ids, list[i].ID)
		idx[list[i].ID] = i
		if list[i].Kind == "" {
			list[i].Kind = KindPersona
		}
		list[i].Members = []TeamMember{}
		list[i].Team = nil
	}
	rows, err := tx.Query(ctx, `
		SELECT tm.team_id::text, t.name, tm.employee_id::text, e.name, e.last_name, e.tag,
		       tm.from_day, tm.to_day,
		       (SELECT count(*) FROM team_members x
		         WHERE x.team_id = tm.team_id AND (x.to_day IS NULL OR x.to_day >= $2::date))::int
		  FROM team_members tm
		  JOIN employees t ON t.id = tm.team_id
		  JOIN employees e ON e.id = tm.employee_id
		 WHERE (tm.to_day IS NULL OR tm.to_day >= $2::date)
		   AND (tm.team_id = ANY($1::uuid[]) OR tm.employee_id = ANY($1::uuid[]))
		 ORDER BY e.name, coalesce(e.last_name, ''), tm.from_day`, ids, today)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var teamID, teamName, memberID, memberName string
		var lastName, tag *string
		var from time.Time
		var to *time.Time
		var count int
		if err := rows.Scan(&teamID, &teamName, &memberID, &memberName, &lastName, &tag,
			&from, &to, &count); err != nil {
			return err
		}
		var toDay *domain.Day
		if to != nil {
			toDay = &domain.Day{Time: *to}
		}
		if i, ok := idx[teamID]; ok {
			list[i].Members = append(list[i].Members, TeamMember{
				ID: memberID, Name: memberName, LastName: lastName, Tag: tag,
				From: domain.Day{Time: from}, To: toDay,
			})
		}
		if i, ok := idx[memberID]; ok && list[i].Team == nil {
			list[i].Team = &TeamRef{ID: teamID, Name: teamName, From: domain.Day{Time: from}, To: toDay, Members: count}
		}
	}
	return rows.Err()
}

// AttachTeam is AttachTeams for one employee.
func AttachTeam(ctx context.Context, tx pgx.Tx, e *Employee) error {
	list := []Employee{*e}
	if err := AttachTeams(ctx, tx, list); err != nil {
		return err
	}
	*e = list[0]
	return nil
}

// TeamOn is the team a person belongs to on any day of [from, to], or nil.
func TeamOn(ctx context.Context, tx pgx.Tx, employeeID string, from, to time.Time) (*TeamRef, error) {
	var t TeamRef
	var f time.Time
	err := tx.QueryRow(ctx, `
		SELECT t.id::text, t.name, tm.from_day
		  FROM team_members tm JOIN employees t ON t.id = tm.team_id
		 WHERE tm.employee_id = $1
		   AND tm.from_day <= $3::date
		   AND (tm.to_day IS NULL OR tm.to_day >= $2::date)
		 ORDER BY tm.from_day DESC LIMIT 1`, employeeID, from, to).Scan(&t.ID, &t.Name, &f)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	t.From = domain.Day{Time: f}
	return &t, nil
}

// WorkerInTeam is the 409 for personal paid work of somebody in a team.
func WorkerInTeam(t *TeamRef, msg string) *domain.Error {
	return domain.Conflict(domain.CodeWorkerInTeam, msg).WithDetails(map[string]any{
		"teamId": t.ID, "teamName": t.Name,
	})
}

// EnsureNotInTeam refuses personal paid work for a member of a team.
func EnsureNotInTeam(ctx context.Context, tx pgx.Tx, employeeID string, from, to time.Time) error {
	t, err := TeamOn(ctx, tx, employeeID, from, to)
	if err != nil {
		return err
	}
	if t != nil {
		return WorkerInTeam(t, "this person belongs to the team «"+t.Name+
			"» on that day: register the work and the money to the team")
	}
	return nil
}

// employeeKind reads kind and whether the row is live.
func employeeKind(ctx context.Context, tx pgx.Tx, id string) (kind string, active bool, err error) {
	err = tx.QueryRow(ctx, `SELECT kind, deleted_at IS NULL FROM employees WHERE id = $1`, id).
		Scan(&kind, &active)
	return
}

// SetTeamMembers makes `memberIDs` the members of the team from `from` on:
// anybody live in the team and not listed leaves the day before (or, if their
// membership had not started yet, is taken off), and anybody listed who is
// not already a member joins on `from`. History before `from` is untouched.
func SetTeamMembers(ctx context.Context, tx pgx.Tx, farmID, teamID string, memberIDs []string,
	from time.Time, by string) error {
	if err := checkSettableTeam(ctx, tx, teamID); err != nil {
		return err
	}
	want, err := wantedMembers(ctx, tx, teamID, memberIDs)
	if err != nil {
		return err
	}

	// Close or drop memberships that are no longer wanted.
	have, err := closeUnwantedMembers(ctx, tx, teamID, from, want)
	if err != nil {
		return err
	}

	for id := range want {
		if have[id] {
			continue
		}
		if err := addTeamMember(ctx, tx, farmID, teamID, id, from, by); err != nil {
			return err
		}
	}
	return nil
}

// checkSettableTeam refuses a team id that is not a live team.
func checkSettableTeam(ctx context.Context, tx pgx.Tx, teamID string) error {
	kind, active, err := employeeKind(ctx, tx, teamID)
	if errors.Is(err, pgx.ErrNoRows) {
		return NoRows
	}
	if err != nil {
		return err
	}
	if kind != KindEquipo {
		return domain.BadRequest("members can only be set on a team (kind equipo)")
	}
	if !active {
		return domain.BadRequest("the team is inactive: reactivate it first")
	}
	return nil
}

// wantedMembers validates the requested members — live people of this farm,
// never the team itself — and returns them as a set.
func wantedMembers(ctx context.Context, tx pgx.Tx, teamID string, memberIDs []string) (map[string]bool, error) {
	want := map[string]bool{}
	for _, id := range memberIDs {
		if id == teamID {
			return nil, domain.BadRequest("a team cannot be a member of itself")
		}
		if want[id] {
			continue
		}
		if err := checkMemberCandidate(ctx, tx, id); err != nil {
			return nil, err
		}
		want[id] = true
	}
	return want, nil
}

// checkMemberCandidate refuses an id that is not a live person of this farm.
func checkMemberCandidate(ctx context.Context, tx pgx.Tx, id string) error {
	mk, mActive, err := employeeKind(ctx, tx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.BadRequest("member " + id + " is not a worker of this farm")
	}
	if err != nil {
		return err
	}
	if mk != KindPersona {
		return domain.BadRequest("a team's members must be people, not teams")
	}
	if !mActive {
		return domain.BadRequest("member " + id + " is inactive: reactivate them first")
	}
	return nil
}

// closeUnwantedMembers ends, the day before `from`, every membership live on
// or after `from` whose member is not wanted, and drops the ones that had not
// started yet. It returns the wanted members who are already in the team.
func closeUnwantedMembers(ctx context.Context, tx pgx.Tx, teamID string, from time.Time,
	want map[string]bool) (map[string]bool, error) {

	rows, err := tx.Query(ctx, `
		SELECT id::text, employee_id::text, from_day FROM team_members
		 WHERE team_id = $1 AND (to_day IS NULL OR to_day >= $2::date)`, teamID, from)
	if err != nil {
		return nil, err
	}
	type live struct {
		id, member string
		from       time.Time
	}
	var current []live
	for rows.Next() {
		var l live
		if err := rows.Scan(&l.id, &l.member, &l.from); err != nil {
			rows.Close()
			return nil, err
		}
		current = append(current, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, l := range current {
		if want[l.member] {
			have[l.member] = true
			continue
		}
		if !l.from.Before(from) {
			if _, err := tx.Exec(ctx, `DELETE FROM team_members WHERE id = $1`, l.id); err != nil {
				return nil, err
			}
			continue
		}
		if _, err := tx.Exec(ctx, `UPDATE team_members SET to_day = $2::date - 1 WHERE id = $1`,
			l.id, from); err != nil {
			return nil, err
		}
	}
	return have, nil
}

// addTeamMember opens a membership of `id` in the team from `from` on.
func addTeamMember(ctx context.Context, tx pgx.Tx, farmID, teamID, id string, from time.Time, by string) error {
	// One team per person per day: say which team, before the trigger
	// says it in SQL.
	var otherID, otherName string
	err := tx.QueryRow(ctx, `
		SELECT t.id::text, t.name FROM team_members tm JOIN employees t ON t.id = tm.team_id
		 WHERE tm.employee_id = $1 AND tm.team_id <> $2
		   AND (tm.to_day IS NULL OR tm.to_day >= $3::date)
		 LIMIT 1`, id, teamID, from).Scan(&otherID, &otherName)
	if err == nil {
		return WorkerInTeam(&TeamRef{ID: otherID, Name: otherName},
			"that person already belongs to the team «"+otherName+"»: take them out of it first")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO team_members (id, farm_id, team_id, employee_id, from_day, created_by)
		VALUES (gen_random_uuid(), $1, $2, $3, $4::date, $5)`,
		farmID, teamID, id, from, nilUUID(by)); err != nil {
		if pe, ok := PgErr(err); ok && pe.ConstraintName == "team_members_one_team" {
			return domain.Conflict(domain.CodeWorkerInTeam,
				"that person already belongs to another team on those days")
		}
		return err
	}
	return nil
}

// CloseMemberships ends every open membership of an employee (as team or as
// member) on `day`. Used when a team or a person is taken off the payroll.
func CloseMemberships(ctx context.Context, tx pgx.Tx, employeeID string, day time.Time) error {
	if _, err := tx.Exec(ctx, `
		DELETE FROM team_members
		 WHERE (team_id = $1 OR employee_id = $1) AND from_day > $2::date`, employeeID, day); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		UPDATE team_members SET to_day = $2::date
		 WHERE (team_id = $1 OR employee_id = $1) AND (to_day IS NULL OR to_day > $2::date)`,
		employeeID, day)
	return err
}

// SetEmployeeKind turns a person into a team or back. A person who belongs to
// a team cannot become one; a team with members cannot become a person.
func SetEmployeeKind(ctx context.Context, tx pgx.Tx, id, kind string) error {
	if kind != KindPersona && kind != KindEquipo {
		return domain.BadRequest("kind must be persona or equipo")
	}
	current, _, err := employeeKind(ctx, tx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return NoRows
	}
	if err != nil {
		return err
	}
	if current == kind {
		return nil
	}
	var n int
	col := "employee_id"
	if current == KindEquipo {
		col = "team_id"
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM team_members WHERE `+col+` = $1`, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		if current == KindEquipo {
			return domain.BadRequest("this team has (or had) members: it cannot become a person")
		}
		return domain.BadRequest("this person is (or was) in a team: they cannot become a team")
	}
	_, err = tx.Exec(ctx, `UPDATE employees SET kind = $2 WHERE id = $1`, id, kind)
	return err
}
