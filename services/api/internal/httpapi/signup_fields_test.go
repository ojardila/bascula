// SPDX-License-Identifier: MIT

package httpapi

import (
	"strings"
	"testing"
)

// The sanitizers are what stands between a future caller of
// kickTenantProvision that skipped validation and the workflow.
func TestSanitizeDispatchFields(t *testing.T) {
	for in, want := range map[string]string{
		"Finca La Ñapa Ñuñoa – José María": "Finca La Ñapa Ñuñoa – José María",
		"Finca\nmode: shared":              "Finca mode: shared",
		"a\r\n\tb":                         "a b",
		"a\u0085b\u2028c\u2029d":           "a b c d",
		"\u202eevil\u200b":                 "evil",
		"x\x00y\x7fz":                      "xyz",
		"bad\xffutf8":                      "badutf8",
	} {
		if got := sanitizeDispatchText(in, maxFarmNameRunes); got != want {
			t.Errorf("sanitizeDispatchText(%q) = %q, want %q", in, got, want)
		}
	}
	if got := sanitizeDispatchText(strings.Repeat("ñ", 200), maxFarmNameRunes); got != strings.Repeat("ñ", 80) {
		t.Errorf("not truncated to 80 runes: %d", len([]rune(got)))
	}
	if got := sanitizeDispatchPhone("+57 (310)\n555-1234; rm"); got != "+57 (310)555-1234" {
		t.Errorf("sanitizeDispatchPhone = %q", got)
	}
	if got := sanitizeDispatchPhone(strings.Repeat("9", 40)); len(got) != maxPhoneLength {
		t.Errorf("phone not truncated: %q", got)
	}
	if got := sanitizeDispatchEmail("ana@example.com\r\nBcc: x@evil.test"); strings.ContainsAny(got, "\r\n ") {
		t.Errorf("sanitizeDispatchEmail kept a break or space: %q", got)
	}
}

func TestValidators(t *testing.T) {
	ok := []string{"Finca La Ñapa Ñuñoa – José María", "San José", strings.Repeat("ñ", 80)}
	for _, v := range ok {
		if err := validFarmName("farm.name", v); err != nil {
			t.Errorf("validFarmName(%q) = %v", v, err)
		}
	}
	bad := []string{"a\nb", "a\rb", "a\tb", "a\u0085b", "a\u2028b", "a\u2029b", strings.Repeat("ñ", 81), "bad\xff"}
	for _, v := range bad {
		if err := validFarmName("farm.name", v); err == nil {
			t.Errorf("validFarmName(%q) accepted", v)
		}
	}
	for _, v := range []string{"", "+57 (310) 555-1234", "3105551234"} {
		if err := validPhone("owner.phone", v); err != nil {
			t.Errorf("validPhone(%q) = %v", v, err)
		}
	}
	for _, v := range []string{"310.555", "310\n555", strings.Repeat("1", 26)} {
		if err := validPhone("owner.phone", v); err == nil {
			t.Errorf("validPhone(%q) accepted", v)
		}
	}
	for _, v := range []string{"ana@example.com", "dueno+finca@example.co"} {
		if err := validEmail("owner.email", v); err != nil {
			t.Errorf("validEmail(%q) = %v", v, err)
		}
	}
	for _, v := range []string{"ana <ana@example.com>", "ana@example.com\nbcc: x@y.z", "a@b@c", strings.Repeat("a", 250) + "@example.com"} {
		if err := validEmail("owner.email", v); err == nil {
			t.Errorf("validEmail(%q) accepted", v)
		}
	}
}
