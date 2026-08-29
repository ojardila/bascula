package domain

import (
	"math/big"
	"testing"
	"time"
)

// TestAmountMinorRoundsHalfUp pins the rule the golden cases exist to defend:
// round(quantity * rate), half AWAY FROM ZERO, per line, never bankers'
// rounding. 2.5 * 8333 = 20832.5 exactly, and the answer is 20833.
func TestAmountMinorRoundsHalfUp(t *testing.T) {
	cases := []struct {
		quantity string
		rate     int64
		want     int64
		why      string
	}{
		{"2.5", 8333, 20833, "half up, not to even; bankers' rounding gives 20832"},
		{"4.5", 8333, 37499, ""},
		{"1.5", 8333, 12500, ""},
		{"0.5", 8333, 4167, "half up again; to even would give 4166"},
		{"52.5", 80000, 4_200_000, ""},
		{"47.5", 80000, 3_800_000, ""},
		{"1", 60000, 60000, "a contract is quantity 1 times its total"},
		{"2", 60000, 120000, "two day wages"},
		{"100", 80000, 8_000_000, ""},
	}
	for _, c := range cases {
		q, ok := new(big.Rat).SetString(c.quantity)
		if !ok {
			t.Fatalf("bad fixture quantity %q", c.quantity)
		}
		if got := AmountMinor(q, c.rate); got != c.want {
			t.Errorf("AmountMinor(%s, %d) = %d, want %d. %s",
				c.quantity, c.rate, got, c.want, c.why)
		}
	}
}

// TestRoundingIsPerLine is the second half of golden case 06: summing the
// exact products and rounding the total gives 74997; rounding each line and
// summing integers gives 74999. Two cents over four weighings, and the receipt
// the worker checks has to add up line by line.
func TestRoundingIsPerLine(t *testing.T) {
	quantities := []string{"2.5", "4.5", "1.5", "0.5"}
	const rate = 8333

	var perLine int64
	exact := new(big.Rat)
	for _, raw := range quantities {
		q, _ := new(big.Rat).SetString(raw)
		perLine += AmountMinor(q, rate)
		exact.Add(exact, new(big.Rat).Mul(q, new(big.Rat).SetInt64(rate)))
	}
	roundedTotal := AmountMinor(exact, 1)

	if perLine != 74999 {
		t.Errorf("per-line total = %d, want 74999", perLine)
	}
	if roundedTotal != 74997 {
		t.Errorf("rounded-once total = %d, want 74997", roundedTotal)
	}
	if perLine == roundedTotal {
		t.Error("the two totals agree, so this test can no longer tell them apart")
	}
}

// TestMondayOf pins the week: the Monday's ISO date, never a "2026-W33" label,
// and never the Sunday.
func TestMondayOf(t *testing.T) {
	cases := map[string]string{
		"2026-08-24": "2026-08-24", // a Monday is its own week
		"2026-08-25": "2026-08-24",
		"2026-08-30": "2026-08-24", // Sunday belongs to the week that started
		"2026-08-31": "2026-08-31",
		"2026-12-29": "2026-12-28", // the week across the year boundary is one week
		"2027-01-03": "2026-12-28",
	}
	for in, want := range cases {
		d, err := time.Parse("2006-01-02", in)
		if err != nil {
			t.Fatal(err)
		}
		if got := MondayOf(d).Format("2006-01-02"); got != want {
			t.Errorf("MondayOf(%s) = %s, want %s", in, got, want)
		}
	}
}

// TestSignsByKind documents the sign table the ledger constraint enforces.
func TestSignsByKind(t *testing.T) {
	if !RateWeeklyPrice.Derived() || !RateActivityDated.Derived() {
		t.Error("both derived rate sources must report as derived: they are the ones "+
			"that force a single-day work record", RateWeeklyPrice, RateActivityDated)
	}
	if RateExplicit.Derived() {
		t.Error("an explicit rate is frozen by the caller, so it is not derived")
	}
}
