package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// cloudflare is a one-zone stand-in for the custom hostnames API. Hosts named
// in active are already live; anything created starts pending.
type cloudflare struct {
	active  map[string]bool
	created []string
}

func (c *cloudflare) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if strings.Contains(r.URL.RawQuery, "hostname=broken.example.com") {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":10000,"message":"auth"}],"result":null}`))
		return
	}
	reply := func(result any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "errors": []any{}, "result": result})
	}
	switch r.Method {
	case http.MethodGet:
		host := r.URL.Query().Get("hostname")
		if !c.active[host] {
			reply([]any{})
			return
		}
		reply([]any{hostname(host, "active", "active")})
	case http.MethodPost:
		var body struct {
			Hostname string `json:"hostname"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		c.created = append(c.created, body.Hostname)
		h := hostname(body.Hostname, "pending", "pending_validation")
		h["ownership_verification"] = map[string]any{"name": "_cf." + body.Hostname, "type": "txt", "value": "tok"}
		h["ssl"].(map[string]any)["validation_records"] = []any{
			map[string]any{"txt_name": "_acme." + body.Hostname, "txt_value": "v1", "status": "pending"},
			map[string]any{"http_url": "http://" + body.Hostname + "/.well-known/x", "http_body": "b", "status": "pending"},
		}
		if body.Hostname == "dead.example.com" {
			h["status"] = "blocked"
		}
		reply(h)
	default:
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}
}

func hostname(name, status, ssl string) map[string]any {
	return map[string]any{
		"id": "id-" + name, "hostname": name, "status": status,
		"ssl": map[string]any{"status": ssl},
	}
}

func fakeCloudflare(t *testing.T, active ...string) *cloudflare {
	t.Helper()
	cf := &cloudflare{active: map[string]bool{}}
	for _, a := range active {
		cf.active[a] = true
	}
	srv := httptest.NewServer(cf)
	t.Cleanup(srv.Close)
	t.Setenv("CF_SAAS_TOKEN", "token")
	t.Setenv("CF_ZONE_ID", "zone-1")
	t.Setenv("CF_API_URL", srv.URL)
	t.Setenv("CF_SAAS_DCV_METHOD", "")
	return cf
}

func TestRunRefusesBadUsage(t *testing.T) {
	if err := run(nil); err == nil || !strings.Contains(err.Error(), "usage") {
		t.Fatalf("no args: %v", err)
	}
	t.Setenv("CF_SAAS_TOKEN", "")
	t.Setenv("CF_ZONE_ID", "")
	if err := run([]string{"check", "a.example.com"}); err == nil || !strings.Contains(err.Error(), "CF_SAAS_TOKEN") {
		t.Fatalf("no token: %v", err)
	}
	fakeCloudflare(t)
	if err := run([]string{"delete", "a.example.com"}); err == nil || !strings.Contains(err.Error(), "unknown command") {
		t.Fatalf("unknown command: %v", err)
	}
}

func TestRunCheck(t *testing.T) {
	fakeCloudflare(t, "live.example.com")
	for _, host := range []string{"live.example.com", " NEW.example.com "} {
		if err := run([]string{"check", host}); err != nil {
			t.Fatalf("check %q: %v", host, err)
		}
	}
	if err := run([]string{"check", "broken.example.com"}); err == nil {
		t.Fatal("expected the API error to come back")
	}
}

func TestRunCreate(t *testing.T) {
	cf := fakeCloudflare(t, "live.example.com")
	if err := run([]string{"create", "live.example.com"}); err != nil {
		t.Fatalf("create existing: %v", err)
	}
	if err := run([]string{"create", "new.example.com"}); err != nil {
		t.Fatalf("create new: %v", err)
	}
	if len(cf.created) != 1 || cf.created[0] != "new.example.com" {
		t.Fatalf("created = %v", cf.created)
	}
	if err := run([]string{"create", "broken.example.com"}); err == nil {
		t.Fatal("expected the API error to come back")
	}
}

// wait returns at once for a hostname that is already active or that failed
// for good; neither case sleeps.
func TestRunWait(t *testing.T) {
	fakeCloudflare(t, "live.example.com")
	if err := run([]string{"wait", "live.example.com"}); err != nil {
		t.Fatalf("wait active: %v", err)
	}
	if err := run([]string{"wait", "dead.example.com"}); err == nil || !strings.Contains(err.Error(), "not active") {
		t.Fatalf("wait blocked: %v", err)
	}
	if err := run([]string{"wait", "broken.example.com"}); err == nil {
		t.Fatal("expected the API error to come back")
	}
}
