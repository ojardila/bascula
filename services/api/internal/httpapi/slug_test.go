package httpapi

import (
	"net/http"
	"testing"
)

func TestSlugifyFarmName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Finca El Roble", "finca-el-roble"},
		{"San Jose", "san-jose"},
		{"  San   José  ", "san-jos"},
		{"ABC", "abc"},
		{"!!!", ""},
		{"a", "a"},
		{"well-known", "well-known"},
		{"--Foo--Bar--", "foo-bar"},
	}
	for _, c := range cases {
		if got := slugifyFarmName(c.in); got != c.want {
			t.Errorf("slugifyFarmName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNormalizeFarmSlug(t *testing.T) {
	ok, err := normalizeFarmSlug("San-Jose")
	if err != nil || ok != "san-jose" {
		t.Fatalf("got %q %v, want san-jose", ok, err)
	}
	if _, err := normalizeFarmSlug("admin"); err == nil {
		t.Fatal("reserved slug was accepted")
	}
	if _, err := normalizeFarmSlug("a"); err == nil {
		t.Fatal("one-character slug was accepted")
	}
	if _, err := normalizeFarmSlug("San_Jose"); err == nil {
		t.Fatal("underscore slug was accepted")
	}
	if _, err := normalizeFarmSlug("-leading"); err == nil {
		t.Fatal("leading hyphen was accepted")
	}
}

func TestGenerateFarmSlug(t *testing.T) {
	id := "0192f3a0-0000-7000-8000-000000000001"
	if got := generateFarmSlug("Finca El Roble", id); got != "finca-el-roble" {
		t.Fatalf("got %q", got)
	}
	if got := generateFarmSlug("Admin", id); got != "admin-0192f3a0" {
		t.Fatalf("reserved name: got %q, want admin-0192f3a0", got)
	}
	if got := generateFarmSlug("!!!", id); got != "0192f3a0" {
		t.Fatalf("empty: got %q, want 0192f3a0", got)
	}
}

func TestFarmSlugFromHost(t *testing.T) {
	cases := []struct {
		host, fwd, want string
	}{
		{"sanjose.bascula.engp.io", "", "sanjose"},
		{"SanJose.Bascula.engp.io:443", "", "sanjose"},
		{"bascula.engp.io", "", ""},
		{"www.bascula.engp.io", "", "www"},
		{"sanjose.int.dev.engp.io", "", "sanjose"},
		{"bascula.int.dev.engp.io", "", ""},
		{"localhost", "", ""},
		{"localhost:8080", "", ""},
		{"127.0.0.1:8099", "", ""},
		{"example.com", "", ""},
		{"foo.bar.bascula.engp.io", "", ""},
		{"sanjose.bascula.int.dev.engp.io", "", ""},
		{"example.com", "el-roble.bascula.engp.io", "el-roble"},
		{"example.com", "el-roble.bascula.engp.io, other.example", "el-roble"},
		{"sanjose.bascula.engp.io", "bascula.int.dev.engp.io", ""},
	}
	for _, c := range cases {
		req, _ := http.NewRequest(http.MethodPost, "http://"+c.host+"/v1/auth/login", nil)
		if c.fwd != "" {
			req.Header.Set("X-Forwarded-Host", c.fwd)
		}
		if got := farmSlugFromHost(req); got != c.want {
			t.Errorf("host %q fwd %q → %q, want %q", c.host, c.fwd, got, c.want)
		}
	}
}
