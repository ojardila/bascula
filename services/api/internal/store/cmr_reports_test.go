// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

const cmrThisWeek = "SELECT this_week FROM bounds"

func cmrWantErr(t *testing.T, what string, err error) {
	t.Helper()
	if !errors.Is(err, errCMR) {
		t.Errorf("%s: got %v, want the scripted failure passed through", what, err)
	}
}

// A report half-read is not a smaller report: a row that fails to scan, or a
// result set that ends in an error, is the error and never the rows so far.
func TestCMRReportsPassScanAndIterationErrorsThrough(t *testing.T) {
	ctx := context.Background()
	for _, rows := range []*cmrRows{cmrFailing(), cmrEndsBadly()} {
		tx := &cmrTx{query: map[string]*cmrRows{reportWeeksSQL: rows}}
		items, _, err := ReportWeeks(ctx, tx, nil, nil, 26)
		cmrWantErr(t, "ReportWeeks", err)
		if items != nil {
			t.Errorf("ReportWeeks returned rows with its error: %v", items)
		}

		tx = &cmrTx{query: map[string]*cmrRows{cropLabelsSQL: rows}}
		_, err = cropLabels(ctx, tx)
		if rows.iterErr == nil {
			cmrWantErr(t, "cropLabels scan", err)
		} else {
			cmrWantErr(t, "cropLabels iteration", err)
		}

		tx = &cmrTx{query: map[string]*cmrRows{weekByDayCellsSQL: rows}}
		_, err = gridFromCells(ctx, tx, weekByDayCellsSQL, time.Now(), time.Now(), nil)
		cmrWantErr(t, "gridFromCells", err)

		header := cmrRow{vals: []any{"pc-1", "Café — Lote 1"}}
		tx = &cmrTx{row: map[string]cmrRow{"FROM plot_crops pc": header}, query: map[string]*cmrRows{cropWeeksSQL: rows}}
		_, err = ReportCrop(ctx, tx, "pc-1", 12)
		cmrWantErr(t, "ReportCrop", err)

		tx = &cmrTx{query: map[string]*cmrRows{performanceCrewSQL: rows}}
		_, _, err = performanceCrew(ctx, tx, time.Now())
		cmrWantErr(t, "performanceCrew", err)

		tx = &cmrTx{query: map[string]*cmrRows{harvestCurveSQL: rows},
			row: map[string]cmrRow{cmrThisWeek: {vals: []any{time.Now()}}}}
		_, err = ReportHarvestCurve(ctx, tx, nil, 26)
		cmrWantErr(t, "ReportHarvestCurve", err)
	}

	tx := &cmrTx{query: map[string]*cmrRows{performanceIndexSQL: cmrFailing()}}
	err := applyPerformanceIndex(ctx, tx, time.Now(), time.Now(), nil, map[string]int{})
	cmrWantErr(t, "applyPerformanceIndex", err)

	tx = &cmrTx{row: map[string]cmrRow{"SELECT today - $1::int FROM bounds": {vals: []any{time.Now()}}},
		query: map[string]*cmrRows{ruleImpossibleSQL: cmrFailing()}}
	_, _, err = ReportAnomalies(ctx, tx, 30, 40, 50)
	cmrWantErr(t, "ReportAnomalies", err)
}

