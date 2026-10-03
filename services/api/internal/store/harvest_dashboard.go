// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// ---------------------------------------------------------------------------
// The harvest week at a glance: the home screen of a farm in «Modo cosecha».
//
// One request answers the questions an owner asks walking up to the scale:
// how much this week against last week, how much today and by how many
// people, which lotes are giving, who is picking and who is behind, and what
// the week will cost. It follows the reports' rules:
//
//   - scope is harvest: work paid by the unit of work, through harvestCTE, so
//     the value of each weighing is priced exactly as every other report
//     prices it (settled amount > frozen amount > kilo_price() rules:
//     persona > lote > semana > finca — the server twin of resolveKiloPrice()
//     in packages/shared/src/kiloPrice.ts);
//   - days and weeks are the FARM's (local_day, week_start);
//   - a weighing in a unit with no kg_factor has no kilos: it is left out of
//     every kilo figure and counted, and kilos with nothing behind them are
//     null, never zero;
//   - a weighing belongs to a lote only when it resolves to exactly one
//     (directly, or through the crop it names); the rest are reported apart;
//   - people are HEADS, not accounts: a team's weighing counts every member
//     the team had that day (picker_ids, migration 00040), so «personas hoy»,
//     the farm's kilos per person per day and the 70% flag divide by people.
//     A team is one row of the ranking, ordered by its kilos per member.
//
// Everything is read from one pass over the weighings of last week and this
// week, and folded here with Totals.add, so every row adds up to the summary
// by construction.
// ---------------------------------------------------------------------------

// HarvestBelowAverageRatio is how far under the farm's kilos per person per
// day somebody's own kilos per day must fall to be flagged: under 70% of it.
// A flag is a prompt to look, not a verdict, so it is deliberately loose.
const HarvestBelowAverageRatio = 0.7

// HarvestMinPickersToCompare is how many people must have picked this week
// before anybody is flagged against the average. With two, "below average"
// only means "the other one picked more".
const HarvestMinPickersToCompare = 3

// HarvestDashboardSummary is the big figures at the top.
type HarvestDashboardSummary struct {
	// ThisWeek is the running week so far. Its valueCents is the week's
	// estimated harvest payroll (valueIsEstimate says whether any of it is
	// still an estimate).
	ThisWeek Totals `json:"thisWeek"`
	// LastWeekToDate is last week over the same weekdays the running week has
	// had so far: the fair comparison for a week that is not over.
	LastWeekToDate Totals `json:"lastWeekToDate"`
	// LastWeek is last week, whole.
	LastWeek Totals `json:"lastWeek"`
	// Today is today's weighings.
	Today Totals `json:"today"`
	// PickersToday and PickersThisWeek are distinct people with at least one
	// harvest weighing today / this week.
	PickersToday    int `json:"pickersToday"`
	PickersThisWeek int `json:"pickersThisWeek"`
	// PersonDays is the distinct (person, day) pairs with kilos this week, and
	// KgPerPersonDay the week's kilos over it: the farm's kilos per person per
	// day. Nil when nothing this week is in kilos. A team-day is as many
	// person-days as the team had members that day.
	PersonDays     int      `json:"personDays"`
	KgPerPersonDay *float64 `json:"kgPerPersonDay"`
}

// HarvestDashboardDay is one day of the running week, Monday to Sunday.
type HarvestDashboardDay struct {
	Day domain.Day `json:"day"`
	Totals
	Pickers int `json:"pickers"`
	// Future is a day of this week that has not happened yet in the farm.
	Future bool `json:"future"`
}

// HarvestDashboardPlot is one lote: this week's figures, last week's kilos
// beside them, its share of the week's kilos and how many people picked it.
type HarvestDashboardPlot struct {
	PlotID string `json:"plotId"`
	Name   string `json:"name"`
	// Totals are this week's weighings in this lote.
	Totals
	LastWeekToDateKg *float64 `json:"lastWeekToDateKg"`
	LastWeekKg       *float64 `json:"lastWeekKg"`
	// Share is this lote's fraction (0..1) of the week's kilos, nil when the
	// week has no kilos or this lote has none.
	Share   *float64 `json:"share"`
	Pickers int      `json:"pickers"`
}

