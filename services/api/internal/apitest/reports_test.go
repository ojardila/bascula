package apitest

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// The reports.
//
// What is pinned here is what the phone's own suites pin, translated case for
// case, because these six endpoints are a PORT and a port that is not compared
// against its original is a rewrite:
//
//   - apps/mobile/src/performance.test.ts — the comparative index, which
//     shipped with three statistical defects at once and is the number a farm
//     would use to decide who not to hire again;
//   - apps/mobile/src/review.test.ts — the five review rules, each of which
//     has to be shown actually FIRING, because the extra-zero rule spent
//     several versions algebraically unable to;
//   - packages/shared/src/harvest.test.ts, already translated in
//     internal/domain/harvest_test.go.
//
// Plus the two properties the phone never had to have and this contract does:
// the grids add up by rows AND by columns, and no figure is ever a zero that
// means "I do not know".

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

// weighing is one seeded harvest record. It goes in through SQL and not
// through /v1/work-records for one reason only: created_at. The duplicate rule
// turns on minutes, and two records written over HTTP in the same test are
// always milliseconds apart, so "forty minutes later" cannot be expressed
// through the door. Everything else about the row — the trigger that computes
// local_day in the farm's zone, the generated week_start, every CHECK — runs
// exactly as it does for a real write.
type weighing struct {
	worker   string
	plotCrop string // "" for a weighing that names no crop
	day      string // YYYY-MM-DD in the farm's calendar
	qty      float64
	// createdAtOffset shifts created_at from the day's noon. Only the
	// duplicate rule reads it.
	createdAtOffset time.Duration
	// unitID overrides the farm's kilo unit. Used to seed a weighing that
	// cannot be converted to kilos at all.
	unitID string
}

// seedWeighings writes the rows and returns their ids in order.
func (h *harness) seedWeighings(t *testing.T, f *farmFixture, ws []weighing) []string {
	t.Helper()
	activityID := h.harvestActivityID(t, f)

	var ids []string
	err := h.withTenantCommit(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
		func(ctx context.Context, tx pgx.Tx) error {
			var defaultUnit string
			if err := tx.QueryRow(ctx,
				`SELECT unit_id::text FROM activities WHERE id = $1`, activityID).
				Scan(&defaultUnit); err != nil {
				return err
			}
			for _, wg := range ws {
				id := uuid.NewString()
				unit := wg.unitID
				if unit == "" {
					unit = defaultUnit
				}
				// Noon in the farm's zone, so a daylight shift can never file
				// the row on the day before — the same reason
				// InstantForLocalDay picks midday.
				_, err := tx.Exec(ctx, `
					INSERT INTO work_records
					  (id, farm_id, employee_id, activity_id, pay_scheme, rate_source,
					   started_at, ended_at, quantity, unit_id, created_by, created_at)
					SELECT $1, $2, $3, $4, 'unidad_trabajo', 'weekly_price',
					       ($5::date + time '12:00') AT TIME ZONE f.timezone,
					       ($5::date + time '12:00') AT TIME ZONE f.timezone,
					       $6, $7, $8,
					       (($5::date + time '12:00') AT TIME ZONE f.timezone) + $9::interval
					  FROM farms f WHERE f.id = $2`,
					id, f.FarmID, wg.worker, activityID, wg.day, wg.qty, unit,
					f.OwnerUserID, fmt.Sprintf("%d seconds", int(wg.createdAtOffset.Seconds())))
				if err != nil {
					return err
				}
				if wg.plotCrop != "" {
					if _, err := tx.Exec(ctx, `
						INSERT INTO work_record_plot_crops (work_record_id, plot_crop_id, farm_id)
						VALUES ($1, $2, $3)`, id, wg.plotCrop, f.FarmID); err != nil {
						return err
					}
				}
				ids = append(ids, id)
			}
			return nil
		})
	if err != nil {
		t.Fatalf("seed weighings: %v", err)
	}
	return ids
}

// linkCrop adds a SECOND crop to a weighing, which is the case the phone
// cannot have: there a pickup carries one cropId.
func (h *harness) linkCrop(t *testing.T, f *farmFixture, recordID, plotCropID string) {
	t.Helper()
	err := h.withTenantCommit(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
		func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `
				INSERT INTO work_record_plot_crops (work_record_id, plot_crop_id, farm_id)
				VALUES ($1, $2, $3)`, recordID, plotCropID, f.FarmID)
			return err
		})
	if err != nil {
		t.Fatalf("link second crop: %v", err)
	}
}

// createPlotCrop makes a plot with one crop in it and returns the CROP's id,
// which is what a work record and every report point at.
func (h *harness) createPlotCrop(t *testing.T, f *farmFixture, plotName, cropType string) string {
	t.Helper()
	res := h.mustDo(t, http.MethodPost, "/v1/plots", f.OwnerToken, map[string]any{
		"name": plotName, "areaHa": 2.0,
		// The hectares go on the CROP, not only on the plot: kgPerHa is
		// deliberately not allowed to borrow the plot's area, because a plot
		// with two crops would hand the whole area to each of them.
		"crops": []map[string]any{{"cropType": cropType, "variety": "Castillo", "areaHa": 2.0}},
	}, http.StatusCreated)
	crops, _ := res.Body["crops"].([]any)
	if len(crops) == 0 {
		t.Fatalf("plot came back with no crops: %s", res.Raw)
	}
	return crops[0].(map[string]any)["id"].(string)
}

// createUnitWithoutKgFactor gives the farm a work unit that does NOT convert
// to kilos — a "canasta", which is exactly the catalogue value the decision of
// 2026-08-29 says a farm is free to invent.
func (h *harness) createUnitWithoutKgFactor(t *testing.T, f *farmFixture) string {
	t.Helper()
	res := h.mustDo(t, http.MethodPost, "/v1/catalogs/work-units", f.OwnerToken, map[string]any{
		"code": "canasta", "label": "Canasta",
	}, http.StatusOK)
	return mustString(t, res.Body, "id")
}

