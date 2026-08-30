package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// ---------------------------------------------------------------------------
// The reports.
//
// Every statement below is a port of SQL that already runs on eighteen
// thousand weighings in apps/mobile — WEEK_*_SQL, INDEX_SQL, RULE_*_SQL in
// apps/mobile/src/schema.ts and the WeekReports / CropReports / Performance /
// Anomalies objects in apps/mobile/src/data/sqliteRepository.ts. They are kept
// as close to the original text as the dialect allows, for the reason
// store/money.go states about the money queries: a rewrite would prove nothing
// about what the phone actually executes, and these particular statements
// carry two bugs that took a season to find and are fixed in exactly one place.
//
// WHAT POSTGRES NEEDED THAT SQLITE DID NOT, in one list, because it is the
// same four differences over and over:
//
//  1. THE LOCAL DAY IS A COLUMN, NOT A CALL. The phone computes
//     `date(pk.date,'localtime')` everywhere, which no index can serve — which
//     is why every mobile rule carries a SECOND, redundant bound on the raw
//     instant purely to become sargable. Here `local_day` and `week_start` are
//     written by a trigger and a generated column in the farm's own timezone,
//     so the correct predicate is already the indexable one and the double
//     bound is gone. (The phone is converging on the same shape: the working
//     tree has PENDING_SQL and the five rules moving to `pk.localDay`.)
//
//  2. 'localtime' IS THE FARM'S ZONE ON A PHONE AND UTC ON A SERVER. Every
//     `date('now','localtime',?)` becomes
//     `(now() AT TIME ZONE f.timezone)::date - n`. Getting this wrong shifts
//     the window by up to a day at each end and silently changes who is inside
//     a comparison.
//
//  3. THE TIE-BREAK IN THE DUPLICATE RULE. `b.id < a.id` is chronological on
//     SQLite's AUTOINCREMENT integers and MEANINGLESS on our random UUIDs. It
//     is `(b.created_at, b.id) < (a.created_at, a.id)` here — still a total
//     order, so exactly one row of each pair is the suspect, but ordered by
//     the clock rather than by luck.
//
//  4. A WEIGHING IS NOT ALWAYS IN KILOS. The phone has one `weight` column in
//     one unit. Here a work record is a quantity in a work_unit, and a farm
//     may invent one — "canasta" — with no kg_factor. Multiplying by a missing
//     factor is how a report invents kilos, so those records are excluded from
//     every kg figure and COUNTED, and the count travels with the figure.
//
// AND THE RULE THAT OVERRIDES ALL OF THEM: no endpoint here returns a zero
// that means "I do not know". Kilos, value and the performance index are all
// nullable, and every null arrives with either a count or a reason beside it.
// A zero in a report is a credible answer and a credible wrong answer is the
// dangerous kind.
// ---------------------------------------------------------------------------

// ScopeHarvest names what every figure in these reports covers: work paid by
// the unit of work. A day's wage has no kilos and is not a harvest; it is the
// same filter the /v1/pickups facade applies. It travels on the wire so nobody
// reads a week's harvest value as the week's whole payroll.
const ScopeHarvest = "harvest"

// harvestCTE is the one definition of "a weighing" that every report shares.
//
// Scope: work paid by the unit of work. A day's wage is not a harvest and has
// no kilos, exactly as the /v1/pickups facade filters. This is the scope of
// every figure below, including the money ones, and it is declared on the wire
// so nobody reads a week's harvest value as the week's whole payroll.
//
// The value of a record follows priceWorkRecords in work_records.go, which is
// the fix for "every harvest record showed $0 in the console": what a live
// settlement line paid, else the record's own frozen amount, else — for work
// priced by the week — the quantity at the price in force for that week, which
// is the number a settlement would post today. Anything else is NULL, and NULL
// is reported as NULL.
//
// It always takes $1 and $2: the inclusive local-day window, either of which
// may be NULL for "unbounded". Every query below starts its own parameters at
// $3 so the numbering never has to be reasoned about twice.
const harvestCTE = `
harvest AS (
  SELECT l.id, l.employee_id, l.local_day, l.end_local_day, l.week_start,
         l.quantity, l.created_at,
         (l.quantity * u.kg_factor)::float8 AS kg,
         COALESCE(
           sl.amount_minor,
           l.amount_minor,
           CASE WHEN l.rate_source = 'weekly_price'
                THEN round(l.quantity * COALESCE(wp.price_minor, fc.price_minor))::bigint
           END) AS value_minor,
         (sl.amount_minor IS NULL AND l.amount_minor IS NULL) AS value_is_estimate,
         COALESCE(wp.price_minor, fc.price_minor) AS week_price_minor
    FROM work_records l
    LEFT JOIN work_units u ON u.id = l.unit_id
    LEFT JOIN LATERAL (
      SELECT si.amount_minor FROM settlement_items si
       WHERE si.payable_id = l.id AND si.voided_at IS NULL LIMIT 1) sl ON true
    LEFT JOIN week_prices wp ON wp.farm_id = l.farm_id AND wp.week_start = l.week_start
    LEFT JOIN farm_config fc ON fc.farm_id = l.farm_id
   WHERE l.deleted_at IS NULL
     AND l.pay_scheme = 'unidad_trabajo'
     AND ($1::date IS NULL OR l.local_day >= $1)
     AND ($2::date IS NULL OR l.local_day <= $2)
)`

// cropLinkCTE resolves the ONE crop a weighing belongs to, or none.
//
// On the phone a pickup carries a single `cropId`. Here the link is a
// many-to-many table, so a record can name two crops — and attributing its
// kilos to both would make the columns of a grid add up to more than the grid.
// A record that does not resolve to exactly one crop is attributed to no crop
// and reported in its own bucket, which keeps every total exact and says out
// loud what could not be attributed.
const cropLinkCTE = `
crop_link AS (
  SELECT c.work_record_id,
         -- min() has no uuid overload in Postgres; the text detour is the
         -- shortest honest way to say "the only one, when there is only one".
         CASE WHEN count(*) = 1 THEN min(c.plot_crop_id::text)::uuid END AS plot_crop_id,
         count(*) AS crops
    FROM work_record_plot_crops c
   GROUP BY c.work_record_id
)`

// boundsCTE is today and this week's Monday, in the FARM's timezone. See
// difference 2 at the top of this file.
const boundsCTE = `
bounds AS (
  SELECT (now() AT TIME ZONE f.timezone)::date AS today,
         week_start((now() AT TIME ZONE f.timezone)::date) AS this_week
    FROM farms f WHERE f.id = current_farm()
)`

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

