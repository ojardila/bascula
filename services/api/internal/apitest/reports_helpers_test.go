// SPDX-License-Identifier: MIT

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
)

// Helpers extracted so reports_test.go Test* (and seedWeighings) stay under
// SonarQube's cognitive-complexity budget (go:S3776). Behavior unchanged.

func insertOneWeighing(ctx context.Context, tx pgx.Tx, f *farmFixture, activityID, defaultUnit string, wg weighing) (string, error) {
	id := uuid.NewString()
	unit := wg.unitID
	if unit == "" {
		unit = defaultUnit
	}
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
		return "", err
	}
	if wg.plotCrop != "" {
		if _, err := tx.Exec(ctx, `
			INSERT INTO work_record_plot_crops (work_record_id, plot_crop_id, farm_id)
			VALUES ($1, $2, $3)`, id, wg.plotCrop, f.FarmID); err != nil {
			return "", err
		}
	}
	return id, nil
}

func assertGridReconciles(t *testing.T, name string, grid reportGrid, wantKg float64) {
	t.Helper()
	var rowKg, rowValue, colKg, colValue float64
	rowRecords, colRecords := 0, 0
	for _, row := range grid.Rows {
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

func assertWeeklyListMatchesDetail(t *testing.T, h *harness, f *farmFixture, monday string, wantKg float64) {
	t.Helper()
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

func noFigureUnconvertibleWeek(t *testing.T, h *harness, f *farmFixture, ana, cafe, canasta, monday string) {
	t.Helper()
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
	if d.ByDay.Total.ValueCents == nil || *d.ByDay.Total.ValueCents == 0 {
		t.Errorf("valueCents = %v; 10 units at 80000 is knowable", d.ByDay.Total.ValueCents)
	}
	if !d.ByDay.Total.ValueIsEstimate {
		t.Error("unsettled work priced from the week is an estimate and must say so")
	}
}

func noFigurePartialSum(t *testing.T, h *harness, f *farmFixture, ana, cafe, canasta string) {
	t.Helper()
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
}

func noFigureNullIndexWithoutPeers(t *testing.T, h *harness, f *farmFixture) {
	t.Helper()
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
}

type perfCrew struct {
	f    *farmFixture
	w    []string
	crop []string
}

func newPerfCrew(t *testing.T, h *harness, name string, n int) perfCrew {
	t.Helper()
	f := h.signupFarm(t, name, 80000)
	c := perfCrew{f: f}
	for i := 0; i < n; i++ {
		c.w = append(c.w, h.createWorker(t, f, fmt.Sprintf("P%d", i+1),
			fmt.Sprintf("4%07d", i+1)))
	}
	c.crop = append(c.crop,
		h.createPlotCrop(t, f, "Lote 1", "Cafe"),
		h.createPlotCrop(t, f, "Lote 2", "Platano"))
	return c
}

func performanceIndexOf(t *testing.T, h *harness, f *farmFixture) map[string]*float64 {
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

func performanceComparableDaysOf(t *testing.T, h *harness, f *farmFixture, worker string) int {
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

func perfIndexMatchesMates(t *testing.T, h *harness) {
	t.Helper()
	c := newPerfCrew(t, h, "Indice uno", 3)
	var ws []weighing
	for _, d := range []int{2, 3, 4} {
		for _, p := range c.w {
			ws = append(ws, weighing{worker: p, plotCrop: c.crop[0], day: daysAgo(d), qty: 50})
		}
	}
	h.seedWeighings(t, c.f, ws)
	got := performanceIndexOf(t, h, c.f)[c.w[0]]
	if got == nil || *got != 1 {
		t.Fatalf("index = %v, want exactly 1", got)
	}
}

func perfIndexDoublingScoresTwo(t *testing.T, h *harness) {
	t.Helper()
	c := newPerfCrew(t, h, "Indice dos", 3)
	var ws []weighing
	for _, d := range []int{2, 3, 4} {
		ws = append(ws,
			weighing{worker: c.w[0], plotCrop: c.crop[0], day: daysAgo(d), qty: 60},
			weighing{worker: c.w[1], plotCrop: c.crop[0], day: daysAgo(d), qty: 30},
			weighing{worker: c.w[2], plotCrop: c.crop[0], day: daysAgo(d), qty: 30})
	}
	h.seedWeighings(t, c.f, ws)
	got := performanceIndexOf(t, h, c.f)[c.w[0]]
	if got == nil || *got != 2 {
		t.Fatalf("index = %v, want exactly 2 — 1.5 is the bug where the "+
			"picker is inside their own benchmark", got)
	}
}

func perfIndexIndependentOfCrewSize(t *testing.T, h *harness) {
	t.Helper()
	c := newPerfCrew(t, h, "Indice cuadrilla", 6)
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
	idx := performanceIndexOf(t, h, c.f)
	a, b := idx[c.w[0]], idx[c.w[3]]
	if a == nil || b == nil || *a != *b {
		t.Fatalf("a crew of three scored %v and a crew of six scored %v", a, b)
	}
}

func perfIndexHeavyDayDoesNotOutweigh(t *testing.T, h *harness) {
	t.Helper()
	c := newPerfCrew(t, h, "Indice promedio", 3)
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
	got := performanceIndexOf(t, h, c.f)[c.w[0]]
	if got == nil || math.Abs(*got-1.35) > 1e-9 {
		t.Fatalf("index = %v, want ~1.35", got)
	}
}

func perfIndexFewerThanThreeNoComparison(t *testing.T, h *harness) {
	t.Helper()
	c := newPerfCrew(t, h, "Indice sin cuadrilla", 2)
	h.seedWeighings(t, c.f, []weighing{
		{worker: c.w[0], plotCrop: c.crop[0], day: daysAgo(2), qty: 80},
		{worker: c.w[1], plotCrop: c.crop[0], day: daysAgo(2), qty: 40},
	})
	got, present := performanceIndexOf(t, h, c.f)[c.w[0]]
	if !present {
		t.Fatal("the picker fell out of the report entirely; they worked, they belong in it")
	}
	if got != nil {
		t.Fatalf("index = %v from two people; two is not a crew", *got)
	}
}

func perfIndexComparableDaysCountDays(t *testing.T, h *harness) {
	t.Helper()
	c := newPerfCrew(t, h, "Indice dias", 3)
	var ws []weighing
	for _, p := range c.w {
		ws = append(ws,
			weighing{worker: p, plotCrop: c.crop[0], day: daysAgo(2), qty: 50},
			weighing{worker: p, plotCrop: c.crop[1], day: daysAgo(2), qty: 50})
	}
	h.seedWeighings(t, c.f, ws)
	if got := performanceComparableDaysOf(t, h, c.f, c.w[0]); got != 1 {
		t.Fatalf("comparableDays = %d, want 1", got)
	}
}

func perfIndexOutsideWindowIgnored(t *testing.T, h *harness) {
	t.Helper()
	c := newPerfCrew(t, h, "Indice ventana", 3)
	var ws []weighing
	for _, p := range c.w {
		ws = append(ws, weighing{worker: p, plotCrop: c.crop[0], day: daysAgo(40), qty: 50})
	}
	h.seedWeighings(t, c.f, ws)
	idx := performanceIndexOf(t, h, c.f)
	if got, present := idx[c.w[0]]; present && got != nil {
		t.Fatalf("index = %v from work forty days back, inside a 28-day window", *got)
	}
}

type reviewFinding struct {
	RecordID  string   `json:"recordId"`
	Quantity  float64  `json:"quantity"`
	Rule      string   `json:"rule"`
	Reference *float64 `json:"reference"`
}

func reviewAnomalies(t *testing.T, h *harness, f *farmFixture, query string) []reviewFinding {
	t.Helper()
	res := h.mustDo(t, http.MethodGet, "/v1/reports/anomalies?days=3650"+query,
		f.OwnerToken, nil, http.StatusOK)
	var body struct {
		Items []reviewFinding `json:"items"`
	}
	if err := json.Unmarshal([]byte(res.Raw), &body); err != nil {
		t.Fatalf("decode: %v\n%s", err, res.Raw)
	}
	return body.Items
}

func reviewOnly(t *testing.T, found []reviewFinding, rule string) []reviewFinding {
	t.Helper()
	var out []reviewFinding
	for _, a := range found {
		if a.Rule == rule {
			out = append(out, a)
		}
	}
	return out
}

func reviewNewFarm(t *testing.T, h *harness, name string, workers int) (*farmFixture, []string, string) {
	t.Helper()
	f := h.signupFarm(t, name, 80000)
	var ws []string
	for i := 0; i < workers; i++ {
		ws = append(ws, h.createWorker(t, f, fmt.Sprintf("P%d", i+1), fmt.Sprintf("5%07d", i+1)))
	}
	return f, ws, h.createPlotCrop(t, f, "Lote 1", "Cafe")
}

func reviewImpossibleLoad(t *testing.T, h *harness) {
	t.Helper()
	f, w, crop := reviewNewFarm(t, h, "Regla imposible", 1)
	h.seedWeighings(t, f, []weighing{
		{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 55},
		{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 340},
	})
	found := reviewOnly(t, reviewAnomalies(t, h, f, "&maxKg=120"), "impossible")
	if len(found) != 1 || found[0].Quantity != 340 {
		t.Fatalf("impossible fired on %v, want exactly the 340", found)
	}
	if found[0].Reference == nil || *found[0].Reference != 120 {
		t.Errorf("reference = %v, want the 120 kg ceiling it was judged against", found[0].Reference)
	}
}

func reviewDuplicateWithinThreeMinutes(t *testing.T, h *harness) {
	t.Helper()
	f, w, crop := reviewNewFarm(t, h, "Regla duplicado", 1)
	h.seedWeighings(t, f, []weighing{
		{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 47},
		{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 47, createdAtOffset: 90 * time.Second},
	})
	found := reviewOnly(t, reviewAnomalies(t, h, f, ""), "duplicate")
	if len(found) != 1 {
		t.Fatalf("duplicate fired %d times, want exactly one — the SECOND of the pair "+
			"is the suspect, and on random UUIDs that needs (created_at, id), "+
			"not the phone's b.id < a.id: %v", len(found), found)
	}
}

func reviewEqualHoursApartNotDuplicate(t *testing.T, h *harness) {
	t.Helper()
	f, w, crop := reviewNewFarm(t, h, "Regla no duplicado", 1)
	h.seedWeighings(t, f, []weighing{
		{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 47},
		{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 47, createdAtOffset: 40 * time.Minute},
	})
	if found := reviewOnly(t, reviewAnomalies(t, h, f, ""), "duplicate"); len(found) != 0 {
		t.Fatalf("duplicate fired on weighings forty minutes apart: %v", found)
	}
}

func reviewExtraTypedZero(t *testing.T, h *harness) {
	t.Helper()
	f, w, crop := reviewNewFarm(t, h, "Regla digito", 1)
	var ws []weighing
	for i := 0; i < 20; i++ {
		ws = append(ws, weighing{worker: w[0], plotCrop: crop, day: daysAgo(3), qty: 30,
			createdAtOffset: time.Duration(i) * time.Minute})
	}
	ws = append(ws, weighing{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 300})
	h.seedWeighings(t, f, ws)

	found := reviewOnly(t, reviewAnomalies(t, h, f, "&maxKg=1000"), "digit")
	if len(found) != 1 || found[0].Quantity != 300 {
		t.Fatalf("digit fired on %v, want exactly the 300", found)
	}
	if found[0].Reference == nil || math.Abs(*found[0].Reference-30) > 1e-9 {
		t.Errorf("reference = %v, want 30 — the suspect excluded from its own average",
			found[0].Reference)
	}
}

func reviewGoodDayNotTypo(t *testing.T, h *harness) {
	t.Helper()
	f, w, crop := reviewNewFarm(t, h, "Regla buen dia", 1)
	var ws []weighing
	for i := 0; i < 20; i++ {
		ws = append(ws, weighing{worker: w[0], plotCrop: crop, day: daysAgo(3), qty: 30,
			createdAtOffset: time.Duration(i) * time.Minute})
	}
	ws = append(ws, weighing{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 45})
	h.seedWeighings(t, f, ws)
	if found := reviewOnly(t, reviewAnomalies(t, h, f, ""), "digit"); len(found) != 0 {
		t.Fatalf("a strong day was called a typo: %v", found)
	}
}

func reviewOutlierAboveCrew(t *testing.T, h *harness) {
	t.Helper()
	f, w, crop := reviewNewFarm(t, h, "Regla cuadrilla", 6)
	ws := []weighing{{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 400}}
	for _, p := range w[1:] {
		ws = append(ws, weighing{worker: p, plotCrop: crop, day: daysAgo(2), qty: 30})
	}
	h.seedWeighings(t, f, ws)

	found := reviewOnly(t, reviewAnomalies(t, h, f, "&maxKg=1000"), "outlier")
	if len(found) != 1 || found[0].Quantity != 400 {
		t.Fatalf("outlier fired on %v, want exactly the 400", found)
	}
	if found[0].Reference == nil || math.Abs(*found[0].Reference-30) > 1e-9 {
		t.Errorf("reference = %v, want 30 — the MATES' average, this row excluded",
			found[0].Reference)
	}
}

func reviewOutlierQuietWithoutCrew(t *testing.T, h *harness) {
	t.Helper()
	f, w, crop := reviewNewFarm(t, h, "Regla sin cuadrilla", 2)
	h.seedWeighings(t, f, []weighing{
		{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 400},
		{worker: w[1], plotCrop: crop, day: daysAgo(2), qty: 30},
	})
	if found := reviewOnly(t, reviewAnomalies(t, h, f, "&maxKg=1000"), "outlier"); len(found) != 0 {
		t.Fatalf("no crew, no comparison — yet it fired: %v", found)
	}
}

func reviewFutureDateFlagged(t *testing.T, h *harness) {
	t.Helper()
	f, w, crop := reviewNewFarm(t, h, "Regla futuro", 1)
	h.seedWeighings(t, f, []weighing{
		{worker: w[0], plotCrop: crop, day: daysAgo(-3), qty: 50},
		{worker: w[0], plotCrop: crop, day: daysAgo(0), qty: 50},
	})
	found := reviewOnly(t, reviewAnomalies(t, h, f, ""), "future")
	if len(found) != 1 {
		t.Fatalf("future fired %d times, want 1 — today is not tomorrow, and "+
			"'today' has to be the FARM's day, not the server's: %v", len(found), found)
	}
	if found[0].Reference != nil {
		t.Errorf("reference = %v for a date in the future; it must be null", *found[0].Reference)
	}
}

func reviewReportedOnceWorstFirst(t *testing.T, h *harness) {
	t.Helper()
	f, w, crop := reviewNewFarm(t, h, "Regla una vez", 1)
	h.seedWeighings(t, f, []weighing{
		{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 55},
		{worker: w[0], plotCrop: crop, day: daysAgo(2), qty: 340},
	})
	found := reviewAnomalies(t, h, f, "&maxKg=120")
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
}

func cropReportAnswersBasics(t *testing.T, h *harness, f *farmFixture, crop string) {
	t.Helper()
	res := h.mustDo(t, http.MethodGet, "/v1/reports/crops/"+crop, f.OwnerToken, nil, http.StatusOK)
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
	if math.Abs(report.KgPerHa-875) > 1e-6 {
		t.Errorf("kgPerHa = %v, want 875", report.KgPerHa)
	}
}

func cropCurveFindsPeak(t *testing.T, h *harness, f *farmFixture) {
	t.Helper()
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
}

func cropOtherFarmIs404(t *testing.T, h *harness, f *farmFixture) {
	t.Helper()
	other := h.signupFarm(t, "Finca ajena", 80000)
	theirs := h.createPlotCrop(t, other, "Lote Ajeno", "Cafe")

	res := h.do(t, http.MethodGet, "/v1/reports/crops/"+theirs, f.OwnerToken, nil)
	if res.Status != http.StatusNotFound {
		t.Errorf("crop report on another farm's crop: got %d, want 404. A sum over "+
			"an id that matches nothing reads as 'this crop produced nothing': %s",
			res.Status, res.Raw)
	}
	res = h.do(t, http.MethodGet, "/v1/reports/harvest-curve?plotCropId="+theirs,
		f.OwnerToken, nil)
	if res.Status != http.StatusNotFound {
		t.Errorf("harvest curve on another farm's crop: got %d, want 404: %s",
			res.Status, res.Raw)
	}
	res = h.do(t, http.MethodGet, "/v1/reports/crops/not-a-uuid", f.OwnerToken, nil)
	if res.Status != http.StatusNotFound {
		t.Errorf("a malformed id: got %d, want 404: %s", res.Status, res.Raw)
	}
}
