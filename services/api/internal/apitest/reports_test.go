// SPDX-License-Identifier: MIT

package apitest

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"testing"
	"time"

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
				id, err := insertOneWeighing(ctx, tx, f, activityID, defaultUnit, wg)
				if err != nil {
					return err
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
func daysAgo(n int) string {
	loc, err := time.LoadLocation("America/Bogota")
	if err != nil {
		loc = time.UTC
	}
	return time.Now().In(loc).AddDate(0, 0, -n).Format("2006-01-02")
}

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
		assertGridReconciles(t, name, grid, wantKg)
	}

	if kg(t, detail.ByDay.Total, "byDay") != kg(t, detail.ByCrop.Total, "byCrop") {
		t.Errorf("the day grid says %v kg and the crop grid says %v",
			*detail.ByDay.Total.Kg, *detail.ByCrop.Total.Kg)
	}

	assertWeeklyListMatchesDetail(t, h, f, monday, wantKg)
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
		noFigureUnconvertibleWeek(t, h, f, ana, cafe, canasta, monday)
	})
	t.Run("a partial sum carries the count of what it left out", func(t *testing.T) {
		noFigurePartialSum(t, h, f, ana, cafe, canasta)
	})
	t.Run("a picker with no comparable days has a null index, never a low one", func(t *testing.T) {
		noFigureNullIndexWithoutPeers(t, h, f)
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

	t.Run("someone matching their mates scores exactly 1", func(t *testing.T) {
		perfIndexMatchesMates(t, h)
	})
	t.Run("doubling your mates scores 2, not 1.5", func(t *testing.T) {
		perfIndexDoublingScoresTwo(t, h)
	})
	t.Run("the score does not depend on how big the crew was", func(t *testing.T) {
		perfIndexIndependentOfCrewSize(t, h)
	})
	t.Run("a heavy day does not outweigh several light ones", func(t *testing.T) {
		perfIndexHeavyDayDoesNotOutweigh(t, h)
	})
	t.Run("fewer than three on a crop that day is not a comparison", func(t *testing.T) {
		perfIndexFewerThanThreeNoComparison(t, h)
	})
	t.Run("comparable days count days, not rows", func(t *testing.T) {
		perfIndexComparableDaysCountDays(t, h)
	})
	t.Run("work older than the window does not count", func(t *testing.T) {
		perfIndexOutsideWindowIgnored(t, h)
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

	t.Run("a load nobody could carry is flagged", func(t *testing.T) {
		reviewImpossibleLoad(t, h)
	})
	t.Run("the same weighing saved twice within three minutes is flagged", func(t *testing.T) {
		reviewDuplicateWithinThreeMinutes(t, h)
	})
	t.Run("two equal weights hours apart are not a duplicate", func(t *testing.T) {
		reviewEqualHoursApartNotDuplicate(t, h)
	})
	t.Run("an extra typed zero is caught — the rule used to be unable to fire", func(t *testing.T) {
		reviewExtraTypedZero(t, h)
	})
	t.Run("a good day is not mistaken for a typo", func(t *testing.T) {
		reviewGoodDayNotTypo(t, h)
	})
	t.Run("a weight far above the rest of the crew that day is flagged", func(t *testing.T) {
		reviewOutlierAboveCrew(t, h)
	})
	t.Run("with too few mates that day the outlier rule stays quiet", func(t *testing.T) {
		reviewOutlierQuietWithoutCrew(t, h)
	})
	t.Run("a weighing dated in the future is flagged, and today's is not", func(t *testing.T) {
		reviewFutureDateFlagged(t, h)
	})
	t.Run("one weighing is reported once, worst first", func(t *testing.T) {
		reviewReportedOnceWorstFirst(t, h)
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
		cropReportAnswersBasics(t, h, f, cafe)
	})
	t.Run("the curve finds the peak and calls the season", func(t *testing.T) {
		cropCurveFindsPeak(t, h, f)
	})
	t.Run("a crop of another farm is a 404, not an empty season", func(t *testing.T) {
		cropOtherFarmIs404(t, h, f)
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
