// SPDX-License-Identifier: MIT

package httpapi

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	cryptorand "crypto/rand"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/mailer"
	"github.com/ojardila/bascula/services/api/internal/secalert"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// Coverage round 2, batch B: the refusals a handler makes when the tenant
// middleware did not run (no transaction, or a transaction with no farm), and
// the small helpers around them, reached with bodies that pass validation so
// the refusal itself is what answers.

const c2hbID = "0192f3a0-0000-7000-8000-00000000c2b0"

type c2hbCall struct {
	name    string
	method  string
	route   string
	path    string
	handler http.HandlerFunc
	body    string
	// tx, when set, goes on the context with an empty farm, so tenant.Tx
	// passes and tenant.FarmID is what refuses.
	tx        pgx.Tx
	principal *auth.Principal
}

func (c c2hbCall) serve(t *testing.T) *httptest.ResponseRecorder {
	t.Helper()
	p := c.principal
	if p == nil {
		p = &auth.Principal{UserID: cauFarmID, FarmID: cauFarmID, Role: domain.RoleOwner}
	}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := auth.WithPrincipal(req.Context(), p)
			if c.tx != nil {
				ctx = tenant.WithTestTx(ctx, c.tx, "")
			}
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.MethodFunc(c.method, c.route, c.handler)
	req := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "10.99.0.2:1234"
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestC2hbHandlersRefuseWithoutTenant(t *testing.T) {
	s := cauServer(t)
	activity := `{"name":"Desyerba c2hb","payScheme":"tiempo","categoryId":"` + c2hbID + `",` +
		`"rate":{"rateCents":1000%s}}`
	dated := strings.Replace(activity, "%s", `,"validFrom":"2026-08-24"`, 1)
	undated := strings.Replace(activity, "%s", "", 1)
	// confirmOurs asks the transaction once per id it is given; this answers
	// "yes, ours" to that one question and nothing else.
	oneOurs := func() pgx.Tx { return &scriptedTx{rows: [][]any{{1}}} }
	adminFarm := `{"name":"Finca c2hb","priceCents":90000,` +
		`"owner":{"email":"c2hb-admin@example.com","name":"Duena"}}`
	sale := `{"productId":"` + c2hbID + `","warehouseId":"` + c2hbID + `","qty":2,"amountCents":5000}`
	season := `{"deviceId":"c2hb-handset","balances":[{"workerId":"` + c2hbID + `","balanceCents":0}]}`

	calls := []c2hbCall{
		{name: "create activity, no date, no transaction", method: http.MethodPost, route: "/a", path: "/a",
			handler: s.handleCreateActivity, body: undated},
		{name: "create activity, no transaction", method: http.MethodPost, route: "/a", path: "/a",
			handler: s.handleCreateActivity, body: dated},
		{name: "create activity, no farm", method: http.MethodPost, route: "/a", path: "/a",
			handler: s.handleCreateActivity, body: dated, tx: brokenTx{}},
		{name: "update activity, no farm", method: http.MethodPatch, route: "/a/{id}", path: "/a/" + c2hbID,
			handler: s.handleUpdateActivity, body: `{"name":"Otra"}`, tx: brokenTx{}},
		{name: "set rate, no transaction", method: http.MethodPost, route: "/a/{id}/rates", path: "/a/" + c2hbID + "/rates",
			handler: s.handleSetActivityRate, body: `{"rateCents":1200,"validFrom":"2026-08-24"}`},
		{name: "create work unit, no transaction", method: http.MethodPost, route: "/wu", path: "/wu",
			handler: s.handleCreateWorkUnit, body: `{"code":"c2hb"}`},
		{name: "create work unit, no farm", method: http.MethodPost, route: "/wu", path: "/wu",
			handler: s.handleCreateWorkUnit, body: `{"code":"c2hb"}`, tx: brokenTx{}},
		{name: "create expense, no farm", method: http.MethodPost, route: "/e", path: "/e",
			handler: s.handleCreateExpense, tx: oneOurs(),
			body: `{"concept":"Abono","amountCents":5000,"activityId":"` + c2hbID + `"}`},
		{name: "harvest mode, no transaction", method: http.MethodPut, route: "/h", path: "/h",
			handler: s.handleSetHarvestMode, body: `{"enabled":true}`},
		{name: "admin farm, no transaction", method: http.MethodPost, route: "/af", path: "/af",
			handler: s.handleCreateAdminFarm, body: adminFarm},
		{name: "farm status, no transaction", method: http.MethodPut, route: "/af/{id}/status", path: "/af/" + c2hbID + "/status",
			handler: s.handleSetFarmStatus, body: `{"status":"suspended"}`},
		{name: "season import, no transaction", method: http.MethodPost, route: "/i", path: "/i",
			handler: s.handleImportSeason, body: season},
		{name: "season import, no farm", method: http.MethodPost, route: "/i", path: "/i",
			handler: s.handleImportSeason, body: season, tx: brokenTx{}},
		{name: "create sale, no transaction", method: http.MethodPost, route: "/s", path: "/s",
			handler: s.handleCreateSale, body: sale},
		{name: "create sale, no farm", method: http.MethodPost, route: "/s", path: "/s",
			handler: s.handleCreateSale, body: sale, tx: brokenTx{}},
		{name: "update sale, no farm", method: http.MethodPatch, route: "/s/{id}", path: "/s/" + c2hbID,
			handler: s.handleUpdateSale, body: `{}`, tx: brokenTx{}},
		{name: "void sale, no farm", method: http.MethodDelete, route: "/s/{id}", path: "/s/" + c2hbID,
			handler: s.handleVoidSale, tx: brokenTx{}},
		{name: "close other sessions, no transaction", method: http.MethodPost, route: "/me/s", path: "/me/s",
			handler: s.handleCloseOtherSessions, principal: &auth.Principal{
				UserID: cauFarmID, FarmID: cauFarmID, Role: domain.RoleOwner, SessionID: c2hbID,
			}},
	}
	for _, c := range calls {
		t.Run(c.name, func(t *testing.T) {
			rec := c.serve(t)
			if rec.Code != http.StatusInternalServerError || cauErrCode(t, rec) != domain.CodeTenantNotSet {
				t.Fatalf("got %d %s, want 500 TENANT_NOT_SET", rec.Code, rec.Body.String())
			}
		})
	}

	// The console's farm list checks its filter after it has a transaction.
	rec := c2hbCall{method: http.MethodGet, route: "/af", path: "/af?status=borrada",
		handler: s.handleListAdminFarms, tx: brokenTx{}}.serve(t)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "active") {
		t.Fatalf("a bad status filter: %d %s", rec.Code, rec.Body.String())
	}
}

