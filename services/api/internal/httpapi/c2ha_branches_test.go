// SPDX-License-Identifier: MIT

package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/cfsaas"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// Branches the database-backed suite cannot reach: a request that arrives
// without the tenant transaction, or with one but no farm pinned to it; the
// rare answers of the Cloudflare watcher; and the small helpers whose odd
// inputs no route sends.

const (
	c2haFarm = "0192f3a0-0000-7000-8000-0000000000c2"
	c2haUser = "0192f3a0-0000-7000-8000-0000000000c3"
)

// c2haTx answers QueryRow with the values in rows (in order) and Exec through
// exec; everything else fails like brokenTx.
type c2haTx struct {
	brokenTx
	rows [][]any
	exec func(sql string) (pgconn.CommandTag, error)
}

type c2haRow struct{ vals []any }

func (r c2haRow) Scan(dest ...any) error {
	for i, d := range dest {
		switch p := d.(type) {
		case *bool:
			*p = r.vals[i].(bool)
		default:
			return errDBDown
		}
	}
	return nil
}

func (t *c2haTx) QueryRow(context.Context, string, ...any) pgx.Row {
	if len(t.rows) == 0 {
		return brokenRow{}
	}
	row := c2haRow{vals: t.rows[0]}
	t.rows = t.rows[1:]
	return row
}

func (t *c2haTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	if t.exec == nil {
		return pgconn.CommandTag{}, errDBDown
	}
	return t.exec(sql)
}

// c2haServe sends one request through every route with a principal on the
// context and, unless tx is nil, tx pinned to farmID.
func c2haServe(t *testing.T, s *Server, tx pgx.Tx, farmID, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := auth.WithPrincipal(req.Context(), &auth.Principal{
				UserID: c2haUser, FarmID: c2haFarm, Role: domain.RoleOwner,
			})
			if tx != nil {
				ctx = tenant.WithTestTx(ctx, tx, farmID)
			}
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	for _, rt := range s.Routes() {
		r.MethodFunc(rt.Method, rt.Pattern, rt.Handler)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func c2haCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var env errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("not an error envelope: %q", rec.Body.String())
	}
	return string(env.Error.Code)
}

func c2haServer(t *testing.T) *Server {
	t.Helper()
	t.Setenv("APP_ENV", "development")
	return New(nil, nil, Config{UploadDir: t.TempDir()})
}

// TestHandlersRefuseWithoutTenant sends valid bodies, so the handler gets
// past its validation, to a request that has no tenant transaction ("no-tx")
// or a transaction with no farm pinned ("no-farm"). Every one must stop with
// TENANT_NOT_SET instead of writing for nobody.
func TestHandlersRefuseWithoutTenant(t *testing.T) {
	s := c2haServer(t)
	const id = "0192f3a0-0000-7000-8000-0000000000aa"
	cases := []struct {
		mode, method, path, body string
	}{
		{"no-tx", http.MethodPost, "/v1/catalogs/crop-types", `{"name":"Cafe"}`},
		{"no-farm", http.MethodPost, "/v1/catalogs/crop-types", `{"name":"Cafe"}`},
		{"no-tx", http.MethodPost, "/v1/products", `{"name":"Urea","storageUnit":"bulto"}`},
		{"no-farm", http.MethodPost, "/v1/products", `{"name":"Urea","storageUnit":"bulto"}`},
		{"no-farm", http.MethodPatch, "/v1/products/" + id, `{}`},
		{"no-tx", http.MethodPost, "/v1/customers", `{"name":"Cooperativa"}`},
		{"no-farm", http.MethodPost, "/v1/customers", `{"name":"Cooperativa"}`},
		{"no-tx", http.MethodPost, "/v1/plots", `{"name":"El alto"}`},
		{"no-farm", http.MethodPost, "/v1/plots", `{"name":"El alto"}`},
		{"no-tx", http.MethodPut, "/v1/plots/" + id + "/boundary", `{"boundary":{"type":"Point","coordinates":[0,0]}}`},
		{"no-tx", http.MethodPost, "/v1/plots/" + id + "/crops", `{"cropType":"Cafe"}`},
		{"no-farm", http.MethodPost, "/v1/plots/" + id + "/crops", `{"cropType":"Cafe"}`},
		{"no-tx", http.MethodPost, "/v1/pickups", `{"workerId":"` + id + `","weight":"12","date":"2026-09-07"}`},
		{"no-tx", http.MethodPost, "/v1/sync/handshake", `{"deviceId":"` + id + `","schemaVersion":99}`},
		{"no-tx", http.MethodPost, "/v1/sync/push", `{"deviceId":"` + id + `","ops":[]}`},
		{"no-farm", http.MethodPost, "/v1/sync/push", `{"deviceId":"` + id + `","ops":[]}`},
		{"no-tx", http.MethodGet, "/v1/prices/special/lotes/" + id + "/2026-09-07/impact", ``},
	}
	for _, c := range cases {
		var tx pgx.Tx
		if c.mode == "no-farm" {
			tx = brokenTx{}
		}
		rec := c2haServe(t, s, tx, "", c.method, c.path, c.body)
		if rec.Code != http.StatusInternalServerError || c2haCode(t, rec) != string(domain.CodeTenantNotSet) {
			t.Errorf("%s %s %s: %d %s, want 500 TENANT_NOT_SET", c.mode, c.method, c.path, rec.Code, rec.Body.String())
		}
	}
}

