// Package cfsaas talks to Cloudflare for SaaS: one custom hostname, with its
// own edge certificate, per farm address ({slug}.bascula.engp.io).
//
// Why it exists: Universal SSL on the free plan covers engp.io and *.engp.io,
// one level deep. A farm address is two levels deep, so without a certificate
// of its own the browser gets a TLS handshake failure at Cloudflare's edge.
// Cloudflare for SaaS issues one DV certificate per custom hostname (100 free,
// then $0.10 each) and renews it on its own. Routing is unchanged: a proxied
// wildcard CNAME *.bascula.engp.io points at the Cloudflare tunnel, and the
// SaaS fallback origin is bascula.engp.io, which points at the same tunnel.
//
// Only the calls the provisioning needs are here: find, create, get, and a
// PATCH that asks Cloudflare to try validation again. Everything is keyed by
// the zone id; the token needs "SSL and Certificates: Edit" on that zone.
package cfsaas

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultBaseURL is the Cloudflare API v4 root.
const DefaultBaseURL = "https://api.cloudflare.com/client/v4"

// Client is a minimal Cloudflare for SaaS client. The zero value is not
// usable: Token and ZoneID are required.
type Client struct {
	Token   string
	ZoneID  string
	BaseURL string
	// Method is the certificate validation method: "http" (default) or "txt".
	// HTTP works once the hostname is proxied through Cloudflare, which the
	// wildcard record already does for every farm address.
	Method string
	HTTP   *http.Client
}

// Enabled reports whether the client has what it needs to make calls.
func (c *Client) Enabled() bool {
	return c != nil && strings.TrimSpace(c.Token) != "" && strings.TrimSpace(c.ZoneID) != ""
}

// Hostname is the part of a custom hostname the provisioning looks at.
type Hostname struct {
	ID       string `json:"id"`
	Hostname string `json:"hostname"`
	// Status is the hostname activation: pending, active, blocked, moved…
	Status string `json:"status"`
	SSL    struct {
		Status            string             `json:"status"`
		Method            string             `json:"method"`
		ValidationRecords []ValidationRecord `json:"validation_records"`
		ValidationErrors  []struct {
			Message string `json:"message"`
		} `json:"validation_errors"`
	} `json:"ssl"`
	OwnershipVerification *struct {
		Name  string `json:"name"`
		Type  string `json:"type"`
		Value string `json:"value"`
	} `json:"ownership_verification"`
	VerificationErrors []string `json:"verification_errors"`
}

// ValidationRecord is what the certificate authority checks.
type ValidationRecord struct {
	TXTName  string `json:"txt_name"`
	TXTValue string `json:"txt_value"`
	HTTPURL  string `json:"http_url"`
	HTTPBody string `json:"http_body"`
	Status   string `json:"status"`
}

// Active is true when Cloudflare proxies the hostname AND serves its
// certificate. Both are needed before a browser can open the address.
func (h *Hostname) Active() bool {
	return h != nil && h.Status == "active" && h.SSL.Status == "active"
}

// Failed is true for states that will not fix themselves by waiting.
func (h *Hostname) Failed() bool {
	if h == nil {
		return false
	}
	switch h.Status {
	case "blocked", "moved", "deleted", "pending_blocked", "test_blocked", "test_failed":
		return true
	}
	switch h.SSL.Status {
	case "validation_timed_out", "issuance_timed_out", "deployment_timed_out", "initializing_timed_out", "expired", "deleted":
		return true
	}
	return false
}

// Summary is one line for logs and the CLI.
func (h *Hostname) Summary() string {
	if h == nil {
		return "(none)"
	}
	s := fmt.Sprintf("%s: hostname=%s ssl=%s", h.Hostname, h.Status, h.SSL.Status)
	var errs []string
	errs = append(errs, h.VerificationErrors...)
	for _, e := range h.SSL.ValidationErrors {
		errs = append(errs, e.Message)
	}
	if len(errs) > 0 {
		s += " errors=" + strings.Join(errs, "; ")
	}
	return s
}

// APIError is a non-successful Cloudflare answer.
type APIError struct {
	Status int
	Errors []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
}

func (e *APIError) Error() string {
	var parts []string
	for _, x := range e.Errors {
		parts = append(parts, fmt.Sprintf("%d %s", x.Code, x.Message))
	}
	if len(parts) == 0 {
		return fmt.Sprintf("cloudflare: status %d", e.Status)
	}
	return fmt.Sprintf("cloudflare: status %d: %s", e.Status, strings.Join(parts, "; "))
}

// ErrDisabled is returned when the client has no token or zone.
var ErrDisabled = errors.New("cfsaas: no token or zone id")

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+"/zones/"+url.PathEscape(c.ZoneID)+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.Token))
	req.Header.Set("Content-Type", "application/json")
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	var env struct {
		Success bool            `json:"success"`
		Errors  json.RawMessage `json:"errors"`
		Result  json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("cloudflare: status %d: %w", res.StatusCode, err)
	}
	if res.StatusCode >= 300 || !env.Success {
		apiErr := &APIError{Status: res.StatusCode}
		_ = json.Unmarshal(env.Errors, &apiErr.Errors)
		return apiErr
	}
	if out != nil && len(env.Result) > 0 {
		return json.Unmarshal(env.Result, out)
	}
	return nil
}

// Find returns the custom hostname with exactly this name, or nil.
func (c *Client) Find(ctx context.Context, hostname string) (*Hostname, error) {
	var list []Hostname
	if err := c.do(ctx, http.MethodGet, "/custom_hostnames?hostname="+url.QueryEscape(hostname), nil, &list); err != nil {
		return nil, err
	}
	for i := range list {
		if strings.EqualFold(list[i].Hostname, hostname) {
			return &list[i], nil
		}
	}
	return nil, nil
}

// Get reads one custom hostname by id.
func (c *Client) Get(ctx context.Context, id string) (*Hostname, error) {
	var h Hostname
	if err := c.do(ctx, http.MethodGet, "/custom_hostnames/"+url.PathEscape(id), nil, &h); err != nil {
		return nil, err
	}
	return &h, nil
}

func (c *Client) sslBody() map[string]any {
	method := strings.TrimSpace(c.Method)
	if method == "" {
		method = "http"
	}
	return map[string]any{"method": method, "type": "dv"}
}

// Create adds the custom hostname and asks for its certificate.
func (c *Client) Create(ctx context.Context, hostname string) (*Hostname, error) {
	var h Hostname
	err := c.do(ctx, http.MethodPost, "/custom_hostnames",
		map[string]any{"hostname": hostname, "ssl": c.sslBody()}, &h)
	if err != nil {
		return nil, err
	}
	return &h, nil
}

// Revalidate asks Cloudflare to try the validation again, which the API docs
// require for HTTP validation when the hostname started pointing at the zone
// after the custom hostname was created.
func (c *Client) Revalidate(ctx context.Context, id string) (*Hostname, error) {
	var h Hostname
	if err := c.do(ctx, http.MethodPatch, "/custom_hostnames/"+url.PathEscape(id),
		map[string]any{"ssl": c.sslBody()}, &h); err != nil {
		return nil, err
	}
	return &h, nil
}

// Ensure returns the custom hostname, creating it when it does not exist.
// Safe to call again and again: a second call finds the first one's hostname.
func (c *Client) Ensure(ctx context.Context, hostname string) (*Hostname, error) {
	h, err := c.Find(ctx, hostname)
	if err != nil || h != nil {
		return h, err
	}
	return c.Create(ctx, hostname)
}
