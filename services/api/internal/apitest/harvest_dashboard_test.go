package apitest

import (
	"math"
	"net/http"
	"strings"
	"testing"
	"time"
)

// GET /v1/reports/harvest-dashboard and PUT /v1/farm/harvest-mode —
// «Modo cosecha».
//
// Pinned here: this week against last week over the same weekdays, today's
// kilos and people, kilos per person per day, the estimated value priced like
// every other report, the lotes (trend, share, pickers) and the people
// (ranking, below-average flag, who has nothing today), and the roles.

type harvestDashboard struct {
	Scope             string  `json:"scope"`
	Today             string  `json:"today"`
	ThisWeek          string  `json:"thisWeek"`
	LastWeek          string  `json:"lastWeek"`
	BelowAverageRatio float64 `json:"belowAverageRatio"`
	Summary           struct {
		ThisWeek        reportTotals `json:"thisWeek"`
		LastWeekToDate  reportTotals `json:"lastWeekToDate"`
		LastWeek        reportTotals `json:"lastWeek"`
		Today           reportTotals `json:"today"`
		PickersToday    int          `json:"pickersToday"`
		PickersThisWeek int          `json:"pickersThisWeek"`
		PersonDays      int          `json:"personDays"`
		KgPerPersonDay  *float64     `json:"kgPerPersonDay"`
	} `json:"summary"`
	Days []struct {
		Day string `json:"day"`
		reportTotals
		Pickers int  `json:"pickers"`
		Future  bool `json:"future"`
	} `json:"days"`
	Plots []struct {
		PlotID string `json:"plotId"`
		Name   string `json:"name"`
		reportTotals
		LastWeekToDateKg *float64 `json:"lastWeekToDateKg"`
		LastWeekKg       *float64 `json:"lastWeekKg"`
		Share            *float64 `json:"share"`
		Pickers          int      `json:"pickers"`
	} `json:"plots"`
	Unattributed reportTotals `json:"unattributed"`
	People       []struct {
		EmployeeID string `json:"employeeId"`
		Name       string `json:"name"`
		reportTotals
		DaysWorked   int      `json:"daysWorked"`
		KgPerDay     *float64 `json:"kgPerDay"`
		PickedToday  bool     `json:"pickedToday"`
		BelowAverage bool     `json:"belowAverage"`
	} `json:"people"`
	NotToday []struct {
		EmployeeID   string `json:"employeeId"`
		Name         string `json:"name"`
		LastRecordOn string `json:"lastRecordOn"`
	} `json:"notToday"`
}

func TestHarvestDashboard(t *testing.T) {
	h := requireDB(t)
	const price = 80000
	f := h.signupFarm(t, "Finca del modo cosecha", price)

	ana := h.createWorker(t, f, "Ana", "40000001")
	beto := h.createWorker(t, f, "Beto", "40000002")
	carla := h.createWorker(t, f, "Carla", "40000003")
	dora := h.createWorker(t, f, "Dora", "40000004")
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
	isMonday := todayT.Weekday() == time.Monday
	isSunday := todayT.Weekday() == time.Sunday
	weekday := (int(todayT.Weekday()) + 6) % 7

	h.seedWeighings(t, f, []weighing{
		// This week.
		{worker: ana, plotCrop: alto, day: today, qty: 30},
		{worker: ana, day: today, qty: 3, unitID: canasta}, // no kilos, no lote
		{worker: beto, plotCrop: bajo, day: today, qty: 10},
		{worker: carla, plotCrop: alto, day: at(0, 0), qty: 40},
		// Last week.
		{worker: ana, plotCrop: alto, day: daysAgo(7), qty: 25},
		{worker: dora, plotCrop: bajo, day: at(1, 0), qty: 50},
		{worker: beto, plotCrop: alto, day: at(1, 6), qty: 60},
		// Two weeks back: outside everything.
		{worker: dora, plotCrop: bajo, day: at(2, 3), qty: 999},
	})

	res := h.mustDo(t, http.MethodGet, "/v1/reports/harvest-dashboard", f.OwnerToken, nil, http.StatusOK)
	r := decodeInto[harvestDashboard](t, res)

	if r.Scope != "harvest" || r.Today != today || r.ThisWeek != thisMonday || r.LastWeek != at(1, 0) {
		t.Errorf("envelope: scope=%s today=%s thisWeek=%s lastWeek=%s", r.Scope, r.Today, r.ThisWeek, r.LastWeek)
	}

	a3CheckHarvestSummary(t, r, price, isMonday, isSunday)

	a3CheckHarvestDays(t, r, at, weekday, isMonday)

	a3CheckHarvestPlots(t, r, isSunday)

	a3CheckHarvestPeople(t, r, carla, ana, beto)

	a3CheckHarvestNotToday(t, r, carla, dora, at, isMonday)

	t.Run("an empty farm is nulls, not zeros", func(t *testing.T) {
		empty := h.signupFarm(t, "Finca vacía de cosecha", price)
		r := decodeInto[harvestDashboard](t, h.mustDo(t, http.MethodGet,
			"/v1/reports/harvest-dashboard", empty.OwnerToken, nil, http.StatusOK))
		if r.Summary.ThisWeek.Kg != nil || r.Summary.KgPerPersonDay != nil || r.Summary.ThisWeek.ValueCents != nil ||
			len(r.Plots) != 0 || len(r.People) != 0 || len(r.NotToday) != 0 || len(r.Days) != 7 {
			t.Errorf("empty farm: %+v", r)
		}
	})

	t.Run("roles", func(t *testing.T) {
		a3HarvestDashboardRoles(t, h, f)
	})
}

