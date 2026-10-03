package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// ---------------------------------------------------------------------------
// One person's harvest, for the «Rendimiento» section of their profile.
//
// This is deliberately NOT the comparative index of ReportPerformance. That
// number judges people against the mates beside them and carries every guard
// that needs; this one only says what THIS person picked, week by week, day by
// day and lote by lote, with the farm's average per picker drawn beside the
// weeks for scale. Nothing here ranks anybody.
//
// It follows the reports' rules all the same:
//
//   - scope is harvest: work paid by the unit of work (pay_scheme
//     'unidad_trabajo'), the same filter as harvestCTE;
//   - weeks are the settlement weeks, keyed by their Monday (`week_start`,
//     generated in the farm's zone), so the chart names the same weeks the
//     liquidaciones do;
//   - "today" and "this week" are the FARM's, not the server's;
//   - a weighing in a unit without a kg_factor has no kilos: it is left out of
//     every kg figure and COUNTED, and kilos with no records behind them are
//     null, not zero.
//
// Only kilos are read, never money, which is why this does not reuse
// harvestCTE and its pricing joins.
// ---------------------------------------------------------------------------

// PerformanceRecentWeeks is how many weeks, the running one included, the
// «promedio por día trabajado» and the lotes are measured over.
const PerformanceRecentWeeks = 4

// PerformanceWeek is one settlement week of this person's harvest, with the
// farm's average per picker for the same week beside it.
type PerformanceWeek struct {
	WeekStart domain.Day `json:"weekStart"`
	// Records is this person's harvest records filed in the week. A real
	// count; zero means nothing was written down.
	Records int `json:"records"`
	// Kg is their kilos, nil when none of their records could be expressed in
	// kilos (including when there are no records at all).
	Kg             *float64 `json:"kg"`
	RecordsNotInKg int      `json:"recordsNotInKg"`
	// DaysWorked is the distinct days with at least one weighing in kilos.
	DaysWorked int `json:"daysWorked"`
	// FarmAvgKg is the farm's kilos that week divided by the people who picked
	// them (everybody with kilos that week, this person included). Nil when
	// nobody on the farm has kilos that week.
	FarmAvgKg   *float64 `json:"farmAvgKg"`
	FarmPickers int      `json:"farmPickers"`
	// Finished says the week is over. The running week is partial and the
	// screen draws it as such.
	Finished bool `json:"finished"`
}

// PerformanceDay is one day of the running week, Monday to Sunday.
type PerformanceDay struct {
	Day     domain.Day `json:"day"`
	Records int        `json:"records"`
	Kg      *float64   `json:"kg"`
	// Future is a day of this week that has not happened yet in the farm.
	Future bool `json:"future"`
}

// PerformancePlot is the kilos this person picked in one lote over the recent
// weeks. A record is attributed to a lote only when it resolves to exactly one
// (directly, or through the crop it names); the rest are reported apart in
// EmployeePerformance.UnattributedKg rather than guessed.
type PerformancePlot struct {
	PlotID  string  `json:"plotId"`
	Name    string  `json:"name"`
	Kg      float64 `json:"kg"`
	Records int     `json:"records"`
}

// PerformanceSummary is the three big numbers at the top of the section.
type PerformanceSummary struct {
	// ThisWeekKg is the running week so far.
	ThisWeekKg *float64 `json:"thisWeekKg"`
	// LastWeekToDateKg is last week over the SAME weekdays the running week
	// has had so far (Monday to today's weekday). Comparing a Tuesday against a
	// whole finished week would make every Monday read as a collapse.
	LastWeekToDateKg *float64 `json:"lastWeekToDateKg"`
	// LastWeekKg is last week, whole.
	LastWeekKg *float64 `json:"lastWeekKg"`
	// RecentKg and RecentDaysWorked cover the last PerformanceRecentWeeks
	// weeks, the running one included. KgPerDayWorked is their ratio, nil
	// when no day in the window has kilos.
	RecentFrom       domain.Day `json:"recentFrom"`
	RecentKg         *float64   `json:"recentKg"`
	RecentDaysWorked int        `json:"recentDaysWorked"`
	KgPerDayWorked   *float64   `json:"kgPerDayWorked"`
}

