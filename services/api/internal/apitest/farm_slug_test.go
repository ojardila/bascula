package apitest

import (
	"net/http"
	"testing"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

func TestFarmSlug(t *testing.T) {
	h := requireDB(t)
	a := h.signupFarm(t, "Finca slug origen", 80000)
	token := h.superadminToken(t, a.FarmID)

	t.Run("an explicit slug is stored as given, lowercased", func(t *testing.T) {
		res := h.mustDo(t, http.MethodPost, "/v1/admin/farms", token, map[string]any{
			"name": "Finca La Palma", "slug": "La-Palma", "priceCents": 90000,
			"owner": map[string]any{"email": "palma@example.com"},
		}, http.StatusCreated)
		if res.Body["slug"] != "la-palma" {
			t.Fatalf("got %v, want la-palma: %s", res.Body["slug"], res.Raw)
		}
		listed := h.mustDo(t, http.MethodGet, "/v1/admin/farms", token, nil, http.StatusOK)
		var found bool
		for _, raw := range listed.Body["items"].([]any) {
			row := raw.(map[string]any)
			if row["id"] == res.Body["id"] {
				found = row["slug"] == "la-palma"
			}
		}
		if !found {
			t.Fatalf("list missing slug: %s", listed.Raw)
		}
	})

	t.Run("a reserved slug is a 400", func(t *testing.T) {
		for _, slug := range []string{"admin", "www", "bascula", "mcp", "oauth"} {
			res := h.do(t, http.MethodPost, "/v1/admin/farms", token, map[string]any{
				"name": "No", "slug": slug, "priceCents": 1,
				"owner": map[string]any{"email": "reserved-" + slug + "@example.com"},
			})
			if res.Status != http.StatusBadRequest {
				t.Fatalf("slug %q: got %d %s, want 400", slug, res.Status, res.Raw)
			}
		}
	})

	t.Run("a duplicate slug is a 409", func(t *testing.T) {
		h.mustDo(t, http.MethodPost, "/v1/admin/farms", token, map[string]any{
			"name": "Primera", "slug": "el-cedro", "priceCents": 80000,
			"owner": map[string]any{"email": "cedro1@example.com"},
		}, http.StatusCreated)
		res := h.do(t, http.MethodPost, "/v1/admin/farms", token, map[string]any{
			"name": "Segunda", "slug": "el-cedro", "priceCents": 80000,
			"owner": map[string]any{"email": "cedro2@example.com"},
		})
		if res.Status != http.StatusConflict || res.code() != string(domain.CodeConflict) {
			t.Fatalf("duplicate slug: got %d %s, want 409 CONFLICT", res.Status, res.Raw)
		}
	})

	t.Run("PUT /v1/farm does not take a slug", func(t *testing.T) {
		res := h.do(t, http.MethodPut, "/v1/farm", a.OwnerToken, map[string]any{
			"slug": "renamed",
		})
		if res.Status != http.StatusOK {
			t.Fatalf("round-trip slug on PUT: got %d %s", res.Status, res.Raw)
		}
		got := h.mustDo(t, http.MethodGet, "/v1/farm", a.OwnerToken, nil, http.StatusOK)
		if got.Body["slug"] == "renamed" {
			t.Fatalf("slug was rewritten: %s", got.Raw)
		}
	})

	t.Run("signup and POST /v1/farms accept a slug", func(t *testing.T) {
		f := h.signupFarm(t, "Finca Nueva", 80000)
		got := h.mustDo(t, http.MethodGet, "/v1/farm", f.OwnerToken, nil, http.StatusOK)
		if got.Body["slug"] != "finca-nueva" {
			t.Fatalf("signup slug: %s", got.Raw)
		}
		second := h.mustDo(t, http.MethodPost, "/v1/farms", f.OwnerToken,
			map[string]any{"name": "Otra", "slug": "otra-finca", "priceCents": 70000},
			http.StatusCreated)
		if second.Body["slug"] != "otra-finca" {
			t.Fatalf("POST /v1/farms slug: %s", second.Raw)
		}
	})
}

func TestLoginHostPinsFarm(t *testing.T) {
	h := requireDB(t)
	first := h.signupFarm(t, "Finca Ancla", 80000)
	second := h.mustDo(t, http.MethodPost, "/v1/farms", first.OwnerToken, map[string]any{
		"name": "Finca Pin", "slug": "finca-pin", "priceCents": 70000,
	}, http.StatusCreated)
	pinID := mustString(t, second.Body, "farmId")
	anchor := h.mustDo(t, http.MethodGet, "/v1/farm", first.OwnerToken, nil, http.StatusOK)
	anchorSlug := mustString(t, anchor.Body, "slug")

	t.Run("several farms without a pin is a 400 that names the slugs", func(t *testing.T) {
		res := h.loginOwner(t, first, "", nil)
		if res.Status != http.StatusBadRequest {
			t.Fatalf("got %d %s, want 400", res.Status, res.Raw)
		}
		errObj, _ := res.Body["error"].(map[string]any)
		details, _ := errObj["details"].(map[string]any)
		farms, _ := details["farms"].([]any)
		if len(farms) < 2 {
			t.Fatalf("details.farms: %s", res.Raw)
		}
		var sawPin bool
		for _, raw := range farms {
			row := raw.(map[string]any)
			if row["slug"] == nil {
				t.Fatalf("farm choice missing slug: %s", res.Raw)
			}
			if row["slug"] == "finca-pin" {
				sawPin = true
			}
		}
		if !sawPin {
			t.Fatalf("finca-pin missing from the choice: %s", res.Raw)
		}
	})

	t.Run("Host {slug}.bascula.engp.io pins that farm", func(t *testing.T) {
		res := h.loginOwner(t, first, "finca-pin.bascula.engp.io", nil)
		if res.Status != http.StatusOK {
			t.Fatalf("got %d %s, want 200", res.Status, res.Raw)
		}
		if res.Body["farmId"] != pinID || res.Body["slug"] != "finca-pin" {
			t.Fatalf("pinned the wrong farm: %s", res.Raw)
		}
	})

	t.Run("Host {slug}.int.dev.engp.io pins too", func(t *testing.T) {
		res := h.loginOwner(t, first, anchorSlug+".int.dev.engp.io", nil)
		if res.Status != http.StatusOK || res.Body["farmId"] != first.FarmID {
			t.Fatalf("dev host: got %d %s", res.Status, res.Raw)
		}
	})

	t.Run("the apex hosts pin nothing", func(t *testing.T) {
		for _, host := range []string{"bascula.engp.io", "bascula.int.dev.engp.io", "localhost"} {
			res := h.loginOwner(t, first, host, nil)
			if res.Status != http.StatusBadRequest {
				t.Fatalf("%s pinned a farm: %d %s", host, res.Status, res.Raw)
			}
		}
	})

	t.Run("a Host pin that disagrees with farmId is a 400", func(t *testing.T) {
		res := h.loginOwner(t, first, "finca-pin.bascula.engp.io", map[string]any{
			"farmId": first.FarmID,
		})
		if res.Status != http.StatusBadRequest {
			t.Fatalf("disagreeing pin: got %d %s, want 400", res.Status, res.Raw)
		}
	})

	t.Run("a Host the account cannot see is ignored", func(t *testing.T) {
		stranger := h.signupFarm(t, "Finca Ajena Pin", 80000)
		strangerFarm := h.mustDo(t, http.MethodGet, "/v1/farm", stranger.OwnerToken, nil, http.StatusOK)
		slug := mustString(t, strangerFarm.Body, "slug")
		res := h.loginOwner(t, first, slug+".bascula.engp.io", nil)
		if res.Status != http.StatusBadRequest {
			t.Fatalf("invisible host leaked a pin: %d %s", res.Status, res.Raw)
		}
	})

	t.Run("the tenant stays the JWT, not the Host", func(t *testing.T) {
		pinned := h.loginOwner(t, first, "finca-pin.bascula.engp.io", nil)
		if pinned.Status != http.StatusOK {
			t.Fatalf("pin login: %s", pinned.Raw)
		}
		token := mustString(t, pinned.Body, "accessToken")
		// Authenticated routes ignore Host: this token is farm-pin, even if
		// the request names the other farm's host.
		got := h.doAt(t, anchorSlug+".bascula.engp.io", http.MethodGet, "/v1/farm", token, nil)
		if got.Status != http.StatusOK || got.Body["id"] != pinID {
			t.Fatalf("Host overrode the JWT tenant: %d %s", got.Status, got.Raw)
		}
		me := h.mustDo(t, http.MethodGet, "/v1/me", token, nil, http.StatusOK)
		farm, _ := me.Body["farm"].(map[string]any)
		if farm["id"] != pinID || farm["slug"] != "finca-pin" {
			t.Fatalf("/v1/me: %s", me.Raw)
		}
	})
}