func a3CheckHarvestSummary(t *testing.T, r harvestDashboard, price int64, isMonday, isSunday bool) {
	t.Helper()
	// Summary.
	s := r.Summary
	a3Near(t, "kilos this week", s.ThisWeek.Kg, 80)
	if s.ThisWeek.Records != 4 || s.ThisWeek.RecordsNotInKg != 1 {
		t.Errorf("this week counts: %+v", s.ThisWeek)
	}
	// Priced like every report: the canasta has no kilos but it has a value.
	if s.ThisWeek.ValueCents == nil || *s.ThisWeek.ValueCents != (30+3+10+40)*price || !s.ThisWeek.ValueIsEstimate {
		t.Errorf("estimated value this week: %+v", s.ThisWeek)
	}
	a3Near(t, "last week whole", s.LastWeek.Kg, 135)
	lastToDate := 75.0
	if isSunday {
		lastToDate += 60
	}
	a3Near(t, "last week to date", s.LastWeekToDate.Kg, lastToDate)
	todayKg, todayPickers := 40.0, 2
	if isMonday {
		todayKg += 40
		todayPickers++
	}
	a3Near(t, "kilos today", s.Today.Kg, todayKg)
	if s.PickersToday != todayPickers || s.PickersThisWeek != 3 || s.PersonDays != 3 {
		t.Errorf("people: today=%d week=%d personDays=%d", s.PickersToday, s.PickersThisWeek, s.PersonDays)
	}
	a3Near(t, "kilos per person per day", s.KgPerPersonDay, 80.0/3)
}

func a3CheckHarvestDays(t *testing.T, r harvestDashboard, at func(int, int) string, weekday int, isMonday bool) {
	t.Helper()
	// Days.
	if len(r.Days) != 7 {
		t.Fatalf("days: got %d, want 7", len(r.Days))
	}
	for i, d := range r.Days {
		if d.Day != at(0, i) || d.Future != (i > weekday) {
			t.Errorf("day %d: %s future=%v", i, d.Day, d.Future)
		}
	}
	mondayKg := 40.0
	if isMonday {
		mondayKg += 40
	}
	a3Near(t, "Monday", r.Days[0].Kg, mondayKg)
	if !isMonday {
		a3Near(t, "today", r.Days[weekday].Kg, 40)
		if r.Days[weekday].Pickers != 2 {
			t.Errorf("pickers today in days: %d", r.Days[weekday].Pickers)
		}
	}
}

func a3CheckHarvestPlots(t *testing.T, r harvestDashboard, isSunday bool) {
	t.Helper()
	// Lotes.
	if len(r.Plots) != 2 || r.Plots[0].Name != "Lote Alto" || r.Plots[1].Name != "Lote Bajo" {
		t.Fatalf("plots: %+v", r.Plots)
	}
	a, b := r.Plots[0], r.Plots[1]
	a3Near(t, "alto this week", a.Kg, 70)
	a3Near(t, "alto last week", a.LastWeekKg, 85)
	altoToDate := 25.0
	if isSunday {
		altoToDate += 60
	}
	a3Near(t, "alto last week to date", a.LastWeekToDateKg, altoToDate)
	a3Near(t, "alto share", a.Share, 70.0/80)
	if a.Pickers != 2 {
		t.Errorf("alto pickers: %d", a.Pickers)
	}
	a3Near(t, "bajo this week", b.Kg, 10)
	a3Near(t, "bajo last week", b.LastWeekKg, 50)
	a3Near(t, "bajo share", b.Share, 10.0/80)
	if r.Unattributed.Records != 1 || r.Unattributed.Kg != nil || r.Unattributed.RecordsNotInKg != 1 {
		t.Errorf("unattributed: %+v", r.Unattributed)
	}
}