// HarvestDashboardPerson is one person who picked this week.
type HarvestDashboardPerson struct {
	EmployeeID string `json:"employeeId"`
	Name       string `json:"name"`
	// Tag is the basket number («número de canasto»), nil when they have none.
	Tag *string `json:"tag"`
	// Kind is "persona" or "equipo". Members is how many people the row
	// stands for (1 for a person; a team's members on the days it picked,
	// averaged and rounded).
	Kind    string `json:"kind"`
	Members int    `json:"members"`
	// Totals are this row's weighings this week (a team's: «juntos»).
	Totals
	// KgEach is the kilos per member («c/u»): Kg for a person, a team's kilos
	// over its members. The ranking is ordered by it.
	KgEach *float64 `json:"kgEach"`
	// DaysWorked is the distinct days with kilos this week; KgPerDay the
	// kilos per person per day worked (a team's kilos over its person-days).
	DaysWorked int      `json:"daysWorked"`
	KgPerDay   *float64 `json:"kgPerDay"`
	// PickedToday says there is at least one harvest weighing of theirs today.
	PickedToday bool `json:"pickedToday"`
	// BelowAverage flags kilos per day under HarvestBelowAverageRatio of the
	// farm's kilos per person per day. Never set when fewer than
	// HarvestMinPickersToCompare people picked this week.
	BelowAverage bool `json:"belowAverage"`
}

// HarvestDashboardAbsent is somebody on the books who picked last week or
// this week and has nothing registered today.
type HarvestDashboardAbsent struct {
	EmployeeID   string     `json:"employeeId"`
	Name         string     `json:"name"`
	Tag          *string    `json:"tag"`
	LastRecordOn domain.Day `json:"lastRecordOn"`
}

// HarvestDashboard is the whole response of GET /v1/reports/harvest-dashboard.
type HarvestDashboard struct {
	Scope             string                   `json:"scope"`
	Today             domain.Day               `json:"today"`
	ThisWeek          domain.Day               `json:"thisWeek"`
	LastWeek          domain.Day               `json:"lastWeek"`
	BelowAverageRatio float64                  `json:"belowAverageRatio"`
	Summary           HarvestDashboardSummary  `json:"summary"`
	Days              []HarvestDashboardDay    `json:"days"`  // Monday..Sunday
	Plots             []HarvestDashboardPlot   `json:"plots"` // most kilos this week first
	Unattributed      Totals                   `json:"unattributed"`
	People            []HarvestDashboardPerson `json:"people"` // most kilos this week first
	NotToday          []HarvestDashboardAbsent `json:"notToday"`
}

// harvestDashboardSQL is every harvest weighing of last week and this week,
// one row each, with the one lote it belongs to (or none).
const harvestDashboardSQL = `
WITH ` + harvestCTE + `,
links AS (
  SELECT wp.work_record_id, wp.plot_id
    FROM work_record_plots wp WHERE wp.work_record_id IN (SELECT id FROM harvest)
  UNION
  SELECT c.work_record_id, pc.plot_id
    FROM work_record_plot_crops c JOIN plot_crops pc ON pc.id = c.plot_crop_id
   WHERE c.work_record_id IN (SELECT id FROM harvest)
),
one AS (
  SELECT work_record_id,
         CASE WHEN count(*) = 1 THEN min(plot_id::text) END AS plot_id
    FROM links GROUP BY work_record_id
)
SELECT h.employee_id::text, h.local_day, h.kg, h.value_minor,
       coalesce(h.value_is_estimate, false),
       coalesce(week_start(h.end_local_day) > h.week_start, false),
       o.plot_id,
       ARRAY(SELECT p::text FROM picker_ids(h.employee_id, h.local_day) p)
  FROM harvest h
  LEFT JOIN one o ON o.work_record_id = h.id`

type dashRow struct {
	employee string
	day      time.Time
	plot     *string
	t        Totals
	// people are the heads behind the weighing that day: the employee, or a
	// team's members.
	people []string
}

func dayKey(t time.Time) string { return t.Format(time.DateOnly) }