// daysAgo is a day in the farm's calendar, which for these fixtures is the
// same calendar the test process is on.
func daysAgo(n int) string { return time.Now().AddDate(0, 0, -n).Format("2006-01-02") }

// ---------------------------------------------------------------------------
// Reading the responses
// ---------------------------------------------------------------------------

type reportTotals struct {
	Records             int      `json:"records"`
	Kg                  *float64 `json:"kg"`
	RecordsNotInKg      int      `json:"recordsNotInKg"`
	ValueCents          *int64   `json:"valueCents"`
	RecordsWithoutValue int      `json:"recordsWithoutValue"`
	ValueIsEstimate     bool     `json:"valueIsEstimate"`
}

type reportGrid struct {
	Columns []struct {
		Key   *string      `json:"key"`
		Label string       `json:"label"`
		Total reportTotals `json:"total"`
	} `json:"columns"`
	Rows []struct {
		WorkerID string `json:"workerId"`
		Name     string `json:"name"`
		Cells    []struct {
			Column *string `json:"column"`
			reportTotals
		} `json:"cells"`
		Total reportTotals `json:"total"`
	} `json:"rows"`
	Total        reportTotals `json:"total"`
	Unattributed *struct {
		NoCropLink        int `json:"noCropLink"`
		SharedAcrossCrops int `json:"sharedAcrossCrops"`
	} `json:"unattributed"`
}

type weekDetail struct {
	Scope     string       `json:"scope"`
	WeekStart string       `json:"weekStart"`
	ByDay     reportGrid   `json:"byDay"`
	ByCrop    reportGrid   `json:"byCrop"`
	Total     reportTotals `json:"total"`
}

func decodeInto[T any](t *testing.T, res response) T {
	t.Helper()
	var out T
	if err := json.Unmarshal([]byte(res.Raw), &out); err != nil {
		t.Fatalf("decode %T: %v\n%s", out, err, res.Raw)
	}
	return out
}

func kg(t *testing.T, tot reportTotals, context string) float64 {
	t.Helper()
	if tot.Kg == nil {
		t.Fatalf("%s: kg is null with %d records behind it", context, tot.Records)
	}
	return *tot.Kg
}

// ---------------------------------------------------------------------------
// 1 & 2. The week, and the two grids that must agree
// ---------------------------------------------------------------------------

// TestWeekDetailAddsUpByRowsAndByColumns is the property the phone's week
// tests pin and the one a foreman will notice within a day of using this: a
// table whose margins do not match the cells is a table nobody can act on.
//
// Four checks, and they are deliberately not the same check written four ways:
// the rows against the grand total, the columns against the grand total, the
// two GRIDS against each other (they are built by two different queries over
// the same weighings), and the whole week against the row the weekly LIST
// reports for it, which is a third query again.
func TestWeekDetailAddsUpByRowsAndByColumns(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la cuadratura", 80000)

	ana := h.createWorker(t, f, "Ana", "10000001")
	beto := h.createWorker(t, f, "Beto", "10000002")
	cafe := h.createPlotCrop(t, f, "Lote Alto", "Cafe")
	platano := h.createPlotCrop(t, f, "Lote Bajo", "Platano")

	// A whole week, deliberately ragged: neither picker worked every day and
	// neither worked only one crop. A square fixture proves nothing about a
	// grid.
	monday := mondayOf(daysAgo(10))
	day := func(n int) string {
		d, _ := time.Parse("2006-01-02", monday)
		return d.AddDate(0, 0, n).Format("2006-01-02")
	}
	h.seedWeighings(t, f, []weighing{
		{worker: ana, plotCrop: cafe, day: day(0), qty: 30},
		{worker: ana, plotCrop: cafe, day: day(1), qty: 41.5},
		{worker: ana, plotCrop: platano, day: day(1), qty: 12},
		{worker: ana, plotCrop: platano, day: day(3), qty: 18},
		{worker: beto, plotCrop: cafe, day: day(0), qty: 27},
		{worker: beto, plotCrop: cafe, day: day(2), qty: 33.25},
		{worker: beto, plotCrop: platano, day: day(3), qty: 9},
	})
	const wantKg = 30 + 41.5 + 12 + 18 + 27 + 33.25 + 9

	res := h.mustDo(t, http.MethodGet, "/v1/reports/weeks/"+monday, f.OwnerToken, nil, http.StatusOK)
	detail := decodeInto[weekDetail](t, res)

	for name, grid := range map[string]reportGrid{"byDay": detail.ByDay, "byCrop": detail.ByCrop} {
		var rowKg, rowValue, colKg, colValue float64
		rowRecords, colRecords := 0, 0
		for _, row := range grid.Rows {
			// And the row's own total agrees with its own cells.
			var cellKg float64
			cells := 0
			for _, c := range row.Cells {
				cellKg += kg(t, c.reportTotals, name+" cell")
				cells += c.Records
			}
			if math.Abs(cellKg-kg(t, row.Total, name+" row total")) > 1e-9 || cells != row.Total.Records {
				t.Errorf("%s: %s's row total %v/%d does not match their own cells %v/%d",
					name, row.Name, row.Total.Kg, row.Total.Records, cellKg, cells)
			}
			rowKg += kg(t, row.Total, name+" row")
			rowValue += float64(*row.Total.ValueCents)
			rowRecords += row.Total.Records
		}
		for _, col := range grid.Columns {
			colKg += kg(t, col.Total, name+" column")
			colValue += float64(*col.Total.ValueCents)
			colRecords += col.Total.Records
		}
		grand := kg(t, grid.Total, name+" grand total")

		if math.Abs(rowKg-grand) > 1e-9 || rowRecords != grid.Total.Records {
			t.Errorf("%s: the rows add to %v kg over %d records, the grand total says %v over %d",
				name, rowKg, rowRecords, grand, grid.Total.Records)
		}
		if math.Abs(colKg-grand) > 1e-9 || colRecords != grid.Total.Records {
			t.Errorf("%s: the columns add to %v kg over %d records, the grand total says %v over %d",
				name, colKg, colRecords, grand, grid.Total.Records)
		}
		if math.Abs(rowValue-float64(*grid.Total.ValueCents)) > 0.5 ||
			math.Abs(colValue-float64(*grid.Total.ValueCents)) > 0.5 {
			t.Errorf("%s: value does not reconcile — rows %v, columns %v, total %d",
				name, rowValue, colValue, *grid.Total.ValueCents)
		}
		if math.Abs(grand-wantKg) > 1e-9 {
			t.Errorf("%s: the week totals %v kg, the fixture put in %v", name, grand, wantKg)
		}
	}

	// The two grids are two different queries over the same weighings. If they
	// disagree, one of them is inventing or losing work.
	if kg(t, detail.ByDay.Total, "byDay") != kg(t, detail.ByCrop.Total, "byCrop") {
		t.Errorf("the day grid says %v kg and the crop grid says %v",
			*detail.ByDay.Total.Kg, *detail.ByCrop.Total.Kg)
	}

	// And a third query again: the weekly list must report the same week.
	list := h.mustDo(t, http.MethodGet, "/v1/reports/weeks", f.OwnerToken, nil, http.StatusOK)
	items, _ := list.Body["items"].([]any)
	found := false
	for _, raw := range items {
		row := raw.(map[string]any)
		if row["weekStart"] != monday {
			continue
		}
		found = true
		if math.Abs(row["kg"].(float64)-wantKg) > 1e-9 {
			t.Errorf("the weekly list says %v kg for %s, the detail says %v",
				row["kg"], monday, wantKg)
		}
		if row["pickers"].(float64) != 2 {
			t.Errorf("the weekly list counts %v pickers, two worked", row["pickers"])
		}
	}
	if !found {
		t.Fatalf("the weekly list has no row for %s: %s", monday, list.Raw)
	}
}

