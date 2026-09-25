package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// InternalHandler is the second listener a DEDICATED stack runs (cfg.TenantSlug
// set). It is not behind the Gateway: the Service exposes it on port 8081 and
// the CiliumNetworkPolicy lets only the platform API pods reach it. It answers
// two questions and accepts one write:
//
//	GET  /internal/tenant       which farm this stack is for, and has it arrived
//	POST /internal/tenant/seed  the farm, its members and their password hashes
//
// The seed is accepted only for this stack's own slug and only while the farm
// is not there yet, so a second push is a no-op and never an overwrite.
func (s *Server) InternalHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/tenant", s.handleInternalTenant)
	mux.HandleFunc("POST /internal/tenant/seed", s.handleInternalSeed)
	return mux
}

func (s *Server) tenantSeeded(ctx context.Context) (bool, error) {
	_, _, _, err := farmBySlug(ctx, s.pool, s.cfg.TenantSlug)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Server) handleInternalTenant(w http.ResponseWriter, r *http.Request) {
	seeded, err := s.tenantSeeded(r.Context())
	writeJSON(w, http.StatusOK, tenantInfo{
		Slug:     s.cfg.TenantSlug,
		Database: err == nil,
		Seeded:   seeded,
	})
}

func (s *Server) handleInternalSeed(w http.ResponseWriter, r *http.Request) {
	var seed tenantSeed
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&seed); err != nil {
		writeError(w, r, domain.BadRequest("seed is not valid JSON"))
		return
	}
	if seed.Farm.Slug != s.cfg.TenantSlug || s.cfg.TenantSlug == "" {
		writeError(w, r, domain.Forbidden("this stack serves another farm"))
		return
	}
	if seed.Farm.ID == "" || len(seed.Members) == 0 {
		writeError(w, r, domain.BadRequest("seed needs a farm id and at least one member"))
		return
	}
	var owner *tenantSeedMember
	for i := range seed.Members {
		if seed.Members[i].Role == string(domain.RoleOwner) {
			owner = &seed.Members[i]
			break
		}
	}
	if owner == nil {
		writeError(w, r, domain.BadRequest("seed needs an owner"))
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, _, _, err := farmBySlug(ctx, tx, seed.Farm.Slug); err == nil {
		writeJSON(w, http.StatusOK, map[string]any{"seeded": true, "created": false})
		return
	} else if !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, err)
		return
	}

	for _, m := range seed.Members {
		existing, err := store.FindUserByEmail(ctx, tx, m.Email)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, r, err)
			return
		}
		if existing != nil {
			continue
		}
		if err := store.CreateUser(ctx, tx, store.User{
			ID: m.ID, Email: m.Email, Name: m.Name, Phone: m.Phone, PasswordHash: m.PasswordHash,
		}); err != nil {
			writeError(w, r, err)
			return
		}
		if m.EmailVerifiedAt != nil {
			if err := store.VerifyUserEmail(ctx, tx, m.ID); err != nil {
				writeError(w, r, err)
				return
			}
		}
	}

	fctx, err := tenant.SetForSignup(ctx, tx, seed.Farm.ID, owner.ID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	price := seed.Farm.PriceMinor
	if price <= 0 {
		price = 80000
	}
	if err := store.CreateFarm(fctx, tx, store.NewFarm{
		ID: seed.Farm.ID, Name: seed.Farm.Name, Slug: seed.Farm.Slug,
		Timezone: seed.Farm.Timezone, Currency: seed.Farm.Currency, PriceMinor: price,
	}); err != nil {
		writeError(w, r, err)
		return
	}
	for _, m := range seed.Members {
		u, err := store.FindUserByEmail(fctx, tx, m.Email)
		if err != nil {
			writeError(w, r, err)
			return
		}
		if err := store.CreateMembership(fctx, tx, seed.Farm.ID, u.ID, domain.Role(m.Role)); err != nil {
			writeError(w, r, err)
			return
		}
	}
	if err := seedFarm(fctx, tx, seed.Farm.ID, price); err != nil {
		writeError(w, r, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, r, err)
		return
	}
	slog.Info("tenant seeded from platform", "slug", seed.Farm.Slug, "members", len(seed.Members))
	writeJSON(w, http.StatusCreated, map[string]any{"seeded": true, "created": true})
}
