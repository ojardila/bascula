package apitest

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// The golden cases: packages/shared/golden/cases/*.json.
//
// They are the calculation contract, not a test of the phone. Each file is a
// sequence of writes and the exact cents that must come out, verified against
// the SQL the phone actually executes. This runner replays them against the Go
// domain and real Postgres, so a picker is paid the same whether the weighing
// was recorded on a phone or on the web.
//
// The mapping from the phone's vocabulary to the server's:
//
//	pickup    -> a work record of the seeded "Recoleccion" activity: work unit, kilos,
//	             one day, priced from the week at settlement time.
//	personId  -> employees.id      cropId -> plot_crops.id
//	settle/pay/advance/deduct/adjust/void/reverse -> the same names in store.
//
// Two things are done deliberately rather than conveniently:
//
//   - Each event runs in its own transaction, exactly as an HTTP request would.
//     That also gives the ledger a well-defined order, since now() is the
//     transaction's start time.
//   - `pickup.at` is a wall-clock local time and is converted with the case's
//     timezone before being written, so the local_day trigger does the same
//     work it does in production. Case 04 depends on precisely this: a Sunday
//     19:30 in Colombia is Monday in UTC.
//
// The runner drives the domain layer, not HTTP. Golden case 07 pays more than
// the balance, which POST /v1/payments guards against by default; see the
// AllowOverpayment comment in handlers_money.go for that contradiction and how
// it is resolved.

type goldenCase struct {
	ID               string           `json:"id"`
	Title            string           `json:"title"`
	Why              string           `json:"why"`
	Timezone         string           `json:"timezone"`
	GeneralRateCents int64            `json:"generalRateCents"`
	WeeklyRateCents  map[string]int64 `json:"weeklyRateCents"`
	People           []goldenPerson   `json:"people"`
	Crops            []goldenCrop     `json:"crops"`
	Events           []goldenEvent    `json:"events"`
	Expect           goldenExpect     `json:"expect"`
}

type goldenPerson struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	LastName string `json:"lastName"`
}

type goldenCrop struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type goldenEvent struct {
	Op           string      `json:"op"`
	ID           int         `json:"id"`
	PersonID     int         `json:"personId"`
	CropID       int         `json:"cropId"`
	Quantity     json.Number `json:"quantity"`
	At           string      `json:"at"`
	From         string      `json:"from"`
	To           string      `json:"to"`
	On           string      `json:"on"`
	AmountCents  int64       `json:"amountCents"`
	SignedCents  int64       `json:"signedCents"`
	Method       string      `json:"method"`
	Note         string      `json:"note"`
	SettlementID int         `json:"settlementId"`
	LedgerID     int         `json:"ledgerId"`
	Label        string      `json:"label"`
}

type goldenExpect struct {
	Pickups     []goldenPickupExpect     `json:"pickups"`
	Settlements []goldenSettlementExpect `json:"settlements"`
	Ledger      []goldenLedgerExpect     `json:"ledger"`
	Balances    []goldenBalanceExpect    `json:"balances"`
	Checkpoints []goldenCheckpoint       `json:"checkpoints"`
}

type goldenPickupExpect struct {
	ID       int    `json:"id"`
	LocalDay string `json:"localDay"`
	Week     string `json:"week"`
}

type goldenSettlementExpect struct {
	ID          int                `json:"id"`
	PersonID    int                `json:"personId"`
	PeriodStart string             `json:"periodStart"`
	PeriodEnd   string             `json:"periodEnd"`
	GrossCents  int64              `json:"grossCents"`
	Status      string             `json:"status"`
	Items       []goldenItemExpect `json:"items"`
}

type goldenItemExpect struct {
	PickupID         int         `json:"pickupId"`
	Week             string      `json:"week"`
	Quantity         json.Number `json:"quantity"`
	CostPerUnitCents int64       `json:"costPerUnitCents"`
	AmountCents      int64       `json:"amountCents"`
	Voided           bool        `json:"voided"`
}

