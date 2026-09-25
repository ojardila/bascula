package httpapi

import (
	"context"
	"net"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
)

// farms.slug: 2–63 lowercase letters, digits and single hyphens, matching the
// DNS label a host like sanjose.bascula.engp.io carries.
var farmSlugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

var reservedFarmSlugs = map[string]struct{}{
	"www": {}, "api": {}, "admin": {}, "mcp": {}, "app": {}, "int": {},
	"bascula": {}, "static": {}, "assets": {}, "health": {}, "oauth": {},
	"well-known": {}, "mail": {}, "staging": {}, "prod": {}, "dev": {},
}

const (
	prodFarmHostApex   = "bascula.engp.io"
	prodFarmHostSuffix = ".bascula.engp.io"
	devFarmHostApex    = "bascula.int.dev.engp.io"
	devFarmHostSuffix  = ".int.dev.engp.io"
)

func reservedFarmSlug(slug string) bool {
	_, ok := reservedFarmSlugs[slug]
	return ok
}

func slugifyFarmName(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	b.Grow(len(s))
	dash := false
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if ok {
			b.WriteRune(r)
			dash = false
			continue
		}
		if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	s = strings.Trim(b.String(), "-")
	if len(s) > 63 {
		s = strings.TrimRight(s[:63], "-")
	}
	return s
}

// normalizeFarmSlug lowercases a caller-supplied slug and refuses anything
// the CHECK would reject, or a reserved label.
func normalizeFarmSlug(raw string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if !farmSlugPattern.MatchString(s) || len(s) < 2 || len(s) > 63 {
		return "", domain.BadRequest("slug must be 2–63 lowercase letters, digits and hyphens")
	}
	if reservedFarmSlug(s) {
		return "", domain.BadRequest("that slug is reserved")
	}
	return s, nil
}

func farmIDPrefix(id string, n int) string {
	if n <= 8 && len(id) >= 8 {
		return id[:8]
	}
	hex := strings.ReplaceAll(id, "-", "")
	if n < 8 {
		n = 8
	}
	if n > len(hex) {
		n = len(hex)
	}
	if n == 0 {
		return id
	}
	return hex[:n]
}

func uniquifyFarmSlug(base, id string, extra int) string {
	suf := farmIDPrefix(id, 8+4*extra)
	if base == "" {
		return suf
	}
	out := base + "-" + suf
	if len(out) <= 63 {
		return out
	}
	keep := 63 - 1 - len(suf)
	if keep < 1 {
		return suf
	}
	trimmed := strings.TrimRight(base[:keep], "-")
	if trimmed == "" {
		return suf
	}
	return trimmed + "-" + suf
}

func generateFarmSlug(name, id string) string {
	base := slugifyFarmName(name)
	if base == "" || len(base) < 2 || reservedFarmSlug(base) {
		return uniquifyFarmSlug(base, id, 0)
	}
	return base
}

func resolveCreateSlug(name, id, requested string) (string, error) {
	if strings.TrimSpace(requested) != "" {
		return normalizeFarmSlug(requested)
	}
	return generateFarmSlug(name, id), nil
}

// createFarmRecord inserts the farm, generating a slug when the caller omitted
// one and retrying with an id suffix if that slug is taken. A caller-supplied
// slug that collides is 409, not retried.
func createFarmRecord(ctx context.Context, tx pgx.Tx, f *store.NewFarm, requested string) error {
	slug, err := resolveCreateSlug(f.Name, f.ID, requested)
	if err != nil {
		return err
	}
	f.Slug = slug
	explicit := strings.TrimSpace(requested) != ""
	for attempt := 0; attempt < 6; attempt++ {
		// A unique violation aborts the transaction. The savepoint lets a
		// generated slug that collided be retried without killing the signup.
		if _, err := tx.Exec(ctx, `SAVEPOINT farm_slug`); err != nil {
			return err
		}
		err := store.CreateFarm(ctx, tx, *f)
		if err == nil {
			_, _ = tx.Exec(ctx, `RELEASE SAVEPOINT farm_slug`)
			return nil
		}
		if _, rb := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT farm_slug`); rb != nil {
			return err
		}
		if store.IsUniqueViolation(err, "farms_slug_key") {
			if explicit {
				return domain.Conflict(domain.CodeConflict, "that slug is already in use")
			}
			f.Slug = uniquifyFarmSlug(slugifyFarmName(f.Name), f.ID, attempt+1)
			continue
		}
		return err
	}
	return domain.Conflict(domain.CodeConflict, "that slug is already in use")
}

func requestHostname(r *http.Request) string {
	h := r.Header.Get("X-Forwarded-Host")
	if h == "" {
		h = r.Host
	}
	if i := strings.IndexByte(h, ','); i >= 0 {
		h = h[:i]
	}
	h = strings.TrimSpace(h)
	if host, _, err := net.SplitHostPort(h); err == nil {
		return host
	}
	return strings.Trim(h, "[]")
}

func labelBefore(host, suffix string) (string, bool) {
	if !strings.HasSuffix(host, suffix) {
		return "", false
	}
	label := strings.TrimSuffix(host, suffix)
	if label == "" || strings.Contains(label, ".") {
		return "", false
	}
	return label, true
}

// farmSlugFromHost is the login pin. `{slug}.bascula.engp.io` names a farm;
// `{slug}.int.dev.engp.io` does too unless the first label is `bascula` (the
// apex). localhost and the two apex hosts pin nothing.
func farmSlugFromHost(r *http.Request) string {
	host := strings.ToLower(requestHostname(r))
	switch host {
	case "", "localhost", "127.0.0.1", "::1", prodFarmHostApex, devFarmHostApex:
		return ""
	}
	if slug, ok := labelBefore(host, prodFarmHostSuffix); ok {
		return slug
	}
	if slug, ok := labelBefore(host, devFarmHostSuffix); ok {
		if slug == "bascula" {
			return ""
		}
		return slug
	}
	return ""
}

// FarmSlugFromURL is the farm a dedicated stack serves, read off its public
// base URL (https://lapalma.bascula.engp.io -> "lapalma"). Empty when the URL
// names no farm.
func FarmSlugFromURL(raw string) string {
	host := strings.ToLower(strings.TrimSpace(raw))
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	if i := strings.IndexAny(host, "/?#"); i >= 0 {
		host = host[:i]
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	for _, suffix := range []string{prodFarmHostSuffix, devFarmHostSuffix} {
		if slug, ok := labelBefore(host, suffix); ok && slug != "bascula" {
			if s, err := normalizeFarmSlug(slug); err == nil {
				return s
			}
		}
	}
	return ""
}