// createWorkRecord is shared by the single and the batch routes and answers
// an error instead of writing one, so it is called directly.
func TestC2hbCreateWorkRecordWithoutTenant(t *testing.T) {
	s := cauServer(t)
	body := workRecordRequest{ActivityID: c2hbID, WorkerID: c2hbID, DateFrom: "2026-08-24"}
	for _, tx := range []pgx.Tx{nil, brokenTx{}} {
		ctx := context.Background()
		if tx != nil {
			ctx = tenant.WithTestTx(ctx, tx, "")
		}
		r := httptest.NewRequest(http.MethodPost, "/", nil).WithContext(ctx)
		out, status, err := s.createWorkRecord(r, body)
		var de *domain.Error
		if out != nil || status != 0 || !errors.As(err, &de) || de.Code != domain.CodeTenantNotSet {
			t.Fatalf("tx=%v: %v %d %v", tx != nil, out, status, err)
		}
	}
}

// A price so small against so small a quantity that the amount rounds to
// zero is refused rather than stored as a free day's work.
func TestC2hbWorkRecordThatAddsUpToZero(t *testing.T) {
	rate := int64(1)
	qty := big.NewRat(1, 1000)
	var rec store.WorkRecord
	day := time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)
	err := priceWorkRecord(context.Background(), brokenTx{}, &rec, &store.Activity{}, &rate, qty, day, day)
	if err == nil || !strings.Contains(err.Error(), "adds up to zero") {
		t.Fatalf("got %v, want the zero-amount refusal", err)
	}
}

