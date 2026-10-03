// SPDX-License-Identifier: MIT

package apitest

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// TestProvisionStatusIsComputedOncePerSlugUnderLoad: the waiting screen's
// endpoint is public, and one computation costs a probe, cluster reads and a
// GitHub call. Concurrent callers for one slug share one computation.
//
// Twenty is deliberately more than the pool's connections
// (store.OrdinaryConns + store.MaxImportsAtOnce): a caller that holds a
// connection while it waits would starve the computation it waits on.
func TestProvisionStatusIsComputedOncePerSlugUnderLoad(t *testing.T) {
	h := requireDB(t)
	var probes atomic.Int32
	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probes.Add(1)
		time.Sleep(200 * time.Millisecond) // a slow farm address
		http.NotFound(w, r)
	}))
	defer public.Close()

	cfg := httpapi.DefaultConfig()
	cfg.UploadDir = t.TempDir()
	cfg.SignupsPerIPPerHour = 1000
	cfg.SignupsPerEmailPerHour = 1000
	cfg.TenantPublicURL = public.URL
	srv := httpapi.New(h.pool, auth.NewSigner([]byte("test-signing-key"), "bascula"), cfg)
	slug := "carga-" + uuid.NewString()[:6]
	signupWithSlug(t, srv, "Finca bajo carga", slug)
	probes.Store(0)

	var wg sync.WaitGroup
	codes := make([]int, 20)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, provisionStatusPath(slug), nil)
			req.RemoteAddr = "10.9.2.1:1"
			rec := httptest.NewRecorder()
			srv.ServeHTTP(rec, req)
			codes[i] = rec.Code
		}(i)
	}
	wg.Wait()
	for i, c := range codes {
		if c != http.StatusOK {
			t.Fatalf("request %d: %d", i, c)
		}
	}
	if n := probes.Load(); n != 1 {
		t.Fatalf("20 concurrent requests probed the farm address %d times, want 1", n)
	}
}
