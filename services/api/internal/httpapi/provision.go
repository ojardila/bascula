// SPDX-License-Identifier: MIT

package httpapi

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/logsafe"
)

// A farm can get a stack of its own: a namespace with its own Postgres, API
// and web behind {slug}.bascula.engp.io. The flow, end to end:
//
//  1. signup, POST /v1/farms or the console creates the farm on the shared
//     platform, exactly as before. The farm works there from the first second.
//  2. kickTenantProvision asks GitHub Actions (repository_dispatch) to commit
//     tenants/dedicated/{slug}.yaml into gitops; Argo's ApplicationSet turns it
//     into namespace bascula-{slug}.
//  3. The new API boots empty. watchTenant — started here, and restarted by
//     anybody polling the status — waits for its internal port and pushes the
//     farm, its members and their password hashes into it (seedTenant), so the
//     owner logs in on the new address with the password they already chose.
//  4. GET /v1/farms/{slug}/provision-status tells the waiting screen which of
//     those steps are done, including whether the public address answers.

type tenantProvision struct {
	Slug      string
	FarmName  string
	Email     string
	OwnerName string
	Phone     string
}

// dedicatedProvisioning reports whether this deployment launches a stack per
// farm. Without a dispatch token every farm stays on the shared platform.
func (s *Server) dedicatedProvisioning() bool {
	return strings.TrimSpace(s.cfg.GitHubDispatchToken) != "" &&
		strings.TrimSpace(s.cfg.GitHubDispatchRepo) != ""
}