// TestWeekDetailNamesWorkItCouldNotAttribute is the case the phone cannot
// have: there a pickup carries one cropId, here a work record can name none or
// several.
//
// Attributing shared work to both crops would make the columns exceed the
// grid; splitting it would be a guess; dropping it would make the crop grid
// quietly smaller than the day grid — three different ways of lying with a
// number. It gets a column of its own, the columns still add up exactly, and
// `unattributed` says which of the two causes it was.
func TestWeekDetailNamesWorkItCouldNotAttribute(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca sin atribuir", 80000)

	ana := h.createWorker(t, f, "Ana", "20000001")
	cafe := h.createPlotCrop(t, f, "Lote Uno", "Cafe")
	platano := h.createPlotCrop(t, f, "Lote Dos", "Platano")

	monday := mondayOf(daysAgo(10))
	ids := h.seedWeighings(t, f, []weighing{
		{worker: ana, plotCrop: cafe, day: monday, qty: 40}, // attributable
		{worker: ana, day: monday, qty: 25},                 // names no crop
		{worker: ana, plotCrop: cafe, day: monday, qty: 15}, // will name two
	})
	h.linkCrop(t, f, ids[2], platano)

	res := h.mustDo(t, http.MethodGet, "/v1/reports/weeks/"+monday, f.OwnerToken, nil, http.StatusOK)
	detail := decodeInto[weekDetail](t, res)

	if detail.ByCrop.Unattributed == nil {
		t.Fatalf("no unattributed bucket, so 40 kg of work vanished silently: %s", res.Raw)
	}
	if detail.ByCrop.Unattributed.NoCropLink != 1 {
		t.Errorf("noCropLink = %d, want 1", detail.ByCrop.Unattributed.NoCropLink)
	}
	if detail.ByCrop.Unattributed.SharedAcrossCrops != 1 {
		t.Errorf("sharedAcrossCrops = %d, want 1", detail.ByCrop.Unattributed.SharedAcrossCrops)
	}

	// The whole point: nothing was lost and nothing was counted twice.
	if got := kg(t, detail.ByCrop.Total, "byCrop"); math.Abs(got-80) > 1e-9 {
		t.Errorf("the crop grid totals %v kg, the fixture put in 80", got)
	}
	if got := kg(t, detail.ByDay.Total, "byDay"); math.Abs(got-80) > 1e-9 {
		t.Errorf("the day grid totals %v kg, the fixture put in 80", got)
	}
	var colKg float64
	for _, c := range detail.ByCrop.Columns {
		colKg += kg(t, c.Total, "column")
	}
	if math.Abs(colKg-80) > 1e-9 {
		t.Errorf("the crop columns add to %v, the grid says 80", colKg)
	}
	// The unattributed column reads last, so it looks like the footnote it is.
	last := detail.ByCrop.Columns[len(detail.ByCrop.Columns)-1]
	if last.Key != nil {
		t.Errorf("the unattributed column is not last: %v", last.Key)
	}
}

// ---------------------------------------------------------------------------
// The rule that overrides all the others
// ---------------------------------------------------------------------------

