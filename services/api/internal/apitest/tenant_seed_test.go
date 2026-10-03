// SPDX-License-Identifier: MIT

package apitest

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// The internal seed endpoint of a dedicated stack, called directly: what it
// refuses, what it builds from a good seed, and that a second seed is a no-op.
func TestTenantSeedEdges(t *testing.T) {
	h := requireDB(t)
	slug := "semilla-" + uuid.NewString()[:6]
	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = t.TempDir()
	cfg.TenantSlug = slug
	stack := httpapi.New(scratchTenantDB(t, h), auth.NewSigner([]byte("tenant-signing-key-0123456789abcdef"), "bascula"), cfg)
	internal := stack.InternalHandler()
	seed := func(body any) response {
		return call(t, internal, http.MethodPost, "/internal/tenant/seed", "", body)
	}

	hash, err := auth.HashPassword("una-clave-larga-1")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	owner := map[string]any{"id": uuid.NewString(), "email": "dueno-" + slug + "@example.com", "name": "Dueño",
		"passwordHash": hash, "emailVerifiedAt": now, "role": "owner"}
	admin := map[string]any{"id": uuid.NewString(), "email": "admin-" + slug + "@example.com", "name": "Admin",
		"passwordHash": hash, "role": "admin"}
	farm := map[string]any{"id": uuid.NewString(), "name": "Finca semilla", "slug": slug,
		"timezone": "America/Bogota", "currency": "COP", "priceMinor": 0}

	expectStatus(t, "another farm's seed", seed(map[string]any{
		"farm": map[string]any{"id": uuid.NewString(), "slug": "otra"}, "members": []any{owner},
	}), http.StatusForbidden)
	expectStatus(t, "no members", seed(map[string]any{"farm": farm, "members": []any{}}), http.StatusBadRequest)
	expectStatus(t, "no owner", seed(map[string]any{"farm": farm, "members": []any{admin}}), http.StatusBadRequest)

	res := seed(map[string]any{"farm": farm, "members": []any{owner, admin}})
	expectStatus(t, "a good seed", res, http.StatusCreated)
	res = seed(map[string]any{"farm": farm, "members": []any{owner, admin}})
	expectStatus(t, "the same seed again", res, http.StatusOK)
	if res.Body["created"] != false {
		t.Fatalf("a second seed created something: %s", res.Raw)
	}
	info := call(t, internal, http.MethodGet, "/internal/tenant", "", nil)
	if info.Body["seeded"] != true || info.Body["slug"] != slug {
		t.Fatalf("tenant info: %s", info.Raw)
	}
	// The seeded owner signs in on the stack with the platform password.
	login := call(t, stack, http.MethodPost, "/v1/auth/login", "", map[string]any{
		"email": owner["email"], "password": "una-clave-larga-1",
	})
	expectStatus(t, "owner login on the stack", login, http.StatusOK)
}

func TestTenantSeedRefusesGarbage(t *testing.T) {
	h := requireDB(t)
	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = t.TempDir()
	cfg.TenantSlug = "basura"
	stack := httpapi.New(h.pool, auth.NewSigner([]byte("tenant-signing-key-0123456789abcdef"), "bascula"), cfg)
	rec := callRaw(stack.InternalHandler(), "/internal/tenant/seed", "{no es json")
	if rec != http.StatusBadRequest {
		t.Fatalf("garbage seed: %d", rec)
	}
}

func callRaw(srv http.Handler, path, body string) int {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	return rec.Code
}