// ReportHarvestDashboard reads the running week and the one before it.
func ReportHarvestDashboard(ctx context.Context, tx pgx.Tx) (*HarvestDashboard, error) {
	var today, thisWeek time.Time
	if err := tx.QueryRow(ctx, `
		SELECT (now() AT TIME ZONE f.timezone)::date,
		       week_start((now() AT TIME ZONE f.timezone)::date)
		  FROM farms f WHERE f.id = current_farm()`).Scan(&today, &thisWeek); err != nil {
		return nil, err
	}
	lastWeek := thisWeek.AddDate(0, 0, -7)
	sunday := thisWeek.AddDate(0, 0, 6)

	all, err := readDashRows(ctx, tx, lastWeek, sunday)
	if err != nil {
		return nil, err
	}

	out := &HarvestDashboard{
		Scope:             ScopeHarvest,
		Today:             domain.Day{Time: today},
		ThisWeek:          domain.Day{Time: thisWeek},
		LastWeek:          domain.Day{Time: lastWeek},
		BelowAverageRatio: HarvestBelowAverageRatio,
		Days:              []HarvestDashboardDay{},
		Plots:             []HarvestDashboardPlot{},
		People:            []HarvestDashboardPerson{},
		NotToday:          []HarvestDashboardAbsent{},
	}
	acc := newDashAcc(out, today, thisWeek)
	for _, r := range all {
		acc.add(r)
	}
	acc.summarize()

	// Names. Deleted people and lotes keep their name: their kilos are real.
	names, active, err := employeeNames(ctx, tx, keys(acc.people))
	if err != nil {
		return nil, err
	}
	kinds, tags, err := employeeKinds(ctx, tx, keys(acc.people))
	if err != nil {
		return nil, err
	}
	plotNames, err := plotNamesOf(ctx, tx, keys(acc.plots))
	if err != nil {
		return nil, err
	}

	acc.plotRows(plotNames)
	acc.personRows(dashNames{names: names, active: active, kinds: kinds, tags: tags})
	return out, nil
}