// c2hbReactivationTx says the worker was taken off the payroll last year and
// keeps the arguments of every Exec.
type c2hbReactivationTx struct {
	brokenTx
	execs [][]any
}

type c2hbDeletedRow struct{}

func (c2hbDeletedRow) Scan(dest ...any) error {
	*(dest[0].(*time.Time)) = time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	*(dest[1].(**string)) = nil
	return nil
}

func (*c2hbReactivationTx) QueryRow(context.Context, string, ...any) pgx.Row {
	return c2hbDeletedRow{}
}

func (x *c2hbReactivationTx) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	x.execs = append(x.execs, args)
	return pgconn.CommandTag{}, nil
}

// Without a deviceId in the body, the handset named by the token is the one
// that brought the worker back, and the reactivation says "sync".
func TestC2hbReactivationTakesTheTokensDevice(t *testing.T) {
	tx := &c2hbReactivationTx{}
	p := &auth.Principal{UserID: cauFarmID, DeviceID: "c2hb-phone"}
	body := &workRecordRequest{WorkerID: c2hbID}
	started := time.Date(2026, 8, 24, 5, 0, 0, 0, time.UTC)
	if err := reactivateForWorkRecord(context.Background(), tx, cauFarmID, p, body, c2hbID, started); err != nil {
		t.Fatal(err)
	}
	if len(tx.execs) != 2 {
		t.Fatalf("execs: %v", tx.execs)
	}
	var sawDevice, sawSync bool
	for _, a := range tx.execs[1] {
		switch v := a.(type) {
		case *string:
			if v != nil && *v == "c2hb-phone" {
				sawDevice = true
			}
		case string:
			if v == "sync" {
				sawSync = true
			}
		}
	}
	if !sawDevice || !sawSync {
		t.Fatalf("the reactivation does not name the token's handset: %v", tx.execs[1])
	}
	if body.DeviceID != nil {
		t.Fatal("the body was rewritten")
	}
}

// The batch's default activity: its own, none needed when every line names
// one, and the farm's harvest activity only when some line has none.
func TestC2hbBatchDefaultActivity(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	got, err := batchDefaultActivity(r, &workRecordBatchRequest{ActivityID: "own"})
	if err != nil || got != "own" {
		t.Fatalf("own activity: %q %v", got, err)
	}
	named := &workRecordBatchRequest{Items: []workRecordRequest{{ActivityID: "a"}, {ActivityID: "b"}}}
	got, err = batchDefaultActivity(r, named)
	if err != nil || got != "" {
		t.Fatalf("every line named one: %q %v", got, err)
	}
	unnamed := &workRecordBatchRequest{Items: []workRecordRequest{{ActivityID: "a"}, {}}}
	_, err = batchDefaultActivity(r, unnamed)
	var de *domain.Error
	if !errors.As(err, &de) || de.Code != domain.CodeTenantNotSet {
		t.Fatalf("a line without one, no transaction: %v", err)
	}
	r = r.WithContext(tenant.WithTestTx(r.Context(), brokenTx{}, cauFarmID))
	if _, err = batchDefaultActivity(r, unnamed); !errors.Is(err, errDBDown) {
		t.Fatalf("a line without one, broken transaction: %v", err)
	}
}

