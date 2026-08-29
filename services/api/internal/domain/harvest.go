package domain

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

// WeekTotal is one finished week's yield. Kg is a pointer because a week whose
// kilos could not be established is not a week that produced nothing: see the
// note on ReportWeek in internal/store/reports.go.
type WeekTotal struct {
	WeekStart string   `json:"weekStart"`
	Kg        *float64 `json:"kg"`
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
// kilos are unknown is excluded too, and for the stronger reason — treating an
// unknown as a zero would manufacture a 100% drop and tell a farm its season
// was over.
func ReadHarvest(weeks []WeekTotal, currentMonday string, dropThreshold float64) HarvestShape {
	finished := make([]WeekTotal, 0, len(weeks))
	for _, w := range weeks {
		if w.WeekStart < currentMonday && w.Kg != nil {
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

	// Newest first, so each week is compared against the one before it.
	falling := 0
	for i := 0; i < len(finished)-1; i++ {
		prev := *finished[i+1].Kg
		if prev <= 0 {
			break
		}
		drop := (prev - *finished[i].Kg) / prev
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