// TestSpecialPriceTargetRefusals: an id that is not a uuid is "no such lote"
// before any query, a body that does not parse is a 400, and a target that
// exists on a transaction with no farm pinned still stops at the farm.
func TestSpecialPriceTargetRefusals(t *testing.T) {
	s := c2haServer(t)
	const id = "0192f3a0-0000-7000-8000-0000000000aa"
	base := "/v1/prices/special/lotes/"

	rec := c2haServe(t, s, brokenTx{}, c2haFarm, http.MethodGet, base+"no-es-uuid/2026-09-07/impact", "")
	if rec.Code != http.StatusNotFound || c2haCode(t, rec) != string(domain.CodeNotFound) {
		t.Errorf("bad id: %d %s", rec.Code, rec.Body.String())
	}
	rec = c2haServe(t, s, brokenTx{}, c2haFarm, http.MethodPut, base+id+"/2026-09-07", `{"priceCents":`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad body: %d %s", rec.Code, rec.Body.String())
	}
	tx := &c2haTx{rows: [][]any{{true}}}
	rec = c2haServe(t, s, tx, "", http.MethodPut, base+id+"/2026-09-07", `{"priceCents":90000}`)
	if rec.Code != http.StatusInternalServerError || c2haCode(t, rec) != string(domain.CodeTenantNotSet) {
		t.Errorf("no farm: %d %s", rec.Code, rec.Body.String())
	}
	if len(tx.rows) != 0 {
		t.Error("the target was not looked up before the farm")
	}
}