// Totals is what every report row adds up to, plus the two admissions it is
// not allowed to leave out.
//
// Kg and ValueCents are pointers. A nil is "this could not be established",
// which is a different fact from 0, and the counts beside them say how much of
// the figure is missing — so a partial sum can never be read as a whole one.
type Totals struct {
	// Records contributing to this row. A real count; zero means zero.
	Records int `json:"records"`

	// Kg is the sum of the records that could be expressed in kilos, and nil
	// when not one of them could. RecordsNotInKg counts those left out: a
	// weighing in a work unit whose kg_factor the farm never set cannot be
	// converted, and guessing one is how a report invents harvest.
	Kg             *float64 `json:"kg"`
	RecordsNotInKg int      `json:"recordsNotInKg"`

	// ValueCents is the sum of what those records are worth, and nil when not
	// one of them could be priced. RecordsWithoutValue counts the rest.
	ValueCents          *int64 `json:"valueCents"`
	RecordsWithoutValue int    `json:"recordsWithoutValue"`

	// ValueIsEstimate is true when any contributing record is priced by its
	// week rather than by a settlement or a frozen amount — what the farm
	// would owe, not what it has paid. The two must never look alike.
	ValueIsEstimate bool `json:"valueIsEstimate"`

	// RecordsSpanningWeeks counts contributing records whose work carries on
	// past the week this row files them under, and it is the third admission
	// of the same kind as the two above.
	//
	// A work record has a start day and an end day. Ranges are legal — a
	// contract cleared over five days is one record, priced once — but
	// `week_start` is a generated column over the START day alone, so the
	// whole of a Saturday-to-Wednesday labour is credited to the week that
	// Saturday falls in and none of it to the week that got three of its five
	// days. Nothing else in the schema can undo that: there is no per-day
	// split anywhere, because nobody recorded one, and dividing the quantity
	// evenly across the span would be this file inventing the very thing it
	// refuses to invent everywhere else.
	//
	// So the attribution stays where the data supports it — all of it on the
	// first week — and the count travels beside the figure, exactly as
	// recordsNotInKg travels beside the kilos. A week whose kilos include a
	// labour that ran into the next week says so, and a reader comparing two
	// weeks knows which one borrowed from the other.
	RecordsSpanningWeeks int `json:"recordsSpanningWeeks"`
}

// totalsCols is the SELECT list that fills a Totals from a `harvest h`.
//
// `sum()` in Postgres skips NULLs and returns NULL only when every input was
// NULL, which is exactly the semantics wanted: a partial sum with a count of
// what is missing beside it, and an honest NULL when nothing at all could be
// worked out.
const totalsCols = `count(*)::int,
	sum(h.kg)::float8,
	count(*) FILTER (WHERE h.kg IS NULL)::int,
	sum(h.value_minor)::bigint,
	count(*) FILTER (WHERE h.value_minor IS NULL)::int,
	coalesce(bool_or(h.value_is_estimate), false),
	count(*) FILTER (WHERE week_start(h.end_local_day) > h.week_start)::int`

// totalsColsOuter is totalsCols for a query that LEFT JOINs the weighings onto
// something else — a calendar of weeks, in practice.
//
// The difference is `count(*)` against `count(h.id)`, and it is not a detail. A
// left join produces one all-NULL row for a week with no work, and `count(*)`
// counts it: the week would report ONE record with no kilos and no value, which
// is a weighing nobody made. Every filtered count is guarded the same way, so a
// week with nothing in it reports zero records — a real zero, beside a NULL for
// the kilos, which is the pair this file insists on everywhere else.
const totalsColsOuter = `count(h.id)::int,
	sum(h.kg)::float8,
	count(*) FILTER (WHERE h.id IS NOT NULL AND h.kg IS NULL)::int,
	sum(h.value_minor)::bigint,
	count(*) FILTER (WHERE h.id IS NOT NULL AND h.value_minor IS NULL)::int,
	coalesce(bool_or(h.value_is_estimate), false),
	count(*) FILTER (WHERE h.id IS NOT NULL
	                   AND week_start(h.end_local_day) > h.week_start)::int`

func (t *Totals) scanTargets() []any {
	return []any{&t.Records, &t.Kg, &t.RecordsNotInKg,
		&t.ValueCents, &t.RecordsWithoutValue, &t.ValueIsEstimate,
		&t.RecordsSpanningWeeks}
}

// weekSeriesCTE is the calendar a weekly report is drawn on: every Monday from
// the first week with work to the last, WITH THE EMPTY ONES IN IT.
//
// # Why a report cannot be a GROUP BY
//
// `GROUP BY week_start` produces a row per week that HAS work, which sounds like
// the same thing and is not. A week in which nobody picked simply vanishes, and
// the two rows either side of the hole become neighbours: the list shows them
// adjacent, a chart draws a straight line over the gap, and the harvest reading
// compares them as consecutive weeks. A season that stopped for a fortnight of
// rain and restarted reads as a season that never stopped — and the number that
// falls out of that comparison is the one an owner uses to decide whether to
// move his crew off the plot.
//
// The empty week comes back with `records: 0` and `kg: null`, and the pairing is
// the point. Zero records is a fact: nothing was written down that week. Null
// kilos is the honest consequence: whether nobody picked or nobody recorded it
// is not something this database can tell, and a 0.0 there would be the reading
// silently choosing one of the two — which, through ReadHarvest, would
// manufacture a 100% drop and end somebody's season on paper.
//
// # Where the calendar starts and stops
//
// At the farm's own data, clamped by whatever window the caller asked for. Weeks
// are never invented outside the span of what was recorded: a caller asking
// `from=1900-01-01` wants their season, not four thousand empty Mondays ahead of
// it, and the LIMIT would then push the real weeks off the end of the list.
//
// It takes $1 and $2 like every other statement here — the inclusive local-day
// window, either of which may be NULL — and GREATEST/LEAST do the clamping,
// because in Postgres they ignore NULL inputs, which is exactly "unbounded".
const weekSeriesCTE = `
span AS (
  SELECT GREATEST(week_start($1::date), (SELECT min(week_start) FROM harvest)) AS lo,
         LEAST(week_start($2::date),    (SELECT max(week_start) FROM harvest)) AS hi
),
series AS (
  SELECT gs::date AS week_start
    FROM span, generate_series(span.lo::timestamp, span.hi::timestamp,
                               interval '7 day') gs
   WHERE span.lo IS NOT NULL AND span.hi IS NOT NULL
)`

// weekWindowCols reports WHAT PART of each week the row actually covers.
//
// A request for three days of a week used to come back as `weekStart:
// 2026-08-03, finished: true`, carrying a tenth of the week's kilos, with
// nothing anywhere saying that only three days had been counted. Printed beside
// full weeks it is not a small error: it is a week that appears to have
// collapsed.
//
// So every row carries the interval it summed and whether that interval is the
// whole Monday-to-Sunday week. `partialWindow` is about the QUESTION being
// truncated, and it is a different fact from `finished`, which is about the week
// still running — a row can be either, both or neither, and a client that
// conflated them would badge the wrong ones.
const weekWindowCols = `GREATEST(s.week_start, $1::date) AS covered_from,
	LEAST(s.week_start + 6, $2::date)  AS covered_to,
	(GREATEST(s.week_start, $1::date) > s.week_start
	 OR LEAST(s.week_start + 6, $2::date) < s.week_start + 6) AS partial_window`

// add folds one row into a running total. It is how a grid's row totals,
// column totals and grand total are all derived from the same cells, so they
// cannot disagree with each other — and the tests still check that they do
// not, because deriving them together is a promise, not a proof.
func (t *Totals) add(o Totals) {
	t.Records += o.Records
	t.RecordsNotInKg += o.RecordsNotInKg
	t.RecordsWithoutValue += o.RecordsWithoutValue
	t.RecordsSpanningWeeks += o.RecordsSpanningWeeks
	t.ValueIsEstimate = t.ValueIsEstimate || o.ValueIsEstimate
	if o.Kg != nil {
		sum := *o.Kg
		if t.Kg != nil {
			sum += *t.Kg
		}
		t.Kg = &sum
	}
	if o.ValueCents != nil {
		sum := *o.ValueCents
		if t.ValueCents != nil {
			sum += *t.ValueCents
		}
		t.ValueCents = &sum
	}
}

