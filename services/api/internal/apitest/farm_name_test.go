package apitest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// TestTheFrontDoorKnowsTheFarmsName: a farm's own address greets people with
// the farm's display name ("San José"), not its DNS label ("san-jose"). The
// name comes from a public endpoint that answers for the request's host, or
// for `?slug=` where the host names no farm, and for nothing else.
func TestTheFrontDoorKnowsTheFarmsName(t *testing.T) {
	h := requireDB(t)
	slug := "san-jose-" + strings.ReplaceAll(uuid.NewString()[:6], "-", "")
	signupWithSlug(t, h.server, "San José", slug)

	byHost := func(host string) response {
		req := httptest.NewRequest(http.MethodGet, "/v1/farm-name", nil)
		req.Host = host
		req.RemoteAddr = "10.0.0.9:12345"
		rec := httptest.NewRecorder()
		h.server.ServeHTTP(rec, req)
		out := response{Status: rec.Code, Raw: rec.Body.String()}
		_ = json.Unmarshal(rec.Body.Bytes(), &out.Body)
		return out
	}

	t.Run("by the farm's own host", func(t *testing.T) {
		res := byHost(slug + ".bascula.engp.io")
		if res.Status != http.StatusOK || res.Body["name"] != "San José" || res.Body["slug"] != slug {
			t.Fatalf("farm name by host: %d %s", res.Status, res.Raw)
		}
	})

	t.Run("by slug where the host names no farm", func(t *testing.T) {
		res := h.do(t, http.MethodGet, "/v1/farm-name?slug="+strings.ToUpper(slug), "", nil)
		if res.Status != http.StatusOK || res.Body["name"] != "San José" {
			t.Fatalf("farm name by slug: %d %s", res.Status, res.Raw)
		}
		if len(res.Body) != 2 {
			t.Fatalf("the public answer carries more than the slug and the name: %s", res.Raw)
		}
	})

	t.Run("nothing for an address no farm has", func(t *testing.T) {
		for _, path := range []string{
			"/v1/farm-name?slug=nadie-" + uuid.NewString()[:6],
			"/v1/farm-name?slug=NO%20VALE",
			"/v1/farm-name",
		} {
			res := h.do(t, http.MethodGet, path, "", nil)
			if res.Status != http.StatusNotFound {
				t.Fatalf("%s: %d %s, want 404", path, res.Status, res.Raw)
			}
		}
		if res := byHost("nadie-" + uuid.NewString()[:6] + ".bascula.engp.io"); res.Status != http.StatusNotFound {
			t.Fatalf("unknown farm host: %d %s", res.Status, res.Raw)
		}
	})
}
