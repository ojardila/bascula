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

// ---------------------------------------------------------------------------
// The peak walks the same calendar the falling run does
// ---------------------------------------------------------------------------

// TestThePeakDoesNotStepOverAHoleTheRunRefusesToCross.
//
// The run was taught to stop at a week whose kilos are unknown. The peak was
// not, so one response could say "your best week was 1000 kg" and, of the very
// same series, "I will not compare these weeks to each other because there is a
// hole between them". Two numbers disagreeing about what the series is, with
// nothing on the wire to show it.
func TestThePeakDoesNotStepOverAHoleTheRunRefusesToCross(t *testing.T) {
	// 1000, then a week nobody could put in kilos, then 300 and 100.
	series := weeks(100, 300, 0, 1000)
	series[2].Kg = nil

	r := read(series, "2026-08-31")
	if r.Peak == nil || *r.Peak.Kg != 300 {
		t.Fatalf("peak = %+v, want the 300 week: the 1000 is on the far side "+
			"of the hole", r.Peak)
	}
	if r.ContiguousWeeks != 2 {
		t.Fatalf("contiguousWeeks = %d, want 2", r.ContiguousWeeks)
	}
	if r.FallingWeeks != 1 || r.WindingDown {
		t.Fatalf("the run stepped over the hole after all: %+v", r)
	}
}

// TestASeasonEndsOnlyOnItsOwnUnbrokenStretch.
//
// Two falls are enough to call the season over, so the weeks that produced them
// had better be the weeks the peak came from. Here they are: an unbroken run,
// and the verdict stands.
func TestASeasonEndsOnlyOnItsOwnUnbrokenStretch(t *testing.T) {
	r := read(weeks(100, 300, 500, 400), "2026-08-31")
	if !r.WindingDown || r.FallingWeeks != 2 {
		t.Fatalf("an unbroken decline was not read as one: %+v", r)
	}
	if r.Peak == nil || *r.Peak.Kg != 500 || r.ContiguousWeeks != 4 {
		t.Fatalf("peak/contiguous: %+v %d", r.Peak, r.ContiguousWeeks)
	}

	// The same four numbers with a hole punched between the falls and the peak.
	// The falls are still two, and they are still real; what is gone is the
	// peak they were supposed to be falling FROM, so the season is not called.
	holed := weeks(100, 300, 500, 0, 400)
	holed[3].Kg = nil
	h := read(holed, "2026-08-31")
	if h.FallingWeeks != 2 {
		t.Fatalf("fallingWeeks = %d, want 2: the hole is behind them", h.FallingWeeks)
	}
	if h.Peak == nil || *h.Peak.Kg != 500 {
		t.Fatalf("peak = %+v, want the 500 week", h.Peak)
	}
	if h.ContiguousWeeks != 3 {
		t.Fatalf("contiguousWeeks = %d, want 3", h.ContiguousWeeks)
	}
	// The peak is the oldest week of the stretch and the run has fallen away
	// from it twice: that is a season ending, read over the three weeks this
	// farm actually knows about, and it says so.
	if !h.WindingDown {
		t.Fatalf("a decline inside one unbroken stretch was thrown away: %+v", h)
	}
}

// TestTheReadingStartsAtTheNewestWeekItCanSee.
//
// The newest finished week's kilos are unknown, so there is no run at all: the
// reading must not answer with a peak drawn from weeks the run cannot reach.
func TestTheReadingStartsAtTheNewestWeekItCanSee(t *testing.T) {
	series := weeks(0, 400, 300, 200)
	series[0].Kg = nil

	r := read(series, "2026-08-31")
	if r.FallingWeeks != 0 || r.WindingDown {
		t.Fatalf("a run was read past an unknown week: %+v", r)
	}
	if r.Peak == nil || *r.Peak.Kg != 400 {
		t.Fatalf("peak = %+v, want the 400 week — the newest one that is known", r.Peak)
	}
	if r.ContiguousWeeks != 3 {
		t.Fatalf("contiguousWeeks = %d, want 3", r.ContiguousWeeks)
	}
}
