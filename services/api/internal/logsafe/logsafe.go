// Package logsafe makes values that came from outside (a request, a header,
// a slug, a provider's error) safe to put in a log line.
package logsafe

import (
	"strings"
	"unicode"
)

// Str returns s with the characters that could forge or break a log line
// neutralised: "\r" and "\n" become the two-character escapes `\r` and `\n`,
// and every other control character (and the Unicode line and paragraph
// separators) becomes '?'. Anything else is returned unchanged, so a
// well-formed value logs exactly as before.
//
// The newline replacement is done with strings.ReplaceAll on purpose: that
// is the form CodeQL's go/log-injection query recognises as a sanitizer.
func Str(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '\r', r == '\n':
			return r // escaped below
		case unicode.IsControl(r), r == '\u2028', r == '\u2029':
			return '?'
		}
		return r
	}, s)
	s = strings.ReplaceAll(s, "\r", `\r`)
	return strings.ReplaceAll(s, "\n", `\n`)
}
