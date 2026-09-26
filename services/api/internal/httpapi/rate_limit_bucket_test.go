package httpapi

import "testing"

func TestRateLimitBucket(t *testing.T) {
	for in, want := range map[string]string{
		"203.0.113.7":                  "203.0.113.7",
		"::ffff:203.0.113.7":           "203.0.113.7",
		"2001:db8:1:2:aaaa:bbbb:cc:dd": "2001:db8:1:2::",
		"2001:db8:1:2::1":              "2001:db8:1:2::",
		"2001:db8:1:3::1":              "2001:db8:1:3::",
		"fe80::1%eth0":                 "fe80::",
		"not-an-ip":                    "not-an-ip",
	} {
		if got := rateLimitBucket(in); got != want {
			t.Errorf("rateLimitBucket(%q) = %q, want %q", in, got, want)
		}
	}
}
