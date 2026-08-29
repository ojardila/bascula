package domain

import (
	"testing"
	"time"
)

// packages/shared/src/harvest.test.ts, case for case. The reading decides
// whether an owner is told to move his crew off a plot, so the two
// implementations agreeing is not a nicety.

// weeks builds the newest-first series the queries return, dated back from
// 2026-08-24 one Monday at a time — the same fixture the TypeScript suite uses.
func weeks(kg ...float64) []WeekTotal {
	base := time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)
	out := make([]WeekTotal, 0, len(kg))
	for i, k := range kg {
		v := k
		out = append(out, WeekTotal{
			WeekStart: base.AddDate(0, 0, -i*7).Format("2006-01-02"),
			Kg:        &v,
		})
	}
	return out
}

const current = "2026-08-24"

func read(w []WeekTotal, monday string) HarvestShape {
	return ReadHarvest(w, monday, DefaultDropThreshold)
}

func TestARisingHarvestIsNotWindingDown(t *testing.T) {
	r := read(weeks(900, 800, 600, 300), "2026-08-31")
	if r.FallingWeeks != 0 || r.WindingDown {
		t.Fatalf("rising harvest read as falling: %+v", r)
	}
	if r.Peak == nil || *r.Peak.Kg != 900 {
		t.Fatalf("peak: %+v", r.Peak)
	}
}

func TestTwoSteepFallsAfterThePeakMeansTheSeasonIsEnding(t *testing.T) {
	// 1000 -> 700 (-30%) -> 450 (-36%), newest first.
	r := read(weeks(450, 700, 1000, 900), "2026-08-31")
	if r.FallingWeeks != 2 || !r.WindingDown {
		t.Fatalf("want 2 falling weeks and winding down, got %+v", r)
	}
}

func TestASingleBadWeekIsNotATrend(t *testing.T) {
	r := read(weeks(600, 1000, 950, 900), "2026-08-31")
	if r.FallingWeeks != 1 {
		t.Fatalf("falling weeks: %d, want 1", r.FallingWeeks)
	}
	if r.WindingDown {
		t.Fatal("one week could just be rain")
	}
}

func TestAMildDeclineDoesNotTriggerIt(t *testing.T) {
	// -10% each week: the harvest is easing off, not collapsing.
	r := read(weeks(729, 810, 900, 1000), "2026-08-31")
	if r.FallingWeeks != 0 || r.WindingDown {
		t.Fatalf("a 10%% ease-off read as a collapse: %+v", r)
	}
}

func TestTheRunningWeekNeverCountsAsAFall(t *testing.T) {
	// The newest week is the current one and looks tiny because it is partial.
	r := read(weeks(120, 1000, 950, 900), current)
	if r.FallingWeeks != 0 {
		t.Fatalf("a week in progress proves nothing, got %d falling", r.FallingWeeks)
	}
	if r.Peak == nil || *r.Peak.Kg != 1000 {
		t.Fatalf("the running week cannot be the peak either: %+v", r.Peak)
	}
}

func TestAHarvestThatPeakedEarlyAndKeptFallingIsWindingDown(t *testing.T) {
	// 1000 -> 400 (-60%) -> 200 (-50%) -> 100 (-50%), newest first.
	r := read(weeks(100, 200, 400, 1000), "2026-08-31")
	if r.Peak == nil || *r.Peak.Kg != 1000 {
		t.Fatalf("peak: %+v", r.Peak)
	}
	if r.FallingWeeks != 3 || !r.WindingDown {
		t.Fatalf("want 3 falling and winding down, got %+v", r)
	}
}

func TestASeasonWithOnlyTheCurrentWeekSaysNothingYet(t *testing.T) {
	r := read(weeks(500), current)
	if r.Peak != nil {
		t.Fatalf("peak from a week still running: %+v", r.Peak)
	}
	if r.WindingDown {
		t.Fatal("winding down with nothing to compare")
	}
	// And it says WHY, rather than handing back a shape indistinguishable
	// from a healthy season with no decline in it.
	if r.Reason != ReasonSeasonTooShort {
		t.Fatalf("reason %q, want %q", r.Reason, ReasonSeasonTooShort)
	}
}

// The one case the phone cannot have, because SQLite gave it a number for
// every week: here a week's kilos can be genuinely unknown — every record in
// it was weighed in a unit with no conversion to kilos. Treating that as zero
// would manufacture a 100% drop and end somebody's season on paper.
func TestAWeekWithUnknownKilosIsNotAWeekOfNothing(t *testing.T) {
	series := weeks(1000, 1000, 1000)
	series[0].Kg = nil // the newest finished week cannot be expressed in kilos

	r := read(series, "2026-08-31")
	if r.FallingWeeks != 0 {
		t.Fatalf("an unknown week counted as a collapse: %+v", r)
	}
	if r.Peak == nil || *r.Peak.Kg != 1000 {
		t.Fatalf("peak: %+v", r.Peak)
	}
}