// TestPickupListRefusesBadFilter: the filter is read after the transaction,
// and a bad one is the caller's mistake.
func TestPickupListRefusesBadFilter(t *testing.T) {
	s := c2haServer(t)
	rec := c2haServe(t, s, brokenTx{}, c2haFarm, http.MethodGet, "/v1/pickups?payScheme=trueque", "")
	if rec.Code != http.StatusBadRequest || c2haCode(t, rec) != string(domain.CodeBadRequest) {
		t.Errorf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestPrincipalIDWithoutPrincipal(t *testing.T) {
	if got := principalID(httptest.NewRequest(http.MethodGet, "/", nil)); got != "" {
		t.Errorf("principalID = %q, want empty", got)
	}
}

// --- sync helpers -----------------------------------------------------------

func TestReaderDeviceFallsBackToTheToken(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	const dev = "0192f3a0-0000-7000-8000-0000000000dd"
	got, err := readerDevice(r, "", &auth.Principal{DeviceID: dev})
	if err != nil || got != store.SyncReaderDevice("", dev) {
		t.Errorf("token device: %q %v", got, err)
	}
	got, err = readerDevice(r, "", &auth.Principal{DeviceID: "no-es-uuid"})
	if err != nil || got != store.SyncReaderDevice("", "") {
		t.Errorf("a token device that is not a uuid is ignored: %q %v", got, err)
	}
	if _, err := readerDevice(r, "no-es-uuid", nil); err == nil {
		t.Error("a named device that is not a uuid must be refused")
	}
}

func TestPushHelpersEdges(t *testing.T) {
	if pushWorkRecordCreatedBy(nil) != nil || pushWorkRecordCreatedBy(&auth.Principal{}) != nil {
		t.Error("no user means no created_by")
	}
	if err := opIDRefusal(""); err == nil {
		t.Error("an empty opId must be refused")
	}
	var v struct{}
	err := decodePayload(nil, &v)
	if de, ok := domain.AsError(err); !ok || de.Code != domain.CodeBadRequest {
		t.Errorf("no payload: %v", err)
	}
}

// --- render -----------------------------------------------------------------

type c2haBrokenBody struct{}

func (c2haBrokenBody) Read([]byte) (int, error) { return 0, errors.New("connection reset") }
func (c2haBrokenBody) Close() error             { return nil }

func TestRenderEdges(t *testing.T) {
	// A value json cannot encode: the status is already out, the body is empty.
	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusOK, func() {})
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Errorf("unencodable: %d %q", rec.Code, rec.Body.String())
	}

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Body = c2haBrokenBody{}
	var v struct{}
	if _, err := decodeNulls(req, &v); err == nil || !strings.Contains(err.Error(), "could not read") {
		t.Errorf("unreadable body: %v", err)
	}

	// Trailing bytes after the object: the decoder stops at the object, the
	// key map cannot be read, and no key counts as an explicit null.
	req = httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":null} sobra`))
	var named struct {
		Name *string `json:"name"`
	}
	nulls, err := decodeNulls(req, &named)
	if err != nil || len(nulls) != 0 {
		t.Errorf("trailing bytes: %v %v", nulls, err)
	}

	req = httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":5}`))
	var typed struct {
		Name string `json:"name"`
	}
	err = decode(req, &typed)
	if de, ok := domain.AsError(err); !ok || de.Message != "name: expected string" {
		t.Errorf("type error: %v", err)
	}
}

// --- edge log ---------------------------------------------------------------

func TestEdgeLogEdges(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Body = c2haBrokenBody{}
	if m, tool := edgeLogPeekRPC(req); m != "" || tool != "" {
		t.Errorf("unreadable body: %q %q", m, tool)
	}

	req = httptest.NewRequest(http.MethodPost, "/oauth/token", nil)
	req.Form = url.Values{"client_secret": {"s"}}
	if id, how := edgeLogOAuthClient(req, "cli"); id != "cli" || how != "post" {
		t.Errorf("secret in the form: %q %q", id, how)
	}

	long := strings.Repeat("x", 80)
	raw := []byte(`{"method":"tools/call","params":{"name":"` + long + `"}}`)
	if got := jsonRPCToolName(raw); got != long[:64] {
		t.Errorf("tool name not cut to 64: %d chars", len(got))
	}
}

// --- server -----------------------------------------------------------------

func TestServerConstructionRefusals(t *testing.T) {
	file := filepath.Join(t.TempDir(), "un-archivo")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Error("an upload dir that cannot be created must panic")
			}
		}()
		New(nil, nil, Config{UploadDir: filepath.Join(file, "sub")})
	}()
	func() {
		defer func() {
			msg, _ := recover().(string)
			if !strings.Contains(msg, "TrustedProxyCIDRs[0]") {
				t.Errorf("panic = %q", msg)
			}
		}()
		fromTrustedPeer([]string{"10.1.2.3"}, func(h http.Handler) http.Handler { return h })
	}()
}

func TestPeerIsTrustedEdges(t *testing.T) {
	prefixes := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	if !peerIsTrusted("10.0.0.5", prefixes) {
		t.Error("a bare address inside the range is trusted")
	}
	if peerIsTrusted("no-es-ip", prefixes) {
		t.Error("an address that does not parse is never trusted")
	}
}

