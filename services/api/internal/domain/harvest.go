package domain

import "time"

// Reading the shape of a harvest. This is the Go twin of
// packages/shared/src/harvest.ts, kept pure for the same reason that one is:
// what the farm should DO about the weekly totals is the part worth testing,
// and the part a chart cannot say out loud.
//
// The port is line for line. The threshold, the exclusion of the running week,
// the "strictly greater" that keeps the newest week on a tie, and the two-week
// floor before anything is called a decline all behave exactly as they do on
// the phone, and harvest_test.go is the TypeScript suite translated case for
// case so that a divergence fails here rather than in front of an owner
// deciding whether to move his crew.

// WeekTotal is one week's yield. Kg is a pointer because a week whose kilos
// could not be established is not a week that produced nothing: see the note on
// ReportWeek in internal/store/reports.go.
type WeekTotal struct {
	WeekStart string   `json:"weekStart"`
	Kg        *float64 `json:"kg"`
	// Records is how many weighings produced this week. Zero is a real zero and
	// the reason Kg is nil beside it: the week is IN the series, empty, rather
	// than missing from it. The difference decides whether the two weeks either
	// side of it are consecutive, which decides everything below.
	Records int `json:"records"`
}

// HarvestShape is the reading itself.
type HarvestShape struct {
	// Peak is the finished week with the highest yield so far, or nil when
	// there is not one finished week to look at. Never a zero-valued week:
	// "no peak yet" and "a peak of nothing" are different answers.
	Peak *WeekTotal `json:"peak"`
	// FallingWeeks counts consecutive finished weeks that fell by more than
	// the threshold. A genuine count, so zero here means zero.
	FallingWeeks int `json:"fallingWeeks"`
	// WindingDown is true when the harvest is clearly on its way out.
	WindingDown bool `json:"windingDown"`
	// Reason names why there is no reading, and is empty when there is one.
	// A caller must never render "peak: none, falling: 0" as a healthy season
	// when the truth is that the season has barely started.
	Reason string `json:"reason,omitempty"`
}

// DefaultDropThreshold is the phone's, and changing it changes when a farm is
// told to move its crew.
const DefaultDropThreshold = 0.25

// ReasonSeasonTooShort is the one thing that can stop the reading: not a
// single finished week to compare.
const ReasonSeasonTooShort = "no_finished_weeks"

// ReadHarvest takes the weekly totals NEWEST FIRST, as the queries return
// them, and the Monday of the week the farm is currently in.
//
// The current week is excluded from the reading: it is still running, so its
// total will always look like a fall next to a finished one. A week whose
// kilos are unknown is excluded from the PEAK too, and for the stronger reason
// — treating an unknown as a zero would manufacture a 100% drop and tell a farm
// its season was over.
//
// # The falling run walks the calendar, not the surviving rows
//
// This is the part that was wrong, and it was wrong in a way no test with a
// complete series could catch. The run used to be computed over the weeks that
// SURVIVED the filter above, comparing element i against element i+1 as though
// they were consecutive weeks. They are only consecutive if nothing was dropped
// between them — and something is dropped whenever a week's kilos are unknown,
// or (before the series was drawn on a calendar at all) whenever a week had no
// work in it and never appeared.
//
// So a fortnight of rain, or a lot left to rest, became invisible, and the weeks
// either side of it were compared as neighbours. Two such comparisons and the
// farm is told its harvest is winding down and to move the crew somewhere else.
//
// The run therefore stops at the first break: a week that is not the calendar
// week before the one being compared, or a week whose kilos are unknown. Not
// knowing whether last week fell is not the same as knowing it did not, and the
// reading says the smaller of the two — falling stops, WindingDown goes quiet —
// because this number's job is to justify moving people off a plot.
func ReadHarvest(weeks []WeekTotal, currentMonday string, dropThreshold float64) HarvestShape {
	// Every finished week, holes included. The peak looks past the holes; the
	// run below must not.
	series := make([]WeekTotal, 0, len(weeks))
	finished := make([]WeekTotal, 0, len(weeks))
	for _, w := range weeks {
		if w.WeekStart >= currentMonday {
			continue
		}
		series = append(series, w)
		if w.Kg != nil {
			finished = append(finished, w)
		}
	}
	if len(finished) == 0 {
		return HarvestShape{Reason: ReasonSeasonTooShort}
	}

	peak := finished[0]
	for _, w := range finished {
		// Strictly greater, so a tie keeps the newer week — the phone's
		// reduce does the same, and which one is named changes the advice.
		if *w.Kg > *peak.Kg {
			peak = w
		}
	}

	// Newest first, so each week is compared against the one before it — and
	// only when it IS the one before it.
	falling := 0
	for i := 0; i < len(series)-1; i++ {
		cur, older := series[i], series[i+1]
		if cur.Kg == nil || older.Kg == nil {
			break
		}
		if !isWeekBefore(older.WeekStart, cur.WeekStart) {
			break
		}
		prev := *older.Kg
		if prev <= 0 {
			break
		}
		drop := (prev - *cur.Kg) / prev
		if drop > dropThreshold {
			falling++
		} else {
			break
		}
	}

	// Two falling weeks alone could be rain. Past the peak as well, it is the
	// season ending — which is when moving people to another plot pays off.
	return HarvestShape{
		Peak:         &peak,
		FallingWeeks: falling,
		WindingDown:  falling >= 2 && peak.WeekStart < currentMonday,
	}
}

// isWeekBefore says whether `older` is the calendar week immediately before
// `newer`. Both are Mondays as YYYY-MM-DD, which is what the whole series is
// keyed by.
//
// Dates and not string arithmetic: "2026-08-03" is seven days before
// "2026-08-10" and also, by any lexicographic reasoning, next to "2026-08-11".
// A malformed date is not adjacent to anything, which is the safe answer — it
// stops the run rather than extending it over something nobody can read.
func isWeekBefore(older, newer string) bool {
	a, err := time.Parse("2006-01-02", older)
	if err != nil {
		return false
	}
	b, err := time.Parse("2006-01-02", newer)
	if err != nil {
		return false
	}
	return a.AddDate(0, 0, 7).Equal(b)
}