// EmployeePerformance is the whole response of GET /v1/workers/{id}/performance.
type EmployeePerformance struct {
	Scope      string     `json:"scope"`
	EmployeeID string     `json:"employeeId"`
	Today      domain.Day `json:"today"`
	ThisWeek   domain.Day `json:"thisWeek"`
	// LastRecordOn is the day of this person's latest harvest record, ever.
	// Nil means they have never had one — the empty state.
	LastRecordOn *domain.Day        `json:"lastRecordOn"`
	Summary      PerformanceSummary `json:"summary"`
	Weeks        []PerformanceWeek  `json:"weeks"` // oldest first, running week last
	Days         []PerformanceDay   `json:"days"`  // Monday..Sunday of the running week
	Plots        []PerformancePlot  `json:"plots"` // most kilos first
	// Kind is "persona" or "equipo". For a team every figure is the team's
	// («juntos») and Members is how many people it has today; for a member of
	// a team the figures are their share («su parte»: the team's kilos over
	// its members, on the days they belonged) and Team names the team.
	Kind    string   `json:"kind"`
	Members int      `json:"members"`
	Team    *TeamRef `json:"team"`
	// UnattributedKg is recent kilos that name no lote, or more than one.
	UnattributedKg *float64 `json:"unattributedKg"`
	// RecordsNotInKg counts harvest records across the whole window whose
	// unit has no kg_factor, so a reader knows the kilos leave some out.
	RecordsNotInKg int `json:"recordsNotInKg"`
}

// perfHarvestCTE is this person's-and-the-farm's harvest over [$2, $3], in
// kilos. $1 is the employee and is not used here; every statement below keeps
// the same numbering.
const perfHarvestCTE = `
h AS (
  SELECT l.id, l.employee_id, l.local_day, l.week_start,
         (l.quantity * u.kg_factor)::float8 AS kg
    FROM work_records l
    LEFT JOIN work_units u ON u.id = l.unit_id
   WHERE l.deleted_at IS NULL
     AND l.pay_scheme = 'unidad_trabajo'
     AND l.local_day BETWEEN $2::date AND $3::date
),
-- m is the subject's own kilos: their records, plus — for a member of a team
-- — their share («su parte») of the team's records on the days they belonged:
-- the team's kilos over its heads that day (migration 00040). For a team it
-- is the team's records, whole.
m AS (
  SELECT h.id, h.week_start, h.local_day, h.kg FROM h WHERE h.employee_id = $1
  UNION ALL
  SELECT h.id, h.week_start, h.local_day, h.kg / team_heads(h.employee_id, h.local_day)
    FROM h
    JOIN team_members tm ON tm.team_id = h.employee_id AND tm.employee_id = $1
     AND tm.from_day <= h.local_day AND (tm.to_day IS NULL OR tm.to_day >= h.local_day)
)`

const perfWeeksSQL = `
WITH ` + perfHarvestCTE + `,
series AS (
  SELECT gs::date AS week_start
    FROM generate_series($2::timestamp, $4::timestamp, interval '7 day') gs
),
mine AS (
  SELECT week_start,
         count(*)::int AS records,
         sum(kg)::float8 AS kg,
         count(*) FILTER (WHERE kg IS NULL)::int AS not_kg,
         count(DISTINCT local_day) FILTER (WHERE kg IS NOT NULL)::int AS days
    FROM m
   GROUP BY week_start
),
-- Per PERSON, not per account: a team's kilos are split among the people
-- behind it that day, so the farm's average per picker divides by heads.
per_picker AS (
  SELECT h.week_start, p.person, sum(h.kg / team_heads(h.employee_id, h.local_day)) AS kg
    FROM h CROSS JOIN LATERAL picker_ids(h.employee_id, h.local_day) AS p(person)
   WHERE h.kg IS NOT NULL
   GROUP BY h.week_start, p.person
),
farm AS (
  SELECT week_start, avg(kg)::float8 AS avg_kg, count(*)::int AS pickers
    FROM per_picker GROUP BY week_start
)
SELECT s.week_start,
       COALESCE(m.records, 0), m.kg, COALESCE(m.not_kg, 0), COALESCE(m.days, 0),
       f.avg_kg, COALESCE(f.pickers, 0),
       s.week_start < $4::date
  FROM series s
  LEFT JOIN mine m ON m.week_start = s.week_start
  LEFT JOIN farm f ON f.week_start = s.week_start
 ORDER BY s.week_start`