func TestRequireActionUnknownFailsShut(t *testing.T) {
	s := c2haServer(t)
	called := false
	h := s.requireAction(auth.Action("c2ha.not-in-table"))(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if called || rec.Code != http.StatusForbidden {
		t.Errorf("unknown action: called=%v %d", called, rec.Code)
	}
}

// --- slug and signup fields -------------------------------------------------

func TestUniquifyFarmSlugSuffixFillsTheLabel(t *testing.T) {
	id := strings.Repeat("z", 70)
	got := uniquifyFarmSlug("finca", id, 14)
	if got != id[:64] {
		t.Errorf("got %q", got)
	}
}

func TestCreateFarmRecordSlugRetries(t *testing.T) {
	taken := &pgconn.PgError{Code: "23505", ConstraintName: "farms_slug_key"}
	inserts := 0
	tx := &c2haTx{exec: func(sql string) (pgconn.CommandTag, error) {
		if strings.Contains(sql, "INSERT INTO farms") {
			inserts++
			return pgconn.CommandTag{}, taken
		}
		return pgconn.CommandTag{}, nil
	}}
	f := &store.NewFarm{ID: "0192f3a0-0000-7000-8000-0000000000ff", Name: "La Esperanza"}
	err := createFarmRecord(context.Background(), tx, f, "")
	if de, ok := domain.AsError(err); !ok || de.Code != domain.CodeConflict {
		t.Fatalf("every slug taken: %v", err)
	}
	if inserts != 6 || !strings.HasPrefix(f.Slug, "la-esperanza-") {
		t.Errorf("inserts=%d slug=%q", inserts, f.Slug)
	}

	// The savepoint cannot be rolled back: the insert's own error comes out.
	tx = &c2haTx{exec: func(sql string) (pgconn.CommandTag, error) {
		switch {
		case strings.Contains(sql, "INSERT INTO farms"):
			return pgconn.CommandTag{}, taken
		case strings.HasPrefix(sql, "ROLLBACK"):
			return pgconn.CommandTag{}, errDBDown
		}
		return pgconn.CommandTag{}, nil
	}}
	err = createFarmRecord(context.Background(), tx, &store.NewFarm{ID: f.ID, Name: f.Name}, "")
	if !errors.Is(err, taken) {
		t.Errorf("rollback failed: %v", err)
	}

	// Any other insert failure is not retried.
	inserts = 0
	tx = &c2haTx{exec: func(sql string) (pgconn.CommandTag, error) {
		if strings.Contains(sql, "INSERT INTO farms") {
			inserts++
			return pgconn.CommandTag{}, errDBDown
		}
		return pgconn.CommandTag{}, nil
	}}
	err = createFarmRecord(context.Background(), tx, &store.NewFarm{ID: f.ID, Name: f.Name}, "")
	if !errors.Is(err, errDBDown) || inserts != 1 {
		t.Errorf("other failure: %v after %d inserts", err, inserts)
	}
}

func TestValidEmailRequired(t *testing.T) {
	err := validEmail("owner.email", "")
	if de, ok := domain.AsError(err); !ok || de.Message != "owner.email is required" {
		t.Errorf("empty email: %v", err)
	}
}

// --- MCP --------------------------------------------------------------------

func TestMCPCatalogWithoutTools(t *testing.T) {
	s := c2haServer(t)
	s.mcpCatalog = nil
	raw, err := json.Marshal(s.mcpCatalogFor(httptest.NewRequest(http.MethodGet, "/mcp/tools.json", nil)))
	if err != nil || !strings.Contains(string(raw), `"tools":[]`) {
		t.Errorf("tools must be an empty list, not null: %s %v", raw, err)
	}
}

func TestMCPToolHandlerBadArguments(t *testing.T) {
	s := c2haServer(t)
	handler := s.mcpToolHandler(mcpTool{Name: "farm", Method: http.MethodGet, Path: "/v1/farm"})
	res, err := handler(context.Background(), &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{Arguments: json.RawMessage(`[1,2]`)},
	})
	if err != nil || !res.IsError || !strings.Contains(toolResultText(res), "argumentos inválidos") {
		t.Errorf("array arguments: %v %s", err, toolResultText(res))
	}
}

func TestMCPDispatchEdges(t *testing.T) {
	s := c2haServer(t)
	status, body := s.mcpDispatch(context.Background(), &mcp.CallToolRequest{}, "MAL METODO", "/v1/farm", nil)
	if status != http.StatusInternalServerError || !strings.Contains(string(body), "INTERNAL") {
		t.Errorf("bad method: %d %s", status, body)
	}

	var mu sync.Mutex
	var seen http.Header
	inner := chi.NewRouter()
	inner.HandleFunc("/*", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = r.Header.Clone()
		mu.Unlock()
		w.WriteHeader(http.StatusTeapot)
	})
	s.router = inner
	h := http.Header{}
	h.Set("Authorization", "Bearer abc")
	h.Set("X-Forwarded-For", "203.0.113.9")
	status, _ = s.mcpDispatch(context.Background(), &mcp.CallToolRequest{Extra: &mcp.RequestExtra{Header: h}},
		http.MethodGet, "/v1/farm", nil)
	mu.Lock()
	defer mu.Unlock()
	if status != http.StatusTeapot || seen.Get("Authorization") != "Bearer abc" || seen.Get("X-Forwarded-For") != "203.0.113.9" {
		t.Errorf("forwarded headers: %d %v", status, seen)
	}
}

