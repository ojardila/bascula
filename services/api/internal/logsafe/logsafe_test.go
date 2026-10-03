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
