package cfsaas

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fake is a stand-in for the custom hostnames API of one zone.
type fake struct {
	mu      sync.Mutex
	hosts   map[string]*Hostname
	creates int
	patches int
	lastSSL map[string]any
	auth    string
}

func newFake() *fake { return &fake{hosts: map[string]*Hostname{}} }

func (f *fake) reply(w http.ResponseWriter, status int, result any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"success": status < 300, "errors": []any{}, "result": result})
}

func (f *fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.auth = r.Header.Get("Authorization")
	const prefix = "/zones/zone-1/custom_hostnames"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.NotFound(w, r)
		return
	}
	id := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, prefix), "/")
	switch {
	case r.Method == http.MethodGet && id == "":
		var out []Hostname
		for _, h := range f.hosts {
			if h.Hostname == r.URL.Query().Get("hostname") {
				out = append(out, *h)
			}
		}
		f.reply(w, 200, out)
	case r.Method == http.MethodPost && id == "":
		var body struct {
			Hostname string         `json:"hostname"`
			SSL      map[string]any `json:"ssl"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.creates++
		f.lastSSL = body.SSL
		h := &Hostname{ID: "id-" + body.Hostname, Hostname: body.Hostname, Status: "pending"}
		h.SSL.Status = "initializing"
		f.hosts[h.ID] = h
		f.reply(w, 201, h)
	case r.Method == http.MethodGet:
		h, ok := f.hosts[id]
		if !ok {
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":1436,"message":"not found"}],"result":null}`))
			return
		}
		f.reply(w, 200, h)
	case r.Method == http.MethodPatch:
		f.patches++
		f.reply(w, 200, f.hosts[id])
	default:
		http.Error(w, "unexpected", 500)
	}
}

func TestEnsureCreatesOnceAndSendsHTTPValidation(t *testing.T) {
	f := newFake()
	srv := httptest.NewServer(f)
	defer srv.Close()
	c := &Client{Token: "tok", ZoneID: "zone-1", BaseURL: srv.URL}
	ctx := context.Background()

	h, err := c.Ensure(ctx, "finca.bascula.engp.io")
	if err != nil {
		t.Fatal(err)
	}
	if h.Hostname != "finca.bascula.engp.io" || h.Active() {
		t.Fatalf("created = %+v", h)
	}
	if f.lastSSL["method"] != "http" || f.lastSSL["type"] != "dv" {
		t.Fatalf("ssl body = %v", f.lastSSL)
	}
	if f.auth != "Bearer tok" {
		t.Fatalf("auth header = %q", f.auth)
	}
	// A second call finds it instead of creating another.
	again, err := c.Ensure(ctx, "finca.bascula.engp.io")
	if err != nil || again.ID != h.ID || f.creates != 1 {
		t.Fatalf("second ensure: %+v %v creates=%d", again, err, f.creates)
	}

	f.mu.Lock()
	f.hosts[h.ID].Status = "active"
	f.hosts[h.ID].SSL.Status = "active"
	f.mu.Unlock()
	got, err := c.Get(ctx, h.ID)
	if err != nil || !got.Active() {
		t.Fatalf("get: %+v %v", got, err)
	}
	if _, err := c.Revalidate(ctx, h.ID); err != nil || f.patches != 1 {
		t.Fatalf("revalidate: %v patches=%d", err, f.patches)
	}
}

func TestErrorsAndDisabled(t *testing.T) {
	f := newFake()
	srv := httptest.NewServer(f)
	defer srv.Close()
	c := &Client{Token: "tok", ZoneID: "zone-1", BaseURL: srv.URL}
	_, err := c.Get(context.Background(), "missing")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 404 || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err = %v", err)
	}
	var off *Client
	if off.Enabled() || (&Client{Token: "x"}).Enabled() {
		t.Fatal("a client without token and zone must be disabled")
	}
	if _, err := (&Client{}).Find(context.Background(), "x"); !errors.Is(err, ErrDisabled) {
		t.Fatalf("disabled find: %v", err)
	}
}

func TestFailedAndSummary(t *testing.T) {
	h := &Hostname{Hostname: "a.b.c", Status: "pending"}
	h.SSL.Status = "validation_timed_out"
	h.VerificationErrors = []string{"custom hostname does not CNAME to this zone"}
	if !h.Failed() || h.Active() {
		t.Fatal("timed out validation is a failure")
	}
	if s := h.Summary(); !strings.Contains(s, "ssl=validation_timed_out") || !strings.Contains(s, "CNAME") {
		t.Fatalf("summary = %q", s)
	}
}