// A line that points at nothing is a 404 that names the line.
func TestC2hbBatchLineNotFound(t *testing.T) {
	for _, cause := range []error{pgx.ErrNoRows, store.NoRows} {
		err := batchLineError(3, cause)
		var de *domain.Error
		if !errors.As(err, &de) || de.Status != http.StatusNotFound ||
			!strings.HasPrefix(de.Message, "line 3:") || de.Details["line"] != 3 {
			t.Fatalf("got %#v", err)
		}
	}
	if err := batchLineError(1, errDBDown); !errors.Is(err, errDBDown) {
		t.Fatalf("an ordinary failure became %v", err)
	}
}

// c2hbDeadlineWriter takes a read deadline but refuses a write deadline.
type c2hbDeadlineWriter struct {
	*httptest.ResponseRecorder
	read time.Time
}

func (w *c2hbDeadlineWriter) SetReadDeadline(t time.Time) error { w.read = t; return nil }
func (w *c2hbDeadlineWriter) SetWriteDeadline(time.Time) error {
	return errors.New("no write deadline here")
}

// A connection that takes the read deadline but not the write one still gets
// the progress body: the upload goes on under the server's write timeout.
func TestC2hbImportDeadlinesWithoutAWriteDeadline(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(prev)

	w := &c2hbDeadlineWriter{ResponseRecorder: httptest.NewRecorder()}
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{}"))
	if !extendImportDeadlines(w, r) {
		t.Fatal("the read deadline was granted, yet the extension reports failure")
	}
	if _, ok := r.Body.(*progressBody); !ok {
		t.Fatalf("body is %T, want the progress body", r.Body)
	}
	if w.read.IsZero() || !strings.Contains(logs.String(), "could not extend the write deadline") {
		t.Fatalf("read deadline %v, log %q", w.read, logs.String())
	}
}

// Past the wall, the read deadline stops at the wall; and closing the
// progress body closes what it wraps.
func TestC2hbProgressBodyStopsAtTheWall(t *testing.T) {
	w := &c2hbDeadlineWriter{ResponseRecorder: httptest.NewRecorder()}
	hard := time.Now().Add(time.Second)
	inner := &c2hbClosingReader{Reader: strings.NewReader("abc")}
	b := &progressBody{rc: http.NewResponseController(w), body: inner, hard: hard}
	buf := make([]byte, 8)
	if n, _ := b.Read(buf); n != 3 {
		t.Fatalf("read %d bytes", n)
	}
	if !w.read.Equal(hard) {
		t.Fatalf("deadline %v, want the wall %v", w.read, hard)
	}
	if err := b.Close(); err != nil || !inner.closed {
		t.Fatalf("close: %v, inner closed %v", err, inner.closed)
	}
}

type c2hbClosingReader struct {
	io.Reader
	closed bool
}

func (c *c2hbClosingReader) Close() error { c.closed = true; return nil }

// Without a signer there is no ticket and no run ref; a super-admin session
// may always watch a provisioning.
func TestC2hbProvisionTicketHelpers(t *testing.T) {
	s := &Server{}
	if s.provisionTicket("finca") != "" || s.provisionRunRef("finca") != "" {
		t.Fatal("a ticket or a ref without a signer")
	}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if s.mayWatchProvision(r, "finca") {
		t.Fatal("a stranger may watch")
	}
	r = r.WithContext(auth.WithPrincipal(r.Context(), &auth.Principal{Superadmin: true}))
	if !s.mayWatchProvision(r, "finca") {
		t.Fatal("the super-admin may not watch")
	}
}

type c2hbMailer struct {
	mu   sync.Mutex
	sent []mailer.Message
}

func (m *c2hbMailer) Send(_ context.Context, msg mailer.Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, msg)
	return nil
}

func (m *c2hbMailer) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sent)
}

