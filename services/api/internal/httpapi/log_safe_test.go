package httpapi

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestLogSafeStripsLineBreaks(t *testing.T) {
	got := logSafe("finca\r\nlevel=ERROR msg=forged\n")
	if strings.ContainsAny(got, "\r\n") {
		t.Fatalf("line break kept: %q", got)
	}
	if got != "fincalevel=ERROR msg=forged" {
		t.Fatalf("got %q", got)
	}
}

func TestLogSafeCapsLength(t *testing.T) {
	short := strings.Repeat("a", logSafeMax)
	if got := logSafe(short); got != short {
		t.Fatalf("value at the cap was changed: %q", got)
	}
	// Multi-byte runes: the cap counts runes and never splits one.
	long := strings.Repeat("ñ", logSafeMax+50)
	got := logSafe(long)
	if !utf8.ValidString(got) {
		t.Fatalf("truncation split a rune: %q", got)
	}
	if n := utf8.RuneCountInString(got); n != logSafeMax+1 {
		t.Fatalf("got %d runes, want %d plus the ellipsis", n, logSafeMax)
	}
}

func TestLogSafeAllAndErr(t *testing.T) {
	got := logSafeAll([]string{"https://a\n", "b\r"})
	if got[0] != "https://a" || got[1] != "b" {
		t.Fatalf("got %q", got)
	}
	if logSafeErr(nil) != "" {
		t.Fatal("nil error should render empty")
	}
	if got := logSafeErr(errors.New("bad\nslug")); got != "badslug" {
		t.Fatalf("got %q", got)
	}
}
