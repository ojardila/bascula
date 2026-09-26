package apitest

import (
	"math"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// GET /v1/workers/{id}/performance — the «Rendimiento» section of a profile.
//
// Pinned here: the weeks are the settlement weeks with the running one last,
// the farm average is per PICKER (not per worker on the books), last week is
// compared over the same weekdays, kilos in a unit with no kg_factor are
// counted and left out, the lotes add up, and the route answers only to an
// administrator of the person's own farm.

type perfWeek struct {
	WeekStart      string   `json:"weekStart"`
	Records        int      `json:"records"`
	Kg             *float64 `json:"kg"`
	RecordsNotInKg int      `json:"recordsNotInKg"`
	DaysWorked     int      `json:"daysWorked"`
	FarmAvgKg      *float64 `json:"farmAvgKg"`
	FarmPickers    int      `json:"farmPickers"`
	Finished       bool     `json:"finished"`
}

type perfReport struct {
	Scope        string  `json:"scope"`
	EmployeeID   string  `json:"employeeId"`
	Today        string  `json:"today"`
	ThisWeek     string  `json:"thisWeek"`
	LastRecordOn *string `json:"lastRecordOn"`
	Summary      struct {
		ThisWeekKg       *float64 `json:"thisWeekKg"`
		LastWeekToDateKg *float64 `json:"lastWeekToDateKg"`
		LastWeekKg       *float64 `json:"lastWeekKg"`
		RecentFrom       string   `json:"recentFrom"`
		RecentKg         *float64 `json:"recentKg"`
		RecentDaysWorked int      `json:"recentDaysWorked"`
		KgPerDayWorked   *float64 `json:"kgPerDayWorked"`
	} `json:"summary"`
	Weeks []perfWeek `json:"weeks"`
	Days  []struct {
		Day     string   `json:"day"`
		Records int      `json:"records"`
		Kg      *float64 `json:"kg"`
		Future  bool     `json:"future"`
	} `json:"days"`
	Plots []struct {
		PlotID  string  `json:"plotId"`
		Name    string  `json:"name"`
		Kg      float64 `json:"kg"`
		Records int     `json:"records"`
	} `json:"plots"`
	UnattributedKg *float64 `json:"unattributedKg"`
	RecordsNotInKg int      `json:"recordsNotInKg"`
}

func wantKg(t *testing.T, what string, got *float64, want float64) {
	t.Helper()
	if got == nil {
		t.Errorf("%s: got null, want %v kg", what, want)
		return
	}
	if math.Abs(*got-want) > 1e-9 {
		t.Errorf("%s: got %v kg, want %v kg", what, *got, want)
	}
}

func TestWorkerPerformance(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del rendimiento", 80000)

	ana := h.createWorker(t, f, "Ana", "20000001")
	beto := h.createWorker(t, f, "Beto", "20000002")
	carla := h.createWorker(t, f, "Carla", "20000003")
	alto := h.createPlotCrop(t, f, "Lote Alto", "Cafe")
	bajo := h.createPlotCrop(t, f, "Lote Bajo", "Cafe")
	canasta := h.createUnitWithoutKgFactor(t, f)

	today := daysAgo(0)
	thisMonday := mondayOf(today)
	at := func(weeksBack, dayOfWeek int) string {
		d, _ := time.Parse("2006-01-02", thisMonday)
		return d.AddDate(0, 0, -7*weeksBack+dayOfWeek).Format("2006-01-02")
	}
	todayT, _ := time.Parse("2006-01-02", today)
	isSunday := todayT.Weekday() == time.Sunday

	h.seedWeighings(t, f, []weighing{
		// This week: 30 kg on Monday, plus a canasta that has no kilos.
		{worker: ana, plotCrop: alto, day: at(0, 0), qty: 30},
		{worker: ana, plotCrop: alto, day: at(0, 0), qty: 3, unitID: canasta},
		// Last week: Monday and Sunday.
		{worker: ana, plotCrop: alto, day: at(1, 0), qty: 20},
		{worker: ana, plotCrop: alto, day: at(1, 6), qty: 50},
		// Three weeks back, another lote.
		{worker: ana, plotCrop: bajo, day: at(3, 2), qty: 40},
		// Outside the twelve weeks and outside the lotes window.
		{worker: ana, plotCrop: bajo, day: at(20, 1), qty: 99},
		// Beto only moves the farm average of last week.
		{worker: beto, plotCrop: alto, day: at(1, 1), qty: 60},
	})

	get := func(token, id, query string) response {
		return h.do(t, http.MethodGet, "/v1/workers/"+id+"/performance"+query, token, nil)
	}

	t.Run("the figures", func(t *testing.T) {
		res := get(f.OwnerToken, ana, "")
		if res.Status != http.StatusOK {
			t.Fatalf("status %d: %s", res.Status, res.Raw)
		}
		r := decodeInto[perfReport](t, res)

		if r.Scope != "harvest" || r.EmployeeID != ana || r.ThisWeek != thisMonday || r.Today != today {
			t.Errorf("envelope: %+v", r)
		}
		if r.LastRecordOn == nil || *r.LastRecordOn != at(0, 0) {
			t.Errorf("lastRecordOn = %v, want %s", r.LastRecordOn, at(0, 0))
		}
		if len(r.Weeks) != 12 {
			t.Fatalf("weeks: got %d, want 12", len(r.Weeks))
		}
		for i, w := range r.Weeks {
			if want := at(11-i, 0); w.WeekStart != want {
				t.Errorf("week %d starts %s, want %s", i, w.WeekStart, want)
			}
			if w.Finished != (i < 11) {
				t.Errorf("week %s finished=%v", w.WeekStart, w.Finished)
			}
		}

		cur, last, three := r.Weeks[11], r.Weeks[10], r.Weeks[8]
		wantKg(t, "this week", cur.Kg, 30)
		if cur.Records != 2 || cur.RecordsNotInKg != 1 || cur.DaysWorked != 1 {
			t.Errorf("this week counts: %+v", cur)
		}
		wantKg(t, "farm average this week", cur.FarmAvgKg, 30)
		wantKg(t, "last week", last.Kg, 70)
		if last.DaysWorked != 2 || last.FarmPickers != 2 {
			t.Errorf("last week counts: %+v", last)
		}
		// (70 + 60) / 2 pickers — Carla, who picked nothing, is not in it.
		wantKg(t, "farm average last week", last.FarmAvgKg, 65)
		wantKg(t, "three weeks back", three.Kg, 40)
		if empty := r.Weeks[9]; empty.Kg != nil || empty.Records != 0 || empty.FarmAvgKg != nil {
			t.Errorf("an empty week must be records 0 and null kilos: %+v", empty)
		}
		if r.RecordsNotInKg != 1 {
			t.Errorf("recordsNotInKg = %d, want 1", r.RecordsNotInKg)
		}

		wantKg(t, "summary this week", r.Summary.ThisWeekKg, 30)
		wantKg(t, "summary last week", r.Summary.LastWeekKg, 70)
		lastToDate := 20.0
		if isSunday {
			lastToDate += 50
		}
		wantKg(t, "last week to date", r.Summary.LastWeekToDateKg, lastToDate)
		if r.Summary.RecentFrom != at(3, 0) {
			t.Errorf("recentFrom = %s, want %s", r.Summary.RecentFrom, at(3, 0))
		}
		wantKg(t, "recent kilos", r.Summary.RecentKg, 140)
		if r.Summary.RecentDaysWorked != 4 {
			t.Errorf("recentDaysWorked = %d, want 4", r.Summary.RecentDaysWorked)
		}
		wantKg(t, "kilos per day worked", r.Summary.KgPerDayWorked, 35)

		if len(r.Days) != 7 {
			t.Fatalf("days: got %d, want 7", len(r.Days))
		}
		wantKg(t, "Monday", r.Days[0].Kg, 30)
		for i, d := range r.Days {
			if d.Day != at(0, i) {
				t.Errorf("day %d is %s, want %s", i, d.Day, at(0, i))
			}
			if d.Future != (d.Day > today) {
				t.Errorf("day %s future=%v with today %s", d.Day, d.Future, today)
			}
			if i > 0 && d.Kg != nil {
				t.Errorf("day %s has kilos nobody picked: %v", d.Day, *d.Kg)
			}
		}

		if len(r.Plots) != 2 || r.Plots[0].Name != "Lote Alto" || r.Plots[1].Name != "Lote Bajo" {
			t.Fatalf("plots: %+v", r.Plots)
		}
		if r.Plots[0].Kg != 100 || r.Plots[0].Records != 3 || r.Plots[1].Kg != 40 {
			t.Errorf("plots: %+v", r.Plots)
		}
		if r.UnattributedKg != nil {
			t.Errorf("unattributedKg = %v, want null", *r.UnattributedKg)
		}
	})

	t.Run("weeks is bounded", func(t *testing.T) {
		r := decodeInto[perfReport](t, h.mustDo(t, http.MethodGet,
			"/v1/workers/"+ana+"/performance?weeks=2", f.OwnerToken, nil, http.StatusOK))
		if len(r.Weeks) != 4 {
			t.Errorf("weeks=2: got %d weeks, want the 4-week minimum", len(r.Weeks))
		}
		r = decodeInto[perfReport](t, h.mustDo(t, http.MethodGet,
			"/v1/workers/"+ana+"/performance?weeks=21", f.OwnerToken, nil, http.StatusOK))
		wantKg(t, "twenty weeks back", r.Weeks[0].Kg, 99)
	})

	t.Run("nobody picked anything", func(t *testing.T) {
		r := decodeInto[perfReport](t, h.mustDo(t, http.MethodGet,
			"/v1/workers/"+carla+"/performance", f.OwnerToken, nil, http.StatusOK))
		if r.LastRecordOn != nil || r.Summary.ThisWeekKg != nil || r.Summary.KgPerDayWorked != nil ||
			r.Summary.RecentKg != nil || len(r.Plots) != 0 {
			t.Errorf("an empty person must come back empty and null, not zero: %+v", r)
		}
		// The farm average is still there, for scale.
		wantKg(t, "farm average seen from Carla", r.Weeks[10].FarmAvgKg, 65)
	})

	t.Run("roles and tenancy", func(t *testing.T) {
		if res := get(f.AdminToken, ana, ""); res.Status != http.StatusOK {
			t.Errorf("admin: %d", res.Status)
		}
		if res := get(f.WeigherToken, ana, ""); res.Status != http.StatusForbidden {
			t.Errorf("weigher: got %d, want 403", res.Status)
		}
		if res := get("", ana, ""); res.Status != http.StatusUnauthorized {
			t.Errorf("no token: got %d, want 401", res.Status)
		}
		other := h.signupFarm(t, "Finca vecina", 80000)
		if res := get(other.OwnerToken, ana, ""); res.Status != http.StatusNotFound {
			t.Errorf("another farm's owner: got %d, want 404 — %s", res.Status, res.Raw)
		}
		if res := get(f.OwnerToken, uuid.NewString(), ""); res.Status != http.StatusNotFound {
			t.Errorf("unknown worker: got %d, want 404", res.Status)
		}
		// The neighbour's own picker must not leak Ana's farm into its average.
		pedro := h.createWorker(t, other, "Pedro", "30000001")
		r := decodeInto[perfReport](t, h.mustDo(t, http.MethodGet,
			"/v1/workers/"+pedro+"/performance", other.OwnerToken, nil, http.StatusOK))
		for _, w := range r.Weeks {
			if w.FarmAvgKg != nil || w.FarmPickers != 0 {
				t.Errorf("another farm's weighings leaked into the average: %+v", w)
			}
		}
	})
}
