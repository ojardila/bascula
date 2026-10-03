// SPDX-License-Identifier: MIT

package kube

import (
	"context"
	"encoding/pem"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// c3gPod stands in for a pod's ServiceAccount: the token and CA files InCluster
// reads, and the service env pointing at host:port.
func c3gPod(t *testing.T, host, port string, ca []byte, withCA bool) {
	t.Helper()
	dir := t.TempDir()
	oldToken, oldCA := tokenFile, caFile
	t.Cleanup(func() { tokenFile, caFile = oldToken, oldCA })
	tokenFile, caFile = filepath.Join(dir, "token"), filepath.Join(dir, "ca.crt")
	if err := os.WriteFile(tokenFile, []byte("sa-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if withCA {
		if err := os.WriteFile(caFile, ca, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("KUBERNETES_SERVICE_HOST", host)
	t.Setenv("KUBERNETES_SERVICE_PORT", port)
}

// Inside a pod, InCluster trusts exactly the cluster CA and sends the
// ServiceAccount token read from its file.
func TestInClusterTalksToTheAPIServerWithTheServiceAccount(t *testing.T) {
	var auth string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"metadata":{"name":"ok"}}`))
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	host, port, _ := net.SplitHostPort(u.Host)
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	c3gPod(t, host, port, ca, true)

	c := InCluster()
	if c == nil {
		t.Fatal("no client inside a pod")
	}
	if c.BaseURL != "https://"+net.JoinHostPort(host, port) || c.TokenFile != tokenFile {
		t.Fatalf("client %+v", c)
	}
	var out struct {
		Metadata struct{ Name string } `json:"metadata"`
	}
	if err := c.Get(context.Background(), "/api/v1/namespaces/ok", &out); err != nil || out.Metadata.Name != "ok" {
		t.Fatalf("Get: %+v %v", out, err)
	}
	if auth != "Bearer sa-token" {
		t.Fatalf("Authorization %q, want the ServiceAccount token", auth)
	}
}

// Without a readable CA, or with one that holds no certificate, there is no
// client: talking to the API server unverified is not an option.
func TestInClusterNeedsAUsableCA(t *testing.T) {
	cases := []struct {
		name   string
		ca     []byte
		withCA bool
	}{
		{"missing", nil, false},
		{"not pem", []byte("not a certificate"), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c3gPod(t, "10.0.0.1", "443", c.ca, c.withCA)
			if got := InCluster(); got != nil {
				t.Fatalf("got a client: %+v", got)
			}
		})
	}
}
