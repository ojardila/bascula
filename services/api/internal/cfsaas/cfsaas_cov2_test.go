// SPDX-License-Identifier: MIT

package cfsaas

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type c2otRoundTrip func(*http.Request) (*http.Response, error)

func (f c2otRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func c2otReply(body io.Reader) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(body)}
}

// With no BaseURL the client talks to the real Cloudflare API root; nothing
// leaves the process here because the transport answers in its place.
func TestEmptyBaseURLMeansCloudflare(t *testing.T) {
	var got string
	c := &Client{Token: " tok ", ZoneID: "zone/1", HTTP: &http.Client{Transport: c2otRoundTrip(func(r *http.Request) (*http.Response, error) {
		got = r.URL.String()
		if a := r.Header.Get("Authorization"); a != "Bearer tok" {
			t.Errorf("Authorization = %q", a)
		}
		return c2otReply(strings.NewReader(`{"success":true,"result":{"id":"h-1","hostname":"a.example.com"}}`)), nil
	})}}
	h, err := c.Get(context.Background(), "h-1")
	if err != nil {
		t.Fatal(err)
	}
	if want := DefaultBaseURL + "/zones/zone%2F1/custom_hostnames/h-1"; got != want {
		t.Fatalf("URL = %s, want %s", got, want)
	}
	if h.ID != "h-1" {
		t.Fatalf("hostname = %+v", h)
	}
}

// A body that cannot be encoded never reaches the network.
func TestUnencodableBodyIsRefusedBeforeSending(t *testing.T) {
	called := false
	c := &Client{Token: "tok", ZoneID: "z", HTTP: &http.Client{Transport: c2otRoundTrip(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, errors.New("must not be called")
	})}}
	err := c.do(context.Background(), http.MethodPost, "/custom_hostnames", map[string]any{"bad": make(chan int)}, nil)
	if err == nil || called {
		t.Fatalf("do = %v, called = %v; want an encoding error and no request", err, called)
	}
}

// A base URL that does not parse is an error, not a panic or a request.
func TestMalformedBaseURLIsAnError(t *testing.T) {
	c := &Client{Token: "tok", ZoneID: "z", BaseURL: "http://[::1"}
	if _, err := c.Get(context.Background(), "id"); err == nil {
		t.Fatal("a malformed base URL must fail")
	}
}

// A reply cut off in the middle of the body is reported, not decoded as empty.
func TestBodyReadFailureIsReported(t *testing.T) {
	boom := errors.New("connection reset mid-body")
	c := &Client{Token: "tok", ZoneID: "z", BaseURL: "http://cf.invalid", HTTP: &http.Client{Transport: c2otRoundTrip(func(*http.Request) (*http.Response, error) {
		return c2otReply(io.MultiReader(strings.NewReader(`{"success":`), c2otFailingReader{boom})), nil
	})}}
	if _, err := c.Find(context.Background(), "a.example.com"); !errors.Is(err, boom) {
		t.Fatalf("Find = %v, want %v", err, boom)
	}
}

type c2otFailingReader struct{ err error }

func (r c2otFailingReader) Read([]byte) (int, error) { return 0, r.err }

// A request that never gets an answer returns the transport's error.
func TestTransportFailureIsReported(t *testing.T) {
	refused := errors.New("dial tcp: connection refused")
	c := &Client{Token: "tok", ZoneID: "z", BaseURL: "http://cf.invalid", HTTP: &http.Client{Transport: c2otRoundTrip(func(*http.Request) (*http.Response, error) {
		return nil, refused
	})}}
	if _, err := c.Ensure(context.Background(), "a.example.com"); !errors.Is(err, refused) {
		t.Fatalf("Ensure = %v, want %v", err, refused)
	}
}