// kickTenantProvision asks GitHub Actions (the provision-tenant workflow in
// GitHubDispatchRepo, ojardila/gitops) to commit a dedicated tenant there. Argo then creates namespace, Postgres and API/web pods. Failures
// are logged: the farm already exists on the shared platform.
func (s *Server) kickTenantProvision(p tenantProvision) {
	// The farm address needs its certificate on the shared platform too.
	s.ensureFarmCertificate(p.Slug)
	if !s.dedicatedProvisioning() || p.Slug == "" {
		return
	}
	token := strings.TrimSpace(s.cfg.GitHubDispatchToken)
	repo := strings.TrimSpace(s.cfg.GitHubDispatchRepo)
	api := strings.TrimRight(s.cfg.GitHubAPIURL, "/")
	if api == "" {
		api = "https://api.github.com"
	}
	// Signup and the console validated these already (signup_fields.go);
	// sanitize again here so no future caller can send a line break or an
	// unbounded string to the workflow.
	p.FarmName = sanitizeDispatchText(p.FarmName, maxFarmNameRunes)
	p.OwnerName = sanitizeDispatchText(p.OwnerName, maxOwnerNameRunes)
	p.Email = sanitizeDispatchEmail(p.Email)
	p.Phone = sanitizeDispatchPhone(p.Phone)
	go func() {
		body, err := json.Marshal(map[string]any{
			"event_type": "provision-tenant",
			"client_payload": map[string]string{
				"slug": p.Slug,
				// ref, not slug, titles the run. See provisionRunRef.
				"ref":       s.provisionRunRef(p.Slug),
				"farmName":  p.FarmName,
				"email":     p.Email,
				"ownerName": p.OwnerName,
				"phone":     p.Phone,
				"mode":      "dedicated",
			},
		})
		if err != nil {
			return
		}
		req, err := http.NewRequest(http.MethodPost,
			api+"/repos/"+repo+"/dispatches", bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		req.Header.Set("Content-Type", contentTypeJSON)
		client := &http.Client{Timeout: 15 * time.Second}
		res, err := client.Do(req)
		if err != nil {
			slog.Error("tenant provision dispatch", "slug", p.Slug, "err", err)
			return
		}
		defer res.Body.Close()
		if res.StatusCode >= 300 {
			slog.Error("tenant provision dispatch", "slug", p.Slug, "status", res.StatusCode)
			return
		}
		slog.Info("tenant provision dispatched", "slug", p.Slug)
	}()
	s.watchTenant(p.Slug)
}

// ---------------------------------------------------------------------------
// Watching and seeding the new stack
// ---------------------------------------------------------------------------

type provisioner struct {
	mu       sync.Mutex
	watching map[string]bool
	emailing map[string]bool
	cache    map[string]cachedStatus
	certs    map[string]*certState
	// pipelines caches the provision-tenant run per slug; stages remembers
	// which progress stages were seen done, so progress never goes back.
	pipelines map[string]pipelineView
	stages    map[string]*stageMemory
	// inflight holds the one computation running per slug; see
	// handleProvisionStatus.
	inflight map[string]*statusCall
}

// statusCall is one computation of a slug's status that concurrent callers
// wait on instead of starting their own.
type statusCall struct {
	done   chan struct{}
	status provisionStatus
	err    error
}

type cachedStatus struct {
	at     time.Time
	status provisionStatus
}

func newProvisioner() *provisioner {
	return &provisioner{watching: map[string]bool{}, emailing: map[string]bool{}, cache: map[string]cachedStatus{}, certs: map[string]*certState{},
		pipelines: map[string]pipelineView{}, stages: map[string]*stageMemory{}, inflight: map[string]*statusCall{}}
}

func (s *Server) tenantInternalURL(slug string) string {
	tpl := s.cfg.TenantInternalURL
	if tpl == "" {
		tpl = "http://bascula-api.bascula-%s.svc.cluster.local:8081"
	}
	return expandSlugTemplate(tpl, slug)
}

// expandSlugTemplate fills %s with the slug. A template without %s is used as
// is, which is what a test pointing at one stand-in server wants.
func expandSlugTemplate(tpl, slug string) string {
	if strings.Contains(tpl, "%s") {
		tpl = strings.ReplaceAll(tpl, "%s", slug)
	}
	return strings.TrimRight(tpl, "/")
}

func (s *Server) tenantPublicURL(slug string) string {
	tpl := s.cfg.TenantPublicURL
	if tpl == "" {
		tpl = "https://%s.bascula.engp.io"
	}
	return expandSlugTemplate(tpl, slug)
}

// watchTenant polls the new stack in the background until the farm has been
// copied into it, or gives up after ProvisionWatchFor. One watcher per slug.
func (s *Server) watchTenant(slug string) {
	if !s.dedicatedProvisioning() || slug == "" {
		return
	}
	s.prov.mu.Lock()
	if s.prov.watching[slug] {
		s.prov.mu.Unlock()
		return
	}
	s.prov.watching[slug] = true
	s.prov.mu.Unlock()

	go s.pollTenant(slug)
}

// pollTenant is watchTenant's background loop; it releases the slug when it
// stops.
func (s *Server) pollTenant(slug string) {
	defer func() {
		s.prov.mu.Lock()
		delete(s.prov.watching, slug)
		s.prov.mu.Unlock()
	}()
	every := s.cfg.ProvisionPollEvery
	if every <= 0 {
		every = 15 * time.Second
	}
	deadline := time.Now().Add(s.provisionWatchFor())
	for time.Now().Before(deadline) {
		if s.trySeedTenant(slug) {
			return
		}
		time.Sleep(every)
	}
	slog.Warn("tenant watch gave up", "slug", logsafe.Str(slug))
}

// trySeedTenant is one poll: it reports whether the stack is seeded, seeding
// it first when its database is up and it is not seeded yet.
func (s *Server) trySeedTenant(slug string) bool {
	info, err := s.tenantInfo(context.Background(), slug)
	if err != nil {
		return false
	}
	if info.Seeded {
		return true
	}
	if !info.Database {
		return false
	}
	if err := s.seedTenant(context.Background(), slug); err != nil {
		slog.Warn("tenant seed", "slug", logsafe.Str(slug), "err", logsafe.Str(err.Error()))
		return false
	}
	slog.Info("tenant seeded", "slug", logsafe.Str(slug))
	return true
}

func (s *Server) provisionWatchFor() time.Duration {
	if s.cfg.ProvisionWatchFor > 0 {
		return s.cfg.ProvisionWatchFor
	}
	return 45 * time.Minute
}

// tenantInfo is what the dedicated stack says about itself on its internal
// port. It answers only inside the cluster (see manifests/base/networkpolicy).
type tenantInfo struct {
	Slug     string `json:"slug"`
	Database bool   `json:"database"`
	Seeded   bool   `json:"seeded"`
}

func (s *Server) tenantInfo(ctx context.Context, slug string) (tenantInfo, error) {
	var out tenantInfo
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.tenantInternalURL(slug)+"/internal/tenant", nil)
	if err != nil {
		return out, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return out, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return out, fmt.Errorf("tenant info: status %d", res.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&out); err != nil {
		return out, err
	}
	if out.Slug != slug {
		return out, fmt.Errorf("tenant info: stack serves %q, not %q", out.Slug, slug)
	}
	return out, nil
}

// tenantSeed is everything the dedicated stack needs to open the farm with the
// same ids, the same owner and the same password as on the shared platform.
type tenantSeed struct {
	Farm struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		Slug       string `json:"slug"`
		Timezone   string `json:"timezone"`
		Currency   string `json:"currency"`
		PriceMinor int64  `json:"priceMinor"`
		// PriceConfirmed is whether the owner chose the price (migration
		// 00030). A pointer so a seed from an older platform, which never
		// sends it, reads as "chosen": before 00030 every price was.
		PriceConfirmed *bool `json:"priceConfirmed,omitempty"`
	} `json:"farm"`
	Members []tenantSeedMember `json:"members"`
}