func a3CheckHarvestPeople(t *testing.T, r harvestDashboard, carla, ana, beto string) {
	t.Helper()
	// People: most kilos first; Beto is well under the average.
	if len(r.People) != 3 {
		t.Fatalf("people: %+v", r.People)
	}
	order := []string{carla, ana, beto}
	for i, p := range r.People {
		if p.EmployeeID != order[i] {
			t.Errorf("people[%d] = %s (%s)", i, p.Name, p.EmployeeID)
		}
	}
	if !strings.HasPrefix(r.People[0].Name, "Carla") {
		t.Errorf("name: %q", r.People[0].Name)
	}
	a3Near(t, "ana kg/day", r.People[1].KgPerDay, 30)
	if r.People[1].DaysWorked != 1 || !r.People[1].PickedToday || r.People[1].BelowAverage {
		t.Errorf("ana: %+v", r.People[1])
	}
	if !r.People[2].BelowAverage || r.People[0].BelowAverage {
		t.Errorf("below average: carla=%v beto=%v", r.People[0].BelowAverage, r.People[2].BelowAverage)
	}
}

func a3CheckHarvestNotToday(t *testing.T, r harvestDashboard, carla, dora string, at func(int, int) string, isMonday bool) {
	t.Helper()
	// Who has nothing today: Dora (last week only), and Carla unless today is
	// her Monday.
	want := []string{dora}
	if !isMonday {
		want = []string{carla, dora}
	}
	if len(r.NotToday) != len(want) {
		t.Fatalf("notToday: %+v", r.NotToday)
	}
	for i, p := range r.NotToday {
		if p.EmployeeID != want[i] {
			t.Errorf("notToday[%d] = %s", i, p.Name)
		}
	}
	if r.NotToday[len(r.NotToday)-1].LastRecordOn != at(1, 0) {
		t.Errorf("dora last record: %s", r.NotToday[len(r.NotToday)-1].LastRecordOn)
	}
}

func a3HarvestDashboardRoles(t *testing.T, h *harness, f *farmFixture) {
	if res := h.do(t, http.MethodGet, "/v1/reports/harvest-dashboard", f.AdminToken, nil); res.Status != http.StatusOK {
		t.Errorf("admin: %d", res.Status)
	}
	if res := h.do(t, http.MethodGet, "/v1/reports/harvest-dashboard", f.WeigherToken, nil); res.Status != http.StatusForbidden {
		t.Errorf("weigher: got %d, want 403", res.Status)
	}
	if res := h.do(t, http.MethodGet, "/v1/reports/harvest-dashboard", "", nil); res.Status != http.StatusUnauthorized {
		t.Errorf("no token: got %d, want 401", res.Status)
	}
}

// a3Near compares a nullable kilo figure with what it should be.
func a3Near(t *testing.T, what string, got *float64, want float64) {
	t.Helper()
	if got == nil {
		t.Errorf("%s: got null, want %v", what, want)
		return
	}
	if math.Abs(*got-want) > 1e-9 {
		t.Errorf("%s: got %v, want %v", what, *got, want)
	}
}

func TestHarvestMode(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del interruptor", 80000)
	other := h.signupFarm(t, "Finca vecina del interruptor", 80000)

	mode := func(token string) any {
		t.Helper()
		res := h.mustDo(t, http.MethodGet, "/v1/farm", token, nil, http.StatusOK)
		return res.Body["harvestMode"]
	}
	if got := mode(f.OwnerToken); got != false {
		t.Fatalf("default: harvestMode = %v, want false", got)
	}

	res := h.mustDo(t, http.MethodPut, "/v1/farm/harvest-mode", f.AdminToken,
		map[string]any{"enabled": true}, http.StatusOK)
	if res.Body["harvestMode"] != true {
		t.Errorf("admin turning it on: %s", res.Raw)
	}
	if got := mode(f.OwnerToken); got != true {
		t.Errorf("after turning on: harvestMode = %v", got)
	}
	if got := mode(other.OwnerToken); got != false {
		t.Errorf("another farm was switched too: %v", got)
	}
	// The owner's PUT /v1/farm does not touch it.
	h.mustDo(t, http.MethodPut, "/v1/farm", f.OwnerToken, map[string]any{"city": "Salento"}, http.StatusOK)
	if got := mode(f.OwnerToken); got != true {
		t.Errorf("PUT /v1/farm reset the switch: %v", got)
	}

	res = h.mustDo(t, http.MethodPut, "/v1/farm/harvest-mode", f.OwnerToken,
		map[string]any{"enabled": false}, http.StatusOK)
	if res.Body["harvestMode"] != false {
		t.Errorf("owner turning it off: %s", res.Raw)
	}

	if res := h.do(t, http.MethodPut, "/v1/farm/harvest-mode", f.WeigherToken,
		map[string]any{"enabled": true}); res.Status != http.StatusForbidden {
		t.Errorf("weigher: got %d, want 403", res.Status)
	}
	if res := h.do(t, http.MethodPut, "/v1/farm/harvest-mode", f.OwnerToken,
		map[string]any{}); res.Status != http.StatusBadRequest {
		t.Errorf("no enabled: got %d, want 400", res.Status)
	}
}