// TestNoFigureIsEverAZeroThatMeansUnknown is the sprint's headline rule, and
// it is here rather than in a comment because a zero is a figure a farm can
// genuinely produce: a week where nobody picked really is 0 kg. That is
// exactly what makes an unknown rendered as 0 undetectable.
//
// A weighing in a unit the farm never gave a kg_factor cannot be turned into
// kilos by anybody. The endpoints must say so, and say how much they left out.
func TestNoFigureIsEverAZeroThatMeansUnknown(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de las canastas", 80000)

	ana := h.createWorker(t, f, "Ana", "30000001")
	cafe := h.createPlotCrop(t, f, "Lote Canasta", "Cafe")
	canasta := h.createUnitWithoutKgFactor(t, f)
	monday := mondayOf(daysAgo(10))

	t.Run("a week entirely in an unconvertible unit reports null kilos, not zero", func(t *testing.T) {
		h.seedWeighings(t, f, []weighing{
			{worker: ana, plotCrop: cafe, day: monday, qty: 6, unitID: canasta},
			{worker: ana, plotCrop: cafe, day: monday, qty: 4, unitID: canasta},
		})
		res := h.mustDo(t, http.MethodGet, "/v1/reports/weeks/"+monday, f.OwnerToken, nil, http.StatusOK)
		d := decodeInto[weekDetail](t, res)

		if d.ByDay.Total.Kg != nil {
			t.Fatalf("kg came back as %v for work that cannot be expressed in kilos", *d.ByDay.Total.Kg)
		}
		if d.ByDay.Total.RecordsNotInKg != 2 {
			t.Errorf("recordsNotInKg = %d, want 2 — a null with no count beside it "+
				"is just a different way of saying nothing", d.ByDay.Total.RecordsNotInKg)
		}
		if d.ByDay.Total.Records != 2 {
			t.Errorf("records = %d, want 2: the work happened, only its kilos are unknown",
				d.ByDay.Total.Records)
		}
		// Money is a different question and is still answerable: the week has
		// a price and the quantity is known.
		if d.ByDay.Total.ValueCents == nil || *d.ByDay.Total.ValueCents == 0 {
			t.Errorf("valueCents = %v; 10 units at 80000 is knowable", d.ByDay.Total.ValueCents)
		}
		if !d.ByDay.Total.ValueIsEstimate {
			t.Error("unsettled work priced from the week is an estimate and must say so")
		}
	})

	t.Run("a partial sum carries the count of what it left out", func(t *testing.T) {
		other := mondayOf(daysAgo(24))
		h.seedWeighings(t, f, []weighing{
			{worker: ana, plotCrop: cafe, day: other, qty: 50},
			{worker: ana, plotCrop: cafe, day: other, qty: 3, unitID: canasta},
		})
		res := h.mustDo(t, http.MethodGet, "/v1/reports/weeks/"+other, f.OwnerToken, nil, http.StatusOK)
		d := decodeInto[weekDetail](t, res)

		if got := kg(t, d.ByDay.Total, "partial week"); math.Abs(got-50) > 1e-9 {
			t.Errorf("kg = %v, want 50 — only the convertible weighing", got)
		}
		if d.ByDay.Total.RecordsNotInKg != 1 {
			t.Errorf("recordsNotInKg = %d, want 1: a 50 that is really 50-and-something "+
				"must not read as a complete answer", d.ByDay.Total.RecordsNotInKg)
		}
	})

	t.Run("a picker with no comparable days has a null index, never a low one", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/reports/performance?days=60",
			f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) == 0 {
			t.Fatalf("nobody in the performance report: %s", res.Raw)
		}
		row := items[0].(map[string]any)
		if v, present := row["index"]; !present || v != nil {
			t.Errorf("index = %v for somebody who never worked beside anybody; "+
				"a number there is an accusation the data does not support", v)
		}
		if row["reason"] == nil || row["reason"] == "" {
			t.Errorf("a null index with no reason is a blank a screen will render as 0: %v", row)
		}
	})
}

// ---------------------------------------------------------------------------
// 4. The comparative index
// ---------------------------------------------------------------------------