// TestCMRPerformanceCrewAndIndexEdges: a picker with no kilos says so rather
// than reading as slow, and an index row for somebody outside the crew list
// is skipped rather than written onto somebody else.
func TestCMRPerformanceCrewAndIndexEdges(t *testing.T) {
	ctx := context.Background()
	kg := 120.0
	crew := &cmrRows{data: [][]any{
		{"w-kg", "Ana", 3, &kg},
		{"w-none", "Beto"},
	}}
	tx := &cmrTx{query: map[string]*cmrRows{performanceCrewSQL: crew}}
	out, index, err := performanceCrew(ctx, tx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out[1].Kg != nil || out[1].Reason != ReasonNoKilos || out[0].Reason != ReasonFewComparableDays {
		t.Fatalf("crew reasons: %+v", out)
	}

	irl := 1.2
	idx := &cmrRows{data: [][]any{{"ghost", &irl, 9}, {"w-kg", &irl, MinComparableDays}}}
	tx = &cmrTx{query: map[string]*cmrRows{performanceIndexSQL: idx}}
	if err := applyPerformanceIndex(ctx, tx, time.Now(), time.Now(), out, index); err != nil {
		t.Fatal(err)
	}
	if out[0].Index == nil || *out[0].Index != 1.2 || out[0].Reason != "" || out[1].Index != nil {
		t.Errorf("index applied wrongly: %+v", out)
	}
}

// TestCMRSortsKeepTheUnknownLast: the unattributed crop column and the
// pickers without an index go after everything that has one, from either
// side of the comparison.
func TestCMRSortsKeepTheUnknownLast(t *testing.T) {
	a := "a"
	cols := []GridColumn{{Key: &a, Label: "z"}, {Key: nil, Label: "a"}}
	sortColumns(cols)
	if cols[0].Key == nil || cols[1].Key != nil {
		t.Errorf("the nil column must stay last: %+v", cols)
	}
	cols = []GridColumn{{Key: nil, Label: "a"}, {Key: &a, Label: "z"}}
	sortColumns(cols)
	if cols[0].Key == nil {
		t.Errorf("the nil column must move last: %+v", cols)
	}

	hi, lo := 1.5, 0.5
	ws := []WorkerPerformance{{Name: "n1"}, {Name: "i1", Index: &lo}, {Name: "n0"}, {Name: "i0", Index: &hi}}
	for i := 1; i < len(ws); i++ {
		for j := i; j > 0 && performanceLess(ws[j], ws[j-1]); j-- {
			ws[j], ws[j-1] = ws[j-1], ws[j]
		}
	}
	got := ""
	for _, w := range ws {
		got += w.Name + " "
	}
	if got != "i0 i1 n0 n1 " {
		t.Errorf("performance order = %q", got)
	}
}

// TestCMRAnomaliesStopAtTheLimit: a record flagged by several rules is
// listed once, and the list stops at the limit asked for.
func TestCMRAnomaliesStopAtTheLimit(t *testing.T) {
	ctx := context.Background()
	one := func() *cmrRows { return &cmrRows{data: [][]any{{"r-1", "w-1", "Ana"}, {"r-2", "w-1", "Ana"}}} }
	tx := &cmrTx{row: map[string]cmrRow{"SELECT today - $1::int FROM bounds": {vals: []any{time.Now()}}},
		query: map[string]*cmrRows{ruleImpossibleSQL: one(), ruleDuplicateSQL: one(), ruleDigitSQL: one(),
			ruleOutlierSQL: one(), ruleFutureSQL: one()}}
	out, _, err := ReportAnomalies(ctx, tx, 30, 40, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].RecordID != "r-1" || out[0].Rule != RuleImpossible {
		t.Errorf("anomalies with limit 1: %+v", out)
	}
}

// TestCMRHarvestCurveCountsAndDates covers the week counters and the two
// date reads the covered window is built from.
func TestCMRHarvestCurveCountsAndDates(t *testing.T) {
	ctx := context.Background()
	monday := time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)
	curve := func(data [][]any) (*HarvestCurve, error) {
		tx := &cmrTx{query: map[string]*cmrRows{harvestCurveSQL: {data: data}},
			row: map[string]cmrRow{cmrThisWeek: {vals: []any{monday}}}}
		return ReportHarvestCurve(ctx, tx, nil, 26)
	}
	kg := 10.0
	out, err := curve([][]any{{monday, &kg, 2}, {monday.AddDate(0, 0, -7), nil, 3}, {monday.AddDate(0, 0, -14), nil, 0}})
	if err != nil {
		t.Fatal(err)
	}
	if out.WeeksWithoutKilos != 1 || out.WeeksWithoutRecords != 1 {
		t.Errorf("records without kilos and empty weeks are two different counts: %+v", out)
	}

	// A Monday past year 9999 formats as five digits and cannot be read back:
	// the error, not a window that silently starts at year zero.
	far := time.Date(10000, 1, 3, 0, 0, 0, 0, time.UTC)
	if _, err := curve([][]any{{far, &kg, 1}}); err == nil {
		t.Error("an unreadable oldest week must fail")
	}
	if _, err := curve([][]any{{far, &kg, 1}, {monday, &kg, 1}}); err == nil {
		t.Error("an unreadable newest week must fail")
	}
}
