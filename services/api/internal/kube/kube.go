// Package kube is a tiny, read-only Kubernetes API client for the platform
// API: just enough to GET a handful of objects and read their status while a
// new farm stack comes up. It uses the pod's own ServiceAccount (in-cluster
// token and CA) and never writes anything. The permissions it needs are in
// manifests/cluster/bascula-provision-reader.yaml and docs/provision-progress.md.
//
// Deliberately not client-go: a dozen GETs do not justify the dependency.
package kube

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	saDir     = "/var/run/secrets/kubernetes.io/serviceaccount"
	tokenFile = saDir + "/token"
	caFile    = saDir + "/ca.crt"
)

// ErrNotFound is a 404: the object does not exist (yet).
var ErrNotFound = errors.New("kube: not found")

// ErrForbidden is a 401/403: the ServiceAccount may not read it.
var ErrForbidden = errors.New("kube: forbidden")

// Client reads from the Kubernetes API.
type Client struct {
	// BaseURL is https://host:port of the API server.
	BaseURL string
	// Token is a fixed bearer token (tests). Empty means read TokenFile on
	// every call, since projected tokens rotate.
	Token     string
	TokenFile string
	HTTP      *http.Client
}

// InCluster returns a client for the API server this pod runs under, or nil
// when the process is not in a cluster or has no ServiceAccount token.
func InCluster() *Client {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil
	}
	if _, err := os.Stat(tokenFile); err != nil {
		return nil
	}
	pem, err := os.ReadFile(caFile)
	if err != nil {
		return nil
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil
	}
	tr := &http.Transport{
		TLSClientConfig:     &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout: 5 * time.Second,
		MaxIdleConnsPerHost: 4,
	}
	return &Client{
		BaseURL:   "https://" + net.JoinHostPort(host, port),
		TokenFile: tokenFile,
		HTTP:      &http.Client{Transport: tr, Timeout: 5 * time.Second},
	}
}

func (c *Client) token() string {
	if c.Token != "" {
		return c.Token
	}
	if c.TokenFile == "" {
		return ""
	}
	b, err := os.ReadFile(c.TokenFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// Get reads one object (or list) at path, e.g. /api/v1/namespaces/x, into out.
func (c *Client) Get(ctx context.Context, path string, out any) error {
	if c == nil || c.BaseURL == "" {
		return errors.New("kube: no client")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.BaseURL, "/")+path, nil)
	if err != nil {
		return err
	}
	if t := c.token(); t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	}
	req.Header.Set("Accept", "application/json")
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 5 * time.Second}
	}
	res, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusNotFound:
		return ErrNotFound
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return ErrForbidden
	case res.StatusCode >= 300:
		return fmt.Errorf("kube: GET %s: status %d", path, res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(out)
}