// --- Cloudflare certificate watch -------------------------------------------

// c2haCloudflare is a fake custom-hostnames API. status is what every
// hostname reports; a PATCH (revalidate) always fails.
type c2haCloudflare struct {
	mu      sync.Mutex
	status  string
	patches int
}

func (f *c2haCloudflare) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	host := `{"id":"h-1","hostname":"finca.example.com","status":"` + f.status + `","ssl":{"status":"` + f.status + `"}}`
	switch {
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/custom_hostnames"):
		_, _ = w.Write([]byte(`{"success":true,"result":[]}`))
	case r.Method == http.MethodPatch:
		f.patches++
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":1,"message":"no"}]}`))
	default:
		_, _ = w.Write([]byte(`{"success":true,"result":` + host + `}`))
	}
}

func c2haCertServer(t *testing.T, fake *c2haCloudflare, every, watchFor time.Duration) *Server {
	t.Helper()
	cf := httptest.NewServer(fake)
	t.Cleanup(cf.Close)
	t.Setenv("APP_ENV", "development")
	return New(nil, nil, Config{
		UploadDir: t.TempDir(), CloudflareSaaSToken: "cf", CloudflareZoneID: "zone",
		CloudflareAPIURL: cf.URL, ProvisionPollEvery: every, ProvisionWatchFor: watchFor,
	})
}

func TestFarmCertWatchActiveOnFirstLook(t *testing.T) {
	fake := &c2haCloudflare{status: "active"}
	s := c2haCertServer(t, fake, 0, time.Minute) // 0: the default poll interval
	done := make(chan struct{})
	go func() { s.farmCertWatch(s.cfSaaS(), "finca", "finca.example.com"); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("an active certificate must end the watch on the first look")
	}
	if st := s.certStateOf("finca"); !st.Active || st.Watching || st.ID != "h-1" {
		t.Errorf("state = %+v", st)
	}
}

func TestFarmCertWatchGivesUp(t *testing.T) {
	fake := &c2haCloudflare{status: "pending"}
	s := c2haCertServer(t, fake, 2*time.Millisecond, 80*time.Millisecond)
	s.farmCertWatch(s.cfSaaS(), "finca", "finca.example.com")
	st := s.certStateOf("finca")
	if st.Active || st.Watching || st.Summary == "" {
		t.Errorf("state = %+v", st)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.patches == 0 {
		t.Error("a pending certificate past the revalidate window must be asked for again")
	}
}

func TestFarmCertStateEdges(t *testing.T) {
	s := c2haServer(t)
	s.cfg.TenantPublicURL = "://%s"
	if got := s.farmHostname("finca"); got != "" {
		t.Errorf("unparseable public URL: %q", got)
	}

	h := &cfsaas.Hostname{ID: "h-9", Hostname: "otra.example.com", Status: "pending", VerificationErrors: []string{"dns"}}
	s.setCertState("otra", h, true)
	st := s.certStateOf("otra")
	if !st.Watching || st.ID != "h-9" || !strings.Contains(st.Error, "errors=dns") {
		t.Errorf("state = %+v", st)
	}
}

// TestWindowLimiterSweepsStaleKeys: once a window has passed, a key whose
// last event is older than the window is forgotten, not kept for ever.
func TestWindowLimiterSweepsStaleKeys(t *testing.T) {
	l := newWindowLimiter(5, time.Minute)
	t0 := time.Date(2026, 9, 7, 8, 0, 0, 0, time.UTC)
	if !l.allow("viejo", t0) || !l.allow("nuevo", t0.Add(2*time.Minute)) {
		t.Fatal("both events are within the limit")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.events["viejo"]; ok || len(l.events["nuevo"]) != 1 {
		t.Errorf("events = %v", l.events)
	}
}
