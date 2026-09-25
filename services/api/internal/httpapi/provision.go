package httpapi

import (
	"bytes"
	"context"
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

	"github.com/ojardila/bascula/services/api/internal/domain"
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

// kickTenantProvision asks GitHub Actions to commit a dedicated tenant into
// gitops. Argo then creates namespace, Postgres and API/web pods. Failures
// are logged: the farm already exists on the shared platform.
func (s *Server) kickTenantProvision(p tenantProvision) {
	if !s.dedicatedProvisioning() || p.Slug == "" {
		return
	}
	token := strings.TrimSpace(s.cfg.GitHubDispatchToken)
	repo := strings.TrimSpace(s.cfg.GitHubDispatchRepo)
	api := strings.TrimRight(s.cfg.GitHubAPIURL, "/")
	if api == "" {
		api = "https://api.github.com"
	}
	go func() {
		body, err := json.Marshal(map[string]any{
			"event_type": "provision-tenant",
			"client_payload": map[string]string{
				"slug":      p.Slug,
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
		req.Header.Set("Content-Type", "application/json")
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
	cache    map[string]cachedStatus
}

type cachedStatus struct {
	at     time.Time
	status provisionStatus
}

func newProvisioner() *provisioner {
	return &provisioner{watching: map[string]bool{}, cache: map[string]cachedStatus{}}
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

	go func() {
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
			info, err := s.tenantInfo(context.Background(), slug)
			if err == nil && info.Seeded {
				return
			}
			if err == nil && info.Database {
				if err := s.seedTenant(context.Background(), slug); err != nil {
					slog.Warn("tenant seed", "slug", slug, "err", err)
				} else {
					slog.Info("tenant seeded", "slug", slug)
					return
				}
			}
			time.Sleep(every)
		}
		slog.Warn("tenant watch gave up", "slug", slug)
	}()
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
		SELECT f.id::text, f.name, f.slug, f.timezone, f.currency, coalesce(c.price_minor, 0)
		  FROM farms f LEFT JOIN farm_config c ON c.farm_id = f.id
		 WHERE f.id = $1`, farmID).Scan(&seed.Farm.ID, &seed.Farm.Name, &seed.Farm.Slug,
		&seed.Farm.Timezone, &seed.Farm.Currency, &seed.Farm.PriceMinor); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT u.id::text, u.email, u.name, u.phone, u.password_hash, u.email_verified_at, m.role::text
		  FROM memberships m JOIN users u ON u.id = m.user_id
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
	req.Header.Set("Content-Type", "application/json")
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
}

// handleProvisionStatus answers the waiting screen. It is public: the caller
// just registered and has no session yet, and everything it reveals — whether
// a web address answers — is something anybody can find out with a browser.
// The result is cached for a few seconds per slug so a screen polling every
// few seconds costs one probe, not one per tab.
func (s *Server) handleProvisionStatus(w http.ResponseWriter, r *http.Request) {
	slug, err := normalizeFarmSlug(chi.URLParam(r, "slug"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	s.prov.mu.Lock()
	c, ok := s.prov.cache[slug]
	s.prov.mu.Unlock()
	if ok && time.Since(c.at) < 4*time.Second {
		writeJSON(w, http.StatusOK, c.status)
		return
	}

	_, _, createdAt, err := farmBySlug(r.Context(), s.pool, slug)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, domain.NotFound("farm not found"))
		return
	}
	if err != nil {
		writeError(w, r, err)
		return
	}

	st := provisionStatus{
		Slug:           slug,
		URL:            s.tenantPublicURL(slug),
		Dedicated:      s.dedicatedProvisioning(),
		ElapsedSeconds: int64(time.Since(createdAt).Seconds()),
	}
	database, app := true, true
	if st.Dedicated {
		info, err := s.tenantInfo(r.Context(), slug)
		database = err == nil && info.Database
		app = err == nil && info.Seeded
		if !app {
			// Covers a restart of this process, which forgets its watchers.
			s.watchTenant(slug)
		}
	}
	web := s.probePublic(r.Context(), st.URL)
	st.Steps = []provisionStep{
		{Key: "database", Done: database},
		{Key: "app", Done: app},
		{Key: "web", Done: web},
	}
	st.Ready = database && app && web
	st.Slow = !st.Ready && time.Since(createdAt) > s.provisionSlowAfter()

	s.prov.mu.Lock()
	s.prov.cache[slug] = cachedStatus{at: time.Now(), status: st}
	s.prov.mu.Unlock()
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) provisionSlowAfter() time.Duration {
	if s.cfg.ProvisionSlowAfter > 0 {
		return s.cfg.ProvisionSlowAfter
	}
	return 15 * time.Minute
}

// probePublic asks the farm's own address for /health the way a browser would:
// real DNS, real TLS. Anything but a 200 is "not yet".
func (s *Server) probePublic(ctx context.Context, base string) bool {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/health", nil)
	if err != nil {
		return false
	}
	client := s.cfg.PublicProbeClient
	if client == nil {
		client = &http.Client{
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
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
func (s *Server) handleSlugAvailability(w http.ResponseWriter, r *http.Request) {
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
