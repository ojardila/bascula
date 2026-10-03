// SPDX-License-Identifier: MIT

package kube

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInClusterIsNilOutsideACluster(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	t.Setenv("KUBERNETES_SERVICE_PORT", "")
	if c := InCluster(); c != nil {
		t.Fatalf("got a client without the service env: %+v", c)
	}
	// The env alone is not enough: no ServiceAccount token on this machine.
	if _, err := os.Stat(tokenFile); err == nil {
		t.Skip("running inside a pod")
	}
	t.Setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
	t.Setenv("KUBERNETES_SERVICE_PORT", "443")
	if c := InCluster(); c != nil {
		t.Fatalf("got a client without a token: %+v", c)
	}
}

func apiServer(t *testing.T) (*httptest.Server, *string) {
	t.Helper()
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/api/v1/namespaces/ok":
			_, _ = w.Write([]byte(`{"metadata":{"name":"ok"}}`))
		case "/api/v1/namespaces/forbidden":
			w.WriteHeader(http.StatusForbidden)
		case "/api/v1/namespaces/unauthorized":
			w.WriteHeader(http.StatusUnauthorized)
		case "/api/v1/namespaces/broken":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &auth
}

func TestGetMapsStatuses(t *testing.T) {
	srv, _ := apiServer(t)
	c := &Client{BaseURL: srv.URL + "/", Token: "fixed"}
	ctx := context.Background()
	var out struct {
		Metadata struct{ Name string } `json:"metadata"`
	}
	if err := c.Get(ctx, "/api/v1/namespaces/ok", &out); err != nil || out.Metadata.Name != "ok" {
		t.Fatalf("ok: %+v %v", out, err)
	}
	for path, want := range map[string]error{
		"/api/v1/namespaces/missing":      ErrNotFound,
		"/api/v1/namespaces/forbidden":    ErrForbidden,
		"/api/v1/namespaces/unauthorized": ErrForbidden,
	} {
		if err := c.Get(ctx, path, &out); !errors.Is(err, want) {
			t.Errorf("%s: got %v want %v", path, err, want)
		}
	}
	if err := c.Get(ctx, "/api/v1/namespaces/broken", &out); err == nil || !strings.Contains(err.Error(), "500") {
		t.Errorf("broken: %v", err)
	}
}

func TestGetReadsTheTokenFileEachTime(t *testing.T) {
	srv, auth := apiServer(t)
	file := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(file, []byte("primero\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c := &Client{BaseURL: srv.URL, TokenFile: file}
	var out map[string]any
	if err := c.Get(context.Background(), "/api/v1/namespaces/ok", &out); err != nil || *auth != "Bearer primero" {
		t.Fatalf("first: %q %v", *auth, err)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(context.Background(), "/api/v1/namespaces/ok", &out); err != nil || *auth != "" {
		t.Fatalf("a missing token file sends no header: %q %v", *auth, err)
	}
	if err := (&Client{BaseURL: srv.URL}).Get(context.Background(), "/api/v1/namespaces/ok", &out); err != nil || *auth != "" {
		t.Fatalf("no token at all: %q %v", *auth, err)
	}
}

func TestGetWithoutAClient(t *testing.T) {
	var c *Client
	if err := c.Get(context.Background(), "/x", nil); err == nil {
		t.Fatal("a nil client answered")
	}
	if err := (&Client{}).Get(context.Background(), "/x", nil); err == nil {
		t.Fatal("a client without a base URL answered")
	}
	if err := (&Client{BaseURL: "http://[::1"}).Get(context.Background(), "/x", nil); err == nil {
		t.Fatal("a malformed base URL answered")
	}
	if err := (&Client{BaseURL: "http://127.0.0.1:1"}).Get(context.Background(), "/x", nil); err == nil {
		t.Fatal("a closed port answered")
	}
}