// TestPerformanceIndexPortsThePhonesCases is
// apps/mobile/src/performance.test.ts, case for case, through HTTP.
//
// The three defects it caught on the phone were: the person included in their
// own benchmark, a ratio of sums instead of an average of daily ratios, and a
// window that did not match the rest of the panel. All three are properties of
// the SQL, so all three are re-checked against the ported SQL rather than
// assumed to have survived the translation.
func TestPerformanceIndexPortsThePhonesCases(t *testing.T) {
	h := requireDB(t)

	// indexOf runs the endpoint and returns the index per worker, nil when
	// there is none.
	indexOf := func(t *testing.T, f *farmFixture) map[string]*float64 {
		t.Helper()
		res := h.mustDo(t, http.MethodGet, "/v1/reports/performance?days=28",
			f.OwnerToken, nil, http.StatusOK)
		out := map[string]*float64{}
		items, _ := res.Body["items"].([]any)
		for _, raw := range items {
			row := raw.(map[string]any)
			id := row["workerId"].(string)
			if v, ok := row["index"].(float64); ok {
				val := v
				out[id] = &val
			} else {
				out[id] = nil
			}
		}
		return out
	}
	comparableDaysOf := func(t *testing.T, f *farmFixture, worker string) int {
		t.Helper()
		res := h.mustDo(t, http.MethodGet, "/v1/reports/performance?days=28",
			f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		for _, raw := range items {
			row := raw.(map[string]any)
			if row["workerId"] == worker {
				return int(row["comparableDays"].(float64))
			}
		}
		t.Fatalf("worker %s is not in the report: %s", worker, res.Raw)
		return 0
	}

	// crew builds a farm with n workers and two crops, ready for a fixture.
	type crew struct {
		f    *farmFixture
		w    []string
		crop []string
	}
	newCrew := func(t *testing.T, name string, n int) crew {
		t.Helper()
		f := h.signupFarm(t, name, 80000)
		c := crew{f: f}
		for i := 0; i < n; i++ {
			c.w = append(c.w, h.createWorker(t, f, fmt.Sprintf("P%d", i+1),
				fmt.Sprintf("4%07d", i+1)))
		}
		c.crop = append(c.crop,
			h.createPlotCrop(t, f, "Lote 1", "Cafe"),
			h.createPlotCrop(t, f, "Lote 2", "Platano"))
		return c
	}

	t.Run("someone matching their mates scores exactly 1", func(t *testing.T) {
		// Three days, not one: the phone's test reads INDEX_SQL directly, and
		// the endpoint applies the same floor `Performance.crew` does —
		// fewer than three comparable days is an anecdote, not an index.
		c := newCrew(t, "Indice uno", 3)
		var ws []weighing
		for _, d := range []int{2, 3, 4} {
			for _, p := range c.w {
				ws = append(ws, weighing{worker: p, plotCrop: c.crop[0], day: daysAgo(d), qty: 50})
			}
		}
		h.seedWeighings(t, c.f, ws)

		got := indexOf(t, c.f)[c.w[0]]
		if got == nil || *got != 1 {
			t.Fatalf("index = %v, want exactly 1", got)
		}
	})

	t.Run("doubling your mates scores 2, not 1.5", func(t *testing.T) {
		// The benchmark must exclude the person being measured. Including them
		// drags everyone toward 1: this case used to come out as 1.5.
		c := newCrew(t, "Indice dos", 3)
		var ws []weighing
		for _, d := range []int{2, 3, 4} {
			ws = append(ws,
				weighing{worker: c.w[0], plotCrop: c.crop[0], day: daysAgo(d), qty: 60},
				weighing{worker: c.w[1], plotCrop: c.crop[0], day: daysAgo(d), qty: 30},
				weighing{worker: c.w[2], plotCrop: c.crop[0], day: daysAgo(d), qty: 30})
		}
		h.seedWeighings(t, c.f, ws)

		got := indexOf(t, c.f)[c.w[0]]
		if got == nil || *got != 2 {
			t.Fatalf("index = %v, want exactly 2 — 1.5 is the bug where the "+
				"picker is inside their own benchmark", got)
		}
	})

	t.Run("the score does not depend on how big the crew was", func(t *testing.T) {
		// Same relative performance in a crew of three and a crew of six.
		// These used to come out as 1.5 and 1.71, which reordered people
		// ACROSS groups — the worst kind of wrong for a ranking.
		c := newCrew(t, "Indice cuadrilla", 6)
		var ws []weighing
		for _, d := range []int{2, 3, 4} {
			ws = append(ws,
				weighing{worker: c.w[0], plotCrop: c.crop[0], day: daysAgo(d), qty: 60},
				weighing{worker: c.w[1], plotCrop: c.crop[0], day: daysAgo(d), qty: 30},
				weighing{worker: c.w[2], plotCrop: c.crop[0], day: daysAgo(d), qty: 30},
				weighing{worker: c.w[3], plotCrop: c.crop[1], day: daysAgo(d), qty: 60},
				weighing{worker: c.w[4], plotCrop: c.crop[1], day: daysAgo(d), qty: 30},
				weighing{worker: c.w[5], plotCrop: c.crop[1], day: daysAgo(d), qty: 30})
		}
		h.seedWeighings(t, c.f, ws)

		idx := indexOf(t, c.f)
		a, b := idx[c.w[0]], idx[c.w[3]]
		if a == nil || b == nil || *a != *b {
			t.Fatalf("a crew of three scored %v and a crew of six scored %v", a, b)
		}
	})

	t.Run("a heavy day does not outweigh several light ones", func(t *testing.T) {
		// One day on a loaded plot at 0.9, then three light days at 1.5 each.
		// Dividing sums gave far less than the honest average of the ratios.
		c := newCrew(t, "Indice promedio", 3)
		ws := []weighing{
			{worker: c.w[0], plotCrop: c.crop[0], day: daysAgo(2), qty: 90},
			{worker: c.w[1], plotCrop: c.crop[0], day: daysAgo(2), qty: 100},
			{worker: c.w[2], plotCrop: c.crop[0], day: daysAgo(2), qty: 100},
		}
		for _, d := range []int{3, 4, 5} {
			ws = append(ws,
				weighing{worker: c.w[0], plotCrop: c.crop[1], day: daysAgo(d), qty: 15},
				weighing{worker: c.w[1], plotCrop: c.crop[1], day: daysAgo(d), qty: 10},
				weighing{worker: c.w[2], plotCrop: c.crop[1], day: daysAgo(d), qty: 10})
		}
		h.seedWeighings(t, c.f, ws)

		got := indexOf(t, c.f)[c.w[0]]
		// (0.9 + 1.5 + 1.5 + 1.5) / 4 = 1.35
		if got == nil || math.Abs(*got-1.35) > 1e-9 {
			t.Fatalf("index = %v, want ~1.35", got)
		}
	})

	t.Run("fewer than three on a crop that day is not a comparison", func(t *testing.T) {
		c := newCrew(t, "Indice sin cuadrilla", 2)
		h.seedWeighings(t, c.f, []weighing{
			{worker: c.w[0], plotCrop: c.crop[0], day: daysAgo(2), qty: 80},
			{worker: c.w[1], plotCrop: c.crop[0], day: daysAgo(2), qty: 40},
		})

		got, present := indexOf(t, c.f)[c.w[0]]
		if !present {
			t.Fatal("the picker fell out of the report entirely; they worked, they belong in it")
		}
		if got != nil {
			t.Fatalf("index = %v from two people; two is not a crew", *got)
		}
	})

	t.Run("comparable days count days, not rows", func(t *testing.T) {
		// Working two crops the same day is still one day of evidence.
		c := newCrew(t, "Indice dias", 3)
		var ws []weighing
		for _, p := range c.w {
			ws = append(ws,
				weighing{worker: p, plotCrop: c.crop[0], day: daysAgo(2), qty: 50},
				weighing{worker: p, plotCrop: c.crop[1], day: daysAgo(2), qty: 50})
		}
		h.seedWeighings(t, c.f, ws)

		if got := comparableDaysOf(t, c.f, c.w[0]); got != 1 {
			t.Fatalf("comparableDays = %d, want 1", got)
		}
	})

	t.Run("work older than the window does not count", func(t *testing.T) {
		c := newCrew(t, "Indice ventana", 3)
		var ws []weighing
		for _, p := range c.w {
			ws = append(ws, weighing{worker: p, plotCrop: c.crop[0], day: daysAgo(40), qty: 50})
		}
		h.seedWeighings(t, c.f, ws)

		idx := indexOf(t, c.f)
		if got, present := idx[c.w[0]]; present && got != nil {
			t.Fatalf("index = %v from work forty days back, inside a 28-day window", *got)
		}
	})
}

// ---------------------------------------------------------------------------
// 5. The review rules
// ---------------------------------------------------------------------------

// TestEveryReviewRuleActuallyFires is apps/mobile/src/review.test.ts.
//
// These rules accuse people of mis-weighing, so each one has to be shown
// firing on exactly the weighings it used to and staying quiet on the ones it
// used to leave alone. The extra-zero rule spent several versions
// algebraically unable to fire, which no test that only checked "it does not
// crash" would ever have noticed.
func TestEveryReviewRuleActuallyFires(t *testing.T) {
	h := requireDB(t)

	type finding struct {
		RecordID  string   `json:"recordId"`
		Quantity  float64  `json:"quantity"`
		Rule      string   `json:"rule"`
		Reference *float64 `json:"reference"`
	}
	anomalies := func(t *testing.T, f *farmFixture, query string) []finding {
		t.Helper()
		res := h.mustDo(t, http.MethodGet, "/v1/reports/anomalies?days=3650"+query,
			f.OwnerToken, nil, http.StatusOK)
		var body struct {
			Items []finding `json:"items"`
		}
		if err := json.Unmarshal([]byte(res.Raw), &body); err != nil {
			t.Fatalf("decode: %v\n%s", err, res.Raw)
		}
		return body.Items
	}
	only := func(t *testing.T, found []finding, rule string) []finding {
		t.Helper()
		var out []finding
		for _, a := range found {
			if a.Rule == rule {
				out = append(out, a)
			}
		}
		return out
	}

	newFarm := func(t *testing.T, name string, workers int) (*farmFixture, []string, string) {
		t.Helper()
		f := h.signupFarm(t, name, 80000)
		var ws []string
		for i := 0; i < workers; i++ {
			ws = append(ws, h.createWorker(t, f, fmt.Sprintf("P%d", i+1), fmt.Sprintf("5%07d", i+1)))
		}
		return f, ws, h.createPlotCrop(t, f, "Lote 1", "Cafe")
	}

	t.Run("a load nobody could carry is flagged", func(t *testing.T) {
		f, w, crop := newFarm(t, "Regla imposible", 1)
		h.seedWeighings(t, f, []weighing{
			{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 55}, // a normal sack
			{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 340},
		})
		found := only(t, anomalies(t, f, "&maxKg=120"), "impossible")
		if len(found) != 1 || found[0].Quantity != 340 {
			t.Fatalf("impossible fired on %v, want exactly the 340", found)
		}
		if found[0].Reference == nil || *found[0].Reference != 120 {
			t.Errorf("reference = %v, want the 120 kg ceiling it was judged against", found[0].Reference)
		}
	})

	t.Run("the same weighing saved twice within three minutes is flagged", func(t *testing.T) {
		f, w, crop := newFarm(t, "Regla duplicado", 1)
		h.seedWeighings(t, f, []weighing{
			{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 47},
			{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 47, createdAtOffset: 90 * time.Second},
		})
		found := only(t, anomalies(t, f, ""), "duplicate")
		if len(found) != 1 {
			t.Fatalf("duplicate fired %d times, want exactly one — the SECOND of the pair "+
				"is the suspect, and on random UUIDs that needs (created_at, id), "+
				"not the phone's b.id < a.id: %v", len(found), found)
		}
	})

	t.Run("two equal weights hours apart are not a duplicate", func(t *testing.T) {
		f, w, crop := newFarm(t, "Regla no duplicado", 1)
		h.seedWeighings(t, f, []weighing{
			{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 47},
			{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 47, createdAtOffset: 40 * time.Minute},
		})
		if found := only(t, anomalies(t, f, ""), "duplicate"); len(found) != 0 {
			t.Fatalf("duplicate fired on weighings forty minutes apart: %v", found)
		}
	})

	t.Run("an extra typed zero is caught — the rule used to be unable to fire", func(t *testing.T) {
		// Twenty sacks of 30 kg and one of 300. Comparing against an average
		// that INCLUDED the suspect reduced the condition to n+1 >= n+10:
		// false for every n, in every version, for months.
		f, w, crop := newFarm(t, "Regla digito", 1)
		var ws []weighing
		for i := 0; i < 20; i++ {
			ws = append(ws, weighing{worker: w[0], plotCrop: crop, day: daysAgo(3), qty: 30,
				createdAtOffset: time.Duration(i) * time.Minute})
		}
		ws = append(ws, weighing{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 300})
		h.seedWeighings(t, f, ws)

		found := only(t, anomalies(t, f, "&maxKg=1000"), "digit")
		if len(found) != 1 || found[0].Quantity != 300 {
			t.Fatalf("digit fired on %v, want exactly the 300", found)
		}
		// Stated outright because the CTE was rewritten from window functions
		// to a GROUP BY for speed, and the arithmetic had to come out
		// identical: the reference is this person's OTHER loads.
		if found[0].Reference == nil || math.Abs(*found[0].Reference-30) > 1e-9 {
			t.Errorf("reference = %v, want 30 — the suspect excluded from its own average",
				found[0].Reference)
		}
	})

	t.Run("a good day is not mistaken for a typo", func(t *testing.T) {
		f, w, crop := newFarm(t, "Regla buen dia", 1)
		var ws []weighing
		for i := 0; i < 20; i++ {
			ws = append(ws, weighing{worker: w[0], plotCrop: crop, day: daysAgo(3), qty: 30,
				createdAtOffset: time.Duration(i) * time.Minute})
		}
		ws = append(ws, weighing{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 45})
		h.seedWeighings(t, f, ws)

		if found := only(t, anomalies(t, f, ""), "digit"); len(found) != 0 {
			t.Fatalf("a strong day was called a typo: %v", found)
		}
	})

	t.Run("a weight far above the rest of the crew that day is flagged", func(t *testing.T) {
		f, w, crop := newFarm(t, "Regla cuadrilla", 6)
		ws := []weighing{{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 400}}
		for _, p := range w[1:] {
			ws = append(ws, weighing{worker: p, plotCrop: crop, day: daysAgo(2), qty: 30})
		}
		h.seedWeighings(t, f, ws)

		found := only(t, anomalies(t, f, "&maxKg=1000"), "outlier")
		if len(found) != 1 || found[0].Quantity != 400 {
			t.Fatalf("outlier fired on %v, want exactly the 400", found)
		}
		if found[0].Reference == nil || math.Abs(*found[0].Reference-30) > 1e-9 {
			t.Errorf("reference = %v, want 30 — the MATES' average, this row excluded",
				found[0].Reference)
		}
	})

	t.Run("with too few mates that day the outlier rule stays quiet", func(t *testing.T) {
		f, w, crop := newFarm(t, "Regla sin cuadrilla", 2)
		h.seedWeighings(t, f, []weighing{
			{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 400},
			{worker: w[1], plotCrop: crop, day: daysAgo(2), qty: 30},
		})
		if found := only(t, anomalies(t, f, "&maxKg=1000"), "outlier"); len(found) != 0 {
			t.Fatalf("no crew, no comparison — yet it fired: %v", found)
		}
	})

	t.Run("a weighing dated in the future is flagged, and today's is not", func(t *testing.T) {
		f, w, crop := newFarm(t, "Regla futuro", 1)
		h.seedWeighings(t, f, []weighing{
			{worker: w[0], plotCrop: crop, day: daysAgo(-3), qty: 50}, // three days ahead
			{worker: w[0], plotCrop: crop, day: daysAgo(0), qty: 50},  // today
		})
		found := only(t, anomalies(t, f, ""), "future")
		if len(found) != 1 {
			t.Fatalf("future fired %d times, want 1 — today is not tomorrow, and "+
				"'today' has to be the FARM's day, not the server's: %v", len(found), found)
		}
		// The phone reported 0 here. A 0 in this field reads as "compared
		// against nothing", which is the exact class of zero this contract
		// forbids: there is nothing to compare a future date against.
		if found[0].Reference != nil {
			t.Errorf("reference = %v for a date in the future; it must be null", *found[0].Reference)
		}
	})

	t.Run("one weighing is reported once, worst first", func(t *testing.T) {
		// A 340 kg load with one 55 kg sack beside it breaks `impossible` AND
		// `digit`. It appears once, under the more serious of the two.
		f, w, crop := newFarm(t, "Regla una vez", 1)
		h.seedWeighings(t, f, []weighing{
			{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 55},
			{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 340},
		})
		found := anomalies(t, f, "&maxKg=120")
		seen := map[string]int{}
		for _, a := range found {
			seen[a.RecordID]++
		}
		for id, n := range seen {
			if n > 1 {
				t.Errorf("weighing %s reported %d times", id, n)
			}
		}
		for _, a := range found {
			if a.Quantity == 340 && a.Rule != "impossible" {
				t.Errorf("the 340 came back as %q; impossible is the worse rule and runs first", a.Rule)
			}
		}
	})
}

// ---------------------------------------------------------------------------
// 3 & 6. The crop, and the shape of the season
// ---------------------------------------------------------------------------

func TestCropReportAndHarvestCurve(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la curva", 80000)
	ana := h.createWorker(t, f, "Ana", "60000001")
	beto := h.createWorker(t, f, "Beto", "60000002")
	cafe := h.createPlotCrop(t, f, "Lote Curva", "Cafe")

	// A season that rises to a peak and then collapses: 200, 1000, 400, 150.
	// The last two are drops of 60% and 62.5%, both past the threshold, and
	// the peak is behind us — which is the whole reading.
	weeksBack := []struct {
		back int
		kg   float64
	}{{4, 200}, {3, 1000}, {2, 400}, {1, 150}}
	var ws []weighing
	for _, wk := range weeksBack {
		monday := mondayOf(daysAgo(wk.back * 7))
		ws = append(ws,
			weighing{worker: ana, plotCrop: cafe, day: monday, qty: wk.kg / 2},
			weighing{worker: beto, plotCrop: cafe, day: monday, qty: wk.kg / 2})
	}
	h.seedWeighings(t, f, ws)

	t.Run("the crop report answers kilos, value, people, days and the weeks", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/reports/crops/"+cafe, f.OwnerToken, nil, http.StatusOK)
		var report struct {
			reportTotals
			Label   string  `json:"label"`
			Pickers int     `json:"pickers"`
			Days    int     `json:"days"`
			AreaHa  float64 `json:"areaHa"`
			KgPerHa float64 `json:"kgPerHa"`
			ByWeek  []struct {
				WeekStart string `json:"weekStart"`
				reportTotals
			} `json:"byWeek"`
		}
		if err := json.Unmarshal([]byte(res.Raw), &report); err != nil {
			t.Fatalf("decode: %v\n%s", err, res.Raw)
		}
		if got := kg(t, report.reportTotals, "crop"); math.Abs(got-1750) > 1e-9 {
			t.Errorf("kg = %v, want 1750", got)
		}
		if report.Pickers != 2 {
			t.Errorf("pickers = %d, want 2", report.Pickers)
		}
		if report.Days != 4 {
			t.Errorf("days = %d, want 4", report.Days)
		}
		if len(report.ByWeek) != 4 {
			t.Errorf("byWeek has %d weeks, want 4", len(report.ByWeek))
		}
		if report.ValueCents == nil || *report.ValueCents != 1750*80000 {
			t.Errorf("valueCents = %v, want %d", report.ValueCents, 1750*80000)
		}
		// 1750 kg over the 2 ha the fixture declares.
		if math.Abs(report.KgPerHa-875) > 1e-6 {
			t.Errorf("kgPerHa = %v, want 875", report.KgPerHa)
		}
	})

	t.Run("the curve finds the peak and calls the season", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/reports/harvest-curve", f.OwnerToken, nil, http.StatusOK)
		var curve struct {
			Shape struct {
				Peak *struct {
					WeekStart string  `json:"weekStart"`
					Kg        float64 `json:"kg"`
				} `json:"peak"`
				FallingWeeks int    `json:"fallingWeeks"`
				WindingDown  bool   `json:"windingDown"`
				Reason       string `json:"reason"`
			} `json:"shape"`
		}
		if err := json.Unmarshal([]byte(res.Raw), &curve); err != nil {
			t.Fatalf("decode: %v\n%s", err, res.Raw)
		}
		if curve.Shape.Peak == nil {
			t.Fatalf("no peak in a four-week season: %s", res.Raw)
		}
		if curve.Shape.Peak.Kg != 1000 {
			t.Errorf("peak = %v kg, want the 1000 week", curve.Shape.Peak.Kg)
		}
		if curve.Shape.FallingWeeks != 2 {
			t.Errorf("fallingWeeks = %d, want 2", curve.Shape.FallingWeeks)
		}
		if !curve.Shape.WindingDown {
			t.Error("two steep falls past the peak is a season ending; windingDown says otherwise")
		}
	})

	t.Run("a crop of another farm is a 404, not an empty season", func(t *testing.T) {
		other := h.signupFarm(t, "Finca ajena", 80000)
		theirs := h.createPlotCrop(t, other, "Lote Ajeno", "Cafe")

		// The crop report.
		res := h.do(t, http.MethodGet, "/v1/reports/crops/"+theirs, f.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Errorf("crop report on another farm's crop: got %d, want 404. A sum over "+
				"an id that matches nothing reads as 'this crop produced nothing': %s",
				res.Status, res.Raw)
		}
		// And the curve, which takes the same id as a query parameter.
		res = h.do(t, http.MethodGet, "/v1/reports/harvest-curve?plotCropId="+theirs,
			f.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Errorf("harvest curve on another farm's crop: got %d, want 404: %s",
				res.Status, res.Raw)
		}
		// An id that is not a uuid at all is the same answer, never a 500.
		res = h.do(t, http.MethodGet, "/v1/reports/crops/not-a-uuid", f.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Errorf("a malformed id: got %d, want 404: %s", res.Status, res.Raw)
		}
	})
}

