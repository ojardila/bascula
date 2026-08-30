package apitest

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// ---------------------------------------------------------------------------
// 1. The season import, uploaded slower than the server's ReadTimeout.
// ---------------------------------------------------------------------------

// TestASeasonUploadedSlowerThanTheReadTimeoutArrivesWhole is the one test in
// this suite that cannot run in process.
//
// Every other test here posts through httptest.NewRecorder, which is not a
// connection: it has no read deadline, so a body that would have been cut off
// by http.Server arrives perfectly and the test proves nothing about the thing
// that was actually broken. The bug lived in the transport — cmd/api sets
// ReadTimeout: 30s, that deadline covers the BODY, and the season import is
// 11,7 MB and 48 022 rows on a farm's connection — so the test has to own a
// real listener, a real http.Server with a real timeout, and has to dribble the
// bytes.
//
// The timeout here is two seconds rather than the production thirty for the
// obvious reason: what is under test is the RELATIONSHIP between the server's
// deadline and the route's exemption, and that relationship is the same at two
// seconds as at thirty. The upload takes about six.
//
// The negative control matters as much as the assertion. A second request, the
// same size and the same dribble, goes to a route that has NOT bought itself an
// exemption — and it has to fail. Without that, a test that passes because the
// deadline never fired at all would look exactly like a test that passes
// because the fix works.
func TestASeasonUploadedSlowerThanTheReadTimeoutArrivesWhole(t *testing.T) {
	h := requireDB(t)
	if testing.Short() {
		// It is a real twelve megabytes and a real fifty thousand rows, which
		// is half a minute. That is the point of it — a smaller body would not
		// be the thing the farm is about to send — so it is skippable rather
		// than shrunk. `make test` runs it.
		t.Skip("the whole point of this one is that it is a real season")
	}
	f := h.signupFarm(t, "Finca de la mudanza", 100000)

	const (
		serverReadTimeout = 2 * time.Second
		uploadTakes       = 6 * time.Second
		bodyBytes         = 12 << 20
	)

	body, workers, records := seasonImportBody(t, bodyBytes)
	if len(body) < bodyBytes {
		t.Fatalf("the body is %d bytes, which is not the 12 MB this is about", len(body))
	}

	ts := httptest.NewUnstartedServer(h.server)
	ts.Config.ReadHeaderTimeout = serverReadTimeout
	ts.Config.ReadTimeout = serverReadTimeout
	ts.Config.WriteTimeout = 3 * time.Second
	ts.Start()
	defer ts.Close()

	// dribble posts `payload` in even chunks spread over `over`, which is what a
	// farm's uplink does to eleven megabytes and what no in-process test can
	// imitate.
	dribble := func(path string, payload []byte, over time.Duration) (*http.Response, []byte, error) {
		const chunks = 24
		pr, pw := io.Pipe()
		go func() {
			size := (len(payload) + chunks - 1) / chunks
			for off := 0; off < len(payload); off += size {
				end := off + size
				if end > len(payload) {
					end = len(payload)
				}
				if _, err := pw.Write(payload[off:end]); err != nil {
					_ = pw.CloseWithError(err)
					return
				}
				time.Sleep(over / chunks)
			}
			_ = pw.Close()
		}()

		req, err := http.NewRequest(http.MethodPost, ts.URL+path, pr)
		if err != nil {
			return nil, nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+f.OwnerToken)
		req.ContentLength = int64(len(payload))
		res, err := (&http.Client{Timeout: 3 * time.Minute}).Do(req)
		if err != nil {
			return nil, nil, err
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		return res, raw, err
	}

	t.Run("the negative control: an ordinary route is cut off, as it should be", func(t *testing.T) {
		// A SMALL body, dribbled over the same six seconds, to a route that
		// buys no exemption. Small on purpose: a twelve-megabyte body would be
		// refused by the ordinary 1 MB cap in the first chunk and would prove
		// nothing about the clock. This one is refused by the clock, which is
		// the fact the assertion below depends on — if the deadline were not
		// armed at all, that assertion would pass for the wrong reason.
		small, err := json.Marshal(map[string]any{
			"activityId": uuid.NewString(), "workerId": uuid.NewString(),
			"quantity": 1, "dateFrom": "2026-08-20",
		})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		started := time.Now()
		res, raw, err := dribble("/v1/work-records", small, uploadTakes)
		took := time.Since(started)
		if err == nil && res.StatusCode < 400 {
			t.Fatalf("a body slower than the server's %s ReadTimeout succeeded on "+
				"an ordinary route: %d %s", serverReadTimeout, res.StatusCode, raw)
		}
		// Cut off, and cut off BY THE CLOCK: it ended long before the upload
		// would have. Without this the assertion below could pass because no
		// deadline was ever armed.
		if took >= uploadTakes {
			t.Fatalf("the ordinary route read the whole %s upload before "+
				"answering (%s). The deadline is not armed, so the import "+
				"assertion below proves nothing.", uploadTakes, took.Round(time.Millisecond))
		}
		t.Logf("cut off after %s, as the %s ReadTimeout requires",
			took.Round(time.Millisecond), serverReadTimeout)
	})

	t.Run("the import gets its own deadline and the season arrives entire", func(t *testing.T) {
		started := time.Now()
		res, raw, err := dribble("/v1/import/season", body, uploadTakes)
		if err != nil {
			t.Fatalf("the upload was cut off after %s: %v\n"+
				"That is the whole finding: ReadTimeout is armed on the "+
				"connection before the handler runs, so the phone's 25 minutes "+
				"never get used.", time.Since(started).Round(time.Millisecond), err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("POST /v1/import/season: %d %s", res.StatusCode, raw)
		}
		if took := time.Since(started); took < serverReadTimeout {
			t.Fatalf("the upload finished in %s, which is inside the server's own "+
				"%s: this test did not exercise the deadline at all",
				took.Round(time.Millisecond), serverReadTimeout)
		}

		var report struct {
			Workers         struct{ Written, Skipped int } `json:"workers"`
			WorkRecords     struct{ Written, Skipped int } `json:"workRecords"`
			BalancesChecked int                            `json:"balancesChecked"`
		}
		if err := json.Unmarshal(raw, &report); err != nil {
			t.Fatalf("decode report: %v: %s", err, raw)
		}
		// Every row of a 12 MB body, counted by the server. A body cut short
		// would have failed to decode long before this.
		if report.Workers.Written != workers {
			t.Errorf("workers written = %d, want %d", report.Workers.Written, workers)
		}
		if report.WorkRecords.Written != records {
			t.Errorf("work records written = %d, want %d: the body did not arrive whole",
				report.WorkRecords.Written, records)
		}
		if report.BalancesChecked != workers {
			t.Errorf("balancesChecked = %d, want %d", report.BalancesChecked, workers)
		}
	})
}

// seasonImportBody builds a season of at least `min` bytes and returns it with
// the number of workers and weighings in it.
//
// The shape is the real one — the handset's own uuids, an instant per weighing,
// a declared balance per worker — because the import validates all three and a
// body that only looked the right size would be refused before a byte of it
// mattered. The balances are zero because this file carries no ledger: the
// reconciliation is still run, against every worker the file names, and it
// still has to come out to the cent.
func seasonImportBody(t *testing.T, min int) (body []byte, workers, records int) {
	t.Helper()

	const workerCount = 120
	ids := make([]string, workerCount)
	var b strings.Builder
	b.Grow(min + (min / 8))

	b.WriteString(`{"deviceId":"`)
	b.WriteString(uuid.NewString())
	b.WriteString(`","workers":[`)
	for i := range ids {
		ids[i] = uuid.NewString()
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"id":%q,"name":"Recolector %d","lastName":"Apellido %d","documentType":"CC","docId":"%010d"}`,
			ids[i], i, i, 9000000000+i)
	}
	b.WriteString(`],"workRecords":[`)

	// Weighings until the body is big enough. The dates walk backwards through
	// a season, which is what makes them a season and not one Tuesday.
	day := time.Date(2026, 8, 1, 13, 0, 0, 0, time.UTC)
	for b.Len() < min {
		if records > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"id":%q,"workerId":%q,"quantity":"%d.%03d","occurredAt":%q,"deviceId":%q}`,
			uuid.NewString(), ids[records%workerCount],
			20+records%80, records%1000,
			day.Add(-time.Duration(records%180)*24*time.Hour).Format(time.RFC3339),
			uuid.NewString())
		records++
	}

	b.WriteString(`],"balances":[`)
	for i, id := range ids {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"workerId":%q,"balanceCents":0}`, id)
	}
	b.WriteString(`]}`)

	return []byte(b.String()), workerCount, records
}

// ---------------------------------------------------------------------------
// 2. Taking somebody off a farm has to bite on the next request.
// ---------------------------------------------------------------------------

// TestRemovingSomebodyFromAFarmStopsTheirLiveToken.
//
// DELETE /v1/users/{id} deleted the membership and revoked the refresh tokens,
// so the person could not open a NEW session — and the access token already in
// their pocket went on working for the rest of its fifteen minutes, reading the
// payroll of a farm that had just removed them. Removal is what a farm does
// when it stops trusting somebody, and fifteen minutes is longer than it takes
// to walk out of the office.
//
// It is the same family as the suspension, and it is now the same fix, in the
// same round trip: the tenant middleware asks whether the caller is still a
// member while it is already asking whether the farm is suspended.
func TestRemovingSomebodyFromAFarmStopsTheirLiveToken(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca que retira el acceso", 100000)
	adminID, adminToken := h.addUserWithID(t, f.FarmID, domain.RoleAdmin)

	// The token works. This is not decoration: without it, a test where the
	// token never worked would pass for the wrong reason.
	h.mustDo(t, http.MethodGet, "/v1/workers", adminToken, nil, http.StatusOK)
	h.mustDo(t, http.MethodGet, "/v1/balances", adminToken, nil, http.StatusOK)

	h.mustDo(t, http.MethodDelete, "/v1/users/"+adminID, f.OwnerToken, nil, http.StatusNoContent)

	// The very next request, on the very same token.
	for _, path := range []string{"/v1/workers", "/v1/balances", "/v1/me", "/v1/sync/pull?cursor=0"} {
		res := h.do(t, http.MethodGet, path, adminToken, nil)
		if res.code() != string(domain.CodeMembershipRevoked) {
			t.Errorf("GET %s after removal: got %d %s, want 403 MEMBERSHIP_REVOKED.\n"+
				"An access token is a photograph of a moment that has passed; "+
				"whether the caller is still in the room is not a question it "+
				"can answer.", path, res.Status, res.Raw)
		}
		if res.Status != http.StatusForbidden {
			t.Errorf("GET %s after removal: status %d, want 403", path, res.Status)
		}
	}

	// A write, because a read that is refused and a write that is not is the
	// worst of both.
	res := h.do(t, http.MethodPost, "/v1/workers", adminToken, map[string]any{
		"name": "Nadie", "documentType": "CC", "docId": "7099099099",
	})
	if res.code() != string(domain.CodeMembershipRevoked) {
		t.Errorf("POST /v1/workers after removal: got %d %s, want MEMBERSHIP_REVOKED",
			res.Status, res.Raw)
	}

	// And the owner, who removed nobody's access but their own colleague's, is
	// untouched. A check that refused everybody would also pass the assertions
	// above.
	h.mustDo(t, http.MethodGet, "/v1/workers", f.OwnerToken, nil, http.StatusOK)
}

// TestRemovalDoesNotBreakCreatingAFarm guards the exemption the fix needs.
//
// Signup pins the transaction to a farm whose membership row that same
// transaction is about to write. A membership check with no exemption there
// would make it impossible to create a farm at all — the failure would be
// total, and it would be found by a customer rather than here.
func TestRemovalDoesNotBreakCreatingAFarm(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca recien creada", 90000)
	h.mustDo(t, http.MethodGet, "/v1/farm", f.OwnerToken, nil, http.StatusOK)

	// The second farm of an account that already exists goes through the same
	// SetForSignup, behind a session.
	res := h.mustDo(t, http.MethodPost, "/v1/farms", f.OwnerToken, map[string]any{
		"name": "Segunda finca", "timezone": "America/Bogota",
		"currency": "COP", "priceCents": 90000,
	}, http.StatusCreated)
	if id, _ := res.Body["farmId"].(string); id == "" {
		if id, _ = res.Body["id"].(string); id == "" {
			t.Fatalf("no farm id in %s", res.Raw)
		}
	}
}

// ---------------------------------------------------------------------------
// 3. The crop report header covered the whole history whatever `weeks` said.
// ---------------------------------------------------------------------------

// TestACropReportHeaderCoversTheWeeksItShows.
//
// Every figure outside `byWeek` was a sum with no window at all, sitting on top
// of a `byWeek` that honoured `weeks`. So `?weeks=1` answered with a header
// worth a whole season and one row underneath it, and nothing on the wire could
// tell the two apart — audit finding A4 in another building.
func TestACropReportHeaderCoversTheWeeksItShows(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de un solo lote", 100000)
	worker := h.createWorker(t, f, "Aurelio", "7020020020")
	plotID := h.createPlot(t, f, "El Alto")
	activity := h.harvestActivityID(t, f)

	res := h.mustDo(t, http.MethodGet, "/v1/plots/"+plotID, f.OwnerToken, nil, http.StatusOK)
	crops, _ := res.Body["crops"].([]any)
	if len(crops) == 0 {
		t.Fatalf("the plot has no crop: %s", res.Raw)
	}
	cropID := crops[0].(map[string]any)["id"].(string)

	// Three consecutive weeks, 10 kg, 20 kg, 40 kg, oldest first.
	weeks := []string{"2026-08-04", "2026-08-11", "2026-08-18"}
	for i, date := range weeks {
		h.mustDo(t, http.MethodPost, "/v1/work-records", f.OwnerToken, map[string]any{
			"activityId": activity, "workerId": worker,
			"quantity": 10 * (1 << i), "dateFrom": date,
			"plotIds": []string{plotID}, "plotCropIds": []string{cropID},
		}, http.StatusCreated)
	}

	read := func(weeks int) map[string]any {
		res := h.mustDo(t, http.MethodGet,
			"/v1/reports/crops/"+cropID+"?weeks="+strconv.Itoa(weeks),
			f.OwnerToken, nil, http.StatusOK)
		return res.Body
	}

	t.Run("the whole crop, asked for whole", func(t *testing.T) {
		got := read(12)
		if kg, _ := got["kg"].(float64); kg != 70 {
			t.Errorf("kg = %v, want 70 (10+20+40): %v", got["kg"], got)
		}
		if partial, _ := got["partialWindow"].(bool); partial {
			t.Errorf("partialWindow is true for a window that cut nothing off: %v", got)
		}
		if got["coveredFrom"] != "2026-08-03" {
			t.Errorf("coveredFrom = %v, want the Monday of the first week", got["coveredFrom"])
		}
	})

	t.Run("one week, and the header is that week", func(t *testing.T) {
		got := read(1)
		byWeek, _ := got["byWeek"].([]any)
		if len(byWeek) != 1 {
			t.Fatalf("byWeek has %d rows for weeks=1: %v", len(byWeek), got)
		}
		if kg, _ := got["kg"].(float64); kg != 40 {
			t.Errorf("kg = %v, want 40 — the header must cover the same week the "+
				"rows do, not the crop's whole history: %v", got["kg"], got)
		}
		if records, _ := got["records"].(float64); records != 1 {
			t.Errorf("records = %v, want 1: %v", got["records"], got)
		}
		if partial, _ := got["partialWindow"].(bool); !partial {
			t.Errorf("partialWindow is false while two older weeks are being "+
				"withheld: a total that cannot say it is partial gets read as "+
				"the whole crop: %v", got)
		}
		if got["coveredFrom"] != "2026-08-17" || got["coveredTo"] != "2026-08-23" {
			t.Errorf("covered %v..%v, want 2026-08-17..2026-08-23",
				got["coveredFrom"], got["coveredTo"])
		}
		if w, _ := got["weeks"].(float64); w != 1 {
			t.Errorf("weeks = %v, want the cap echoed back", got["weeks"])
		}
	})

	t.Run("two weeks", func(t *testing.T) {
		got := read(2)
		if kg, _ := got["kg"].(float64); kg != 60 {
			t.Errorf("kg = %v, want 60 (20+40): %v", got["kg"], got)
		}
		if partial, _ := got["partialWindow"].(bool); !partial {
			t.Errorf("partialWindow is false while one older week is withheld: %v", got)
		}
	})
}

// ---------------------------------------------------------------------------
// 4. A labour of several days falls entirely in its first week.
// ---------------------------------------------------------------------------

// TestALabourThatCrossesAWeekSaysSo.
//
// A work record has a start day and an end day, and a range is legal with a
// frozen price. `week_start` is generated from the START day, so the whole of a
// Saturday-to-Wednesday labour is credited to the week that Saturday falls in
// and none of it to the week that got three of its five days.
//
// There is no per-day split anywhere, because nobody recorded one, and dividing
// the quantity evenly would be the report inventing the thing this whole file
// refuses to invent. So the attribution stays where the evidence puts it and
// the count travels beside the figure — the same shape as recordsNotInKg.
func TestALabourThatCrossesAWeekSaysSo(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del contrato largo", 100000)
	worker := h.createWorker(t, f, "Bernarda", "7030030030")
	activity := h.harvestActivityID(t, f)

	// Saturday 15 August to Wednesday 19 August: two weeks, one record.
	h.mustDo(t, http.MethodPost, "/v1/work-records", f.OwnerToken, map[string]any{
		"activityId": activity, "workerId": worker, "quantity": 500,
		"dateFrom": "2026-08-15", "dateTo": "2026-08-19", "rateCents": 100,
	}, http.StatusCreated)
	// And one ordinary single-day weighing in the SAME week, so the count is
	// tested against a row that has both kinds in it.
	h.createWorkRecord(t, f, f.OwnerToken, worker, activity, "2026-08-14", 30)

	res := h.mustDo(t, http.MethodGet,
		"/v1/reports/weeks?from=2026-08-01&to=2026-08-31", f.OwnerToken, nil, http.StatusOK)
	items, _ := res.Body["items"].([]any)

	byWeek := map[string]map[string]any{}
	for _, raw := range items {
		row := raw.(map[string]any)
		byWeek[row["weekStart"].(string)] = row
	}

	first, ok := byWeek["2026-08-10"]
	if !ok {
		t.Fatalf("the week of the 10th is missing: %s", res.Raw)
	}
	if n, _ := first["recordsSpanningWeeks"].(float64); n != 1 {
		t.Errorf("recordsSpanningWeeks = %v in the week that holds the labour, want 1.\n"+
			"All five days of it are credited here; the week that got three of "+
			"them has none of the kilos, and a reader comparing the two has to "+
			"be told which one borrowed from the other.", first["recordsSpanningWeeks"])
	}
	if n, _ := first["records"].(float64); n != 2 {
		t.Errorf("records = %v, want 2: %v", first["records"], first)
	}

	// And the week the labour actually ran into shows no trace of it at all —
	// it is not even a row, because the calendar is drawn between the first
	// week with work and the last, and by that measure Monday the 17th had
	// none. Three of the five days were worked in it. That is the fact being
	// ADMITTED rather than a bug being introduced: nothing in the schema says
	// how much of the 500 fell on which day, so the count above is the only
	// honest thing the report can say about it.
	if second, ok := byWeek["2026-08-17"]; ok {
		if n, _ := second["records"].(float64); n != 0 {
			t.Errorf("records = %v in the following week: the labour is filed "+
				"whole in the week it started, so this must be empty: %v",
				second["records"], second)
		}
	}
	if len(byWeek) != 1 {
		t.Errorf("the month came back as %d weeks, want 1: %s", len(byWeek), res.Raw)
	}
}

// ---------------------------------------------------------------------------
// 5. A rejected sync op was cemented for ever.
// ---------------------------------------------------------------------------

// TestARejectedSyncOpCanBeRetriedOnceItsCauseIsFixed.
//
// sync_ops is the idempotency registry: a seen opId returns its stored answer
// literally and executes nothing. That is right for an envelope that CHANGED
// something — a resent void must not hand the money back twice — and it was
// being applied to envelopes that changed nothing at all.
//
// The canonical case is the one §5.6 describes as ordinary: a weighing arrives
// before the worker it names, is refused with "pull the references first", and
// is meant to be retried once the references have come down. It could not be.
// Resend the same bytes and the stored refusal came back for ever; correct the
// bytes and the fingerprint no longer matched, so the answer was
// IDEMPOTENCY_KEY_REUSED — which §4.3 files under "never retry". Both doors
// shut on an act that was never performed.
func TestARejectedSyncOpCanBeRetriedOnceItsCauseIsFixed(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca que reintenta", 100000)
	device := uuid.NewString()

	workerID := uuid.NewString()
	recordID := uuid.NewString()
	opID := uuid.NewString()

	envelope := func(payload map[string]any) map[string]any {
		return map[string]any{
			"deviceId": device,
			"ops": []map[string]any{{
				"opId": opID, "entity": "workRecord", "op": "upsert", "payload": payload,
			}},
		}
	}
	weighing := map[string]any{
		"id": recordID, "workerId": workerID, "quantity": "42.500",
		"occurredAt": "2026-08-20T13:00:00Z", "deviceId": device,
	}
	push := func(body map[string]any) map[string]any {
		res := h.mustDo(t, http.MethodPost, "/v1/sync/push", f.WeigherToken, body, http.StatusOK)
		results, _ := res.Body["results"].([]any)
		if len(results) != 1 {
			t.Fatalf("push returned %d results: %s", len(results), res.Raw)
		}
		return results[0].(map[string]any)
	}

	// The weighing arrives before the worker does.
	first := push(envelope(weighing))
	if first["status"] != "rejected" {
		t.Fatalf("a weighing naming a worker this farm has not got was not "+
			"refused: %v", first)
	}

	// The handset resends the SAME bytes while the cause is still there. It
	// must get the same refusal — derived again, not remembered — and above
	// all not IDEMPOTENCY_KEY_REUSED.
	second := push(envelope(weighing))
	if second["status"] != "rejected" {
		t.Fatalf("the resend was not refused: %v", second)
	}
	if code := opErrorCode(second); code == string(domain.CodeIdempotencyKeyReused) {
		t.Fatalf("the resend of an identical refused envelope came back as a "+
			"reused key: %v", second)
	}

	// The references come down: the worker is created on the web.
	h.createWorker(t, f, "Celestino", "7040040040")
	if _, err := h.admin.Exec(context.Background(), `
		INSERT INTO employees (id, farm_id, name, document_type, doc_id)
		VALUES ($1, $2, 'Celestino del telefono', 'CC', '7040040041')`,
		workerID, f.FarmID); err != nil {
		t.Fatalf("seed the worker the handset already had: %v", err)
	}

	// And the outbox row goes out at last, under the opId it has carried since
	// the button was pressed. The phone has no reason to mint a new one for an
	// act it never completed, so this is the only way the weighing ever leaves.
	third := push(envelope(weighing))
	if third["status"] != "applied" {
		t.Fatalf("the retry after the cause was fixed did not go through: %v\n"+
			"A refusal wrote nothing, so there is nothing for a replay to "+
			"duplicate and nothing worth remembering.", third)
	}

	// It really is on the server, once.
	res := h.mustDo(t, http.MethodGet, "/v1/work-records/"+recordID,
		f.OwnerToken, nil, http.StatusOK)
	if res.Body["id"] != recordID {
		t.Fatalf("the weighing is not on the server: %s", res.Raw)
	}

	// And NOW the registry does its job. §4.2: a seen opId returns its stored
	// answer LITERALLY and executes nothing — so a fourth send comes back as
	// the same `applied` with the same row id, and no second weighing is
	// written. Forgetting refusals must not have cost the registry the job it
	// exists to do.
	fourth := push(envelope(weighing))
	if fourth["status"] != third["status"] || fourth["id"] != third["id"] {
		t.Errorf("the resend of an APPLIED envelope did not return the stored "+
			"answer literally: %v, want %v", fourth, third)
	}

	// The applied op IS remembered; the refusals were not. That asymmetry is
	// the whole change, so it is asserted rather than assumed.
	var status string
	if err := h.admin.QueryRow(context.Background(),
		`SELECT status FROM sync_ops WHERE op_id = $1`, opID).Scan(&status); err != nil {
		t.Fatalf("the applied op was not recorded: %v", err)
	}
	if status != "applied" {
		t.Errorf("sync_ops holds %q for that opId, want applied", status)
	}
	var rows int
	if err := h.admin.QueryRow(context.Background(),
		`SELECT count(*)::int FROM sync_ops WHERE status = 'rejected'`).Scan(&rows); err != nil {
		t.Fatalf("count rejected ops: %v", err)
	}
	if rows != 0 {
		t.Errorf("%d rejected ops are stored; a refusal is not an outcome worth "+
			"remembering", rows)
	}
}

// TestACorrectedSyncOpIsNotAReusedKey is the other door that was shut: the
// handset fixes the body rather than the world, and resends under the same
// opId.
func TestACorrectedSyncOpIsNotAReusedKey(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca que corrige", 100000)
	device := uuid.NewString()
	worker := h.createWorker(t, f, "Domitila", "7050050050")
	opID := uuid.NewString()
	recordID := uuid.NewString()

	push := func(payload map[string]any) map[string]any {
		res := h.mustDo(t, http.MethodPost, "/v1/sync/push", f.WeigherToken, map[string]any{
			"deviceId": device,
			"ops": []map[string]any{{
				"opId": opID, "entity": "workRecord", "op": "upsert", "payload": payload,
			}},
		}, http.StatusOK)
		results, _ := res.Body["results"].([]any)
		return results[0].(map[string]any)
	}

	// A bare day where the protocol requires an instant with its offset.
	bad := push(map[string]any{
		"id": recordID, "workerId": worker, "quantity": "10.000",
		"occurredAt": "2026-08-20",
	})
	if bad["status"] != "rejected" {
		t.Fatalf("a bare day was accepted as an instant: %v", bad)
	}

	good := push(map[string]any{
		"id": recordID, "workerId": worker, "quantity": "10.000",
		"occurredAt": "2026-08-20T13:00:00Z",
	})
	if good["status"] != "applied" {
		t.Fatalf("the corrected envelope was refused: %v\n"+
			"Before this fix the fingerprint of the corrected body did not "+
			"match the stored one and the answer was IDEMPOTENCY_KEY_REUSED, "+
			"which the protocol files under \"never retry\".", good)
	}
}

// opErrorCode digs the contract code out of one push result.
func opErrorCode(result map[string]any) string {
	errObj, ok := result["error"].(map[string]any)
	if !ok {
		return ""
	}
	code, _ := errObj["code"].(string)
	return code
}
