package apitest

import (
	"context"
	"fmt"
	"math/rand"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// A season, and what it costs to report on it.
//
// The phone's notes on these queries are not about elegance, they are about
// seconds: the crew rule was a self-join that took 10.8 SECONDS on 18,000
// weighings, on the JS thread, every time the review screen opened, and the
// duplicate rule cost more than the other four together until it got an index.
// Porting those queries without measuring the port would be taking the fix on
// faith, so this test builds a real season and times every endpoint against a
// ceiling.
//
// The ceiling is deliberately generous — none of these should be anywhere near
// it — because what it exists to catch is not a slow millisecond, it is a
// return to the shape that took eleven seconds.
const reportBudget = 2 * time.Second

// The season. 18,000 is the figure the phone's own notes use for the run that
// took 10.8 seconds.
const (
	seasonWeighings = 18000
	seasonPickers   = 40
	seasonCrops     = 6
	seasonDays      = 150
)

// TestReportsHoldUpOnASeason seeds ~18,000 weighings and times all six
// reports. It also runs the QUADRATIC form of the crew rule side by side with
// the ported one, because "same results, one pass" is a claim, and a claim
// about performance that is never measured is a comment.
func TestReportsHoldUpOnASeason(t *testing.T) {
	if testing.Short() {
		t.Skip("a season takes a few seconds to build")
	}
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la temporada", 80000)

	crops := make([]string, 0, seasonCrops)
	for i := 0; i < seasonCrops; i++ {
		crops = append(crops, h.createPlotCrop(t, f, fmt.Sprintf("Lote %d", i+1), "Cafe"))
	}

	seeded := time.Now()
	workers := h.seedSeason(t, f, crops)
	t.Logf("seeded %d weighings over %d pickers, %d crops and %d days in %s",
		seasonWeighings, len(workers), len(crops), seasonDays,
		time.Since(seeded).Round(time.Millisecond))

	monday := mondayOf(daysAgo(30))
	cases := []struct{ name, path string }{
		{"weeks (list)", "/v1/reports/weeks"},
		{"week detail (both grids)", "/v1/reports/weeks/" + monday},
		{"crop", "/v1/reports/crops/" + crops[0]},
		{"performance, 30 days", "/v1/reports/performance?days=30"},
		{"performance, whole season", "/v1/reports/performance?days=" + fmt.Sprint(seasonDays)},
		{"anomalies, 120 days", "/v1/reports/anomalies"},
		{"anomalies, whole season", "/v1/reports/anomalies?days=" + fmt.Sprint(seasonDays)},
		{"harvest curve", "/v1/reports/harvest-curve"},
	}

	for _, c := range cases {
		// Once to warm the plan cache and the buffers, then the reading. A
		// first-call figure measures the cold cache, which is not what an
		// owner refreshing a screen experiences.
		h.mustDo(t, http.MethodGet, c.path, f.OwnerToken, nil, http.StatusOK)

		start := time.Now()
		h.mustDo(t, http.MethodGet, c.path, f.OwnerToken, nil, http.StatusOK)
		took := time.Since(start)

		t.Logf("%-28s %8s", c.name, took.Round(time.Millisecond))
		if took > reportBudget {
			t.Errorf("%s took %s over a season of %d weighings, budget %s.\n"+
				"This is the shape the phone's crew rule had before it was "+
				"rewritten: check whether a self-join has come back.",
				c.name, took.Round(time.Millisecond), seasonWeighings, reportBudget)
		}
	}

	// And the comparison that gives the numbers their meaning: the crew rule
	// as it was — every weighing joined against every other weighing of its
	// plot-day — against the derived form that shipped.
	t.Run("the quadratic crew rule against the one that replaced it", func(t *testing.T) {
		h.withTenant(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
			func(ctx context.Context, tx pgx.Tx) {
				since := time.Now().AddDate(0, 0, -seasonDays)

				start := time.Now()
				var derived int
				err := tx.QueryRow(ctx, `
					WITH dayplot AS (
					  SELECT l.id, l.employee_id, c.plot_crop_id, l.local_day,
					         (l.quantity * u.kg_factor)::float8 AS kg
					    FROM work_records l
					    JOIN work_record_plot_crops c ON c.work_record_id = l.id
					    JOIN work_units u ON u.id = l.unit_id
					   WHERE l.deleted_at IS NULL AND l.local_day >= $1
					),
					agg AS (
					  SELECT plot_crop_id, local_day, sum(kg) AS tot, count(*) AS n
					    FROM dayplot GROUP BY 1, 2
					)
					SELECT count(*) FROM dayplot dp
					  JOIN agg ON agg.plot_crop_id = dp.plot_crop_id
					          AND agg.local_day = dp.local_day
					 WHERE agg.n >= 5
					   AND (agg.tot - dp.kg) / (agg.n - 1) > 0
					   AND dp.kg >= 4 * ((agg.tot - dp.kg) / (agg.n - 1))`, since).Scan(&derived)
				if err != nil {
					t.Fatalf("derived form: %v", err)
				}
				derivedTook := time.Since(start)

				start = time.Now()
				var quadratic int
				err = tx.QueryRow(ctx, `
					WITH dayplot AS (
					  SELECT l.id, l.employee_id, c.plot_crop_id, l.local_day,
					         (l.quantity * u.kg_factor)::float8 AS kg
					    FROM work_records l
					    JOIN work_record_plot_crops c ON c.work_record_id = l.id
					    JOIN work_units u ON u.id = l.unit_id
					   WHERE l.deleted_at IS NULL AND l.local_day >= $1
					)
					SELECT count(*) FROM dayplot dp
					 WHERE (SELECT count(*) FROM dayplot m
					         WHERE m.plot_crop_id = dp.plot_crop_id
					           AND m.local_day = dp.local_day) >= 5
					   AND dp.kg >= 4 * (SELECT avg(m.kg) FROM dayplot m
					                      WHERE m.plot_crop_id = dp.plot_crop_id
					                        AND m.local_day = dp.local_day
					                        AND m.id <> dp.id)`, since).Scan(&quadratic)
				if err != nil {
					t.Fatalf("quadratic form: %v", err)
				}
				quadraticTook := time.Since(start)

				t.Logf("crew rule over %d weighings: derived %s, quadratic self-join %s (%.0fx)",
					seasonWeighings, derivedTook.Round(time.Millisecond),
					quadraticTook.Round(time.Millisecond),
					float64(quadraticTook)/float64(derivedTook))

				// The point of running both is that they agree. A rewrite that
				// is faster and answers something else is not a rewrite.
				if derived != quadratic {
					t.Errorf("the two forms disagree: derived found %d, the self-join found %d.\n"+
						"Speed is not the property that matters here — being the same rule is.",
						derived, quadratic)
				}
			})
	})
}

// seedSeason writes a season straight in. Going through HTTP would measure the
// HTTP layer eighteen thousand times, which is not the question. The rows are
// ordinary in every way that matters to the reports: the trigger computes
// local_day in the farm's zone and week_start is generated from it.
func (h *harness) seedSeason(t *testing.T, f *farmFixture, crops []string) []string {
	t.Helper()
	activityID := h.harvestActivityID(t, f)

	workers := make([]string, 0, seasonPickers)
	err := h.withTenantCommit(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
		func(ctx context.Context, tx pgx.Tx) error {
			for i := 0; i < seasonPickers; i++ {
				id := uuid.NewString()
				if _, err := tx.Exec(ctx, `
					INSERT INTO employees (id, farm_id, name, last_name)
					VALUES ($1, $2, $3, 'Temporada')`,
					id, f.FarmID, fmt.Sprintf("Recolector %02d", i+1)); err != nil {
					return err
				}
				workers = append(workers, id)
			}
			return nil
		})
	if err != nil {
		t.Fatalf("seed pickers: %v", err)
	}

	var unitID string
	var tz string
	err = h.withTenantCommit(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
		func(ctx context.Context, tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT a.unit_id::text, fm.timezone
				  FROM activities a JOIN farms fm ON fm.id = a.farm_id
				 WHERE a.id = $1`, activityID).Scan(&unitID, &tz)
		})
	if err != nil {
		t.Fatalf("read the farm's unit and zone: %v", err)
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		t.Fatalf("load %s: %v", tz, err)
	}

	// Deterministic, so a slow run can be reproduced exactly.
	rng := rand.New(rand.NewSource(20260829))
	today := time.Now().In(loc)

	type row struct {
		id       string
		employee string
		crop     string
		at       time.Time
		day      time.Time
		qty      float64
	}
	rows := make([]row, 0, seasonWeighings)
	for i := 0; i < seasonWeighings; i++ {
		back := rng.Intn(seasonDays)
		day := time.Date(today.Year(), today.Month(), today.Day(), 12, 0, 0, 0, loc).
			AddDate(0, 0, -back)
		// A harvest curve worth reading: yield rises to a peak around a third
		// of the way in and tapers off, so the curve endpoint has a real shape
		// to find rather than noise.
		phase := float64(seasonDays-back) / float64(seasonDays)
		scale := 1.6 - 2.2*(phase-0.35)*(phase-0.35)*4
		if scale < 0.25 {
			scale = 0.25
		}
		qty := (18 + rng.Float64()*34) * scale
		// A handful of genuine findings, so the review rules do the work of
		// finding, sorting and capping rather than scanning and returning
		// nothing.
		switch {
		case i%2000 == 0:
			qty = 300 + rng.Float64()*100 // an extra typed zero
		case i%3001 == 0:
			qty = 260 // far above the crew that day
		}
		rows = append(rows, row{
			id:       uuid.NewString(),
			employee: workers[rng.Intn(len(workers))],
			crop:     crops[rng.Intn(len(crops))],
			at:       day,
			day:      day,
			qty:      qty,
		})
	}

	// COPY is refused on a table with row level security, which is the right
	// refusal — RLS is the isolation boundary and COPY would step over it. So
	// the season goes in as batched multi-row INSERTs through unnest, which
	// the policy checks like any other write.
	const batch = 3000
	for lo := 0; lo < len(rows); lo += batch {
		hi := lo + batch
		if hi > len(rows) {
			hi = len(rows)
		}
		chunk := rows[lo:hi]
		ids := make([]string, len(chunk))
		emps := make([]string, len(chunk))
		crps := make([]string, len(chunk))
		ats := make([]time.Time, len(chunk))
		days := make([]time.Time, len(chunk))
		qtys := make([]float64, len(chunk))
		for i, r := range chunk {
			ids[i], emps[i], crps[i] = r.id, r.employee, r.crop
			ats[i], days[i], qtys[i] = r.at, r.day, r.qty
		}
		err = h.withTenantCommit(t, f.FarmID, f.OwnerUserID, domain.RoleOwner,
			func(ctx context.Context, tx pgx.Tx) error {
				if _, err := tx.Exec(ctx, `
					INSERT INTO work_records
					  (id, farm_id, employee_id, activity_id, pay_scheme, rate_source,
					   started_at, ended_at, local_day, end_local_day,
					   quantity, unit_id, created_by, created_at)
					SELECT u.id, $1, u.employee, $2, 'unidad_trabajo', 'weekly_price',
					       u.at, u.at, u.day, u.day, u.qty, $3, $4, u.at
					  FROM unnest($5::uuid[], $6::uuid[], $7::timestamptz[],
					              $8::date[], $9::numeric[])
					       AS u(id, employee, at, day, qty)`,
					f.FarmID, activityID, unitID, f.OwnerUserID,
					ids, emps, ats, days, qtys); err != nil {
					return err
				}
				_, err := tx.Exec(ctx, `
					INSERT INTO work_record_plot_crops (work_record_id, plot_crop_id, farm_id)
					SELECT u.id, u.crop, $1
					  FROM unnest($2::uuid[], $3::uuid[]) AS u(id, crop)`,
					f.FarmID, ids, crps)
				return err
			})
		if err != nil {
			t.Fatalf("seed the season: %v", err)
		}
	}

	// ANALYZE, because the planner has never seen this table with rows in it
	// and a report timed against stale statistics measures the wrong thing.
	if _, err := h.admin.Exec(context.Background(),
		"ANALYZE work_records, work_record_plot_crops"); err != nil {
		t.Fatalf("analyze: %v", err)
	}
	return workers
}