// readDashRows runs harvestDashboardSQL over [from, to] and turns each
// weighing into a dashRow.
func readDashRows(ctx context.Context, tx pgx.Tx, from, to time.Time) ([]dashRow, error) {
	rows, err := tx.Query(ctx, harvestDashboardSQL, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var all []dashRow
	for rows.Next() {
		var r dashRow
		var kg *float64
		var value *int64
		var estimate, spans bool
		if err := rows.Scan(&r.employee, &r.day, &kg, &value, &estimate, &spans, &r.plot, &r.people); err != nil {
			return nil, err
		}
		r.t = Totals{Records: 1, Kg: kg, ValueCents: value, ValueIsEstimate: estimate}
		if kg == nil {
			r.t.RecordsNotInKg = 1
		}
		if value == nil {
			r.t.RecordsWithoutValue = 1
		}
		if spans {
			r.t.RecordsSpanningWeeks = 1
		}
		all = append(all, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return all, nil
}

type dashPersonAcc struct {
	t        Totals
	kgDays   map[string]bool
	heads    map[string]bool // person|day with kilos, for a team's per-member figures
	today    bool
	lastSeen time.Time
}

type dashPlotAcc struct {
	t              Totals
	lastWeekToDate *float64
	lastWeek       *float64
	pickers        map[string]bool
}

// dashAcc accumulates the dashboard's figures one weighing at a time.
type dashAcc struct {
	out                              *HarvestDashboard
	today, thisWeek, sameDayLastWeek time.Time

	days         map[string]*HarvestDashboardDay
	dayPickers   map[string]map[string]bool
	people       map[string]*dashPersonAcc
	plots        map[string]*dashPlotAcc
	pickersToday map[string]bool
	pickersWeek  map[string]bool // people (heads)
	weekAccounts map[string]bool // employee ids with a weighing this week
	personDays   map[string]bool
}

func newDashAcc(out *HarvestDashboard, today, thisWeek time.Time) *dashAcc {
	a := &dashAcc{
		out: out, today: today, thisWeek: thisWeek, sameDayLastWeek: today.AddDate(0, 0, -7),
		days:         map[string]*HarvestDashboardDay{},
		dayPickers:   map[string]map[string]bool{},
		people:       map[string]*dashPersonAcc{},
		plots:        map[string]*dashPlotAcc{},
		pickersToday: map[string]bool{},
		pickersWeek:  map[string]bool{},
		weekAccounts: map[string]bool{},
		personDays:   map[string]bool{},
	}
	for i := 0; i < 7; i++ {
		d := thisWeek.AddDate(0, 0, i)
		a.days[dayKey(d)] = &HarvestDashboardDay{Day: domain.Day{Time: d}, Future: d.After(today)}
		a.dayPickers[dayKey(d)] = map[string]bool{}
	}
	return a
}

// person is the accumulator of the row's employee, made on first sight.
func (a *dashAcc) person(r dashRow) *dashPersonAcc {
	p := a.people[r.employee]
	if p == nil {
		p = &dashPersonAcc{kgDays: map[string]bool{}, heads: map[string]bool{}}
		a.people[r.employee] = p
	}
	if r.day.After(p.lastSeen) {
		p.lastSeen = r.day
	}
	return p
}

// plot is the accumulator of the row's lote, or nil when it names none.
func (a *dashAcc) plot(r dashRow) *dashPlotAcc {
	if r.plot == nil {
		return nil
	}
	pl := a.plots[*r.plot]
	if pl == nil {
		pl = &dashPlotAcc{pickers: map[string]bool{}}
		a.plots[*r.plot] = pl
	}
	return pl
}

func (a *dashAcc) add(r dashRow) {
	p := a.person(r)
	pl := a.plot(r)
	if r.day.Before(a.thisWeek) {
		a.addLastWeek(r, pl)
		return
	}
	a.addThisWeek(r, p, pl)
}

func (a *dashAcc) addLastWeek(r dashRow, pl *dashPlotAcc) {
	a.out.Summary.LastWeek.add(r.t)
	toDate := !r.day.After(a.sameDayLastWeek)
	if toDate {
		a.out.Summary.LastWeekToDate.add(r.t)
	}
	if pl != nil {
		pl.lastWeek = addKg(pl.lastWeek, r.t.Kg)
		if toDate {
			pl.lastWeekToDate = addKg(pl.lastWeekToDate, r.t.Kg)
		}
	}
}

func (a *dashAcc) addThisWeek(r dashRow, p *dashPersonAcc, pl *dashPlotAcc) {
	out := a.out
	k := dayKey(r.day)
	out.Summary.ThisWeek.add(r.t)
	a.weekAccounts[r.employee] = true
	p.t.add(r.t)
	if r.t.Kg != nil {
		p.kgDays[k] = true
	}
	for _, who := range r.people {
		a.pickersWeek[who] = true
		if r.t.Kg != nil {
			a.personDays[who+"|"+k] = true
			p.heads[who+"|"+k] = true
		}
	}
	if d := a.days[k]; d != nil {
		d.Totals.add(r.t)
		for _, who := range r.people {
			a.dayPickers[k][who] = true
		}
	}
	if r.day.Equal(a.today) {
		out.Summary.Today.add(r.t)
		for _, who := range r.people {
			a.pickersToday[who] = true
		}
		p.today = true
	}
	if pl != nil {
		pl.t.add(r.t)
		for _, who := range r.people {
			pl.pickers[who] = true
		}
	} else {
		out.Unattributed.add(r.t)
	}
}

// summarize fills the counts and the seven days once every row is in.
func (a *dashAcc) summarize() {
	out := a.out
	out.Summary.PickersToday = len(a.pickersToday)
	out.Summary.PickersThisWeek = len(a.pickersWeek)
	out.Summary.PersonDays = len(a.personDays)
	if out.Summary.ThisWeek.Kg != nil && out.Summary.PersonDays > 0 {
		v := *out.Summary.ThisWeek.Kg / float64(out.Summary.PersonDays)
		out.Summary.KgPerPersonDay = &v
	}
	for i := 0; i < 7; i++ {
		k := dayKey(a.thisWeek.AddDate(0, 0, i))
		d := a.days[k]
		d.Pickers = len(a.dayPickers[k])
		out.Days = append(out.Days, *d)
	}
}

func (a *dashAcc) plotRows(plotNames map[string]string) {
	out := a.out
	weekKg := out.Summary.ThisWeek.Kg
	for id, pl := range a.plots {
		row := HarvestDashboardPlot{
			PlotID: id, Name: plotNames[id], Totals: pl.t,
			LastWeekToDateKg: pl.lastWeekToDate, LastWeekKg: pl.lastWeek,
			Pickers: len(pl.pickers),
		}
		if weekKg != nil && *weekKg > 0 && pl.t.Kg != nil {
			v := *pl.t.Kg / *weekKg
			row.Share = &v
		}
		out.Plots = append(out.Plots, row)
	}
	sort.Slice(out.Plots, func(i, j int) bool {
		a, b := out.Plots[i], out.Plots[j]
		if ka, kb := kgOrZero(a.Kg), kgOrZero(b.Kg); ka != kb {
			return ka > kb
		}
		if ka, kb := kgOrZero(a.LastWeekKg), kgOrZero(b.LastWeekKg); ka != kb {
			return ka > kb
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
}

// dashNames is what the people rows read about each employee.
type dashNames struct {
	names  map[string]string
	active map[string]bool
	kinds  map[string]string
	tags   map[string]*string
}

func (a *dashAcc) personRows(n dashNames) {
	out := a.out
	avg := out.Summary.KgPerPersonDay
	compare := avg != nil && out.Summary.PickersThisWeek >= HarvestMinPickersToCompare
	for id, p := range a.people {
		if a.weekAccounts[id] {
			out.People = append(out.People, personRow(id, p, n, avg, compare))
		}
		if !p.today && n.active[id] {
			out.NotToday = append(out.NotToday, HarvestDashboardAbsent{
				EmployeeID: id, Name: n.names[id], Tag: n.tags[id], LastRecordOn: domain.Day{Time: p.lastSeen},
			})
		}
	}
	sort.Slice(out.People, func(i, j int) bool {
		a, b := out.People[i], out.People[j]
		if ka, kb := kgOrZero(a.KgEach), kgOrZero(b.KgEach); ka != kb {
			return ka > kb
		}
		if ka, kb := kgOrZero(a.Kg), kgOrZero(b.Kg); ka != kb {
			return ka > kb
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	sort.Slice(out.NotToday, func(i, j int) bool {
		return strings.ToLower(out.NotToday[i].Name) < strings.ToLower(out.NotToday[j].Name)
	})
}

func personRow(id string, p *dashPersonAcc, n dashNames, avg *float64, compare bool) HarvestDashboardPerson {
	kind := n.kinds[id]
	if kind == "" {
		kind = KindPersona
	}
	row := HarvestDashboardPerson{
		EmployeeID: id, Name: n.names[id], Tag: n.tags[id], Kind: kind, Members: 1, Totals: p.t,
		DaysWorked: len(p.kgDays), PickedToday: p.today,
	}
	if p.t.Kg != nil && row.DaysWorked > 0 && len(p.heads) > 0 {
		// Per person per day: the row's kilos over its person-days
		// (for a person, its days).
		v := *p.t.Kg / float64(len(p.heads))
		row.KgPerDay = &v
		row.BelowAverage = compare && v < *avg*HarvestBelowAverageRatio
		// Average heads per day worked.
		heads := float64(len(p.heads)) / float64(row.DaysWorked)
		row.Members = int(heads + 0.5)
		each := *p.t.Kg / heads
		row.KgEach = &each
	}
	return row
}

func kgOrZero(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// employeeNames returns "Name LastName" and whether the person is still on
// the books, for the given ids.
func employeeNames(ctx context.Context, tx pgx.Tx, ids []string) (map[string]string, map[string]bool, error) {
	names, active := map[string]string{}, map[string]bool{}
	if len(ids) == 0 {
		return names, active, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, btrim(name || ' ' || coalesce(last_name, '')), deleted_at IS NULL
		  FROM employees WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		var on bool
		if err := rows.Scan(&id, &name, &on); err != nil {
			return nil, nil, err
		}
		names[id], active[id] = name, on
	}
	return names, active, rows.Err()
}

func plotNamesOf(ctx context.Context, tx pgx.Tx, ids []string) (map[string]string, error) {
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `SELECT id::text, name FROM plots WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

// employeeKinds returns persona/equipo for the given ids.
func employeeKinds(ctx context.Context, tx pgx.Tx, ids []string) (map[string]string, map[string]*string, error) {
	out := map[string]string{}
	tags := map[string]*string{}
	if len(ids) == 0 {
		return out, tags, nil
	}
	rows, err := tx.Query(ctx, `SELECT id::text, kind, tag FROM employees WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, kind string
		var tag *string
		if err := rows.Scan(&id, &kind, &tag); err != nil {
			return nil, nil, err
		}
		out[id] = kind
		tags[id] = tag
	}
	return out, tags, rows.Err()
}
