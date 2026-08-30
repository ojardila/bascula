package apitest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// Sprint 11: the last three findings of the two adversarial audits, and the
// debt the team opened itself.
//
// Same rule as sprint 8: every test here is written against the script that
// found the fault, and its job is to make that script stop working.

// ---------------------------------------------------------------------------
// Finding 14, third case: the role drifted and the token did not
// ---------------------------------------------------------------------------

// TestADemotedAdministratorLosesTheMoneyOnTheNextRequest.
//
// The family is FARM_SUSPENDED (the platform stops trusting the farm),
// MEMBERSHIP_REVOKED (the farm stops trusting the person) and this one, which
// is the case in between and the only one that costs money: the person stays
// and their ROLE changes.
//
// An administrator demoted to weigher kept a token saying `role: admin` for the
// rest of its fifteen minutes. That claim is what auth.Matrix reads, and it is
// also what `app.role` puts in front of row level security, so both layers that
// could have caught it were being told the same stale thing. Fifteen minutes of
// settlements, ledger and balances after the owner decided otherwise — longer
// than a payroll run, which is the same sentence the other two cases got.
func TestADemotedAdministratorLosesTheMoneyOnTheNextRequest(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del descenso", 100000)

	// A real session, not a forged token: the demoted person must be able to
	// refresh out of the hole, and that needs the refresh half of a login.
	email := fmt.Sprintf("degradado-%s@example.com", uuid.NewString()[:8])
	const password = "una-clave-larga-1"
	created := h.mustDo(t, http.MethodPost, "/v1/users", f.OwnerToken, map[string]any{
		"email": email, "name": "Ascendido", "role": "admin",
	}, http.StatusCreated)
	userID := mustString(t, created.Body, "id")
	setPassword(t, h, userID, password)

	login := h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": email, "password": password,
	}, http.StatusOK)
	access := mustString(t, login.Body, "accessToken")
	refresh := mustString(t, login.Body, "refreshToken")

	// The money is his while he is an administrator.
	h.mustDo(t, http.MethodGet, "/v1/balances", access, nil, http.StatusOK)

	h.mustDo(t, http.MethodPatch, "/v1/users/"+userID, f.OwnerToken,
		map[string]any{"role": "weigher"}, http.StatusOK)

	t.Run("the token in his pocket stops at the door", func(t *testing.T) {
		// Every route, not only the money ones: the token no longer describes
		// this account, and what it may do is not a question worth asking of a
		// stale answer.
		for _, path := range []string{
			"/v1/balances", "/v1/settlements", "/v1/me", "/v1/workers",
			"/v1/sync/pull?cursor=0",
		} {
			res := h.do(t, http.MethodGet, path, access, nil)
			if res.Status != http.StatusUnauthorized ||
				res.code() != string(domain.CodeRoleChanged) {
				t.Errorf("GET %s with a demoted administrator's live token: "+
					"got %d %s, want 401 ROLE_CHANGED", path, res.Status, res.Raw)
			}
		}
		// And the writing half, which is the one that moves money.
		pay := h.do(t, http.MethodPost, "/v1/payments", access, map[string]any{
			"id": uuid.NewString(), "workerId": uuid.NewString(), "amountCents": 1000,
		})
		if pay.code() != string(domain.CodeRoleChanged) {
			t.Fatalf("a demoted administrator could still reach a payment: %d %s",
				pay.Status, pay.Raw)
		}
	})

	t.Run("refreshing hands back the role he actually has", func(t *testing.T) {
		// A 401 is what both clients retry once, after refreshing. This is that
		// retry, and it is why the check is a 401 and not a 403: the account is
		// welcome, the token was out of date, and the person sees nothing.
		res := h.mustDo(t, http.MethodPost, "/v1/auth/refresh", "",
			map[string]any{"refreshToken": refresh}, http.StatusOK)
		if res.Body["role"] != string(domain.RoleWeigher) {
			t.Fatalf("the refresh minted the old role again: %s", res.Raw)
		}
		fresh := mustString(t, res.Body, "accessToken")

		// The weighing goes on. The money does not, and the refusal now comes
		// from the permission table in the role he holds — an ordinary 403.
		h.mustDo(t, http.MethodGet, "/v1/workers", fresh, nil, http.StatusOK)
		money := h.do(t, http.MethodGet, "/v1/balances", fresh, nil)
		if money.Status != http.StatusForbidden {
			t.Fatalf("a weigher reached the balances: %d %s", money.Status, money.Raw)
		}
	})

	t.Run("a promotion is not a lockout either", func(t *testing.T) {
		h.mustDo(t, http.MethodPatch, "/v1/users/"+userID, f.OwnerToken,
			map[string]any{"role": "admin"}, http.StatusOK)

		// The weigher token minted a moment ago is stale in the other
		// direction. Same answer, same remedy, and nothing is lost: the check
		// refuses a token that disagrees with the row, whichever way it
		// disagrees. A 403 here would have signed somebody out for being
		// promoted.
		res := h.mustDo(t, http.MethodPost, "/v1/auth/refresh", "",
			map[string]any{"refreshToken": mustString(t,
				h.mustDo(t, http.MethodPost, "/v1/auth/login", "", map[string]any{
					"email": email, "password": password,
				}, http.StatusOK).Body, "refreshToken")}, http.StatusOK)
		if res.Body["role"] != string(domain.RoleAdmin) {
			t.Fatalf("the promotion did not reach the new session: %s", res.Raw)
		}
		h.mustDo(t, http.MethodGet, "/v1/balances",
			mustString(t, res.Body, "accessToken"), nil, http.StatusOK)
	})

	t.Run("the neighbouring farm is untouched", func(t *testing.T) {
		other := h.signupFarm(t, "Finca de al lado", 100000)
		h.mustDo(t, http.MethodGet, "/v1/balances", other.OwnerToken, nil, http.StatusOK)
	})
}

