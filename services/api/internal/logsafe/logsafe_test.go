// SPDX-License-Identifier: MIT

package logsafe

import "testing"

func TestStr(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"empty", "", ""},
		{"plain", "finca-la-esperanza", "finca-la-esperanza"},
		{"unicode kept", "Señor Ñandú ¡listo!", "Señor Ñandú ¡listo!"},
		{"newline", "a\nb", `a\nb`},
		{"carriage return", "a\rb", `a\rb`},
		{"forged line", "x\r\nlevel=ERROR msg=forged", `x\r\nlevel=ERROR msg=forged`},
		{"tab", "a\tb", "a?b"},
		{"nul and escape", "a\x00b\x1b[31m", "a?b?[31m"},
		{"del and c1", "a\x7fb\u0085c", "a?b?c"},
		{"line separators", "a\u2028b\u2029c", "a?b?c"},
		{"invalid utf8", "a\xffb", "a\uFFFDb"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Str(c.in); got != c.want {
				t.Fatalf("Str(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestStrs(t *testing.T) {
	if got := Strs(nil); got != nil {
		t.Fatalf("Strs(nil) = %q, want nil", got)
	}
	in := []string{"https://a.example/cb", "x\r\nlevel=ERROR", ""}
	got := Strs(in)
	want := []string{"https://a.example/cb", `x\r\nlevel=ERROR`, ""}
	if len(got) != len(want) {
		t.Fatalf("Strs = %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Strs = %q, want %q", got, want)
		}
	}
	if in[1] != "x\r\nlevel=ERROR" {
		t.Fatalf("Strs modified its input: %q", in)
	}
}