// Per day for the running week AND last week, so last week can be cut at the
// same weekday as today.
const perfDaysSQL = `
WITH ` + perfHarvestCTE + `
SELECT local_day, count(*)::int, sum(kg)::float8
  FROM m
 WHERE local_day >= $4::date
 GROUP BY local_day`

const perfPlotsSQL = `
WITH ` + perfHarvestCTE + `,
mine AS (SELECT id, kg FROM m WHERE local_day >= $4::date AND kg IS NOT NULL),
links AS (
  SELECT wp.work_record_id, wp.plot_id
    FROM work_record_plots wp WHERE wp.work_record_id IN (SELECT id FROM mine)
  UNION
  SELECT c.work_record_id, pc.plot_id
    FROM work_record_plot_crops c JOIN plot_crops pc ON pc.id = c.plot_crop_id
   WHERE c.work_record_id IN (SELECT id FROM mine)
),
one AS (
  SELECT work_record_id,
         CASE WHEN count(*) = 1 THEN min(plot_id::text)::uuid END AS plot_id
    FROM links GROUP BY work_record_id
)
SELECT o.plot_id::text, p.name, sum(m.kg)::float8, count(*)::int
  FROM mine m
  LEFT JOIN one o ON o.work_record_id = m.id
  LEFT JOIN plots p ON p.id = o.plot_id
 GROUP BY o.plot_id, p.name
 ORDER BY 3 DESC, 2`