// TestARoleForgedIntoATokenIsRefusedByTheRow.
//
// The other half of the same check, and the reason it had to live where the row
// is: a token is a signed claim, and a signing key that ever leaked would let
// somebody mint `role: owner` for an account that holds none. The permission
// table cannot tell — it is handed the claim. The membership row can.
func TestARoleForgedIntoATokenIsRefusedByTheRow(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del rol falsificado", 100000)

	signer := auth.NewSigner([]byte("test-signing-key"), "bascula")
	forged, err := signer.Issue(f.WeigherID, f.FarmID, domain.RoleOwner, "", false)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	res := h.do(t, http.MethodGet, "/v1/balances", forged, nil)
	if res.Status != http.StatusUnauthorized || res.code() != string(domain.CodeRoleChanged) {
		t.Fatalf("a weigher wearing an owner's claim reached the balances: %d %s",
			res.Status, res.Raw)
	}
}

// setPassword gives an invited account a password it can log in with. The
// invitation flow mints one and mails it, and there is no mail sender.
func setPassword(t *testing.T, h *harness, userID, password string) {
	t.Helper()
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if _, err := h.admin.Exec(context.Background(),
		`UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now())
		  WHERE id = $1`, userID, hash); err != nil {
		t.Fatalf("set password: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Finding 11, second half: the window every week total is read through
// ---------------------------------------------------------------------------

// TestEveryWeeklyRouteSaysWhichWindowItCovers.
//
// A week with no harvest stopped disappearing, and a truncated ROW learned to
// say which days it summed. What was still missing is everything else that
// truncates: the list cut by `limit`, the curve cut by `weeks`, and the one
// route whose window is always whole and said nothing at all, so a client could
// not read the window the same way twice.
func TestEveryWeeklyRouteSaysWhichWindowItCovers(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca de la ventana", 100000)
	worker := h.createWorker(t, f, "Ventana", "7015015015")
	activity := h.harvestActivityID(t, f)

	// Five consecutive weeks of picking, oldest first.
	weeks := []string{"2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"}
	for i, monday := range weeks {
		h.createWorkRecord(t, f, f.OwnerToken, worker, activity, monday, float64(10*(i+1)))
	}

	t.Run("the week detail carries the window it always had", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet, "/v1/reports/weeks/2026-08-03",
			f.OwnerToken, nil, http.StatusOK)
		if res.Body["coveredFrom"] != "2026-08-03" || res.Body["coveredTo"] != "2026-08-09" {
			t.Errorf("the week detail does not say which days it covers: %s", res.Raw)
		}
		if res.Body["partialWindow"] != false {
			t.Errorf("a whole week reported as partial: %s", res.Raw)
		}
	})

	t.Run("the list says when limit stopped it short", func(t *testing.T) {
		all := h.mustDo(t, http.MethodGet,
			"/v1/reports/weeks?from=2026-07-27&to=2026-08-30", f.OwnerToken, nil, http.StatusOK)
		if all.Body["partialWindow"] != false {
			t.Errorf("a complete answer flagged as partial: %s", all.Raw)
		}
		if all.Body["coveredFrom"] != "2026-07-27" || all.Body["coveredTo"] != "2026-08-30" {
			t.Errorf("the list's window is wrong: %s", all.Raw)
		}

		cut := h.mustDo(t, http.MethodGet,
			"/v1/reports/weeks?from=2026-07-27&to=2026-08-30&limit=2",
			f.OwnerToken, nil, http.StatusOK)
		items, _ := cut.Body["items"].([]any)
		if len(items) != 2 {
			t.Fatalf("limit=2 returned %d rows: %s", len(items), cut.Raw)
		}
		if cut.Body["partialWindow"] != true {
			t.Fatalf("three weeks were cut off the oldest end and the answer "+
				"looked like a two-week season: %s", cut.Raw)
		}
		// The oldest weeks are the ones that went, so the covered window starts
		// later than the question did — which is exactly the thing to say.
		if cut.Body["coveredFrom"] == "2026-07-27" {
			t.Errorf("the cut list still claims to start where the question did: %s", cut.Raw)
		}
	})

	t.Run("a truncated row still says which days it summed", func(t *testing.T) {
		res := h.mustDo(t, http.MethodGet,
			"/v1/reports/weeks?from=2026-08-03&to=2026-08-05", f.OwnerToken, nil, http.StatusOK)
		items, _ := res.Body["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("want one row: %s", res.Raw)
		}
		row, _ := items[0].(map[string]any)
		if row["partialWindow"] != true || row["coveredTo"] != "2026-08-05" {
			t.Errorf("the row lost its window: %s", res.Raw)
		}
		// And the envelope agrees with the row it is made of.
		if res.Body["partialWindow"] != true || res.Body["coveredTo"] != "2026-08-05" {
			t.Errorf("the envelope and its one row disagree: %s", res.Raw)
		}
	})

	t.Run("the curve says when its own window cut the season", func(t *testing.T) {
		var whole struct {
			PartialWindow bool    `json:"partialWindow"`
			CoveredFrom   *string `json:"coveredFrom"`
			CoveredTo     *string `json:"coveredTo"`
			Weeks         []struct {
				WeekStart string `json:"weekStart"`
			} `json:"weeks"`
			Shape struct {
				ContiguousWeeks int `json:"contiguousWeeks"`
				Peak            *struct {
					Kg float64 `json:"kg"`
				} `json:"peak"`
			} `json:"shape"`
		}
		res := h.mustDo(t, http.MethodGet, "/v1/reports/harvest-curve?weeks=26",
			f.OwnerToken, nil, http.StatusOK)
		if err := json.Unmarshal([]byte(res.Raw), &whole); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if whole.PartialWindow {
			t.Errorf("the whole season reported as a cut one: %s", res.Raw)
		}
		if whole.CoveredFrom == nil || *whole.CoveredFrom != "2026-07-27" {
			t.Errorf("coveredFrom = %v, want the first week worked: %s",
				whole.CoveredFrom, res.Raw)
		}
		if whole.CoveredTo == nil || *whole.CoveredTo != "2026-08-30" {
			t.Errorf("coveredTo = %v, want the Sunday of the last week: %s",
				whole.CoveredTo, res.Raw)
		}

		var cut = whole
		res = h.mustDo(t, http.MethodGet, "/v1/reports/harvest-curve?weeks=2",
			f.OwnerToken, nil, http.StatusOK)
		if err := json.Unmarshal([]byte(res.Raw), &cut); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(cut.Weeks) != 2 {
			t.Fatalf("weeks=2 returned %d weeks: %s", len(cut.Weeks), res.Raw)
		}
		if !cut.PartialWindow {
			t.Fatalf("the season was cut at the oldest end and the reading "+
				"could not see past the cut, and nothing said so: %s", res.Raw)
		}
		if cut.CoveredFrom == nil || *cut.CoveredFrom != "2026-08-17" {
			t.Errorf("coveredFrom = %v, want the oldest week SHOWN: %s",
				cut.CoveredFrom, res.Raw)
		}
		// And the reading is honest about how much it read: the peak of a
		// two-week window is the peak of two weeks.
		if cut.Shape.ContiguousWeeks > 2 {
			t.Errorf("the reading claims more weeks than it was given: %s", res.Raw)
		}
	})
}

// ---------------------------------------------------------------------------
// The debt the team opened itself: the import holds a connection all the way up
// ---------------------------------------------------------------------------

// TestTheSeasonImportCannotDrinkThePool.
//
// The import's transaction is opened by the tenant middleware before the
// handler has a byte of the body, and the body may take 25 minutes to arrive.
// One connection, `idle in transaction`, for the whole upload. That was written
// down as acceptable for a once-in-a-farm's-life act by an owner, and it is —
// right up to the point where several owners move house in the same week.
//
// Measured before this gate existed (see store.MaxImportsAtOnce): eleven at
// once held all ten connections, and ordinary requests did not fail, they
// waited — 17.8 s with the upload compressed into 25, which at the real
// deadline is the whole platform stopped while /health answers ok.
func TestTheSeasonImportCannotDrinkThePool(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca que se muda", 100000)
	worker := h.createWorker(t, f, "Mudanza", "7016016016")

	payload, err := json.Marshal(map[string]any{
		"deviceId": uuid.NewString(),
		"balances": []map[string]any{{"workerId": worker, "balanceCents": 0}},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	started := make(chan struct{}, store.MaxImportsAtOnce)
	release := make(chan struct{})
	done := make(chan int, store.MaxImportsAtOnce)

	// Fill every slot with an upload that has begun and not finished — the
	// shape of a phone on a rural connection, without the twenty-five minutes.
	for i := 0; i < store.MaxImportsAtOnce; i++ {
		go func() {
			req := httptest.NewRequest(http.MethodPost, "/v1/import/season",
				&gatedBody{started: started, release: release, r: bytes.NewReader(payload)})
			req.RemoteAddr = "10.0.0.1:12345"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+f.OwnerToken)
			rec := httptest.NewRecorder()
			h.server.ServeHTTP(rec, req)
			done <- rec.Code
		}()
	}
	for i := 0; i < store.MaxImportsAtOnce; i++ {
		<-started // each one is now inside the handler, holding a slot
	}

	t.Run("the next one is refused at once instead of queued", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/import/season", f.OwnerToken,
			map[string]any{
				"deviceId": uuid.NewString(),
				"balances": []map[string]any{{"workerId": worker, "balanceCents": 0}},
			})
		if res.Status != http.StatusTooManyRequests ||
			res.code() != string(domain.CodeRateLimited) {
			t.Fatalf("a fourth import was let in to hold a fourth connection for "+
				"twenty-five minutes: got %d %s", res.Status, res.Raw)
		}
	})

	t.Run("and the rest of the service is not waiting on any of them", func(t *testing.T) {
		// The point of the extra connections in the pool: the ordinary ten are
		// untouched while the imports hold their own.
		for _, path := range []string{"/v1/workers", "/v1/balances", "/v1/reports/weeks"} {
			h.mustDo(t, http.MethodGet, path, f.OwnerToken, nil, http.StatusOK)
		}
	})

	close(release)
	for i := 0; i < store.MaxImportsAtOnce; i++ {
		if code := <-done; code >= 500 {
			t.Errorf("a held import ended in %d", code)
		}
	}

	t.Run("and the slots come back", func(t *testing.T) {
		res := h.do(t, http.MethodPost, "/v1/import/season", f.OwnerToken,
			map[string]any{
				"deviceId": uuid.NewString(),
				"balances": []map[string]any{{"workerId": worker, "balanceCents": 0}},
			})
		if res.Status == http.StatusTooManyRequests {
			t.Fatalf("the gate never let go: %s", res.Raw)
		}
	})
}