// ---------------------------------------------------------------------------
// 1. The weeks
// ---------------------------------------------------------------------------

// ReportWeek is one line of the weekly list: WEEK_BY_DAY_SQL's aggregate,
// lifted a level to the week itself.
type ReportWeek struct {
	// WeekStart is the Monday, as a calendar day. Reports key on days and a
	// client indexes by this string; sending an instant for a day would make
	// which day it is depend on the reader's zone.
	WeekStart domain.Day `json:"weekStart"`
	Totals
	// Pickers and Days are counts of distinct people and distinct calendar
	// days that produced this row.
	Pickers int `json:"pickers"`
	Days    int `json:"days"`
	// PriceCents is what a unit was worth that week: the owner's override if
	// there is one, otherwise the farm's standing price. Nil only if the farm
	// has no standing price at all, which the schema does not allow — so a nil
	// here is a broken farm and says so rather than pricing the week at zero.
	PriceCents *int64 `json:"priceCents"`
	// Finished says the week is over. A running week's total is not comparable
	// with a finished one and the harvest reading drops it; a list that did
	// not mark it would invite the same mistake by eye.
	Finished bool `json:"finished"`

	// CoveredFrom and CoveredTo are the days this row actually summed: the
	// week, narrowed by the window the caller asked for. PartialWindow says
	// they are not the whole week.
	//
	// Without them a three-day question came back looking exactly like a
	// seven-day answer — same weekStart, same `finished: true`, a tenth of the
	// kilos — and next to full weeks that reads as a collapse rather than as a
	// shorter question.
	CoveredFrom   domain.Day `json:"coveredFrom"`
	CoveredTo     domain.Day `json:"coveredTo"`
	PartialWindow bool       `json:"partialWindow"`
}

const reportWeeksSQL = `
WITH ` + boundsCTE + `, ` + harvestCTE + `, ` + weekSeriesCTE + `
SELECT s.week_start, ` + totalsColsOuter + `,
       count(DISTINCT h.employee_id)::int AS pickers,
       count(DISTINCT h.local_day)::int   AS days,
       COALESCE(max(h.week_price_minor),
                (SELECT wp.price_minor FROM week_prices wp
                  WHERE wp.farm_id = current_farm() AND wp.week_start = s.week_start),
                (SELECT fc.price_minor FROM farm_config fc
                  WHERE fc.farm_id = current_farm())) AS price_minor,
       (s.week_start < (SELECT this_week FROM bounds)) AS finished,
       ` + weekWindowCols + `
  FROM series s
  LEFT JOIN harvest h ON h.week_start = s.week_start
 GROUP BY s.week_start
 ORDER BY s.week_start DESC
 LIMIT $3`

