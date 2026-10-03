// SPDX-License-Identifier: MIT

package httpapi

import (
	"net/mail"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// The farm name, the owner's name, the address and the phone typed at signup
// travel further than this database: kickTenantProvision hands them to the
// provision-tenant workflow as repository_dispatch client_payload, where they
// end up in a YAML file and a commit in the gitops repository. The workflow
// reads them defensively (env, JSON-quoted YAML, refuses control characters),
// and these checks are the sender's half of the same defence: nothing that is
// not a plausible name, address or phone ever leaves this service.
//
// Letters are not restricted to ASCII. "Finca La Ñapa Ñuñoa – José María" is
// an ordinary farm name here.
const (
	maxFarmNameRunes  = 80
	maxOwnerNameRunes = 80
	maxPhoneLength    = 25
	maxEmailLength    = 254
)

// isUnsafeRune reports characters that have no business in a one-line name:
// C0 and C1 controls (including \t, \r and \n) and the Unicode line and
// paragraph separators, which several YAML and JavaScript parsers treat as
// line breaks.
func isUnsafeRune(r rune) bool {
	return unicode.IsControl(r) || r == '\u2028' || r == '\u2029'
}

func hasUnsafeRune(s string) bool {
	return strings.IndexFunc(s, isUnsafeRune) >= 0
}

// fieldProblem is a 400 that also names the field, with the sentence the web
// form shows under it (see extractFieldErrors in apps/web/src/api/errors.ts).
func fieldProblem(field, msg, spanish string) error {
	return domain.BadRequest(msg).WithDetails(map[string]any{
		"fields": map[string]any{field: spanish},
	})
}

// checkName refuses a name with invalid UTF-8, control characters or line
// separators, or longer than max runes once trimmed. An empty name is left to
// the caller, which knows whether it is required.
func checkName(field, v string, max int) error {
	if !utf8.ValidString(v) || hasUnsafeRune(v) {
		return fieldProblem(field, field+" contains control characters",
			"Tiene caracteres no permitidos. Escríbalo en una sola línea.")
	}
	if utf8.RuneCountInString(strings.TrimSpace(v)) > max {
		return fieldProblem(field, field+" is too long",
			"Es demasiado largo.")
	}
	return nil
}

func validFarmName(field, v string) error  { return checkName(field, v, maxFarmNameRunes) }
func validOwnerName(field, v string) error { return checkName(field, v, maxOwnerNameRunes) }

// validPhone accepts an empty phone, or digits, spaces, '+', '-', '(' and ')'
// up to maxPhoneLength characters.
func validPhone(field, v string) error {
	v = strings.TrimSpace(v)
	if len(v) > maxPhoneLength {
		return fieldProblem(field, field+" is too long", "Es demasiado largo.")
	}
	for _, r := range v {
		if !isPhoneRune(r) {
			return fieldProblem(field, field+" may only contain digits, spaces, +, -, ( and )",
				"Escriba solo números, espacios, +, -, ( y ).")
		}
	}
	return nil
}

func isPhoneRune(r rune) bool {
	return (r >= '0' && r <= '9') || r == ' ' || r == '+' || r == '-' || r == '(' || r == ')'
}

// validEmail takes the address already trimmed and lowercased, and accepts it
// only if it is a bare address that net/mail parses back to itself: no display
// name, no comments, no quoting tricks, no line breaks.
func validEmail(field, email string) error {
	if email == "" {
		return domain.BadRequest(field + " is required")
	}
	if len(email) > maxEmailLength || hasUnsafeRune(email) {
		return fieldProblem(field, field+" is not a valid address",
			"Ese correo no parece válido. Revíselo.")
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Name != "" || addr.Address != email || !strings.Contains(email, "@") {
		return fieldProblem(field, field+" is not a valid address",
			"Ese correo no parece válido. Revíselo.")
	}
	return nil
}

// sanitizeDispatchText is the last line before client_payload: whatever a
// caller passed, turn every kind of whitespace (line breaks and separators
// included) into a single space, drop control, format (bidi overrides,
// zero-width) and private-use characters and invalid UTF-8, and cut to max
// runes. Signup has already refused the dangerous ones; this is so a future
// caller cannot skip that.
func sanitizeDispatchText(v string, max int) string {
	v = strings.ToValidUTF8(v, "")
	var b strings.Builder
	for _, r := range v {
		switch {
		case unicode.IsSpace(r): // \t \n \r, U+0085, U+2028, U+2029 among them
			b.WriteRune(' ')
		case isUnsafeRune(r), unicode.In(r, unicode.Cf, unicode.Co, unicode.Cs):
			continue
		default:
			b.WriteRune(r)
		}
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	if rs := []rune(out); len(rs) > max {
		out = strings.TrimSpace(string(rs[:max]))
	}
	return out
}

// sanitizeDispatchPhone keeps only the characters validPhone accepts.
func sanitizeDispatchPhone(v string) string {
	var b strings.Builder
	for _, r := range v {
		if isPhoneRune(r) {
			b.WriteRune(r)
		}
	}
	out := strings.TrimSpace(b.String())
	if len(out) > maxPhoneLength {
		out = strings.TrimSpace(out[:maxPhoneLength])
	}
	return out
}

// sanitizeDispatchEmail strips what sanitizeDispatchText strips, and every
// space, which no address validEmail accepts contains.
func sanitizeDispatchEmail(v string) string {
	return strings.ReplaceAll(sanitizeDispatchText(v, maxEmailLength), " ", "")
}