// gatedBody is an upload that has started and stopped: it announces its first
// read and then waits, which is how a test holds a handler inside the part of
// itself that costs a connection.
type gatedBody struct {
	started chan struct{}
	release chan struct{}
	r       io.Reader
	begun   bool
}

func (g *gatedBody) Read(p []byte) (int, error) {
	if !g.begun {
		g.begun = true
		g.started <- struct{}{}
		<-g.release
	}
	return g.r.Read(p)
}

func (g *gatedBody) Close() error { return nil }

// ---------------------------------------------------------------------------
// The final sweep: the four doors the zero trap was still open on
// ---------------------------------------------------------------------------

// TestTheLastEndpointsThatNarrowByAnIdConfirmItFirst.
//
// "A sum over an id that matches nothing comes back as a plausible 'this
// produced nothing'." Row level security narrows rather than raising, so
// another farm's id answers `{"items": []}` and 200, which is the same answer a
// worker who was off sick gives.
//
// sprint2_test.go walks this table for the money routes and sprint3_test.go for
// the inventory ones. These four were in neither table, which is exactly why
// they were the four still open: the two doors onto the work records — every
// row of which carries `amountCents` — the pay rates of an activity, and the
// product category filter.
func TestTheLastEndpointsThatNarrowByAnIdConfirmItFirst(t *testing.T) {
	h := requireDB(t)
	mine := h.signupFarm(t, "Finca que pregunta", 100000)
	theirs := h.signupFarm(t, "Finca de al lado que no responde", 100000)

	worker := h.createWorker(t, theirs, "Ajena", "7017017017")
	activity := h.harvestActivityID(t, theirs)
	plot := h.mustDo(t, http.MethodPost, "/v1/plots", theirs.OwnerToken, map[string]any{
		"id": uuid.NewString(), "name": "Lote ajeno",
	}, http.StatusCreated).Body["id"].(string)
	crop := h.mustDo(t, http.MethodPost, "/v1/plots/"+plot+"/crops", theirs.OwnerToken,
		map[string]any{"id": uuid.NewString(), "cropType": "Cafe"},
		http.StatusCreated).Body["id"].(string)

	for _, probe := range []struct{ name, path string }{
		{"work records by worker", "/v1/work-records?workerId=" + worker},
		{"work records by activity", "/v1/work-records?activityId=" + activity},
		{"work records by plot", "/v1/work-records?plotId=" + plot},
		{"work records by crop", "/v1/work-records?plotCropId=" + crop},
		{"pickups by worker", "/v1/pickups?workerId=" + worker},
		{"pickups by crop", "/v1/pickups?plotCropId=" + crop},
		{"an activity's pay rates", "/v1/activities/" + activity + "/rates"},
	} {
		res := h.do(t, http.MethodGet, probe.path, mine.OwnerToken, nil)
		if res.Status != http.StatusNotFound {
			t.Errorf("%s: got %d %s, want 404 — another farm's id must not come "+
				"back as an empty list", probe.name, res.Status, res.Raw)
		}
	}

	// And an id that exists nowhere at all answers the same, which is the other
	// half of the rule: "not yours" must not read differently from "does not
	// exist".
	ghost := uuid.NewString()
	for _, path := range []string{
		"/v1/work-records?workerId=" + ghost,
		"/v1/pickups?workerId=" + ghost,
		"/v1/activities/" + ghost + "/rates",
		"/v1/products?categoryId=" + ghost,
	} {
		if res := h.do(t, http.MethodGet, path, mine.OwnerToken, nil); res.Status != http.StatusNotFound {
			t.Errorf("GET %s: got %d %s, want 404", path, res.Status, res.Raw)
		}
	}

	// The farm's own ids still answer, which is what makes the 404 mean
	// something.
	h.mustDo(t, http.MethodGet,
		"/v1/work-records?workerId="+h.createWorker(t, mine, "Propia", "7018018018"),
		mine.OwnerToken, nil, http.StatusOK)
	h.mustDo(t, http.MethodGet, "/v1/work-records", mine.OwnerToken, nil, http.StatusOK)
	h.mustDo(t, http.MethodGet, "/v1/pickups", mine.OwnerToken, nil, http.StatusOK)
	h.mustDo(t, http.MethodGet, "/v1/products", mine.OwnerToken, nil, http.StatusOK)
	h.mustDo(t, http.MethodGet,
		"/v1/activities/"+h.harvestActivityID(t, mine)+"/rates",
		mine.OwnerToken, nil, http.StatusOK)
}