// ReportWeeks lists the weeks with their kilos and their value, newest first —
// every week between the first and the last, including the ones nobody worked.
//
// A week with no work is a row with `records: 0` and `kg: null`, not an absence.
// See weekSeriesCTE: an absence is what let a chart draw a straight line over a
// fortnight of rain and let the season reading compare two weeks that are not
// consecutive.
//
// The price of an empty week is still the price of that week. It comes from
// week_prices, or the farm's standing price, rather than from the weighings that
// are not there — a week nobody picked had a price all the same, and a null
// there would be a second absence pretending to be a fact.
func ReportWeeks(ctx context.Context, tx pgx.Tx, from, to *time.Time, limit int) ([]ReportWeek, error) {
	rows, err := tx.Query(ctx, reportWeeksSQL, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ReportWeek{}
	for rows.Next() {
		var w ReportWeek
		targets := append([]any{&w.WeekStart.Time}, w.Totals.scanTargets()...)
		targets = append(targets, &w.Pickers, &w.Days, &w.PriceCents, &w.Finished,
			&w.CoveredFrom.Time, &w.CoveredTo.Time, &w.PartialWindow)
		if err := rows.Scan(targets...); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// 2. One week in detail: the two grids
// ---------------------------------------------------------------------------

// GridCell is one worker's total under one column of a grid.
type GridCell struct {
	// Column is the day (grid by day) or the plot crop id (grid by crop). Nil
	// in the crop grid means the work could not be attributed to exactly one
	// crop — see Unattributed.
	Column *string `json:"column"`
	Totals
}

// GridRow is one worker across the columns, with their own total.
type GridRow struct {
	WorkerID string     `json:"workerId"`
	Name     string     `json:"name"`
	Cells    []GridCell `json:"cells"`
	Total    Totals     `json:"total"`
}

// GridColumn is one column's heading and its total down the page.
type GridColumn struct {
	// Key is the day as YYYY-MM-DD, or the plot crop id. Nil is the
	// unattributed column of the crop grid.
	Key   *string `json:"key"`
	Label string  `json:"label"`
	Total Totals  `json:"total"`
}

// Unattributed explains the crop grid's nil column, and only ever appears when
// that column exists. Without it the column would be a silent bucket and the
// reader would have no way to tell "nobody said which crop" from "two crops
// share the work".
type Unattributed struct {
	// NoCropLink: the record names no crop at all.
	NoCropLink int `json:"noCropLink"`
	// SharedAcrossCrops: the record names more than one, so attributing it to
	// either would double-count the grid or halve somebody's work on a guess.
	SharedAcrossCrops int `json:"sharedAcrossCrops"`
}

// Grid is a whole table: rows, columns, and one grand total that both agree
// with. The tests check the agreement in both directions, which is what the
// phone's own week tests check.
type Grid struct {
	Columns      []GridColumn  `json:"columns"`
	Rows         []GridRow     `json:"rows"`
	Total        Totals        `json:"total"`
	Unattributed *Unattributed `json:"unattributed,omitempty"`
}

// WeekDetail is the week the foreman actually asks about: not "how much did
// the week give" but "who was where, and did it show".
type WeekDetail struct {
	// Scope names what these figures cover: work paid by the unit of work.
	Scope     string     `json:"scope"`
	WeekStart domain.Day `json:"weekStart"`
	Finished  bool       `json:"finished"`
	// ByDay and ByCrop are the same weighings cut two ways, so their grand
	// totals are equal by construction and asserted equal by the tests.
	ByDay  Grid   `json:"byDay"`
	ByCrop Grid   `json:"byCrop"`
	Total  Totals `json:"total"`
}

const weekByDayCellsSQL = `
WITH ` + harvestCTE + `
SELECT h.employee_id::text,
       coalesce(e.name || ' ' || coalesce(e.last_name, ''), '?') AS name,
       to_char(h.local_day, 'YYYY-MM-DD') AS col, ` + totalsCols + `
  FROM harvest h
  JOIN employees e ON e.id = h.employee_id
 GROUP BY 1, 2, 3
 ORDER BY 2, 3`

const weekByCropCellsSQL = `
WITH ` + harvestCTE + `, ` + cropLinkCTE + `
SELECT h.employee_id::text,
       coalesce(e.name || ' ' || coalesce(e.last_name, ''), '?') AS name,
       cl.plot_crop_id::text AS col, ` + totalsCols + `,
       count(*) FILTER (WHERE cl.work_record_id IS NULL)::int AS no_link,
       count(*) FILTER (WHERE cl.crops > 1)::int              AS shared
  FROM harvest h
  JOIN employees e ON e.id = h.employee_id
  LEFT JOIN crop_link cl ON cl.work_record_id = h.id
 GROUP BY 1, 2, 3
 ORDER BY 2, 3`

// cropLabelsSQL names the columns of the crop grid the way a person would:
// the crop, its variety when there is one, and the plot it stands in.
const cropLabelsSQL = `
SELECT pc.id::text,
       ct.name || coalesce(' ' || v.name, '') || ' — ' || p.name
  FROM plot_crops pc
  JOIN crop_types ct ON ct.id = pc.crop_type_id
  JOIN plots p ON p.id = pc.plot_id
  LEFT JOIN varieties v ON v.id = pc.variety_id`

// ReportWeekDetail builds both grids for one week.
//
// The cells come from SQL; the row totals, the column totals and the grand
// total are folded from those same cells in Go. That is deliberate: a total
// computed by a second query is a second chance to be wrong, and the one
// property this screen has to have is that it adds up.
func ReportWeekDetail(ctx context.Context, tx pgx.Tx, monday time.Time) (*WeekDetail, error) {
	end := monday.AddDate(0, 0, 6)

	byDay, err := gridFromCells(ctx, tx, weekByDayCellsSQL, monday, end, nil)
	if err != nil {
		return nil, err
	}
	labels, err := cropLabels(ctx, tx)
	if err != nil {
		return nil, err
	}
	byCrop, err := gridFromCells(ctx, tx, weekByCropCellsSQL, monday, end, labels)
	if err != nil {
		return nil, err
	}

	var thisWeek time.Time
	if err := tx.QueryRow(ctx, `WITH `+boundsCTE+` SELECT this_week FROM bounds`).
		Scan(&thisWeek); err != nil {
		return nil, err
	}

	return &WeekDetail{
		Scope:     ScopeHarvest,
		WeekStart: domain.Day{Time: monday},
		Finished:  monday.Before(thisWeek),
		ByDay:     *byDay,
		ByCrop:    *byCrop,
		Total:     byDay.Total,
	}, nil
}

func cropLabels(ctx context.Context, tx pgx.Tx) (map[string]string, error) {
	rows, err := tx.Query(ctx, cropLabelsSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, label string
		if err := rows.Scan(&id, &label); err != nil {
			return nil, err
		}
		out[id] = label
	}
	return out, rows.Err()
}

// gridFromCells runs one cell query and folds it into a Grid. `labels` is nil
// for the day grid, whose column key is already its own label.
func gridFromCells(ctx context.Context, tx pgx.Tx, sql string,
	from, to time.Time, labels map[string]string) (*Grid, error) {

	rows, err := tx.Query(ctx, sql, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	grid := &Grid{Columns: []GridColumn{}, Rows: []GridRow{}}
	rowIndex := map[string]int{}
	colIndex := map[string]int{}
	var un Unattributed
	sawUnattributed := false

	for rows.Next() {
		var workerID, name string
		var col *string
		var cell GridCell
		targets := []any{&workerID, &name, &col}
		targets = append(targets, cell.Totals.scanTargets()...)
		var noLink, shared int
		if labels != nil {
			targets = append(targets, &noLink, &shared)
		}
		if err := rows.Scan(targets...); err != nil {
			return nil, err
		}
		cell.Column = col

		if col == nil {
			sawUnattributed = true
			un.NoCropLink += noLink
			un.SharedAcrossCrops += shared
		}

		// The row.
		ri, ok := rowIndex[workerID]
		if !ok {
			ri = len(grid.Rows)
			rowIndex[workerID] = ri
			grid.Rows = append(grid.Rows, GridRow{WorkerID: workerID, Name: name, Cells: []GridCell{}})
		}
		grid.Rows[ri].Cells = append(grid.Rows[ri].Cells, cell)
		grid.Rows[ri].Total.add(cell.Totals)

		// The column. A nil key sorts last and is keyed apart from any id.
		key := "\x00unattributed"
		if col != nil {
			key = *col
		}
		ci, ok := colIndex[key]
		if !ok {
			ci = len(grid.Columns)
			colIndex[key] = ci
			label := "Sin cultivo"
			if col != nil {
				label = *col
				if labels != nil {
					if l, found := labels[*col]; found {
						label = l
					}
				}
			}
			grid.Columns = append(grid.Columns, GridColumn{Key: col, Label: label})
		}
		grid.Columns[ci].Total.add(cell.Totals)

		grid.Total.add(cell.Totals)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	sortColumns(grid.Columns)
	if sawUnattributed {
		grid.Unattributed = &un
	}
	return grid, nil
}

// sortColumns puts the columns in a reading order: by key, with the
// unattributed one last so it reads as a footnote and not as a crop.
func sortColumns(cols []GridColumn) {
	for i := 1; i < len(cols); i++ {
		for j := i; j > 0 && columnLess(cols[j], cols[j-1]); j-- {
			cols[j], cols[j-1] = cols[j-1], cols[j]
		}
	}
}

func columnLess(a, b GridColumn) bool {
	if a.Key == nil {
		return false
	}
	if b.Key == nil {
		return true
	}
	return a.Label < b.Label
}

// ---------------------------------------------------------------------------
// 3. One crop
// ---------------------------------------------------------------------------

// CropReport is the port of CropReports.stats + .byWeek + .value.
type CropReport struct {
	Scope      string `json:"scope"`
	PlotCropID string `json:"plotCropId"`
	Label      string `json:"label"`
	Totals
	Pickers int         `json:"pickers"`
	Days    int         `json:"days"`
	FirstOn *domain.Day `json:"firstOn"`
	LastOn  *domain.Day `json:"lastOn"`
	// AreaHa and KgPerHa: the one agronomic number the schema already holds.
	// KgPerHa is nil when the area was never declared or the kilos are not
	// known, rather than a zero that reads as a barren plot.
	AreaHa  *float64 `json:"areaHa"`
	KgPerHa *float64 `json:"kgPerHa"`
	// SharedRecords counts weighings on this crop that also name another one.
	// Their kilos are counted here in full, so the reader has to know that the
	// same kilos may appear under a second crop as well.
	SharedRecords int `json:"sharedRecords"`

	// Weeks is the cap the caller asked for, and CoveredFrom/CoveredTo are the
	// window the figures above actually cover. All three are on the wire
	// because of what they used to hide.
	//
	// Every figure in the header — records, kilos, value, pickers, days,
	// firstOn, lastOn, kgPerHa — was summed over the crop's ENTIRE history,
	// with no window at all, while byWeek underneath it showed the last twelve
	// weeks. So a lot picked for two seasons answered `?weeks=4` with a header
	// worth two seasons sitting on top of four weeks of rows, and the screen
	// had nothing to tell it from a month that produced eight tonnes. This is
	// audit finding A4 in another building: a figure summed over one thing and
	// labelled as another.
	//
	// The header now covers exactly the weeks in byWeek. PartialWindow says
	// whether `weeks` cut anything off — whether this crop has older weeks the
	// caller is not being shown — so a total can never be read as the whole
	// crop unless it is one. All three are null/false when byWeek is empty:
	// there is no window over nothing.
	Weeks         int         `json:"weeks"`
	CoveredFrom   *domain.Day `json:"coveredFrom"`
	CoveredTo     *domain.Day `json:"coveredTo"`
	PartialWindow bool        `json:"partialWindow"`

	// ByWeek is the evolution, newest first.
	ByWeek []CropWeek `json:"byWeek"`
}

// CropWeek is one week of one crop.
type CropWeek struct {
	WeekStart domain.Day `json:"weekStart"`
	Totals
	Pickers  int  `json:"pickers"`
	Days     int  `json:"days"`
	Finished bool `json:"finished"`
}

const cropStatsSQL = `
WITH ` + harvestCTE + `, ` + cropLinkCTE + `
SELECT ` + totalsCols + `,
       count(DISTINCT h.employee_id)::int AS pickers,
       count(DISTINCT h.local_day)::int   AS days,
       min(h.local_day), max(h.local_day),
       count(*) FILTER (WHERE cl.crops > 1)::int AS shared
  FROM harvest h
  JOIN work_record_plot_crops c ON c.work_record_id = h.id AND c.plot_crop_id = $3
  LEFT JOIN crop_link cl ON cl.work_record_id = h.id`

// cropWeeksSQL draws one crop's weeks on the same calendar the farm's list uses,
// and for the same reason: a lot that yielded nothing for a fortnight has to
// look like a lot that yielded nothing for a fortnight, not like a lot that was
// picked every week.
//
// The crop narrowing moves into a CTE of its own so that the span — where the
// series starts and stops — is THIS CROP's first and last week, and not the
// farm's. Otherwise a plot picked for three weeks of a six-month season would
// come back as twenty-odd empty rows with three real ones buried in them.
const cropWeeksSQL = `
WITH ` + boundsCTE + `, ` + harvestCTE + `,
crop_harvest AS (
  SELECT h.* FROM harvest h
    JOIN work_record_plot_crops c ON c.work_record_id = h.id AND c.plot_crop_id = $3
),
span AS (
  SELECT GREATEST(week_start($1::date), (SELECT min(week_start) FROM crop_harvest)) AS lo,
         LEAST(week_start($2::date),    (SELECT max(week_start) FROM crop_harvest)) AS hi
),
series AS (
  SELECT gs::date AS week_start
    FROM span, generate_series(span.lo::timestamp, span.hi::timestamp,
                               interval '7 day') gs
   WHERE span.lo IS NOT NULL AND span.hi IS NOT NULL
)
SELECT s.week_start, ` + totalsColsOuter + `,
       count(DISTINCT h.employee_id)::int AS pickers,
       count(DISTINCT h.local_day)::int   AS days,
       (s.week_start < (SELECT this_week FROM bounds)) AS finished
  FROM series s
  LEFT JOIN crop_harvest h ON h.week_start = s.week_start
 GROUP BY s.week_start
 ORDER BY s.week_start DESC
 LIMIT $4`

// ReportCrop answers for one crop. The crop is confirmed to be ours FIRST:
// every figure below is a SUM, and a sum over another farm's id comes back as
// a perfectly plausible "this crop produced nothing".
//
// The header and byWeek cover THE SAME WEEKS. The weeks are therefore read
// first and the window they describe is what the header is then summed over —
// see the note on CropReport.Weeks for what the two of them used to disagree
// about.
func ReportCrop(ctx context.Context, tx pgx.Tx, plotCropID string, weeks int) (*CropReport, error) {
	out := CropReport{Scope: ScopeHarvest, PlotCropID: plotCropID, ByWeek: []CropWeek{}}
	err := tx.QueryRow(ctx, `
		SELECT pc.id::text,
		       ct.name || coalesce(' ' || v.name, '') || ' — ' || p.name,
		       pc.area_ha::float8
		  FROM plot_crops pc
		  JOIN crop_types ct ON ct.id = pc.crop_type_id
		  JOIN plots p ON p.id = pc.plot_id
		  LEFT JOIN varieties v ON v.id = pc.variety_id
		 WHERE pc.id = $1`, plotCropID).Scan(&out.PlotCropID, &out.Label, &out.AreaHa)
	if err != nil {
		return nil, err
	}

	// The weeks come FIRST, because they decide the window the header is then
	// summed over. One week more than the caller asked for is fetched and
	// thrown away: it is the cheapest honest answer to "is there more of this
	// crop than I am being shown", and it costs one row rather than a second
	// query over the whole span.
	out.Weeks = weeks
	rows, err := tx.Query(ctx, cropWeeksSQL, nil, nil, plotCropID, weeks+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var w CropWeek
		t := append([]any{&w.WeekStart.Time}, w.Totals.scanTargets()...)
		t = append(t, &w.Pickers, &w.Days, &w.Finished)
		if err := rows.Scan(t...); err != nil {
			return nil, err
		}
		out.ByWeek = append(out.ByWeek, w)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out.ByWeek) > weeks {
		out.ByWeek = out.ByWeek[:weeks]
		out.PartialWindow = true
	}

	// The window, in local days, taken from the rows themselves: the oldest
	// Monday shown, to the Sunday of the newest. byWeek is newest first, so
	// the oldest is last.
	var from, to *time.Time
	if n := len(out.ByWeek); n > 0 {
		lo := out.ByWeek[n-1].WeekStart.Time
		hi := out.ByWeek[0].WeekStart.Time.AddDate(0, 0, 6)
		from, to = &lo, &hi
		out.CoveredFrom, out.CoveredTo = asDay(from), asDay(to)
	}

	var firstOn, lastOn *time.Time
	targets := out.Totals.scanTargets()
	targets = append(targets, &out.Pickers, &out.Days, &firstOn, &lastOn, &out.SharedRecords)
	if err := tx.QueryRow(ctx, cropStatsSQL, from, to, plotCropID).Scan(targets...); err != nil {
		return nil, err
	}
	out.FirstOn, out.LastOn = asDay(firstOn), asDay(lastOn)
	if out.Kg != nil && out.AreaHa != nil && *out.AreaHa > 0 {
		v := *out.Kg / *out.AreaHa
		out.KgPerHa = &v
	}
	return &out, nil
}

// ---------------------------------------------------------------------------
// 4. The performance index
// ---------------------------------------------------------------------------

// WorkerPerformance is one picker's line. This is the most dangerous object in
// the file: it is the number a farm would use to decide who not to hire again,
// and it shipped on the phone with three statistical defects at once.
type WorkerPerformance struct {
	WorkerID string `json:"workerId"`
	Name     string `json:"name"`
	Totals
	Days int `json:"days"`
	// KgPerDay measures effective output — not per weighing, which only says
	// how big a sack somebody carries, and not total kilos, which rewards
	// attendance. Nil when the kilos are not known.
	KgPerDay *float64 `json:"kgPerDay"`

	// Index is the comparative index: this person against the mates who worked
	// the SAME crop on the SAME day, with this person taken OUT of the
	// benchmark, averaged over daily ratios rather than divided out of sums.
	//
	// Nil is the whole point of the field being a pointer. A picker with no
	// comparable days has no index, and printing 0.0 beside their name would
	// be an accusation the data does not support. Reason says which it is.
	Index          *float64 `json:"index"`
	ComparableDays int      `json:"comparableDays"`
	Reason         string   `json:"reason,omitempty"`

	// Trend is the same index split into two halves of the window: above 1 is
	// improving, below 1 is slipping. Nil unless both halves have enough days
	// to mean anything.
	Trend *float64 `json:"trend"`
}

// Reasons an index could not be computed. They are codes, not sentences: the
// translation lives in the client like every other code in this contract.
const (
	ReasonFewComparableDays = "not_enough_comparable_days"
	ReasonNoKilos           = "no_records_in_kilos"
)

// MinComparableDays is the phone's threshold, and it is the difference between
// an index and an anecdote.
const MinComparableDays = 3

// performanceCrewSQL is the port of Performance.crew's first query: kilos and
// days worked per person over the window.
const performanceCrewSQL = `
WITH ` + harvestCTE + `
SELECT h.employee_id::text,
       coalesce(e.name || ' ' || coalesce(e.last_name, ''), '?') AS name,
       ` + totalsCols + `,
       count(DISTINCT h.local_day)::int AS days
  FROM harvest h
  JOIN employees e ON e.id = h.employee_id
 GROUP BY 1, 2`

// performanceIndexSQL is INDEX_SQL, plus the two-window trend that
// Performance.crew ran as a SECOND query over the same CTEs.
//
// Three things had to be right on the phone and none of them were at first,
// and all three are preserved here verbatim:
//
//   - the same window as the kg/day figure, or the list shows a lifetime index
//     next to a 28-day rate and nobody can reconcile them;
//   - the person is EXCLUDED from their own benchmark — `(tot - kg)/(n - 1)`.
//     Including them drags everyone toward 1.0 by an amount that depends on
//     how big the crew was, which reorders people across groups;
//   - an AVERAGE OF DAILY RATIOS, not a ratio of sums, so a day on a heavy
//     plot does not outweigh nine days on a light one.
//
// The arithmetic runs in float8 rather than numeric, to be the same arithmetic
// the phone's REAL columns do. Two dialect notes:
//
//   - `base.n >= 3`: fewer than three people on a crop that day is not a
//     comparison, it is an anecdote.
//   - the trend needed a second query on SQLite; Postgres does it with FILTER
//     in the same pass, which is the one place this port is simpler than its
//     original rather than more complicated.
const performanceIndexSQL = `
WITH ` + harvestCTE + `,
dw AS (
  SELECT h.employee_id, c.plot_crop_id, h.local_day AS d, sum(h.kg) AS kg
    FROM harvest h
    JOIN work_record_plot_crops c ON c.work_record_id = h.id
   WHERE h.kg IS NOT NULL
   GROUP BY 1, 2, 3
),
base AS (
  SELECT plot_crop_id, d, sum(kg) AS tot, count(*) AS n FROM dw GROUP BY 1, 2
),
j AS (
  SELECT dw.employee_id, dw.d,
         dw.kg / nullif((base.tot - dw.kg) / (base.n - 1), 0) AS ratio
    FROM dw
    JOIN base ON base.plot_crop_id = dw.plot_crop_id AND base.d = dw.d
   WHERE base.n >= 3
)
SELECT employee_id::text,
       avg(ratio)                                        AS irl,
       count(DISTINCT d)::int                            AS comparable_days,
       avg(ratio) FILTER (WHERE d >= $3::date)           AS recent,
       avg(ratio) FILTER (WHERE d <  $3::date)           AS earlier,
       count(*) FILTER (WHERE d >= $3::date)::int        AS recent_days,
       count(*) FILTER (WHERE d <  $3::date)::int        AS earlier_days
  FROM j
 GROUP BY 1`

// ReportPerformance runs the index over the last `days` days of the farm's own
// calendar. It returns everybody who worked in the window, index or no index:
// leaving out the people with too little evidence would make the list look
// like a ranking of everyone rather than of the comparable few.
func ReportPerformance(ctx context.Context, tx pgx.Tx, days int) ([]WorkerPerformance, time.Time, error) {
	var since, half time.Time
	err := tx.QueryRow(ctx, `
		WITH `+boundsCTE+`
		SELECT today - $1::int, today - ($1::int / 2) FROM bounds`, days).Scan(&since, &half)
	if err != nil {
		return nil, since, err
	}

	rows, err := tx.Query(ctx, performanceCrewSQL, since, nil)
	if err != nil {
		return nil, since, err
	}
	defer rows.Close()

	out := []WorkerPerformance{}
	index := map[string]int{}
	for rows.Next() {
		var p WorkerPerformance
		t := []any{&p.WorkerID, &p.Name}
		t = append(t, p.Totals.scanTargets()...)
		t = append(t, &p.Days)
		if err := rows.Scan(t...); err != nil {
			return nil, since, err
		}
		if p.Kg != nil && p.Days > 0 {
			v := *p.Kg / float64(p.Days)
			p.KgPerDay = &v
		}
		p.Reason = ReasonFewComparableDays
		if p.Kg == nil {
			p.Reason = ReasonNoKilos
		}
		index[p.WorkerID] = len(out)
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, since, err
	}

	idx, err := tx.Query(ctx, performanceIndexSQL, since, nil, half)
	if err != nil {
		return nil, since, err
	}
	defer idx.Close()
	for idx.Next() {
		var id string
		var irl, recent, earlier *float64
		var comparable, recentDays, earlierDays int
		if err := idx.Scan(&id, &irl, &comparable, &recent, &earlier, &recentDays, &earlierDays); err != nil {
			return nil, since, err
		}
		i, ok := index[id]
		if !ok {
			continue
		}
		p := &out[i]
		p.ComparableDays = comparable
		if comparable >= MinComparableDays && irl != nil {
			p.Index = irl
			p.Reason = ""
		}
		// Both halves need enough days, or the arrow is decided against a
		// single outlying day. The phone's floor is four, and so is this.
		if recent != nil && earlier != nil && *earlier != 0 && recentDays >= 4 && earlierDays >= 4 {
			t := *recent / *earlier
			p.Trend = &t
		}
	}
	if err := idx.Err(); err != nil {
		return nil, since, err
	}

	// Best index first, and everybody without one after them — never
	// interleaved, because a missing index is not a low one.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && performanceLess(out[j], out[j-1]); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, since, nil
}

func performanceLess(a, b WorkerPerformance) bool {
	if a.Index == nil && b.Index == nil {
		return a.Name < b.Name
	}
	if a.Index == nil {
		return false
	}
	if b.Index == nil {
		return true
	}
	return *a.Index > *b.Index
}

// ---------------------------------------------------------------------------
// 5. The review rules
// ---------------------------------------------------------------------------
//
// Deliberately simple and explainable. Accusing a worker with a number nobody
// can justify out loud destroys the trust the whole system runs on, so there
// is no model here — just thresholds anyone can check.
//
// Two of these carried bugs that a season of data found, and both fixes are
// carried over rather than re-derived:
//
//   - THE EXTRA-ZERO RULE WAS ALGEBRAICALLY UNABLE TO FIRE. Its reference
//     included the suspect row, so the outlier inflated the very average it was
//     compared against: `w >= 10*avg` reduces to `n+1 >= n+10`, false for every
//     n. The reference now excludes the row — `(s - w)/(n - 1)`.
//   - THE CREW RULE WAS A QUADRATIC SELF-JOIN. Every pickup was joined against
//     every other pickup of its plot-day, which took 10.8 seconds on 18,000
//     weighings. The mates' average is now derived from the group's total minus
//     this row: same answers, one pass.
//
// The window: the phone needs two bounds per rule because `date(col,'localtime')`
// cannot use an index. Here `local_day` IS the column, so there is one bound
// and it is the correct one. What the window changes is what is worth SHOWING;
// it deliberately does not change any reference value — the extra-zero rule
// still measures a load against this person's whole history.

// Anomaly is one weighing worth a second look.
type Anomaly struct {
	RecordID string     `json:"recordId"`
	WorkerID string     `json:"workerId"`
	Worker   string     `json:"worker"`
	Crop     *string    `json:"crop"`
	Quantity float64    `json:"quantity"`
	Kg       *float64   `json:"kg"`
	LocalDay domain.Day `json:"date"`
	Rule     string     `json:"rule"`
	// Reference is what the quantity was judged against: the ceiling for
	// `impossible`, the person's other loads for `digit`, the mates' average
	// for `outlier`, the twin's own weight for `duplicate`. Nil for `future`,
	// where there is nothing to compare against — the phone put a 0 there and
	// a 0 in this field would read as "compared against nothing", which is
	// exactly the zero this contract does not allow.
	Reference *float64 `json:"reference"`
}

// Rule names, on the wire.
const (
	RuleImpossible = "impossible"
	RuleDuplicate  = "duplicate"
	RuleDigit      = "digit"
	RuleOutlier    = "outlier"
	RuleFuture     = "future"
)

// anomalyCols is the identity every rule reports, so a finding can be acted on
// without a second round trip.
const anomalyCols = `h.id::text, h.employee_id::text,
	coalesce(e.name || ' ' || coalesce(e.last_name, ''), '?'),
	(SELECT ct.name || coalesce(' ' || v.name, '') || ' — ' || p.name
	   FROM work_record_plot_crops c
	   JOIN plot_crops pc ON pc.id = c.plot_crop_id
	   JOIN crop_types ct ON ct.id = pc.crop_type_id
	   JOIN plots p ON p.id = pc.plot_id
	   LEFT JOIN varieties v ON v.id = pc.variety_id
	  WHERE c.work_record_id = h.id LIMIT 1),
	h.quantity::float8, h.kg, h.local_day`

// ruleImpossibleSQL: physically impossible for one person to carry.
//
// The phone also tests `weight <= 0`. Here `quantity > 0` is a CHECK on the
// table, so that half can never fire — it is kept anyway, because a rule that
// silently depends on a constraint elsewhere is a rule that stops working the
// day the constraint is relaxed.
//
// The ceiling is in KILOS, so a record whose unit does not convert cannot be
// judged by it and is not accused.
const ruleImpossibleSQL = `
WITH ` + harvestCTE + `
SELECT ` + anomalyCols + `, $3::float8
  FROM harvest h
  JOIN employees e ON e.id = h.employee_id
 WHERE h.quantity <= 0 OR h.kg > $3::float8
 ORDER BY h.local_day DESC
 LIMIT $4`

// ruleDuplicateSQL: the same weighing saved twice within three minutes.
//
// The phone's `b.id < a.id` is chronological on AUTOINCREMENT integers. Our
// ids are random UUIDs, so it would pick an arbitrary member of each pair and
// report whichever it happened to be. `(created_at, id)` is a total order that
// follows the clock, so the SECOND of the pair is the suspect, every time.
//
// `IS NOT DISTINCT FROM` on the crop keeps the phone's "same person, same
// plot, same weight" and treats two uncropped weighings as the same plot,
// which is what a NULL = NULL comparison would silently fail to do.
//
// ix_work_records_dup is what makes this a lookup rather than the quadratic
// scan that made this one rule cost more than the other four together.
const ruleDuplicateSQL = `
WITH ` + harvestCTE + `, ` + cropLinkCTE + `
SELECT ` + anomalyCols + `, h.quantity::float8
  FROM harvest h
  JOIN employees e ON e.id = h.employee_id
  LEFT JOIN crop_link ca ON ca.work_record_id = h.id
 WHERE EXISTS (
   SELECT 1
     FROM harvest b
     LEFT JOIN crop_link cb ON cb.work_record_id = b.id
    WHERE b.employee_id = h.employee_id
      AND b.quantity = h.quantity
      AND cb.plot_crop_id IS NOT DISTINCT FROM ca.plot_crop_id
      AND (b.created_at, b.id) < (h.created_at, h.id)
      AND h.created_at - b.created_at <= interval '3 minutes')
 ORDER BY h.local_day DESC
 LIMIT $3`

// ruleDigitSQL: far above what this person usually carries — a typed extra
// zero. See the note above: the reference excludes the suspect row, which is
// the fix that made the rule able to fire at all.
//
// The reference is still the person's WHOLE history and not just the window:
// the window decides what is worth showing, never what a normal load for this
// person is. `tot` is therefore computed with no window at all.
const ruleDigitSQL = `
WITH ` + harvestCTE + `,
all_time AS (
  SELECT l.employee_id, sum(l.quantity * u.kg_factor) AS s, count(*) AS n
    FROM work_records l
    JOIN work_units u ON u.id = l.unit_id
   WHERE l.deleted_at IS NULL AND l.pay_scheme = 'unidad_trabajo' AND u.kg_factor IS NOT NULL
   GROUP BY 1
)
SELECT ` + anomalyCols + `,
       ((t.s - h.kg) / nullif(t.n - 1, 0))::float8
  FROM harvest h
  JOIN all_time t ON t.employee_id = h.employee_id
  JOIN employees e ON e.id = h.employee_id
 WHERE h.kg IS NOT NULL
   AND (t.s - h.kg) / nullif(t.n - 1, 0) > 0
   AND h.kg >= 4 * ((t.s - h.kg) / nullif(t.n - 1, 0))
 ORDER BY h.local_day DESC
 LIMIT $3`

// ruleOutlierSQL: far above what the rest of the crew did on that crop that
// day. This is the one that catches a bad weighing on somebody whose own
// history is too short for the rule above to have anything to work with.
//
// The mates' average is derived from the group's total minus this row rather
// than by joining every weighing against every other weighing of its plot-day.
// That join is quadratic INSIDE EACH GROUP: with one season of data it took
// 10.8 seconds. Same results, one pass.
//
// The window goes on the inner CTE, not on the final SELECT: a plot-day is
// either wholly inside the window or wholly outside it, so the mates' total
// and headcount come out identical for every day that is kept.
const ruleOutlierSQL = `
WITH ` + harvestCTE + `,
dayplot AS (
  SELECT h.id, h.employee_id, c.plot_crop_id, h.kg, h.local_day
    FROM harvest h
    JOIN work_record_plot_crops c ON c.work_record_id = h.id
   WHERE h.kg IS NOT NULL
),
agg AS (
  SELECT plot_crop_id, local_day, sum(kg) AS tot, count(*) AS n
    FROM dayplot GROUP BY 1, 2
)
SELECT ` + anomalyCols + `,
       ((agg.tot - dp.kg) / (agg.n - 1))::float8
  FROM dayplot dp
  JOIN agg ON agg.plot_crop_id = dp.plot_crop_id AND agg.local_day = dp.local_day
  JOIN harvest h ON h.id = dp.id
  JOIN employees e ON e.id = h.employee_id
 WHERE agg.n >= 5
   AND (agg.tot - dp.kg) / (agg.n - 1) > 0
   AND dp.kg >= 4 * ((agg.tot - dp.kg) / (agg.n - 1))
 ORDER BY h.local_day DESC
 LIMIT $3`

// ruleFutureSQL: dated after today — a wrong clock or a typo. "Today" is the
// farm's today, not the server's; on a UTC server the phone's `date('now',
// 'localtime')` would flag a whole evening's work in Bogota as being from
// tomorrow.
const ruleFutureSQL = `
WITH ` + boundsCTE + `, ` + harvestCTE + `
SELECT ` + anomalyCols + `, NULL::float8
  FROM harvest h
  JOIN employees e ON e.id = h.employee_id
 WHERE h.local_day > (SELECT today FROM bounds)
 ORDER BY h.local_day DESC
 LIMIT $3`

// AnomalyWindow mirrors DEFAULT_ANOMALY_WINDOW on the phone: one harvest
// season back, and no more findings than anyone will read.
const (
	DefaultAnomalyDays  = 120
	DefaultAnomalyLimit = 200
	DefaultMaxKg        = 120.0
)

// ReportAnomalies runs all five rules and reports each weighing once, worst
// first. One weighing can break more than one rule; the order the rules are
// run in IS the severity order, exactly as on the phone.
func ReportAnomalies(ctx context.Context, tx pgx.Tx, sinceDays int, maxKg float64, limit int) ([]Anomaly, time.Time, error) {
	var since time.Time
	if err := tx.QueryRow(ctx, `WITH `+boundsCTE+` SELECT today - $1::int FROM bounds`,
		sinceDays).Scan(&since); err != nil {
		return nil, since, err
	}

	run := func(sql, rule string, extra ...any) ([]Anomaly, error) {
		args := append([]any{since, nil}, extra...)
		args = append(args, limit)
		rows, err := tx.Query(ctx, sql, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []Anomaly
		for rows.Next() {
			a := Anomaly{Rule: rule}
			if err := rows.Scan(&a.RecordID, &a.WorkerID, &a.Worker, &a.Crop,
				&a.Quantity, &a.Kg, &a.LocalDay.Time, &a.Reference); err != nil {
				return nil, err
			}
			out = append(out, a)
		}
		return out, rows.Err()
	}

	var all []Anomaly
	for _, r := range []struct {
		sql, rule string
		extra     []any
	}{
		{ruleImpossibleSQL, RuleImpossible, []any{maxKg}},
		{ruleDuplicateSQL, RuleDuplicate, nil},
		{ruleDigitSQL, RuleDigit, nil},
		{ruleOutlierSQL, RuleOutlier, nil},
		{ruleFutureSQL, RuleFuture, nil},
	} {
		found, err := run(r.sql, r.rule, r.extra...)
		if err != nil {
			return nil, since, err
		}
		all = append(all, found...)
	}

	seen := map[string]bool{}
	out := []Anomaly{}
	for _, a := range all {
		if seen[a.RecordID] {
			continue
		}
		seen[a.RecordID] = true
		out = append(out, a)
		if len(out) >= limit {
			break
		}
	}
	return out, since, nil
}

// ---------------------------------------------------------------------------
// 6. The harvest curve
// ---------------------------------------------------------------------------

// HarvestCurve is the weekly series plus the reading of it. The reading itself
// is domain.ReadHarvest, the Go twin of packages/shared/src/harvest.ts — pure,
// and tested against the same cases.
type HarvestCurve struct {
	Scope string `json:"scope"`
	// PlotCropID is nil for the whole farm.
	PlotCropID  *string             `json:"plotCropId"`
	CurrentWeek domain.Day          `json:"currentWeek"`
	Weeks       []domain.WeekTotal  `json:"weeks"`
	Shape       domain.HarvestShape `json:"shape"`
	// WeeksWithoutKilos counts weeks that HAD work and whose kilos could not be
	// established — every weighing in them was taken in a unit with no
	// conversion. They are in the series and out of the reading.
	WeeksWithoutKilos int `json:"weeksWithoutKilos"`
	// WeeksWithoutRecords counts weeks in which nothing was recorded at all.
	//
	// It is a separate number from the one above and not a refinement of it,
	// because the two are different facts and a client may want to say
	// different things about them: "we could not price what you weighed" is a
	// unit that needs a kg_factor, and "there is nothing here" is a fortnight
	// nobody picked, or nobody wrote down.
	//
	// It used to be neither, because the week was not in the series at all: the
	// list skipped it, weeksWithoutKilos counted 0, and the curve joined the
	// weeks either side of it into a straight line. A hole that reports itself
	// as no holes is the exact shape of error this whole file is written
	// against.
	WeeksWithoutRecords int `json:"weeksWithoutRecords"`
}

const harvestCurveSQL = `
WITH ` + boundsCTE + `, ` + harvestCTE + `,
sel AS (
  SELECT h.* FROM harvest h
   WHERE ($3::uuid IS NULL OR EXISTS (
           SELECT 1 FROM work_record_plot_crops c
            WHERE c.work_record_id = h.id AND c.plot_crop_id = $3))
),
span AS (
  SELECT GREATEST(week_start($1::date), (SELECT min(week_start) FROM sel)) AS lo,
         LEAST(week_start($2::date),    (SELECT max(week_start) FROM sel)) AS hi
),
series AS (
  SELECT gs::date AS week_start
    FROM span, generate_series(span.lo::timestamp, span.hi::timestamp,
                               interval '7 day') gs
   WHERE span.lo IS NOT NULL AND span.hi IS NOT NULL
)
SELECT s.week_start, sum(h.kg)::float8 AS kg, count(h.id)::int AS records
  FROM series s
  LEFT JOIN sel h ON h.week_start = s.week_start
 GROUP BY s.week_start
 ORDER BY s.week_start DESC
 LIMIT $4`

// ReportHarvestCurve reads the shape of the harvest: where the peak was, how
// many finished weeks have fallen since, and whether the season is ending.
func ReportHarvestCurve(ctx context.Context, tx pgx.Tx, plotCropID *string, weeks int) (*HarvestCurve, error) {
	out := HarvestCurve{Scope: ScopeHarvest, PlotCropID: plotCropID, Weeks: []domain.WeekTotal{}}
	if err := tx.QueryRow(ctx, `WITH `+boundsCTE+` SELECT this_week FROM bounds`).
		Scan(&out.CurrentWeek.Time); err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, harvestCurveSQL, nil, nil, plotCropID, weeks)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var w domain.WeekTotal
		var monday time.Time
		if err := rows.Scan(&monday, &w.Kg, &w.Records); err != nil {
			return nil, err
		}
		w.WeekStart = monday.Format("2006-01-02")
		switch {
		case w.Records == 0:
			out.WeeksWithoutRecords++
		case w.Kg == nil:
			out.WeeksWithoutKilos++
		}
		out.Weeks = append(out.Weeks, w)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out.Shape = domain.ReadHarvest(out.Weeks, out.CurrentWeek.Format("2006-01-02"),
		domain.DefaultDropThreshold)
	return &out, nil
}

// asDay turns a nullable scanned date into the calendar day the wire carries.
func asDay(t *time.Time) *domain.Day {
	if t == nil {
		return nil
	}
	return &domain.Day{Time: *t}
}

// PlotCropExists confirms a crop belongs to this farm before anything is
// summed over it. RLS makes another farm's row invisible, so a miss is
// pgx.ErrNoRows and becomes the ordinary 404 — never an empty report that
// reads as "this crop produced nothing".
func PlotCropExists(ctx context.Context, tx pgx.Tx, id string) error {
	var found string
	return tx.QueryRow(ctx, `SELECT id::text FROM plot_crops WHERE id = $1`, id).Scan(&found)
}
