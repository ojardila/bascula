package httpapi

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// The reports.
//
// The web knew how to administer a farm and had no way to say how the harvest
// was going: all of that analysis lived on the phone and none of it on the
// server. These six endpoints are the port, and store/reports.go carries the
// SQL and the note on what Postgres needed that SQLite did not.
//
// Two rules run through every handler here.
//
// FIRST: nothing returns a zero that means "I do not know". Kilos, value and
// the performance index are nullable on the wire, and every null arrives with
// a count or a reason beside it. This is not a style preference — a farm read
// $0 against every harvest record in the console for a week because a null
// amount was rendered as a figure, and in a REPORT a zero is a perfectly
// credible answer, which makes a credible wrong one the dangerous kind.
//
// SECOND: a report is a sum, and a sum over an id that matches nothing comes
// back as a plausible "this produced nothing". So anything addressed by id
// confirms the resource is ours before it adds anything up, and a miss is the
// ordinary 404.

// Defaults, all overridable by query parameter. The anomaly window is the
// phone's DEFAULT_ANOMALY_WINDOW: one harvest season back, and no more
// findings than anyone will read.
const (
	defaultWeeksInList  = 26
	defaultCropWeeks    = 12
	defaultCurveWeeks   = 26
	defaultPerfDays     = 30
	maxReportWeeks      = 520
	maxPerformanceDays  = 3650
	maxAnomalyDays      = 3650
	maxAnomalyRowsAsked = 1000
)

func (s *Server) handleReportWeeks(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	q := r.URL.Query()
	var from, to *time.Time
	if raw := q.Get("from"); raw != "" {
		d, err := time.Parse("2006-01-02", raw)
		if err != nil {
			writeError(w, r, domain.BadRequest("from must be YYYY-MM-DD"))
			return
		}
		from = &d
	}
	if raw := q.Get("to"); raw != "" {
		d, err := time.Parse("2006-01-02", raw)
		if err != nil {
			writeError(w, r, domain.BadRequest("to must be YYYY-MM-DD"))
			return
		}
		to = &d
	}
	if from != nil && to != nil && to.Before(*from) {
		writeError(w, r, domain.BadRequest("to cannot be before from"))
		return
	}

	items, err := store.ReportWeeks(r.Context(), tx, from, to,
		boundedParam(r, "limit", defaultWeeksInList, maxReportWeeks))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scope": store.ScopeHarvest, "items": items})
}

// handleReportWeek is the detail the phone already had: the employee × day
// table and the employee × crop table, whose row totals, column totals and
// grand total all come from the same cells and are asserted to agree.
//
// A week with no work is a 200 with two empty grids, not a 404. A Monday is
// not a resource anybody owns; "nobody picked that week" is a true answer and
// the honest one. The 404 documented on this route is the ordinary one every
// path with an id carries.
func (s *Server) handleReportWeek(w http.ResponseWriter, r *http.Request) {
	monday, err := parseMonday(chi.URLParam(r, "monday"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	detail, err := store.ReportWeekDetail(r.Context(), tx, monday)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handleReportCrop(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	// Every figure below is a SUM over this id. Confirm the crop is ours
	// before adding: another farm's crop must be a 404 and never a report
	// saying it produced nothing.
	id := chi.URLParam(r, "plotCropId")
	if err := store.PlotCropExists(r.Context(), tx, id); err != nil {
		writeError(w, r, err)
		return
	}
	report, err := store.ReportCrop(r.Context(), tx, id,
		boundedParam(r, "weeks", defaultCropWeeks, maxReportWeeks))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// handleReportPerformance is the comparative index, and the most delicate
// thing in this file: it compares each picker against the mates who worked the
// SAME crop on the SAME day, with the picker taken out of the benchmark, and
// averages the daily ratios. Ported wrong, it points at hard-working people
// and calls them slow.
//
// Anybody with too little evidence comes back with a null index and a reason,
// never a low one.
func (s *Server) handleReportPerformance(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	days := boundedParam(r, "days", defaultPerfDays, maxPerformanceDays)
	items, since, err := store.ReportPerformance(r.Context(), tx, days)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"scope": store.ScopeHarvest, "days": days,
		"since":             since.Format("2006-01-02"),
		"minComparableDays": store.MinComparableDays,
		"items":             items,
	})
}

func (s *Server) handleReportAnomalies(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	days := boundedParam(r, "days", store.DefaultAnomalyDays, maxAnomalyDays)
	limit := boundedParam(r, "limit", store.DefaultAnomalyLimit, maxAnomalyRowsAsked)
	maxKg := store.DefaultMaxKg
	if raw := r.URL.Query().Get("maxKg"); raw != "" {
		v, err := strconv.ParseFloat(raw, 64)
		if err != nil || v <= 0 {
			writeError(w, r, domain.BadRequest("maxKg must be a positive number of kilos"))
			return
		}
		maxKg = v
	}

	items, since, err := store.ReportAnomalies(r.Context(), tx, days, maxKg, limit)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"scope": store.ScopeHarvest, "days": days, "maxKg": maxKg, "limit": limit,
		"since": since.Format("2006-01-02"),
		"items": items,
	})
}

// handleReportHarvestCurve reads the shape of the season: where the peak was,
// how many finished weeks have fallen since, and whether it is time to move
// people to another plot. The reading itself is domain.ReadHarvest, the twin
// of packages/shared/src/harvest.ts, tested against the same cases.
func (s *Server) handleReportHarvestCurve(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	var plotCropID *string
	if raw := r.URL.Query().Get("plotCropId"); raw != "" {
		// A curve for another farm's crop would come back as a flat season
		// with no peak, which reads as a real answer. Confirm it is ours.
		if err := store.PlotCropExists(r.Context(), tx, raw); err != nil {
			writeError(w, r, err)
			return
		}
		plotCropID = &raw
	}
	curve, err := store.ReportHarvestCurve(r.Context(), tx, plotCropID,
		boundedParam(r, "weeks", defaultCurveWeeks, maxReportWeeks))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, curve)
}

// withScope wraps a typed report so the response carries the same `scope`
// marker the list endpoints do, without every struct growing a constant field.
func withScope(v any) map[string]any {
	return map[string]any{"scope": store.ScopeHarvest, "report": v}
}

// boundedParam reads a positive integer query parameter, falling back to the
// default and refusing to let a caller ask for a season of the whole world.
// A bad value is the default rather than a 400, matching limitParam: the
// report is not a write and a typo in a URL should not empty a screen.
func boundedParam(r *http.Request, name string, def, max int) int {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}