// TestReportsRefuseAnUnknownWeek keeps the week route honest about the
// difference between a bad request and an empty answer.
func TestReportsRefuseAnUnknownWeek(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la semana", 80000)

	// A day that is not a Monday names no week.
	res := h.do(t, http.MethodGet, "/v1/reports/weeks/2026-08-25", f.OwnerToken, nil)
	if res.Status != http.StatusBadRequest {
		t.Errorf("a Tuesday: got %d, want 400: %s", res.Status, res.Raw)
	}

	// A Monday nobody worked is a real answer, not a 404: a week is not a
	// resource anybody owns, and "nobody picked" is true.
	res = h.mustDo(t, http.MethodGet, "/v1/reports/weeks/"+mondayOf(daysAgo(300)),
		f.OwnerToken, nil, http.StatusOK)
	d := decodeInto[weekDetail](t, res)
	if d.Total.Records != 0 {
		t.Errorf("records = %d for a week nobody worked", d.Total.Records)
	}
	// And its kilos are null, not zero: nothing was weighed, so there is no
	// weight to report — the count beside it is what says the week was empty.
	if d.Total.Kg != nil {
		t.Errorf("kg = %v for a week with no weighings in it", *d.Total.Kg)
	}
}

// TestWhatWeOweNeverLooksLikeWhatWePaid is the report-shaped version of the
// bug that prompted the rule: work priced by the week has no amount of its own
// until the week is settled, and rendering that null as a figure made a farm
// owing a week of picking read as $0 with the same confidence as the truth.
//
// A report cannot answer "unknown" for money and still be useful — a screen
// showing a dash where every week's value belongs is not a report. So it
// answers with the number a settlement WOULD post, and flags it, which is the
// only way "what we owe" and "what we paid" can share a column without lying.
func TestWhatWeOweNeverLooksLikeWhatWePaid(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del estimado", 80000)
	ana := h.createWorker(t, f, "Ana", "70000001")
	cafe := h.createPlotCrop(t, f, "Lote Estimado", "Cafe")

	monday := mondayOf(daysAgo(10))
	h.seedWeighings(t, f, []weighing{{worker: ana, plotCrop: cafe, day: monday, qty: 100}})

	weekValue := func(t *testing.T) (int64, bool) {
		t.Helper()
		res := h.mustDo(t, http.MethodGet, "/v1/reports/weeks/"+monday, f.OwnerToken, nil, http.StatusOK)
		d := decodeInto[weekDetail](t, res)
		if d.Total.ValueCents == nil {
			t.Fatalf("valueCents is null for 100 kg at a known price: %s", res.Raw)
		}
		return *d.Total.ValueCents, d.Total.ValueIsEstimate
	}

	// Before the settlement: the number the settlement would post, flagged.
	value, estimate := weekValue(t)
	if value != 100*80000 {
		t.Errorf("valueCents = %d, want %d — never 0, which is what the console showed",
			value, 100*80000)
	}
	if !estimate {
		t.Error("unsettled work must be marked an estimate")
	}

	end, _ := time.Parse("2006-01-02", monday)
	h.mustSettle(t, f.OwnerToken, map[string]any{
		"workerId": ana, "from": monday, "to": end.AddDate(0, 0, 6).Format("2006-01-02"),
	}, http.StatusCreated)

	// After it: the same figure, no longer an estimate. The bug report says
	// "settled ones included" — those were reading as $0 too.
	value, estimate = weekValue(t)
	if value != 100*80000 {
		t.Errorf("valueCents = %d after settling, want %d", value, 100*80000)
	}
	if estimate {
		t.Error("settled work is not an estimate; what we paid must not look like what we owe")
	}
}