type goldenLedgerExpect struct {
	ID           int    `json:"id"`
	PersonID     int    `json:"personId"`
	Kind         string `json:"kind"`
	AmountCents  int64  `json:"amountCents"`
	Date         string `json:"date"`
	SettlementID *int   `json:"settlementId"`
	ReversesID   *int   `json:"reversesId"`
}

type goldenBalanceExpect struct {
	PersonID       int    `json:"personId"`
	EarnedCents    int64  `json:"earnedCents"`
	PaidCents      int64  `json:"paidCents"`
	DeductedCents  int64  `json:"deductedCents"`
	BalanceCents   int64  `json:"balanceCents"`
	LastMovementAt string `json:"lastMovementAt"`
}

type goldenCheckpoint struct {
	Label    string                `json:"label"`
	Balances []goldenBalanceExpect `json:"balances"`
}

// goldenRun holds the identity mapping between the fixture's small integers and
// the UUIDs the server actually uses.
type goldenRun struct {
	h        *harness
	farm     *farmFixture
	activity string
	people   map[int]string
	crops    map[int]string
	plotID   string
	pickups  map[int]string

	// Settlements and ledger entries are numbered by the order they were
	// written, which is what the fixtures refer to.
	settlementOrder []string
	ledgerOrder     []string
	checkpoints     []goldenCheckpoint
}

func TestGoldenCases(t *testing.T) {
	h := requireDB(t)

	dir := goldenDir(t)
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil || len(files) == 0 {
		t.Skipf("no golden cases under %s; nothing to run", dir)
	}
	sort.Strings(files)

	for _, file := range files {
		file := file
		t.Run(filepath.Base(file), func(t *testing.T) {
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("read %s: %v", file, err)
			}
			var c goldenCase
			if err := json.Unmarshal(raw, &c); err != nil {
				t.Fatalf("parse %s: %v", file, err)
			}
			runGoldenCase(t, h, c)
		})
	}
}

