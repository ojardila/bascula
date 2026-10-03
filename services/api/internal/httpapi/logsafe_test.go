package httpapi

import (
	"errors"
	"reflect"
	"testing"
)

func TestSanitizeLog(t *testing.T) {
	cases := map[string]string{
		"":                            "",
		"finca-uno":                   "finca-uno",
		"a\nb":                        "ab",
		"a\r\nlevel=ERROR msg=forged": "alevel=ERROR msg=forged",
		"\r\n\r\n":                    "",
		"tab\tstays":                  "tab\tstays",
	}
	for in, want := range cases {
		if got := sanitizeLog(in); got != want {
			t.Errorf("sanitizeLog(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSanitizeLogList(t *testing.T) {
	if got := sanitizeLogList(nil); got != nil {
		t.Errorf("sanitizeLogList(nil) = %v, want nil", got)
	}
	in := []string{"https://a.example/cb", "x\ny", "\r"}
	got := sanitizeLogList(in)
	want := []string{"https://a.example/cb", "xy", ""}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("sanitizeLogList = %q, want %q", got, want)
	}
	if in[1] != "x\ny" {
		t.Errorf("sanitizeLogList modified its input: %q", in)
	}
}

func TestSanitizeLogErr(t *testing.T) {
	if got := sanitizeLogErr(nil); got != "" {
		t.Errorf("sanitizeLogErr(nil) = %q, want empty", got)
	}
	if got := sanitizeLogErr(errors.New("bad slug \"x\nlevel=INFO\"")); got != "bad slug \"xlevel=INFO\"" {
		t.Errorf("sanitizeLogErr = %q", got)
	}
}