// A 5xx on /v1 is counted toward the operator's alert; anything off /v1
// passes straight through and is not.
func TestC2hbServerErrorsAreWatchedOnV1Only(t *testing.T) {
	mail := &c2hbMailer{}
	rules := secalert.DefaultRules()
	rule := rules[secalert.ServerErrors]
	rule.Threshold = 1
	rules[secalert.ServerErrors] = rule
	s := &Server{cfg: Config{Alerts: secalert.New(secalert.Config{
		To: "ops@example.com", Stack: "c2hb", Sender: mail, Rules: rules,
		Go: func(f func()) { f() },
	})}}
	h := s.watchServerErrors(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	for _, path := range []string{"/health", "/oauth/token"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("%s: %d", path, rec.Code)
		}
	}
	if mail.count() != 0 {
		t.Fatalf("a 5xx off /v1 paged: %v", mail.sent)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/farm", nil)
	req.Host = "finca-c2hb.example.com"
	h.ServeHTTP(httptest.NewRecorder(), req)
	if mail.count() != 1 || !strings.Contains(mail.sent[0].Subject, "finca-c2hb.example.com") {
		t.Fatalf("the /v1 5xx did not page with its host: %+v", mail.sent)
	}
}

// A failure to write the audit row is logged and swallowed, and the record it
// would have written leaves out the confirmation token and truncates
// oversized arguments without failing.
func TestC2hbMCPAuditFailureIsLogged(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(prev)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, "postgres://nadie:nada@127.0.0.1:1/nada?connect_timeout=1")
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	s := &Server{pool: pool}
	p := &auth.Principal{UserID: cauFarmID, FarmID: cauFarmID, Role: domain.RoleOwner, ClientID: "c2hb"}
	args := mcpArgs{"confirmationToken": "secreto", "note": strings.Repeat("x", mcpAuditMaxArgs+1)}
	res := &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "listo"}}}
	s.mcpAudit(ctx, p, "create_worker", "done", res, args)
	if !strings.Contains(logs.String(), "mcp audit") || !strings.Contains(logs.String(), "create_worker") {
		t.Fatalf("the failed audit was not logged: %q", logs.String())
	}
	if _, ok := args["confirmationToken"]; !ok {
		t.Fatal("the caller's arguments were modified")
	}
}

func TestC2hbTruncateRunesAndListCap(t *testing.T) {
	if got := truncateRunes("ñandú", 3); got != "ñan…" {
		t.Fatalf("truncate: %q", got)
	}
	if got := truncateRunes("ñandú", 5); got != "ñandú" {
		t.Fatalf("no truncation: %q", got)
	}
	r := httptest.NewRequest(http.MethodGet, "/?limit=150", nil)
	if got := limitParamMax(r, 50, mcpAuditListLimit); got != mcpAuditListLimit {
		t.Fatalf("limit 150 gave %d, want the cap %d", got, mcpAuditListLimit)
	}
	r = httptest.NewRequest(http.MethodGet, "/?limit=7", nil)
	if got := limitParamMax(r, 50, mcpAuditListLimit); got != 7 {
		t.Fatalf("limit 7 gave %d", got)
	}
}

// c2hbFailOnce fails its first read and is crypto/rand after that.
type c2hbFailOnce struct {
	mu     sync.Mutex
	failed bool
}

func (f *c2hbFailOnce) Read(p []byte) (int, error) {
	f.mu.Lock()
	first := !f.failed
	f.failed = true
	f.mu.Unlock()
	if first {
		return 0, errors.New("no entropy right now")
	}
	return cryptorand.Read(p)
}

// When a v7 id cannot be made, newID falls back to a random v4 id rather than
// failing the write.
func TestC2hbNewIDFallsBackToV4(t *testing.T) {
	uuid.SetRand(&c2hbFailOnce{})
	defer uuid.SetRand(nil)
	id, err := uuid.Parse(newID())
	if err != nil || id.Version() != 4 {
		t.Fatalf("fallback id %v (version %d): %v", id, id.Version(), err)
	}
	if v, _ := uuid.Parse(newID()); v.Version() != 7 {
		t.Fatalf("the next id is version %d, want 7", v.Version())
	}
}
