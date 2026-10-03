package httpapi

import (
	"net/http/httptest"
	"testing"
)

func TestPullLimitParam(t *testing.T) {
	cases := []struct {
		q    string
		want int
		bad  bool
	}{
		{"", defaultPullLimit, false},
		{"?limit=1", 1, false},
		{"?limit=499", 499, false},
		{"?limit=500", defaultPullLimit, false},
		{"?limit=0", defaultPullLimit, false},
		{"?limit=501", defaultPullLimit, false},
		{"?limit=2147483647", defaultPullLimit, false},
		{"?limit=2147483648", defaultPullLimit, false},
		{"?limit=9223372036854775808", defaultPullLimit, false},
		{"?limit=99999999999999999999999", defaultPullLimit, false},
		{"?limit=-1", 0, true},
		{"?limit=-99999999999", 0, true},
		{"?limit=x", 0, true},
		{"?limit=1.5", 0, true},
	}
	for _, c := range cases {
		got, err := pullLimitParam(httptest.NewRequest("GET", "/v1/sync/pull"+c.q, nil))
		if (err != nil) != c.bad || got != c.want {
			t.Errorf("%s: got %d, %v; want %d, bad=%v", c.q, got, err, c.want, c.bad)
		}
	}
}
