package apitest

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// TestASeasonFromARealHandsetImports is the gate for the whole move to the
// server, and until this test it was the one thing nobody had measured.
//
// Every other import test in this package builds its payload in Go, from the
// server's own idea of what a season looks like. That proves the endpoint
// agrees with itself. It cannot prove the handset agrees with it, and the
// handset is what will actually send.
//
// The two shapes are NOT the same. `buildSeasonExport` produces
// importId/farmId/schemaVersion/timezone/generatedAt/reconciliation/totals, and
// no `balances` at all; this endpoint decodes with DisallowUnknownFields and
// refuses a file with no balances. A layer on the phone (`toImportInput`)
// reconciles the two, and nothing in either language was testing that it does.
//
// So the fixture beside this file is not hand-written. It is the exact bytes
// `toImportInput(buildSeasonExport(...))` produced from a SQLite database built
// the way the screens build one: three pickers, thirty weighings across three
// weeks, an advance so a balance is not merely the gross, and a full payroll
// through `runPayroll`. Measured on the way in the first time:
//
//	200 {"workers":{"written":3},"plots":{"written":1},"crops":{"written":1},
//	     "workRecords":{"written":30},"settlements":{"written":3},
//	     "settlementItems":{"written":30},"ledger":{"written":7},
//	     "balancesChecked":3,"liveItems":30}
//
// Three balances reconciled to the cent. What this test defends is that the
// server does not drift away from a handset that cannot be updated in the same
// release — a field of phones is not a deployment.
//
// Regenerating the fixture is deliberate work, not a chore to automate away: it
// means the wire shape changed, and the phones already in the field did not.
func TestASeasonFromARealHandsetImports(t *testing.T) {
	h := requireDB(t)
	f := h.signupFarm(t, "Finca del handset", 80000)

	blob, err := os.ReadFile(filepath.Join("testdata", "season_from_handset.json"))
	if err != nil {
		t.Fatalf("the handset fixture is missing: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(blob, &payload); err != nil {
		t.Fatalf("the handset fixture is not valid JSON: %v", err)
	}

	res := h.mustDo(t, http.MethodPost, "/v1/import/season", f.OwnerToken, payload, http.StatusOK)

	var rep struct {
		Workers         struct{ Written int } `json:"workers"`
		WorkRecords     struct{ Written int } `json:"workRecords"`
		Settlements     struct{ Written int } `json:"settlements"`
		SettlementItems struct{ Written int } `json:"settlementItems"`
		Ledger          struct{ Written int } `json:"ledger"`
		BalancesChecked int                   `json:"balancesChecked"`
	}
	if err := json.Unmarshal([]byte(res.Raw), &rep); err != nil {
		t.Fatalf("could not read the import report: %v: %s", err, res.Raw)
	}

	// Counts, not just a 200. An import that accepted the file and wrote
	// nothing is the failure this endpoint is least likely to announce.
	if rep.Workers.Written != 3 {
		t.Errorf("workers written = %d, want 3", rep.Workers.Written)
	}
	if rep.WorkRecords.Written != 30 {
		t.Errorf("work records written = %d, want 30", rep.WorkRecords.Written)
	}
	if rep.Settlements.Written != 3 {
		t.Errorf("settlements written = %d, want 3", rep.Settlements.Written)
	}
	if rep.SettlementItems.Written != 30 {
		t.Errorf("settlement items written = %d, want 30: every weighing is on a document",
			rep.SettlementItems.Written)
	}
	if rep.Ledger.Written != 7 {
		t.Errorf("ledger rows written = %d, want 7", rep.Ledger.Written)
	}
	// The whole reason the endpoint exists. A season that lands with balances
	// unchecked is a season nobody can trust.
	if rep.BalancesChecked != 3 {
		t.Errorf("balances checked = %d, want 3", rep.BalancesChecked)
	}

	// The same file twice is the retry an owner on a bad connection will make,
	// and it must not double the season. It runs against THIS farm rather than
	// a fresh one on purpose: the fixture's ids are the handset's own, and two
	// farms importing the same file would collide on them -- which is a
	// property of reusing one fixture, not something two real farms can do.
	second := h.mustDo(t, http.MethodPost, "/v1/import/season", f.OwnerToken, payload, http.StatusOK)

	var again struct {
		Workers     struct{ Written, Skipped int } `json:"workers"`
		WorkRecords struct{ Written, Skipped int } `json:"workRecords"`
		Settlements struct{ Written, Skipped int } `json:"settlements"`
	}
	if err := json.Unmarshal([]byte(second.Raw), &again); err != nil {
		t.Fatalf("could not read the retry's report: %v: %s", err, second.Raw)
	}
	if again.Workers.Written != 0 || again.WorkRecords.Written != 0 || again.Settlements.Written != 0 {
		t.Errorf("the retry wrote %d workers, %d weighings and %d settlements again; it must skip all three",
			again.Workers.Written, again.WorkRecords.Written, again.Settlements.Written)
	}
	if again.WorkRecords.Skipped != 30 {
		t.Errorf("the retry skipped %d weighings, want 30", again.WorkRecords.Skipped)
	}
}
