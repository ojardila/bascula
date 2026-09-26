package httpapi

import (
	"context"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/ojardila/bascula/services/api/internal/cfsaas"
)

// A farm address such as https://sanjose.bascula.engp.io is two levels below
// engp.io, which the free Universal SSL certificate (*.engp.io) does not
// cover. With Cloudflare for SaaS configured (CF_SAAS_TOKEN + CF_ZONE_ID) the
// platform asks Cloudflare for a custom hostname — and so a certificate — per
// farm when the farm is created, and the waiting screen shows it as a step.
//
// Without the token nothing here runs: no calls, no extra step, and the
// provision status is exactly what it was before.

// certState is what the platform last heard from Cloudflare about one farm.
type certState struct {
	ID      string
	Active  bool
	Failed  bool
	Summary string
	// Error is the last problem: a failed Cloudflare call or the
	// validation errors Cloudflare reports. Empty once active.
	Error    string
	Checked  time.Time
	Watching bool
}

func (s *Server) cfSaaS() *cfsaas.Client {
	c := &cfsaas.Client{
		Token:   s.cfg.CloudflareSaaSToken,
		ZoneID:  s.cfg.CloudflareZoneID,
		BaseURL: s.cfg.CloudflareAPIURL,
		Method:  s.cfg.CloudflareDCVMethod,
	}
	if !c.Enabled() {
		return nil
	}
	return c
}

// farmCertificates reports whether this deployment issues a certificate per
// farm address.
func (s *Server) farmCertificates() bool { return s.cfSaaS() != nil }

// farmHostname is the host part of the farm's public address.
func (s *Server) farmHostname(slug string) string {
	u, err := url.Parse(s.tenantPublicURL(slug))
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

func (s *Server) certStateOf(slug string) certState {
	s.prov.mu.Lock()
	defer s.prov.mu.Unlock()
	if st, ok := s.prov.certs[slug]; ok {
		return *st
	}
	return certState{}
}

func (s *Server) setCertState(slug string, h *cfsaas.Hostname, watching bool) {
	s.prov.mu.Lock()
	defer s.prov.mu.Unlock()
	st, ok := s.prov.certs[slug]
	if !ok {
		st = &certState{}
		s.prov.certs[slug] = st
	}
	st.Watching = watching
	if h != nil {
		st.ID, st.Active, st.Failed, st.Summary = h.ID, h.Active(), h.Failed(), h.Summary()
		st.Checked = time.Now()
		st.Error = ""
		if !h.Active() && strings.Contains(h.Summary(), " errors=") {
			st.Error = h.Summary()
		}
	}
}

// setCertError records a failed Cloudflare call so the status can show it.
func (s *Server) setCertError(slug string, err error) {
	s.prov.mu.Lock()
	defer s.prov.mu.Unlock()
	if st, ok := s.prov.certs[slug]; ok && !st.Active {
		st.Error = err.Error()
		st.Checked = time.Now()
	}
}

// ensureFarmCertificate creates the farm's custom hostname if it does not
// exist and watches it in the background until Cloudflare serves its
// certificate, or gives up after ProvisionWatchFor. One watcher per slug;
// calling it again while one runs does nothing.
func (s *Server) ensureFarmCertificate(slug string) {
	c := s.cfSaaS()
	host := s.farmHostname(slug)
	if c == nil || slug == "" || host == "" {
		return
	}
	s.prov.mu.Lock()
	if st, ok := s.prov.certs[slug]; ok && (st.Watching || st.Active) {
		s.prov.mu.Unlock()
		return
	}
	if s.prov.certs[slug] == nil {
		s.prov.certs[slug] = &certState{}
	}
	s.prov.certs[slug].Watching = true
	s.prov.mu.Unlock()

	go func() {
		var last *cfsaas.Hostname
		defer func() { s.setCertState(slug, last, false) }()
		every := s.cfg.ProvisionPollEvery
		if every <= 0 {
			every = 15 * time.Second
		}
		revalidateAfter := 2 * time.Minute
		if every < time.Second {
			revalidateAfter = 5 * every
		}
		started := time.Now()
		revalidated := false
		var lastRevalidate time.Time
		deadline := started.Add(s.provisionWatchFor())
		for time.Now().Before(deadline) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			var h *cfsaas.Hostname
			var err error
			if last == nil || last.ID == "" {
				h, err = c.Ensure(ctx, host)
				if err == nil && h != nil {
					slog.Info("farm hostname requested", "slug", slug, "hostname", host, "state", h.Summary())
				}
			} else {
				h, err = c.Get(ctx, last.ID)
			}
			cancel()
			if err != nil {
				// Retried on the next tick; the status shows the error.
				slog.Warn("farm hostname", "slug", slug, "hostname", host, "err", err)
				s.setCertError(slug, err)
			} else if h != nil {
				last = h
				s.setCertState(slug, h, true)
				if h.Active() {
					slog.Info("farm certificate active", "slug", slug, "hostname", host)
					return
				}
				// A failed or timed-out certificate never fixes itself: ask
				// Cloudflare to issue it again (at most once per revalidate
				// window) instead of giving up and leaving the farm without
				// one. HTTP validation also needs the hostname to point at the
				// zone when Cloudflare checks; ask once more if still pending.
				if h.Failed() {
					slog.Warn("farm certificate failed; asking again", "slug", slug, "state", h.Summary())
				}
				if (h.Failed() && time.Since(lastRevalidate) > revalidateAfter) ||
					(!revalidated && time.Since(started) > revalidateAfter) {
					lastRevalidate = time.Now()
					revalidated = true
					ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
					if _, err := c.Revalidate(ctx, h.ID); err != nil {
						slog.Warn("farm hostname revalidate", "slug", slug, "err", err)
					}
					cancel()
				}
			}
			time.Sleep(every)
		}
		slog.Warn("farm certificate watch gave up", "slug", slug, "state", last.Summary())
	}()
}
