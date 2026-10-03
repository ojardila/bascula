// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// c3gPoller serves hostnames that start pending. A GET by id of id-slow.*
// reports it active from the second poll on; id-gone.* is a 404.
type c3gPoller struct {
	mu    sync.Mutex
	polls map[string]int
}

func (p *c3gPoller) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	reply := func(result any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "errors": []any{}, "result": result})
	}
	if host := r.URL.Query().Get("hostname"); host != "" {
		reply([]any{hostname(host, "pending", "pending_validation")})
		return
	}
	id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	p.mu.Lock()
	p.polls[id]++
	n := p.polls[id]
	p.mu.Unlock()
	host := strings.TrimPrefix(id, "id-")
	switch {
	case strings.HasPrefix(host, "gone."):
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":1436,"message":"not found"}],"result":null}`))
	case n >= 2:
		reply(hostname(host, "active", "active"))
	default:
		reply(hostname(host, "pending", "pending_validation"))
	}
}

func c3gPollingCloudflare(t *testing.T) *c3gPoller {
	t.Helper()
	p := &c3gPoller{polls: map[string]int{}}
	srv := httptest.NewServer(p)
	t.Cleanup(srv.Close)
	t.Setenv("CF_SAAS_TOKEN", "token")
	t.Setenv("CF_ZONE_ID", "zone-1")
	t.Setenv("CF_API_URL", srv.URL)
	t.Setenv("CF_SAAS_DCV_METHOD", "")
	old := pollEvery
	pollEvery = time.Millisecond
	t.Cleanup(func() { pollEvery = old })
	return p
}

// wait keeps polling a pending hostname until it is active, and stops at the
// first poll the API refuses.
func TestWaitPollsUntilActive(t *testing.T) {
	p := c3gPollingCloudflare(t)
	t.Run("becomes active", func(t *testing.T) {
		if err := run([]string{"wait", "slow.example.com"}); err != nil {
			t.Fatalf("wait: %v", err)
		}
		if got := p.polls["id-slow.example.com"]; got != 2 {
			t.Fatalf("polled %d times, want 2", got)
		}
	})
	t.Run("poll fails", func(t *testing.T) {
		err := run([]string{"wait", "gone.example.com"})
		if err == nil || !strings.Contains(err.Error(), "not found") {
			t.Fatalf("wait = %v, want the API's not found", err)
		}
		if got := p.polls["id-gone.example.com"]; got != 1 {
			t.Fatalf("polled %d times after a failure, want 1", got)
		}
	})
}

// main prints run's error on stderr and exits 1.
func TestMainReportsUsageAndExits(t *testing.T) {
	oldArgs, oldExit, oldStderr := os.Args, exit, os.Stderr
	t.Cleanup(func() { os.Args, exit, os.Stderr = oldArgs, oldExit, oldStderr })
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	code := -1
	exit = func(c int) { code = c }
	os.Args = []string{"cfhostname"}

	main()
	w.Close()
	out, _ := io.ReadAll(r)

	if code != 1 {
		t.Fatalf("exit code %d, want 1", code)
	}
	if want := "cfhostname: usage: cfhostname check|create|wait <hostname>\n"; string(out) != want {
		t.Fatalf("stderr %q, want %q", out, want)
	}
}
