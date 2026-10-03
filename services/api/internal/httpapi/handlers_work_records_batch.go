// SPDX-License-Identifier: MIT

package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// maxBatchWorkRecords bounds one batch. A harvest week of a large crew is a
// few hundred weighings; anything bigger is an import, and has its own route.
const maxBatchWorkRecords = 1000

// batchIDSpace namespaces the ids derived from a batch id, so the same batch
// id sent twice names the same rows and a retry writes nothing new.
var batchIDSpace = uuid.MustParse("5b0f3c8e-7a51-4e8b-9a43-2f6d8f1c0b17")

type workRecordBatchRequest struct {
	// ID is the batch's idempotency key. When present, every line that does
	// not name its own id gets one derived from (batch id, line number), so a
	// resent batch finds its rows already there and answers 200 for each.
	ID string `json:"id"`
	// WeekStart, when present, must be a Monday, and every line must fall in
	// that week: a harvest week that spills into the next one is a typo.
	WeekStart string `json:"weekStart"`
	// ActivityID is the default for lines that name none. When both are
	// empty the farm's harvest activity (priced by the week) is used.
	ActivityID string              `json:"activityId"`
	Items      []workRecordRequest `json:"items"`
}

// handleCreateWorkRecordBatch writes many work records atomically: every line
// goes through createWorkRecord — the same price rules, weigher restrictions
// and idempotency as POST /v1/work-records — inside the request's single
// transaction. The first refusal answers with the line number and the tenant
// middleware rolls back everything before it, so a week is written whole or
// not at all.
func (s *Server) handleCreateWorkRecordBatch(w http.ResponseWriter, r *http.Request) {
	var body workRecordBatchRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	monday, sunday, err := validateWorkRecordBatch(&body)
	if err != nil {
		writeError(w, r, err)
		return
	}

	defaultActivity, err := batchDefaultActivity(r, &body)
	if err != nil {
		writeError(w, r, err)
		return
	}

	out := make([]any, 0, len(body.Items))
	created := 0
	for i, it := range body.Items {
		prepareBatchLine(&it, i, body.ID, defaultActivity)
		if err := batchLineInWeek(it, monday, sunday, body.WeekStart); err != nil {
			writeError(w, r, batchLineError(i, err))
			return
		}
		rec, status, err := s.createWorkRecord(r, it)
		if err != nil {
			writeError(w, r, batchLineError(i, err))
			return
		}
		if status == http.StatusCreated {
			created++
		}
		out = append(out, rec)
	}
	status := http.StatusCreated
	if created == 0 {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]any{
		"items":    out,
		"created":  created,
		"existing": len(out) - created,
	})
}

// prepareBatchLine fills a line's defaults: the batch's activity, and an id
// derived from (batch id, line number) when the batch has one and the line
// names none.
func prepareBatchLine(it *workRecordRequest, i int, batchID, defaultActivity string) {
	if it.ActivityID == "" {
		it.ActivityID = defaultActivity
	}
	if it.ID == "" && batchID != "" {
		it.ID = uuid.NewSHA1(batchIDSpace, []byte(fmt.Sprintf("%s:%d", batchID, i))).String()
	}
}

// validateWorkRecordBatch checks the batch's shape and returns the week its
// lines must fall in (both zero when weekStart is absent).
func validateWorkRecordBatch(body *workRecordBatchRequest) (time.Time, time.Time, error) {
	var monday, sunday time.Time
	if len(body.Items) == 0 {
		return monday, sunday, domain.BadRequest("items is required and cannot be empty")
	}
	if len(body.Items) > maxBatchWorkRecords {
		return monday, sunday, domain.BadRequest(fmt.Sprintf("at most %d items per batch", maxBatchWorkRecords))
	}
	if body.WeekStart != "" {
		d, err := time.Parse(time.DateOnly, body.WeekStart)
		if err != nil || d.Weekday() != time.Monday {
			return monday, sunday, domain.BadRequest("weekStart must be a Monday, YYYY-MM-DD")
		}
		monday, sunday = d, d.AddDate(0, 0, 6)
	}
	if body.ID != "" {
		if _, err := uuid.Parse(body.ID); err != nil {
			return monday, sunday, domain.BadRequest("id must be a UUID")
		}
	}
	return monday, sunday, nil
}

// batchDefaultActivity is the activity for lines that name none: the
// batch's own, or the farm's harvest activity — looked up only when some
// line needs it.
func batchDefaultActivity(r *http.Request, body *workRecordBatchRequest) (string, error) {
	if body.ActivityID != "" {
		return body.ActivityID, nil
	}
	for _, it := range body.Items {
		if it.ActivityID != "" {
			continue
		}
		tx, err := tenant.Tx(r.Context())
		if err != nil {
			return "", err
		}
		return store.HarvestActivityID(r.Context(), tx)
	}
	return "", nil
}

// batchLineInWeek refuses a line whose dates fall outside the batch's week.
// A zero monday means the batch named no week.
func batchLineInWeek(it workRecordRequest, monday, sunday time.Time, weekStart string) error {
	if monday.IsZero() {
		return nil
	}
	from, to, err := parseWorkRecordDates(it)
	if err != nil {
		return err
	}
	if from.Before(monday) || to.After(sunday) {
		return domain.BadRequest(
			"the date is outside the week that starts on " + weekStart)
	}
	return nil
}

// batchLineError says which line was refused, keeping the route's own code.
func batchLineError(i int, err error) error {
	var de *domain.Error
	if errors.As(err, &de) {
		details := map[string]any{"line": i}
		for k, v := range de.Details {
			details[k] = v
		}
		return (&domain.Error{Status: de.Status, Code: de.Code,
			Message: fmt.Sprintf("line %d: %s", i, de.Message)}).WithDetails(details).WithCause(err)
	}
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, store.NoRows) {
		return domain.NotFound(fmt.Sprintf("line %d: the worker, activity, plot or crop does not exist here", i)).
			WithDetails(map[string]any{"line": i}).WithCause(err)
	}
	return err
}