type tenantSeedMember struct {
	ID              string     `json:"id"`
	Email           string     `json:"email"`
	Name            string     `json:"name"`
	Phone           string     `json:"phone"`
	PasswordHash    string     `json:"passwordHash"`
	EmailVerifiedAt *time.Time `json:"emailVerifiedAt"`
	Role            string     `json:"role"`
}

// farmBySlug is the token-less lookup behind migration 00029.
func farmBySlug(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, slug string) (farmID, ownerID string, createdAt time.Time, err error) {
	var owner *string
	err = q.QueryRow(ctx,
		`SELECT farm_id::text, owner_id::text, created_at FROM farm_by_slug($1)`, slug).
		Scan(&farmID, &owner, &createdAt)
	if owner != nil {
		ownerID = *owner
	}
	return
}

func (s *Server) buildTenantSeed(ctx context.Context, slug string) (*tenantSeed, error) {
	// This tx pins itself to the farm with set_config below.
	// nosemgrep: bascula-pool-query-outside-tenant-tx
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	farmID, ownerID, _, err := farmBySlug(ctx, tx, slug)
	if err != nil {
		return nil, err
	}
	if ownerID == "" {
		return nil, errors.New("farm has no owner")
	}
	if _, err := tx.Exec(ctx, `
		SELECT set_config('app.farm_id', $1, true),
		       set_config('app.user_id', $2, true),
		       set_config('app.role', 'owner', true)`, farmID, ownerID); err != nil {
		return nil, err
	}
	var seed tenantSeed
	if err := tx.QueryRow(ctx, `
		SELECT f.id::text, f.name, f.slug, f.timezone, f.currency, coalesce(c.price_minor, 0),
		       c.price_confirmed_at IS NOT NULL
		  FROM farms f LEFT JOIN farm_config c ON c.farm_id = f.id
		 WHERE f.id = $1`, farmID).Scan(&seed.Farm.ID, &seed.Farm.Name, &seed.Farm.Slug,
		&seed.Farm.Timezone, &seed.Farm.Currency, &seed.Farm.PriceMinor, &seed.Farm.PriceConfirmed); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT u.id::text, u.email,
		       coalesce(c.name, u.name), coalesce(c.phone, u.phone),
		       coalesce(c.password_hash, u.password_hash),
		       CASE WHEN c.user_id IS NULL THEN u.email_verified_at ELSE c.created_at END,
		       m.role::text
		  FROM memberships m JOIN users u ON u.id = m.user_id
		  -- A farm registered with an address that already had an account
		  -- carries the name and password typed on THAT registration
		  -- (migration 00032); its own stack gets those, never the account's.
		  LEFT JOIN farm_owner_credentials c ON c.farm_id = m.farm_id AND c.user_id = m.user_id
		 WHERE m.farm_id = $1
		 ORDER BY (m.role = 'owner') DESC, u.id`, farmID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m tenantSeedMember
		if err := rows.Scan(&m.ID, &m.Email, &m.Name, &m.Phone, &m.PasswordHash,
			&m.EmailVerifiedAt, &m.Role); err != nil {
			return nil, err
		}
		seed.Members = append(seed.Members, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(seed.Members) == 0 {
		return nil, errors.New("farm has no members")
	}
	return &seed, nil
}

// seedTenant pushes the farm into its dedicated stack. The stack refuses a
// seed for any slug but its own and never overwrites a farm it already has.
func (s *Server) seedTenant(ctx context.Context, slug string) error {
	seed, err := s.buildTenantSeed(ctx, slug)
	if err != nil {
		return err
	}
	body, err := json.Marshal(seed)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.tenantInternalURL(slug)+"/internal/tenant/seed", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentTypeJSON)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("seed: status %d: %s", res.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

// ---------------------------------------------------------------------------
// GET /v1/farms/{slug}/provision-status
// ---------------------------------------------------------------------------

type provisionStep struct {
	Key  string `json:"key"`
	Done bool   `json:"done"`
}

type provisionStatus struct {
	Slug           string          `json:"slug"`
	URL            string          `json:"url"`
	Dedicated      bool            `json:"dedicated"`
	Steps          []provisionStep `json:"steps"`
	Ready          bool            `json:"ready"`
	Slow           bool            `json:"slow"`
	ElapsedSeconds int64           `json:"elapsedSeconds"`
	// NotifyAvailable: this platform can email the owner when the farm is
	// ready (a mailer is configured). NotifyRequested: the owner asked.
	NotifyAvailable bool `json:"notifyAvailable"`
	NotifyRequested bool `json:"notifyRequested"`
	// CertificateError is the last problem asking Cloudflare for the farm's
	// certificate (API error or validation error), while it is not active.
	CertificateError string `json:"certificateError,omitempty"`
	// Stages are the weighted, monotonic progress stages; Percent their
	// done weight (100 only when Ready); Current the step in progress, in
	// plain Spanish. Source says where progress was read: "cluster",
	// "pipeline" (GitHub Actions, cluster unreadable) or "basic". Note, when
	// set, is a plain-Spanish line for the owner about missing detail.
	// AwaitingVerification: the owner has not opened the mailed link yet,
	// and the farm's own stack is not being built until they do.
	AwaitingVerification bool             `json:"awaitingVerification"`
	Stages               []provisionStage `json:"stages"`
	Percent              int              `json:"percent"`
	Current              string           `json:"current"`
	Source               string           `json:"source"`
	Note                 string           `json:"note,omitempty"`
}

// handleProvisionStatus answers the waiting screen. The caller just
// registered and has no session yet, so the route is public, but the answer is
// not: it names when the farm was created and how its certificate stands, so
// it goes only to the holder of the provision ticket signup handed back (or a
// super-admin). Everybody else gets the 404 of a slug that does not exist.
//
// Being public, it is also a lever: one computation is a call to the farm's
// stack, a TLS probe, about nine Kubernetes reads and, while the farm is being
// built, a GitHub API call on the dispatch token. So the answer is cached per
// slug (a few seconds while provisioning, a minute once ready), and callers
// that arrive while it is being computed wait for that computation instead of
// each starting their own. Before this, a hundred concurrent requests for one
// slug were a hundred computations, and enough of them spent the dispatch
// token's hourly GitHub quota that real signups could no longer provision.
func (s *Server) handleProvisionStatus(w http.ResponseWriter, r *http.Request) {
	slug, err := normalizeFarmSlug(chi.URLParam(r, "slug"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	// Only whoever created the farm (or a super-admin) may watch it; anybody
	// else gets exactly what a slug that does not exist gets, before the
	// database is asked. See farm_lookup.go.
	if !s.mayWatchProvision(r, slug) {
		writeError(w, r, errFarmNotFound())
		return
	}
	s.prov.mu.Lock()
	if c, ok := s.prov.cache[slug]; ok && time.Since(c.at) < provisionStatusTTL(c.status) {
		s.prov.mu.Unlock()
		writeJSON(w, http.StatusOK, c.status)
		return
	}
	call, running := s.prov.inflight[slug]
	if !running {
		call = &statusCall{done: make(chan struct{})}
		s.prov.inflight[slug] = call
	}
	s.prov.mu.Unlock()

	if !running {
		// Not tied to this caller's connection: others may be waiting on it.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 30*time.Second)
		call.status, call.err = s.provisionStatusFor(ctx, slug)
		cancel()
		s.prov.mu.Lock()
		delete(s.prov.inflight, slug)
		if call.err == nil {
			s.prov.cache[slug] = cachedStatus{at: time.Now(), status: call.status}
		}
		s.prov.mu.Unlock()
		close(call.done)
	}
	select {
	case <-call.done:
	case <-r.Context().Done():
		return
	}
	if call.err != nil {
		writeError(w, r, call.err)
		return
	}
	writeJSON(w, http.StatusOK, call.status)
}

// provisionStatusTTL is how long a computed status is served from the cache.
// A ready farm stays ready; there is nothing to watch closely.
func provisionStatusTTL(st provisionStatus) time.Duration {
	if st.Ready {
		return time.Minute
	}
	return 4 * time.Second
}

func (s *Server) provisionStatusFor(ctx context.Context, slug string) (provisionStatus, error) {
	_, _, createdAt, err := farmBySlug(ctx, s.pool, slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return provisionStatus{}, errFarmNotFound()
	}
	if err != nil {
		return provisionStatus{}, err
	}
	// Until its owner confirms the address there is nothing being built:
	// say so rather than show progress that is not coming.
	var awaiting bool
	// Pre-tenant: the public waiting screen has no farm tx yet, and
	// farm_awaiting_owner_email is a SECURITY DEFINER lookup by slug that
	// returns only a boolean.
	// nosemgrep: bascula-pool-query-outside-tenant-tx
	if err := s.pool.QueryRow(ctx, `SELECT farm_awaiting_owner_email($1)`, slug).Scan(&awaiting); err != nil {
		return provisionStatus{}, err
	}
	if awaiting {
		return provisionStatus{
			Slug: slug, URL: s.tenantPublicURL(slug), Dedicated: s.dedicatedProvisioning(),
			AwaitingVerification: true,
			Current:              "Esperando que confirme su correo.",
			Stages:               []provisionStage{}, Steps: []provisionStep{},
			ElapsedSeconds: int64(time.Since(createdAt).Seconds()),
		}, nil
	}
	st := s.computeProvisionStatus(ctx, slug, createdAt)
	st.NotifyAvailable = s.readyEmailAvailable()
	if st.NotifyAvailable {
		requested, sent := s.readyEmailState(ctx, slug)
		st.NotifyRequested = requested
		if st.Ready && requested && !sent {
			// Covers a restart that lost the watcher while the screen was
			// still open. The claim keeps it to one email.
			go s.sendReadyEmail(context.Background(), slug, st.URL)
		}
	}
	return st, nil
}

// computeProvisionStatus asks every step where it stands. Both the waiting
// screen and the ready-email watcher use it, so "ready" means one thing.
func (s *Server) computeProvisionStatus(ctx context.Context, slug string, createdAt time.Time) provisionStatus {
	st := provisionStatus{
		Slug:           slug,
		URL:            s.tenantPublicURL(slug),
		Dedicated:      s.dedicatedProvisioning(),
		ElapsedSeconds: int64(time.Since(createdAt).Seconds()),
	}
	database, app := true, true
	if st.Dedicated {
		info, err := s.tenantInfo(ctx, slug)
		database = err == nil && info.Database
		app = err == nil && info.Seeded
		if !app {
			// Covers a restart of this process, which forgets its watchers.
			s.watchTenant(slug)
		}
	}
	web := s.probePublic(ctx, st.URL)
	st.Steps = []provisionStep{
		{Key: "database", Done: database},
		{Key: "app", Done: app},
	}
	certificate := true
	if s.farmCertificates() {
		cs := s.certStateOf(slug)
		// Done only when Cloudflare itself says the custom hostname AND its
		// certificate are active. The address answering is not enough: the
		// wildcard route and Cloudflare's cache can answer /health for a
		// hostname whose certificate is still pending. When the certificate
		// is not active, (re)start the watcher; that also covers a restart
		// of this process and a hostname whose creation failed.
		certificate = cs.Active
		if !certificate {
			s.ensureFarmCertificate(slug)
			st.CertificateError = cs.Error
		}
		st.Steps = append(st.Steps, provisionStep{Key: "certificate", Done: certificate})
	}
	st.Steps = append(st.Steps, provisionStep{Key: "web", Done: web})
	// Never ready without a certificate a browser accepts: Cloudflare says it
	// is active and a strictly verified TLS request to the real hostname
	// answered 200.
	st.Ready = database && app && certificate && web
	s.fillStages(ctx, &st, createdAt, database, app, certificate, web)
	st.Slow = !st.Ready && time.Since(createdAt) > s.provisionSlowAfter()
	return st
}

func (s *Server) provisionSlowAfter() time.Duration {
	if s.cfg.ProvisionSlowAfter > 0 {
		return s.cfg.ProvisionSlowAfter
	}
	return 15 * time.Minute
}

// strictProbeClient verifies the certificate chain against the system roots
// and the request's own hostname, the way a browser does. Never skip
// verification here: a farm whose certificate a browser rejects is not ready.
func strictProbeClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	tr.DisableKeepAlives = true
	return &http.Client{
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// probePublic asks the farm's own address for /health the way a browser would:
// real DNS, strictly verified TLS for the real hostname, past any cache.
// Anything but a 200 is "not yet".
func (s *Server) probePublic(ctx context.Context, base string) bool {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	// A unique query string so Cloudflare's cache (which keeps /health for
	// an hour) cannot answer for the origin.
	probe := fmt.Sprintf("%s/health?probe=%d", base, time.Now().UnixNano())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, probe, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Cache-Control", "no-cache")
	client := s.cfg.PublicProbeClient
	if client == nil {
		client = strictProbeClient()
	}
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	return res.StatusCode == http.StatusOK
}

// ---------------------------------------------------------------------------
// GET /v1/farm-slugs?slug=
// ---------------------------------------------------------------------------

// handleSlugAvailability lets the signup form say "that address is taken"
// while the owner is still typing, instead of after they press the button.
//
// It is an oracle for one exact slug by nature — that is its job — so it is
// metered per client address: checking one address as it is typed is a few
// calls, testing a dictionary of farm names is thousands. It never lists.
func (s *Server) handleSlugAvailability(w http.ResponseWriter, r *http.Request) {
	if !s.allowFarmLookup(w, r) {
		return
	}
	raw := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("slug")))
	slug, err := normalizeFarmSlug(raw)
	if err != nil {
		reason := "invalid"
		if reservedFarmSlug(raw) {
			reason = "reserved"
		}
		writeJSON(w, http.StatusOK, map[string]any{"slug": raw, "available": false, "reason": reason})
		return
	}
	_, _, _, err = farmBySlug(r.Context(), s.pool, slug)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeJSON(w, http.StatusOK, map[string]any{"slug": slug, "available": true})
	case err != nil:
		writeError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"slug": slug, "available": false, "reason": "taken"})
	}
}

// handleFarmName answers the display name of the farm whose address this is:
// "San José" for san-jose.bascula.engp.io, so the front door stops greeting
// people with a DNS label. The farm is the one named by the request's host;
// `?slug=` names it where the host cannot (the main domain, development,
// tests). A dedicated stack falls back to the farm it serves. Public, like the
// page it feeds; it says nothing that page does not already show.
//
// A dedicated stack only knows its own farm, so there it reveals nothing
// about any other. The shared platform knows every farm, and there the
// lookup is metered like the availability check: the host is the caller's
// to choose (X-Forwarded-Host, ?slug=), so it is a slug oracle too.
func (s *Server) handleFarmName(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TenantSlug == "" && !s.allowFarmLookup(w, r) {
		return
	}
	raw := farmSlugFromHost(r)
	if raw == "" {
		raw = strings.ToLower(strings.TrimSpace(r.URL.Query().Get("slug")))
	}
	if raw == "" {
		raw = s.cfg.TenantSlug
	}
	slug, err := normalizeFarmSlug(raw)
	if err != nil {
		writeError(w, r, errFarmNotFound())
		return
	}
	var name *string
	// farm_display_name is a SECURITY DEFINER lookup by slug, public by design.
	// nosemgrep: bascula-pool-query-outside-tenant-tx
	if err := s.pool.QueryRow(r.Context(), `SELECT farm_display_name($1)`, slug).Scan(&name); err != nil {
		writeError(w, r, err)
		return
	}
	if name == nil || strings.TrimSpace(*name) == "" {
		writeError(w, r, errFarmNotFound())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"slug": slug, "name": strings.TrimSpace(*name)})
}
