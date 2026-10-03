package cfsaas

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func serve(t *testing.T, status int, body string) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return &Client{Token: "tok", ZoneID: "zone-1", BaseURL: srv.URL + "/", HTTP: srv.Client()}
}

func TestRepliesCloudflareDidNotMeanAsSuccess(t *testing.T) {
	ctx := context.Background()

	t.Run("a body that is not JSON names the status", func(t *testing.T) {
		_, err := serve(t, http.StatusBadGateway, "<html>bad gateway</html>").Get(ctx, "id-1")
		if err == nil || !strings.Contains(err.Error(), "status 502") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("a 200 that says success:false is an error with its messages", func(t *testing.T) {
		_, err := serve(t, http.StatusOK,
			`{"success":false,"errors":[{"code":1406,"message":"duplicate hostname"}],"result":null}`).
			Create(ctx, "finca.example.com")
		var apiErr *APIError
		if !errors.As(err, &apiErr) || apiErr.Status != http.StatusOK {
			t.Fatalf("got %v, want an *APIError", err)
		}
		if got := apiErr.Error(); got != "cloudflare: status 200: 1406 duplicate hostname" {
			t.Errorf("message %q", got)
		}
	})

	t.Run("an error with no messages still reads", func(t *testing.T) {
		_, err := serve(t, http.StatusForbidden, `{"success":false}`).Revalidate(ctx, "id-1")
		if err == nil || err.Error() != "cloudflare: status 403" {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("a search that finds other names finds nothing", func(t *testing.T) {
		h, err := serve(t, http.StatusOK,
			`{"success":true,"result":[{"id":"1","hostname":"otra.example.com"}]}`).
			Find(ctx, "finca.example.com")
		if err != nil || h != nil {
			t.Fatalf("got %v, %v", h, err)
		}
	})

	t.Run("a success with no result leaves the target empty", func(t *testing.T) {
		h, err := serve(t, http.StatusOK, `{"success":true}`).Get(ctx, "id-1")
		if err != nil || h == nil || h.ID != "" {
			t.Fatalf("got %+v, %v", h, err)
		}
	})
}

func TestSummaryAndFailedOnEdges(t *testing.T) {
	var none *Hostname
	if none.Summary() != "(none)" || none.Failed() || none.Active() {
		t.Error("a missing hostname is none of active, failed or describable")
	}
	h := &Hostname{Hostname: "finca.example.com", Status: "pending"}
	h.SSL.Status = "pending_validation"
	h.VerificationErrors = []string{"CNAME missing"}
	h.SSL.ValidationErrors = append(h.SSL.ValidationErrors, struct {
		Message string `json:"message"`
	}{Message: "TXT not found"})
	got := h.Summary()
	if !strings.Contains(got, "errors=CNAME missing; TXT not found") {
		t.Errorf("summary %q should carry both kinds of error", got)
	}
	if h.Failed() {
		t.Error("pending is something waiting fixes")
	}
}
