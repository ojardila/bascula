// SPDX-License-Identifier: MIT

package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestRequestUserAgent(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	if requestUserAgent(r) != nil {
		t.Fatal("no header should be nil")
	}
	r.Header.Set("User-Agent", "  Mozilla/5.0  ")
	if got := requestUserAgent(r); got == nil || *got != "Mozilla/5.0" {
		t.Fatalf("trimmed: %v", got)
	}
	long := strings.Repeat("a", maxUserAgent-1) + "ñññ"
	r.Header.Set("User-Agent", long)
	got := requestUserAgent(r)
	if got == nil || len(*got) > maxUserAgent || !utf8.ValidString(*got) {
		t.Fatalf("cut: %d %q", len(*got), (*got)[len(*got)-4:])
	}
}
