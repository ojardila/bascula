package httpapi

import "strings"

// sanitizeLog removes carriage returns and line feeds from a value before it
// is logged, so a value a client controls (a slug, a header, a form field, a
// path) cannot forge or split a log line. The handlers already log through
// slog, which quotes such values; this keeps the guarantee independent of
// the handler and makes it visible to static analysis (CodeQL
// go/log-injection treats ReplaceAll of newlines as a sanitizer).
func sanitizeLog(s string) string {
	s = strings.ReplaceAll(s, "\n", "")
	return strings.ReplaceAll(s, "\r", "")
}

// sanitizeLogList applies sanitizeLog to every element of v.
func sanitizeLogList(v []string) []string {
	if v == nil {
		return nil
	}
	out := make([]string, len(v))
	for i, s := range v {
		out[i] = sanitizeLog(s)
	}
	return out
}

// sanitizeLogErr is sanitizeLog for an error message; a nil error is "".
func sanitizeLogErr(err error) string {
	if err == nil {
		return ""
	}
	return sanitizeLog(err.Error())
}
