package httpapi

import (
	"net/http/httptest"
	"testing"
)

func TestPullLimitParam(t *testing.T) {
	ok := []struct {
		query string
		want  int
	}{
		{"", defaultPullLimit},
		{"limit=0", defaultPullLimit},
		{"limit=1", 1},
		{"limit=500", 500},
		{"limit=501", defaultPullLimit},
		{"limit=2147483647", defaultPullLimit},
	}
	for _, c := range ok {
		r := httptest.NewRequest("GET", "/v1/sync/pull?"+c.query, nil)
		got, err := pullLimitParam(r)
		if err != nil || got != c.want {
			t.Errorf("%q: got %d, %v; want %d", c.query, got, err, c.want)
		}
	}
	for _, q := range []string{"limit=-1", "limit=abc", "limit=2147483648", "limit=9223372036854775807", "limit=99999999999999999999"} {
		r := httptest.NewRequest("GET", "/v1/sync/pull?"+q, nil)
		if _, err := pullLimitParam(r); err == nil {
			t.Errorf("%q: want a 400", q)
		}
	}
}
