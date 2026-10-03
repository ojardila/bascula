// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"testing"
	"time"
)

// The harvest dashboard folded over a scripted week: ties in the lote and
// people rankings, a weighing with no kilos and no value that spans into
// next week, and a person the kinds lookup does not know.

const (
	c2saDashFarmSQL  = "week_start((now() AT TIME ZONE f.timezone)::date)"
	c2saDashRowsSQL  = "picker_ids(h.employee_id, h.local_day)"
	c2saDashNamesSQL = "btrim(name || ' ' || coalesce(last_name, ''))"
	c2saDashKindsSQL = "SELECT id::text, kind, tag FROM employees"
	c2saDashPlotsSQL = "SELECT id::text, name FROM plots"
)

func c2saDay(d int) time.Time { return time.Date(2026, 9, d, 0, 0, 0, 0, time.UTC) }

func c2saF(v float64) *float64 { return &v }
func c2saI(v int64) *int64     { return &v }
func c2saS(v string) *string   { return &v }

// c2saDashRow is one weighing in harvestDashboardSQL's column order.
func c2saDashRow(emp string, day int, kg *float64, value *int64, spans bool, plot *string, people ...string) []any {
	return []any{emp, c2saDay(day), kg, value, false, spans, plot, people}
}

// c2saDashTx is the week of 2026-09-28 seen on Wednesday 2026-09-30.
func c2saDashTx() *cmrTx {
	p1, p2, p3, p4 := c2saS("P1"), c2saS("P2"), c2saS("P3"), c2saS("P4")
	return &cmrTx{
		row: map[string]cmrRow{c2saDashFarmSQL: {vals: []any{c2saDay(30), c2saDay(28)}}},
		query: map[string]*cmrRows{
			c2saDashRowsSQL: {data: [][]any{
				// this week
				c2saDashRow("E1", 28, c2saF(10), c2saI(100), false, p1, "E1"),
				c2saDashRow("E1", 29, c2saF(10), c2saI(100), false, p2, "E1"),
				c2saDashRow("T", 28, c2saF(40), c2saI(400), false, nil, "M1", "M2"),
				c2saDashRow("E2", 29, c2saF(4), c2saI(40), false, p3, "E2"),
				c2saDashRow("E3", 29, c2saF(4), c2saI(40), false, p4, "E3"),
				c2saDashRow("E4", 30, nil, nil, true, nil, "E4"),
				// last week: P1 gave more than P2
				c2saDashRow("E1", 21, c2saF(5), c2saI(50), false, p1, "E1"),
				c2saDashRow("E1", 22, c2saF(3), c2saI(30), false, p2, "E1"),
			}},
			c2saDashNamesSQL: {data: [][]any{
				{"E1", "Eva", true}, {"T", "Equipo", true}, {"E2", "beto", true},
				{"E3", "Ana", true}, {"E4", "Zoe", true},
			}},
			// E2, E3 and E4 are missing from the kinds lookup.
			c2saDashKindsSQL: {data: [][]any{{"E1", "persona", nil}, {"T", "equipo", nil}}},
			c2saDashPlotsSQL: {data: [][]any{{"P1", "Uno"}, {"P2", "Dos"}, {"P3", "b-lote"}, {"P4", "A-lote"}}},
		},
	}
}

func TestC2saHarvestDashboardBreaksTiesAndCountsGaps(t *testing.T) {
	out, err := ReportHarvestDashboard(context.Background(), c2saDashTx())
	if err != nil {
		t.Fatalf("dashboard: %v", err)
	}

	// Lotes: P1 and P2 tie on 10 kg this week, last week decides; P3 and P4
	// tie on everything, the name decides, case-insensitively.
	t.Run("plot order", func(t *testing.T) {
		var plots []string
		for _, p := range out.Plots {
			plots = append(plots, p.PlotID)
		}
		if want := []string{"P1", "P2", "P4", "P3"}; !c2saSameOrder(plots, want) {
			t.Errorf("plot order %v, want %v", plots, want)
		}
	})

	// People: the team and Eva tie on 20 kg each, the team's 40 kg together
	// goes first; Ana and beto tie on everything; Zoe has no kilos.
	t.Run("people order", func(t *testing.T) {
		var people []string
		for _, p := range out.People {
			people = append(people, p.EmployeeID)
		}
		if want := []string{"T", "E1", "E3", "E2", "E4"}; !c2saSameOrder(people, want) {
			t.Errorf("people order %v, want %v", people, want)
		}
	})
	t.Run("people rows", func(t *testing.T) {
		for _, p := range out.People {
			c2saCheckDashPerson(t, p)
		}
	})

	t.Run("summary", func(t *testing.T) {
		w := out.Summary.ThisWeek
		if w.Records != 6 || w.RecordsNotInKg != 1 || w.RecordsWithoutValue != 1 || w.RecordsSpanningWeeks != 1 {
			t.Errorf("this week totals %+v: want 6 records, one each not in kg, without value, spanning weeks", w)
		}
		if out.Summary.LastWeek.Kg == nil || *out.Summary.LastWeek.Kg != 8 {
			t.Errorf("last week kg %v, want 8", out.Summary.LastWeek.Kg)
		}
	})
}

// c2saCheckDashPerson checks one people row of the scripted week.
func c2saCheckDashPerson(t *testing.T, p HarvestDashboardPerson) {
	t.Helper()
	switch p.EmployeeID {
	case "T":
		if p.Kind != "equipo" || p.Members != 2 || p.KgEach == nil || *p.KgEach != 20 {
			t.Errorf("team row %+v", p)
		}
	case "E2", "E3", "E4":
		if p.Kind != KindPersona {
			t.Errorf("%s has kind %q, want %q when the lookup does not know it", p.EmployeeID, p.Kind, KindPersona)
		}
	}
	if p.EmployeeID == "E4" && (p.KgEach != nil || p.Kg != nil) {
		t.Errorf("E4 has kilos out of nothing: %+v", p)
	}
}

func c2saSameOrder(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// Every lookup of the dashboard fails the whole answer when a row fails to
// scan, and the weighings fail it when their iteration ends in an error.
func TestC2saHarvestDashboardPassesLookupFailuresThrough(t *testing.T) {
	ctx := context.Background()
	for _, sql := range []string{c2saDashRowsSQL, c2saDashNamesSQL, c2saDashKindsSQL, c2saDashPlotsSQL} {
		tx := c2saDashTx()
		tx.query[sql] = cmrFailing()
		out, err := ReportHarvestDashboard(ctx, tx)
		cmrWantErr(t, "dashboard scan of "+sql, err)
		if out != nil {
			t.Errorf("%s: a dashboard came back with the error", sql)
		}
	}
	tx := c2saDashTx()
	tx.query[c2saDashRowsSQL] = cmrEndsBadly()
	_, err := ReportHarvestDashboard(ctx, tx)
	cmrWantErr(t, "dashboard iteration", err)
}
