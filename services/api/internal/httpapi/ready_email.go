package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/mailer"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// "Avísenme por correo cuando esté lista". The owner on the waiting screen
// can ask for one email when the farm's own address is ready, and close the
// page. It exists only where a mailer is configured (SMTP_HOST + SMTP_FROM):
// without one the status says notifyAvailable=false, the screen hides the
// option, and POST answers 404.
//
// The email goes to the farm OWNER's address, never to one the caller names,
// and at most once per farm (farm_ready_email_claim in migration 00031). So
// the endpoint can stay public, like the status it sits beside: the worst a
// stranger can do with it is make the owner of a farm created minutes ago
// receive the one message that farm would have received anyway.

func (s *Server) readyEmailAvailable() bool { return s.cfg.Mailer != nil }

// POST /v1/farms/{slug}/ready-email
func (s *Server) handleRequestReadyEmail(w http.ResponseWriter, r *http.Request) {
	if !s.readyEmailAvailable() {
		writeError(w, r, domain.NotFound("email notices are not available here"))
		return
	}
	slug, err := normalizeFarmSlug(chi.URLParam(r, "slug"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	_, _, createdAt, err := farmBySlug(r.Context(), tx, slug)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, domain.NotFound("farm not found"))
		return
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	// Only while the farm is being prepared. An old farm has nothing to
	// announce, and refusing keeps this from being a way to mail its owner.
	if time.Since(createdAt) > s.provisionWatchFor() {
		writeError(w, r, domain.BadRequest("this farm is no longer being prepared"))
		return
	}
	if _, err := tx.Exec(r.Context(), `SELECT farm_ready_email_request($1)`, slug); err != nil {
		writeError(w, r, err)
		return
	}
	s.forgetStatus(slug)
	tenant.AfterRequest(r.Context(), func(context.Context) { s.watchReadyEmail(slug, createdAt) })
	writeJSON(w, http.StatusAccepted, map[string]any{"slug": slug, "requested": true})
}

func (s *Server) forgetStatus(slug string) {
	s.prov.mu.Lock()
	delete(s.prov.cache, slug)
	s.prov.mu.Unlock()
}

// readyEmailState is what the status tells the screen about the notice.
func (s *Server) readyEmailState(ctx context.Context, slug string) (requested, sent bool) {
	if !s.readyEmailAvailable() {
		return false, false
	}
	err := s.pool.QueryRow(ctx, `SELECT requested, sent FROM farm_ready_email_state($1)`, slug).
		Scan(&requested, &sent)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("ready email state", "slug", slug, "err", err)
	}
	return requested, sent
}

// watchReadyEmail checks the farm in the background until it is ready and
// sends the notice, or gives up when the provisioning budget runs out. One
// watcher per slug.
func (s *Server) watchReadyEmail(slug string, createdAt time.Time) {
	if !s.readyEmailAvailable() || slug == "" {
		return
	}
	s.prov.mu.Lock()
	if s.prov.emailing[slug] {
		s.prov.mu.Unlock()
		return
	}
	s.prov.emailing[slug] = true
	s.prov.mu.Unlock()

	go func() {
		defer func() {
			s.prov.mu.Lock()
			delete(s.prov.emailing, slug)
			s.prov.mu.Unlock()
		}()
		every := s.cfg.ProvisionPollEvery
		if every <= 0 {
			every = 15 * time.Second
		}
		deadline := createdAt.Add(s.provisionWatchFor())
		for time.Now().Before(deadline) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			st := s.computeProvisionStatus(ctx, slug, createdAt)
			cancel()
			if st.Ready {
				s.sendReadyEmail(context.Background(), slug, st.URL)
				return
			}
			time.Sleep(every)
		}
		slog.Warn("ready email: farm not ready in time, nothing sent", "slug", slug)
	}()
}

// ResumeReadyEmails restarts the watchers a previous process left behind.
// cmd/api calls it once at boot; it does nothing without a mailer.
func (s *Server) ResumeReadyEmails(ctx context.Context) {
	if !s.readyEmailAvailable() {
		return
	}
	rows, err := s.pool.Query(ctx, `SELECT farm_ready_email_pending($1)`,
		time.Now().Add(-s.provisionWatchFor()))
	if err != nil {
		slog.Warn("ready email resume", "err", err)
		return
	}
	var slugs []string
	for rows.Next() {
		var slug string
		if rows.Scan(&slug) == nil {
			slugs = append(slugs, slug)
		}
	}
	rows.Close()
	for _, slug := range slugs {
		_, _, createdAt, err := farmBySlug(ctx, s.pool, slug)
		if err == nil {
			s.watchReadyEmail(slug, createdAt)
		}
	}
}

// sendReadyEmail claims the notice and sends it. The claim is what makes it
// at most once: two watchers, or a watcher and a polling screen, race for one
// row and only one gets an address back. A failed send releases the claim so
// the next check tries again.
func (s *Server) sendReadyEmail(ctx context.Context, slug, url string) {
	if !s.readyEmailAvailable() {
		return
	}
	var email, ownerName, farmName string
	err := s.pool.QueryRow(ctx, `SELECT email, owner_name, farm_name FROM farm_ready_email_claim($1)`, slug).
		Scan(&email, &ownerName, &farmName)
	if errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err != nil {
		slog.Warn("ready email claim", "slug", slug, "err", err)
		return
	}
	msg := readyEmailMessage(email, ownerName, farmName, url)
	sendCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	if err := s.cfg.Mailer.Send(sendCtx, msg); err != nil {
		slog.Error("ready email send", "slug", slug, "err", err)
		if _, rerr := s.pool.Exec(context.Background(), `SELECT farm_ready_email_release($1)`, slug); rerr != nil {
			slog.Error("ready email release", "slug", slug, "err", rerr)
		}
		return
	}
	s.forgetStatus(slug)
	slog.Info("ready email sent", "slug", slug)
}

// readyEmailMessage is the notice, in plain Spanish for somebody who does
// not read screens for a living: what happened, the one link, what to type.
func readyEmailMessage(to, ownerName, farmName, url string) mailer.Message {
	hello := "Hola,"
	if n := strings.TrimSpace(ownerName); n != "" {
		hello = "Hola, " + n + ":"
	}
	name := strings.TrimSpace(farmName)
	if name == "" {
		name = "su finca"
	}
	link := strings.TrimRight(url, "/") + "/entrar"
	body := fmt.Sprintf(`%s

Su finca %s ya está lista. Ya puede entrar en su propia dirección:

%s

Entre con el mismo correo y la misma clave que usó al registrarse.

Guarde esta dirección para volver a entrar cuando quiera.

Báscula
`, hello, name, link)
	return mailer.Message{To: to, Subject: "Su finca ya está lista", Body: body}
}
