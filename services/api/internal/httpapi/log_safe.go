package httpapi

import "strings"

// logSafeMax caps a logged value. Request-derived strings (user agents,
// redirect URIs, client names) are attacker-sized; a log line should not be.
const logSafeMax = 200

// logSafe makes a request-derived string safe to put in a log attribute.
// Line breaks are removed so a crafted value cannot forge a second log
// entry in plain-text sinks, and the value is capped so one request cannot
// flood the log.
func logSafe(s string) string {
	s = strings.ReplaceAll(s, "\n", "")
	s = strings.ReplaceAll(s, "\r", "")
	if len(s) <= logSafeMax {
		return s
	}
	r := []rune(s)
	if len(r) <= logSafeMax {
		return s
	}
	return string(r[:logSafeMax]) + "…"
}

// logSafeAll applies logSafe to every element, for list attributes.
func logSafeAll(in []string) []string {
	out := make([]string, len(in))
	for i, s := range in {
		out[i] = logSafe(s)
	}
	return out
}

// logSafeErr renders an error whose message may echo request input.
func logSafeErr(err error) string {
	if err == nil {
		return ""
	}
	return logSafe(err.Error())
}
