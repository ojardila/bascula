// SPDX-License-Identifier: MIT

package domain

import (
	"encoding/json"
	"math"
	"math/big"
	"strings"
	"testing"
	"time"
)

func c2otKg(v float64) *float64 { return &v }

// Day reads the plain date the contract declares, keeps the calendar day of an
// RFC 3339 instant rather than its UTC day, and treats empty and null as unset.
func TestDayDecodesWhatTheContractAllows(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{`"2026-08-25"`, "2026-08-25"},
		{`"2026-08-25T23:30:00-05:00"`, "2026-08-25"},
		{`"2026-08-25T00:30:00+05:00"`, "2026-08-25"},
	} {
		var d Day
		if err := json.Unmarshal([]byte(c.in), &d); err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		if got := d.Format(time.DateOnly); got != c.want || d.Location() != time.UTC || d.Hour() != 0 {
			t.Fatalf("%s decoded as %v, want %s at midnight UTC", c.in, d.Time, c.want)
		}
		out, _ := json.Marshal(d)
		if string(out) != `"`+c.want+`"` {
			t.Fatalf("%s re-encoded as %s", c.in, out)
		}
		if p := d.Ptr(); p == nil || !p.Equal(d.Time) {
			t.Fatalf("Ptr = %v", p)
		}
	}
	for _, in := range []string{`""`, `null`} {
		var d Day
		if err := json.Unmarshal([]byte(in), &d); err != nil || !d.IsZero() || d.Ptr() != nil {
			t.Fatalf("%s: %v, %v", in, d, err)
		}
	}
	var d Day
	err := json.Unmarshal([]byte(`"25/08/2026"`), &d)
	if err == nil || !strings.Contains(err.Error(), "2026-08-25") {
		t.Fatalf("a foreign date must be refused with an example: %v", err)
	}
	var nilDay *Day
	if nilDay.Ptr() != nil {
		t.Fatal("a nil Day is no date")
	}
}

func TestRoleValid(t *testing.T) {
	for _, r := range []Role{RoleOwner, RoleAdmin, RoleWeigher} {
		if !r.Valid() {
			t.Errorf("%s must be valid", r)
		}
	}
	for _, r := range []Role{"", "superadmin", "platform", "Owner"} {
		if r.Valid() {
			t.Errorf("%q must not be valid", r)
		}
	}
}

// No quantity is no money, and negative amounts round half away from zero,
// which is what Postgres round(numeric) does.
func TestAmountMinorWithoutQuantityAndBelowZero(t *testing.T) {
	if got := AmountMinor(nil, 1000); got != 0 {
		t.Fatalf("AmountMinor(nil) = %d", got)
	}
	for _, c := range []struct {
		qty  string
		rate int64
		want int64
	}{
		{"-0.5", 1, -1},
		{"-1.4", 1, -1},
		{"-2.5", 1, -3},
		{"1.5", -3, -5},
	} {
		q, _ := new(big.Rat).SetString(c.qty)
		if got := AmountMinor(q, c.rate); got != c.want {
			t.Errorf("AmountMinor(%s, %d) = %d, want %d", c.qty, c.rate, got, c.want)
		}
	}
}

// Text that is not a number, and floats that are not decimals, are refused
// as such rather than as too large or too precise.
func TestCheckNumericRefusesWhatIsNotADecimal(t *testing.T) {
	if err := CheckNumeric("qty", "  ", 12, 3); err == nil || !strings.Contains(err.Error(), "required") {
		t.Fatalf("blank: %v", err)
	}
	if err := CheckNumeric("qty", "doce", 12, 3); err == nil || !strings.Contains(err.Error(), "decimal number") {
		t.Fatalf("words: %v", err)
	}
	for _, f := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if err := CheckNumericFloat("area", f, AreaPrecision, AreaScale); err == nil || !strings.Contains(err.Error(), "decimal number") {
			t.Fatalf("%v: %v", f, err)
		}
	}
	if err := CheckNumericFloat("area", -9999999.999, AreaPrecision, AreaScale); err != nil {
		t.Fatalf("the largest negative value fits: %v", err)
	}
	if err := CheckNumericFloat("area", -10000000, AreaPrecision, AreaScale); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("too large negative: %v", err)
	}
}

// A week that is missing from the series (not unknown: absent) breaks the
// falling run, so the weeks either side are never compared as neighbours.
func TestAMissingWeekStopsTheFallingRun(t *testing.T) {
	series := []WeekTotal{
		{WeekStart: "2026-08-17", Kg: c2otKg(100)},
		{WeekStart: "2026-08-03", Kg: c2otKg(1000)},
		{WeekStart: "2026-07-27", Kg: c2otKg(2000)},
	}
	if got := fallingWeeks(series, DefaultDropThreshold); got != 0 {
		t.Fatalf("fallingWeeks over a gap = %d, want 0", got)
	}
	shape := ReadHarvest(series, "2026-08-24", DefaultDropThreshold)
	if shape.FallingWeeks != 0 || shape.WindingDown || shape.ContiguousWeeks != 1 {
		t.Fatalf("ReadHarvest over a gap = %+v", shape)
	}
}

// A week of zero kilos is no base to measure a fall against: the run stops.
func TestAZeroWeekIsNoBaseForAFall(t *testing.T) {
	series := []WeekTotal{
		{WeekStart: "2026-08-17", Kg: c2otKg(0)},
		{WeekStart: "2026-08-10", Kg: c2otKg(0)},
		{WeekStart: "2026-08-03", Kg: c2otKg(500)},
	}
	if got := fallingWeeks(series, DefaultDropThreshold); got != 0 {
		t.Fatalf("fallingWeeks from a zero base = %d, want 0", got)
	}
	// The fall INTO the zero week still counts; the one before it cannot.
	if got := fallingWeeks(series[1:], DefaultDropThreshold); got != 1 {
		t.Fatalf("fallingWeeks 500 -> 0 = %d, want 1", got)
	}
}

// A malformed Monday is adjacent to nothing.
func TestIsWeekBeforeRefusesMalformedDates(t *testing.T) {
	for _, c := range [][2]string{
		{"2026-8-3", "2026-08-10"},
		{"2026-08-03", "next week"},
		{"", ""},
	} {
		if isWeekBefore(c[0], c[1]) {
			t.Errorf("isWeekBefore(%q, %q) = true", c[0], c[1])
		}
	}
	if !isWeekBefore("2025-12-29", "2026-01-05") {
		t.Fatal("weeks across a year end are adjacent")
	}
}