// goldenDir finds packages/shared/golden/cases from inside services/api.
func goldenDir(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for dir := wd; dir != "/" && dir != "."; dir = filepath.Dir(dir) {
		candidate := filepath.Join(dir, "packages", "shared", "golden", "cases")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return ""
}

func runGoldenCase(t *testing.T, h *harness, c goldenCase) {
	t.Helper()

	loc, err := time.LoadLocation(c.Timezone)
	if err != nil {
		t.Fatalf("%s: unknown timezone %q: %v", c.ID, c.Timezone, err)
	}

	// A farm of its own per case, with the case's standing price.
	farm := h.signupFarm(t, "golden-"+c.ID+"-"+uuid.NewString()[:6], c.GeneralRateCents)
	run := &goldenRun{
		h: h, farm: farm,
		activity: h.harvestActivityID(t, farm),
		people:   map[int]string{},
		crops:    map[int]string{},
		pickups:  map[int]string{},
	}

	for _, p := range c.People {
		run.people[p.ID] = h.createWorker(t, farm,
			p.Name, fmt.Sprintf("golden-%s-%d", c.ID, p.ID))
	}
	// The fixture's `crops` are what the phone calls a lot; on the server that
	// is a plot with one crop planted in it.
	for _, cr := range c.Crops {
		res := h.mustDo(t, "POST", "/v1/plots", farm.OwnerToken, map[string]any{
			"name":  cr.Name,
			"crops": []map[string]any{{"cropType": "Cafe"}},
		}, 201)
		plot := mustString(t, res.Body, "id")
		run.plotID = plot
		crops, _ := res.Body["crops"].([]any)
		if len(crops) == 0 {
			t.Fatalf("plot %q came back with no crops", cr.Name)
		}
		run.crops[cr.ID] = crops[0].(map[string]any)["id"].(string)
	}

	for monday, price := range c.WeeklyRateCents {
		h.mustDo(t, "PUT", "/v1/prices/weeks/"+monday, farm.OwnerToken,
			map[string]any{"priceCents": price}, 200)
	}

	for i, ev := range c.Events {
		if err := run.apply(t, ev, loc); err != nil {
			t.Fatalf("%s: event %d (%s) failed: %v\n\nWhy this case exists: %s",
				c.ID, i+1, ev.Op, err, c.Why)
		}
	}

	run.check(t, c)
}

func (r *goldenRun) apply(t *testing.T, ev goldenEvent, loc *time.Location) error {
	t.Helper()
	var applyErr error

	commitErr := r.h.withTenantCommit(t, r.farm.FarmID, r.farm.OwnerUserID, domain.RoleOwner,
		func(ctx context.Context, tx pgx.Tx) error {
			farmID := r.farm.FarmID
			on := optionalDay(ev.On)

			switch ev.Op {
			case "pickup":
				// The wall-clock time is read in the farm's zone, which is the
				// whole point of case 04: 19:30 on a Colombian Sunday is
				// already Monday in UTC, and the business day is the farm's.
				at, err := time.ParseInLocation("2006-01-02T15:04", ev.At, loc)
				if err != nil {
					return fmt.Errorf("parse at %q: %w", ev.At, err)
				}
				id := newGoldenID()
				record := store.WorkRecord{
					ID: id, EmployeeID: r.people[ev.PersonID], ActivityID: r.activity,
					PayScheme: domain.PaySchemeWorkUnit, RateSource: domain.RateWeeklyPrice,
					StartedAt: at.UTC(), Quantity: ev.Quantity,
					PlotIDs: []string{r.plotID}, PlotCropIDs: []string{r.crops[ev.CropID]},
				}
				if unit := r.activityUnit(ctx, tx); unit != nil {
					record.UnitID = unit
				}
				if _, err := store.CreateWorkRecord(ctx, tx, farmID, record); err != nil {
					return err
				}
				r.pickups[ev.ID] = id

			case "settle":
				id := newGoldenID()
				_, _, err := store.Settle(ctx, tx, farmID, r.people[ev.PersonID], id,
					day(ev.From), day(ev.To), nil, optionalText(ev.Note),
					r.farm.OwnerUserID, on)
				if err != nil {
					return err
				}
				r.settlementOrder = append(r.settlementOrder, id)
				r.recordLedgerSince(ctx, tx)

			case "pay", "advance", "deduct":
				kind := map[string]domain.LedgerKind{
					"pay": domain.KindPayment, "advance": domain.KindAdvance,
					"deduct": domain.KindDeduction,
				}[ev.Op]
				// The fixtures hand over magnitudes; the sign belongs to the
				// data layer, exactly as it does on the phone.
				entry := store.NewLedgerEntry{
					ID: newGoldenID(), EmployeeID: r.people[ev.PersonID], Kind: kind,
					AmountMinor: -ev.AmountCents, LocalDay: on,
					Note: optionalText(ev.Note), CreatedBy: r.farm.OwnerUserID,
				}
				if ev.Method != "" {
					entry.Method = &ev.Method
				}
				if _, _, err := store.AddLedgerEntry(ctx, tx, farmID, entry); err != nil {
					return err
				}
				r.recordLedgerSince(ctx, tx)

			case "adjust":
				// An adjustment is the one kind that arrives already signed.
				if _, _, err := store.AddLedgerEntry(ctx, tx, farmID, store.NewLedgerEntry{
					ID: newGoldenID(), EmployeeID: r.people[ev.PersonID],
					Kind: domain.KindAdjust, AmountMinor: ev.SignedCents, LocalDay: on,
					Note: optionalText(ev.Note), CreatedBy: r.farm.OwnerUserID,
				}); err != nil {
					return err
				}
				r.recordLedgerSince(ctx, tx)

			case "void":
				target := r.settlementOrder[ev.SettlementID-1]
				// The golden fixtures name no reversal id: they replay a
				// story once, never a retry, so the idempotency key has
				// nothing to key on and is deliberately absent.
				if _, _, err := store.VoidSettlement(ctx, tx, farmID, target, "",
					r.farm.OwnerUserID, on); err != nil {
					return err
				}
				r.recordLedgerSince(ctx, tx)

			case "reverse":
				target := r.ledgerOrder[ev.LedgerID-1]
				if _, _, err := store.ReverseLedgerEntry(ctx, tx, farmID, target, "",
					r.farm.OwnerUserID, optionalText(ev.Note), on); err != nil {
					return err
				}
				r.recordLedgerSince(ctx, tx)

			case "checkpoint":
				r.checkpoints = append(r.checkpoints, goldenCheckpoint{
					Label:    ev.Label,
					Balances: r.snapshotBalances(t, ctx, tx),
				})

			default:
				return fmt.Errorf("unknown op %q", ev.Op)
			}
			return nil
		})
	if commitErr != nil {
		return commitErr
	}
	return applyErr
}

// recordLedgerSince appends any ledger rows this event created, in write order,
// so the fixtures' integer ledger ids keep meaning what they mean.
func (r *goldenRun) recordLedgerSince(ctx context.Context, tx pgx.Tx) {
	seen := map[string]bool{}
	for _, id := range r.ledgerOrder {
		seen[id] = true
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text FROM ledger ORDER BY created_at, kind, id`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return
		}
		if !seen[id] {
			r.ledgerOrder = append(r.ledgerOrder, id)
			seen[id] = true
		}
	}
}

func (r *goldenRun) activityUnit(ctx context.Context, tx pgx.Tx) *string {
	a, err := store.GetActivity(ctx, tx, r.activity)
	if err != nil {
		return nil
	}
	return a.UnitID
}

func (r *goldenRun) snapshotBalances(t *testing.T, ctx context.Context, tx pgx.Tx) []goldenBalanceExpect {
	t.Helper()
	ids := make([]int, 0, len(r.people))
	for n := range r.people {
		ids = append(ids, n)
	}
	sort.Ints(ids)

	out := make([]goldenBalanceExpect, 0, len(ids))
	for _, n := range ids {
		b, err := store.Balance(ctx, tx, r.people[n])
		if err != nil {
			t.Fatalf("balance: %v", err)
		}
		row := goldenBalanceExpect{
			PersonID: n, EarnedCents: b.EarnedMinor, PaidCents: b.PaidMinor,
			DeductedCents: b.DeductedMinor, BalanceCents: b.BalanceMinor,
		}
		if b.LastMovementOn != nil {
			row.LastMovementAt = b.LastMovementOn.Format("2006-01-02")
		}
		out = append(out, row)
	}
	return out
}

// check compares what the database now holds against what the case asserts.
// Keys absent from `expect` are not checked: a case asserts what it says and
// nothing more.
func (r *goldenRun) check(t *testing.T, c goldenCase) {
	t.Helper()
	fail := func(format string, args ...any) {
		t.Errorf(format+"\n\nWhy this case exists: %s", append(args, c.Why)...)
	}

	r.h.withTenant(t, r.farm.FarmID, r.farm.OwnerUserID, domain.RoleOwner,
		func(ctx context.Context, tx pgx.Tx) {
			for _, want := range c.Expect.Pickups {
				record, err := store.GetWorkRecord(ctx, tx, r.pickups[want.ID])
				if err != nil {
					fail("pickup %d: %v", want.ID, err)
					continue
				}
				if got := record.LocalDay.Format("2006-01-02"); got != want.LocalDay {
					fail("pickup %d local day = %s, want %s", want.ID, got, want.LocalDay)
				}
				if got := record.WeekStart.Format("2006-01-02"); got != want.Week {
					fail("pickup %d week = %s, want %s", want.ID, got, want.Week)
				}
			}

			for _, want := range c.Expect.Settlements {
				if want.ID > len(r.settlementOrder) {
					fail("case expects settlement %d but only %d were written",
						want.ID, len(r.settlementOrder))
					continue
				}
				got, err := store.GetSettlement(ctx, tx, r.settlementOrder[want.ID-1])
				if err != nil {
					fail("settlement %d: %v", want.ID, err)
					continue
				}
				if got.GrossMinor != want.GrossCents {
					fail("settlement %d gross = %d, want %d",
						want.ID, got.GrossMinor, want.GrossCents)
				}
				if got.Status != want.Status {
					fail("settlement %d status = %s, want %s", want.ID, got.Status, want.Status)
				}
				if s := got.PeriodStart.Format("2006-01-02"); s != want.PeriodStart {
					fail("settlement %d period start = %s, want %s", want.ID, s, want.PeriodStart)
				}
				if e := got.PeriodEnd.Format("2006-01-02"); e != want.PeriodEnd {
					fail("settlement %d period end = %s, want %s", want.ID, e, want.PeriodEnd)
				}
				if len(got.Items) != len(want.Items) {
					fail("settlement %d has %d lines, want %d",
						want.ID, len(got.Items), len(want.Items))
					continue
				}
				for i, wantItem := range want.Items {
					gotItem := got.Items[i]
					if gotItem.PayableID != r.pickups[wantItem.PickupID] {
						fail("settlement %d line %d is for the wrong pickup", want.ID, i+1)
					}
					if gotItem.AmountMinor != wantItem.AmountCents {
						fail("settlement %d line %d amount = %d, want %d",
							want.ID, i+1, gotItem.AmountMinor, wantItem.AmountCents)
					}
					if gotItem.PriceMinor != wantItem.CostPerUnitCents {
						fail("settlement %d line %d unit price = %d, want %d",
							want.ID, i+1, gotItem.PriceMinor, wantItem.CostPerUnitCents)
					}
					if w := gotItem.WeekStart.Format("2006-01-02"); w != wantItem.Week {
						fail("settlement %d line %d week = %s, want %s",
							want.ID, i+1, w, wantItem.Week)
					}
					if gotItem.Voided != wantItem.Voided {
						fail("settlement %d line %d voided = %v, want %v",
							want.ID, i+1, gotItem.Voided, wantItem.Voided)
					}
					if !sameQuantity(gotItem.Quantity, wantItem.Quantity) {
						fail("settlement %d line %d quantity = %s, want %s",
							want.ID, i+1, gotItem.Quantity, wantItem.Quantity)
					}
				}
			}

			if len(c.Expect.Ledger) > 0 {
				r.checkLedger(t, ctx, tx, c, fail)
			}

			for _, want := range c.Expect.Balances {
				b, err := store.Balance(ctx, tx, r.people[want.PersonID])
				if err != nil {
					fail("balance for person %d: %v", want.PersonID, err)
					continue
				}
				compareBalance(want, b, fail)
			}
		})

	if len(c.Expect.Checkpoints) > 0 {
		if len(r.checkpoints) != len(c.Expect.Checkpoints) {
			fail("recorded %d checkpoints, the case declares %d",
				len(r.checkpoints), len(c.Expect.Checkpoints))
			return
		}
		for i, want := range c.Expect.Checkpoints {
			got := r.checkpoints[i]
			if got.Label != want.Label {
				fail("checkpoint %d is %q, want %q", i+1, got.Label, want.Label)
			}
			for j, wantBal := range want.Balances {
				if j >= len(got.Balances) {
					fail("checkpoint %q has no balance for person %d", want.Label, wantBal.PersonID)
					continue
				}
				gotBal := got.Balances[j]
				if gotBal != wantBal {
					fail("checkpoint %q, person %d:\n  got  %+v\n  want %+v",
						want.Label, wantBal.PersonID, gotBal, wantBal)
				}
			}
		}
	}
}

func (r *goldenRun) checkLedger(t *testing.T, ctx context.Context, tx pgx.Tx,
	c goldenCase, fail func(string, ...any)) {
	t.Helper()

	type row struct {
		id, kind   string
		amount     int64
		localDay   time.Time
		settlement *string
		reverses   *string
		employeeID string
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, kind::text, amount_minor, local_day,
		       settlement_id::text, reverses_id::text, employee_id::text
		  FROM ledger ORDER BY created_at, kind, id`)
	if err != nil {
		fail("read ledger: %v", err)
		return
	}
	defer rows.Close()

	byID := map[string]row{}
	for rows.Next() {
		var e row
		if err := rows.Scan(&e.id, &e.kind, &e.amount, &e.localDay,
			&e.settlement, &e.reverses, &e.employeeID); err != nil {
			fail("scan ledger: %v", err)
			return
		}
		byID[e.id] = e
	}

	if len(byID) != len(c.Expect.Ledger) {
		fail("the ledger has %d movements, the case declares %d", len(byID), len(c.Expect.Ledger))
		return
	}

	for _, want := range c.Expect.Ledger {
		if want.ID > len(r.ledgerOrder) {
			fail("case refers to ledger movement %d but only %d exist",
				want.ID, len(r.ledgerOrder))
			continue
		}
		got, ok := byID[r.ledgerOrder[want.ID-1]]
		if !ok {
			fail("ledger movement %d is missing", want.ID)
			continue
		}
		if got.kind != want.Kind {
			fail("ledger %d kind = %s, want %s", want.ID, got.kind, want.Kind)
		}
		if got.amount != want.AmountCents {
			fail("ledger %d amount = %d, want %d", want.ID, got.amount, want.AmountCents)
		}
		if d := got.localDay.Format("2006-01-02"); d != want.Date {
			fail("ledger %d date = %s, want %s", want.ID, d, want.Date)
		}
		if got.employeeID != r.people[want.PersonID] {
			fail("ledger %d belongs to the wrong person", want.ID)
		}

		if want.SettlementID == nil {
			if got.settlement != nil {
				fail("ledger %d points at a settlement, the case says it should not", want.ID)
			}
		} else if got.settlement == nil ||
			*got.settlement != r.settlementOrder[*want.SettlementID-1] {
			fail("ledger %d points at the wrong settlement", want.ID)
		}

		if want.ReversesID == nil {
			if got.reverses != nil {
				fail("ledger %d reverses something, the case says it should not", want.ID)
			}
		} else if got.reverses == nil ||
			*got.reverses != r.ledgerOrder[*want.ReversesID-1] {
			fail("ledger %d reverses the wrong movement", want.ID)
		}
	}
}

func compareBalance(want goldenBalanceExpect, got *domain.Balance, fail func(string, ...any)) {
	if got.EarnedMinor != want.EarnedCents {
		fail("person %d earned = %d, want %d", want.PersonID, got.EarnedMinor, want.EarnedCents)
	}
	if got.PaidMinor != want.PaidCents {
		fail("person %d paid = %d, want %d", want.PersonID, got.PaidMinor, want.PaidCents)
	}
	if got.DeductedMinor != want.DeductedCents {
		fail("person %d deducted = %d, want %d",
			want.PersonID, got.DeductedMinor, want.DeductedCents)
	}
	if got.BalanceMinor != want.BalanceCents {
		fail("person %d balance = %d, want %d",
			want.PersonID, got.BalanceMinor, want.BalanceCents)
	}
	if want.LastMovementAt != "" {
		if got.LastMovementOn == nil {
			fail("person %d has no last movement, want %s", want.PersonID, want.LastMovementAt)
		} else if d := got.LastMovementOn.Format("2006-01-02"); d != want.LastMovementAt {
			fail("person %d last movement = %s, want %s", want.PersonID, d, want.LastMovementAt)
		}
	}
}

// sameQuantity compares two decimals by value, so 50 and 50.000 agree.
func sameQuantity(got, want json.Number) bool {
	a, okA := new(big.Rat).SetString(got.String())
	b, okB := new(big.Rat).SetString(want.String())
	return okA && okB && a.Cmp(b) == 0
}

func optionalDay(s string) *time.Time {
	if s == "" {
		return nil
	}
	d := day(s)
	return &d
}

func optionalText(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// newGoldenID keeps ids sortable and unique. The fixtures number things by
// write order, and the run keeps its own ordered slices for that.
func newGoldenID() string {
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.NewString()
	}
	return id.String()
}

var _ = strconv.Itoa