// EmployeeHarvestPerformance reads one person's harvest over the last `weeks`
// settlement weeks (the running one included). The caller has already
// confirmed the employee is visible to this farm.
func EmployeeHarvestPerformance(ctx context.Context, tx pgx.Tx, employeeID string, weeks int) (*EmployeePerformance, error) {
	if weeks < PerformanceRecentWeeks {
		weeks = PerformanceRecentWeeks
	}
	var today, thisWeek time.Time
	if err := tx.QueryRow(ctx, `
		SELECT (now() AT TIME ZONE f.timezone)::date,
		       week_start((now() AT TIME ZONE f.timezone)::date)
		  FROM farms f WHERE f.id = current_farm()`).Scan(&today, &thisWeek); err != nil {
		return nil, err
	}
	out := &EmployeePerformance{
		Scope:      ScopeHarvest,
		EmployeeID: employeeID,
		Today:      domain.Day{Time: today},
		ThisWeek:   domain.Day{Time: thisWeek},
		Weeks:      []PerformanceWeek{},
		Days:       []PerformanceDay{},
		Plots:      []PerformancePlot{},
	}

	var last *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT max(l.local_day) FROM work_records l
		 WHERE l.deleted_at IS NULL AND l.pay_scheme = 'unidad_trabajo'
		   AND (l.employee_id = $1 OR EXISTS (
		        SELECT 1 FROM team_members tm
		         WHERE tm.team_id = l.employee_id AND tm.employee_id = $1
		           AND tm.from_day <= l.local_day
		           AND (tm.to_day IS NULL OR tm.to_day >= l.local_day)))`,
		employeeID).Scan(&last); err != nil {
		return nil, err
	}
	subject, err := GetEmployee(ctx, tx, employeeID)
	if err != nil {
		return nil, err
	}
	if err := AttachTeam(ctx, tx, subject); err != nil {
		return nil, err
	}
	out.Kind, out.Members, out.Team = subject.Kind, 1, subject.Team
	if subject.Kind == KindEquipo && len(subject.Members) > 0 {
		out.Members = len(subject.Members)
	}
	out.LastRecordOn = asDay(last)

	from := thisWeek.AddDate(0, 0, -7*(weeks-1))
	to := thisWeek.AddDate(0, 0, 6)

	if err := perfLoadWeeks(ctx, tx, out, employeeID, from, to, thisWeek); err != nil {
		return nil, err
	}
	perfSummarizeRecent(out, thisWeek)
	if err := perfLoadDays(ctx, tx, out, employeeID, from, to, today, thisWeek); err != nil {
		return nil, err
	}
	if err := perfLoadPlots(ctx, tx, out, employeeID, from, to); err != nil {
		return nil, err
	}
	return out, nil
}

// perfLoadWeeks reads the weeks of the window into out.Weeks.
func perfLoadWeeks(ctx context.Context, tx pgx.Tx, out *EmployeePerformance,
	employeeID string, from, to, thisWeek time.Time) error {

	rows, err := tx.Query(ctx, perfWeeksSQL, employeeID, from, to, thisWeek)
	if err != nil {
		return err
	}
	for rows.Next() {
		var w PerformanceWeek
		if err := rows.Scan(&w.WeekStart.Time, &w.Records, &w.Kg, &w.RecordsNotInKg,
			&w.DaysWorked, &w.FarmAvgKg, &w.FarmPickers, &w.Finished); err != nil {
			rows.Close()
			return err
		}
		out.RecordsNotInKg += w.RecordsNotInKg
		out.Weeks = append(out.Weeks, w)
	}
	rows.Close()
	return rows.Err()
}

// perfSummarizeRecent fills the summary from out.Weeks. The recent window is
// the last PerformanceRecentWeeks weeks of the list.
func perfSummarizeRecent(out *EmployeePerformance, thisWeek time.Time) {
	recent := out.Weeks
	if len(recent) > PerformanceRecentWeeks {
		recent = recent[len(recent)-PerformanceRecentWeeks:]
	}
	out.Summary.RecentFrom = domain.Day{Time: thisWeek.AddDate(0, 0, -7*(PerformanceRecentWeeks-1))}
	for _, w := range recent {
		out.Summary.RecentKg = addKg(out.Summary.RecentKg, w.Kg)
		out.Summary.RecentDaysWorked += w.DaysWorked
	}
	if out.Summary.RecentKg != nil && out.Summary.RecentDaysWorked > 0 {
		v := *out.Summary.RecentKg / float64(out.Summary.RecentDaysWorked)
		out.Summary.KgPerDayWorked = &v
	}
	if n := len(out.Weeks); n >= 2 {
		out.Summary.ThisWeekKg = out.Weeks[n-1].Kg
		out.Summary.LastWeekKg = out.Weeks[n-2].Kg
	}
}

// perfLoadDays reads the days of the running week, and last week up to the
// same weekday.
func perfLoadDays(ctx context.Context, tx pgx.Tx, out *EmployeePerformance,
	employeeID string, from, to, today, thisWeek time.Time) error {

	lastMonday := thisWeek.AddDate(0, 0, -7)
	byDay := map[string]PerformanceDay{}
	drows, err := tx.Query(ctx, perfDaysSQL, employeeID, from, to, lastMonday)
	if err != nil {
		return err
	}
	for drows.Next() {
		var d PerformanceDay
		if err := drows.Scan(&d.Day.Time, &d.Records, &d.Kg); err != nil {
			drows.Close()
			return err
		}
		byDay[d.Day.Format(time.DateOnly)] = d
	}
	drows.Close()
	if err := drows.Err(); err != nil {
		return err
	}
	sameDayLastWeek := today.AddDate(0, 0, -7)
	for day := lastMonday; !day.After(sameDayLastWeek); day = day.AddDate(0, 0, 1) {
		if d, ok := byDay[day.Format(time.DateOnly)]; ok {
			out.Summary.LastWeekToDateKg = addKg(out.Summary.LastWeekToDateKg, d.Kg)
		}
	}
	for i := 0; i < 7; i++ {
		day := thisWeek.AddDate(0, 0, i)
		d, ok := byDay[day.Format(time.DateOnly)]
		if !ok {
			d = PerformanceDay{Day: domain.Day{Time: day}}
		}
		d.Future = day.After(today)
		out.Days = append(out.Days, d)
	}
	return nil
}

// perfLoadPlots reads the lotes over the recent window.
func perfLoadPlots(ctx context.Context, tx pgx.Tx, out *EmployeePerformance,
	employeeID string, from, to time.Time) error {

	prows, err := tx.Query(ctx, perfPlotsSQL, employeeID, from, to, out.Summary.RecentFrom.Time)
	if err != nil {
		return err
	}
	for prows.Next() {
		var id, name *string
		var p PerformancePlot
		if err := prows.Scan(&id, &name, &p.Kg, &p.Records); err != nil {
			prows.Close()
			return err
		}
		if id == nil || name == nil {
			kg := p.Kg
			out.UnattributedKg = addKg(out.UnattributedKg, &kg)
			continue
		}
		p.PlotID, p.Name = *id, *name
		out.Plots = append(out.Plots, p)
	}
	prows.Close()
	return prows.Err()
}

// addKg sums two nullable kilo figures: nil + nil is nil, anything else adds.
func addKg(a, b *float64) *float64 {
	if b == nil {
		return a
	}
	v := *b
	if a != nil {
		v += *a
	}
	return &v
}
