package httpapi

import (
	"strings"
	"testing"
)

func TestFarmSlugFromURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://lapalma.bascula.engp.io":            "lapalma",
		"https://LaPalma.bascula.engp.io/entrar?x=1": "lapalma",
		"lapalma.bascula.engp.io:443":                "lapalma",
		"https://elroble.int.dev.engp.io#top":        "elroble",
		"https://bascula.int.dev.engp.io":            "",
		"https://bascula.engp.io":                    "",
		"https://a.b.bascula.engp.io":                "",
		"https://example.com":                        "",
		"":                                           "",
	} {
		if got := FarmSlugFromURL(in); got != want {
			t.Errorf("FarmSlugFromURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUniquifyFarmSlugStaysWithinALabel(t *testing.T) {
	id := "0b7a6c1e-2d3f-4a5b-6c7d-8e9f0a1b2c3d"
	if got := uniquifyFarmSlug("", id, 0); got != "0b7a6c1e" {
		t.Errorf("no base: %q", got)
	}
	long := strings.Repeat("a", 60)
	got := uniquifyFarmSlug(long, id, 1)
	if len(got) > 63 || !strings.HasSuffix(got, "-0b7a6c1e2d3f") {
		t.Errorf("long base: %q (%d)", got, len(got))
	}
	if got := uniquifyFarmSlug(strings.Repeat("-", 60), id, 0); got != "0b7a6c1e" {
		t.Errorf("a base of dashes: %q", got)
	}
	if got := uniquifyFarmSlug("finca", id, 20); len(got) > 63 || !strings.HasPrefix(got, "finca-") {
		t.Errorf("many attempts: %q", got)
	}
	if got := farmIDPrefix("", 12); got != "" {
		t.Errorf("empty id: %q", got)
	}
	if got := farmIDPrefix("abc", 4); got != "abc" {
		t.Errorf("short id: %q", got)
	}
	if got := slugifyFarmName(strings.Repeat("ab-", 40)); len(got) > 63 || strings.HasSuffix(got, "-") {
		t.Errorf("long name: %q", got)
	}
}
