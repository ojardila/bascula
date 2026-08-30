package apitest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/httpapi"
)

// The client address, and who is allowed to tell us what it is.
//
// Every other test in this package runs against the shared server, whose
// signup caps are set to 1000 so they stay out of the way. A test about a cap
// needs the cap, so these build their own server on the same pool — same
// database, same migrations, different Config. signup_attempts is not scoped
// to a farm and every other test signs up from 10.0.0.1, so each test here
// also picks a socket address of its own out of RFC 5737's TEST-NET-3 and
// counts only its own rows.

// longEnoughPassword clears handleSignup's ten-character floor and is
// otherwise meaningless: these tests count signup attempts, and none of the
// accounts they create is ever logged into.
func longEnoughPassword() string { return uuid.NewString() }

func (h *harness) serverWithConfig(t *testing.T, mutate func(cfg *httpapi.Config)) *httpapi.Server {
	t.Helper()
	cfg := httpapi.DefaultConfig()
	cfg.DevEcho = true
	cfg.UploadDir = t.TempDir()
	cfg.MaxFarmsPerEmail = 3
	// The per-email cap is not what these tests are about, and every signup
	// below uses a fresh address anyway.
	cfg.SignupsPerEmailPerHour = 1000
	mutate(&cfg)
	// A signing key of its own, and a random one: nothing here issues a token,
	// let alone parses one. Every request below stops at POST /v1/signup, which
	// answers before there is a session to sign.
	return httpapi.New(h.pool, auth.NewSigner([]byte(uuid.NewString()), "bascula"), cfg)
}

// signupFrom posts a valid signup from one socket address with the given
// headers, and returns the response together with the address it registered so
// the caller can go and read the row it left behind.
func signupFrom(t *testing.T, srv *httpapi.Server, remoteAddr string, headers map[string]string) (response, string) {
	t.Helper()
	email := fmt.Sprintf("clientip-%s@example.com", uuid.NewString()[:12])
	body, err := json.Marshal(map[string]any{
		"farm": map[string]any{
			"name": "Finca del limite", "timezone": "America/Bogota",
			"currency": "COP", "priceCents": 100000,
		},
		"owner": map[string]any{
			"email": email, "name": "Owner", "password": longEnoughPassword(),
		},
	})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/signup", strings.NewReader(string(body)))
	req.RemoteAddr = remoteAddr
	req.Header.Set("Content-Type", "application/json")
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	out := response{Status: rec.Code, Raw: rec.Body.String()}
	if out.Raw != "" {
		_ = json.Unmarshal([]byte(out.Raw), &out.Body)
	}
	return out, email
}

// recordedSignupIP reads back what signup_attempts stored, which is the half of
// this that matters after the fact: the rate limit stops an attack in progress,
// the table is the only evidence there was one.
func (h *harness) recordedSignupIP(t *testing.T, email string) string {
	t.Helper()
	var ip string
	err := h.admin.QueryRow(context.Background(),
		`SELECT host(ip) FROM signup_attempts WHERE email = $1`, email).Scan(&ip)
	if err != nil {
		t.Fatalf("read signup_attempts for %s: %v", email, err)
	}
	return ip
}

// TestForwardingHeadersCannotBuyAFreshRateLimitBucket is the regression.
//
// With middleware.RealIP in the chain, chi overwrote r.RemoteAddr with
// True-Client-IP, X-Real-IP or the leftmost X-Forwarded-For before clientIP
// ever looked at it, and no proxy anywhere in this deployment sets any of the
// three. So the counter that bounds signup counted a bucket the caller chose,
// and the sixth signup below — and the six-thousandth — came back 201.
func TestForwardingHeadersCannotBuyAFreshRateLimitBucket(t *testing.T) {
	h := requireDB(t)
	srv := h.serverWithConfig(t, func(cfg *httpapi.Config) {
		// The production posture: five per hour, and nothing in front of us
		// that is allowed to speak for the caller.
		cfg.SignupsPerIPPerHour = 5
		cfg.TrustedProxyCIDRs = nil
	})
	const socket = "203.0.113.10:50001"

	emails := make([]string, 0, 6)
	for i := 0; i < 6; i++ {
		// A different invented address every request, in all three spellings
		// RealIP used to honour, plus a second XFF entry so the leftmost-wins
		// bug has something to be wrong about.
		invented := fmt.Sprintf("198.51.100.%d", i+1)
		res, email := signupFrom(t, srv, socket, map[string]string{
			"True-Client-IP":  invented,
			"X-Real-IP":       invented,
			"X-Forwarded-For": invented + ", 192.0.2.7",
		})
		emails = append(emails, email)

		if i < 5 {
			if res.Status != http.StatusCreated {
				t.Fatalf("signup %d from %s: got %d %s, want 201",
					i+1, socket, res.Status, res.Raw)
			}
			continue
		}
		if res.Status != http.StatusTooManyRequests ||
			res.code() != string(domain.CodeRateLimited) {
			t.Fatalf("the sixth signup from %s was accepted: three headers the "+
				"caller wrote moved the counter to a bucket of their choosing, "+
				"so the cap of %d is a cap on nothing and each accepted signup "+
				"seeds a whole farm: got %d %s",
				socket, 5, res.Status, res.Raw)
		}
	}

	for i, email := range emails {
		if got := h.recordedSignupIP(t, email); got != "203.0.113.10" {
			t.Fatalf("signup_attempts row %d records %q: the only record of who "+
				"tried is the caller's invention, so the table cannot be used as "+
				"evidence of anything", i+1, got)
		}
	}
}

// TestATrustedProxyIsBelievedAndNothingElseIs is the other half. The fix must
// not make the header useless — behind nginx or a CDN, believing the socket
// means every request counts against the proxy and the cap becomes global —
// so an operator who lists the ranges gets the forwarded address back.
func TestATrustedProxyIsBelievedAndNothingElseIs(t *testing.T) {
	h := requireDB(t)
	const socket = "203.0.113.20:50002"
	srv := h.serverWithConfig(t, func(cfg *httpapi.Config) {
		cfg.SignupsPerIPPerHour = 5
		// The range the test's own socket address falls in: a proxy this
		// deployment put there itself.
		cfg.TrustedProxyCIDRs = []string{"203.0.113.0/24"}
	})

	// Six distinct clients behind that proxy are six buckets, and the sixth is
	// not rate limited by the fifth.
	for i := 0; i < 6; i++ {
		client := fmt.Sprintf("198.51.100.%d", 100+i)
		res, email := signupFrom(t, srv, socket,
			map[string]string{"X-Forwarded-For": client})
		if res.Status != http.StatusCreated {
			t.Fatalf("signup %d through a trusted proxy: got %d %s, want 201 — "+
				"six real clients must not share one bucket",
				i+1, res.Status, res.Raw)
		}
		if got := h.recordedSignupIP(t, email); got != client {
			t.Fatalf("signup %d recorded %q, want the forwarded client %q",
				i+1, got, client)
		}
	}

	// The trust is for X-Forwarded-For, and for addresses outside the
	// configured range. Everything else still falls back to the socket, even
	// on a server that has a trusted proxy configured.
	for _, tc := range []struct {
		name    string
		headers map[string]string
	}{
		{"X-Real-IP is not a spelling this service reads",
			map[string]string{"X-Real-IP": "198.51.100.200"}},
		{"neither is True-Client-IP",
			map[string]string{"True-Client-IP": "198.51.100.201"}},
		{"a chain of nothing but trusted hops names no client",
			map[string]string{"X-Forwarded-For": "203.0.113.77"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res, email := signupFrom(t, srv, socket, tc.headers)
			if res.Status != http.StatusCreated {
				t.Fatalf("got %d %s, want 201", res.Status, res.Raw)
			}
			if got := h.recordedSignupIP(t, email); got != "203.0.113.20" {
				t.Fatalf("recorded %q, want the socket address 203.0.113.20", got)
			}
		})
	}
}

// TestAForwardedAddressFromAnUntrustedPeerIsIgnored is the case the first
// version of this fix got wrong, and it is the one that matters most, because
// it is the configured path — the one the note on TRUSTED_PROXY_CIDRS tells an
// operator behind nginx or a CDN to take.
//
// middleware.ClientIPFromXFF has no reference to r.RemoteAddr in it. On its
// own it reads the header for EVERY caller, so merely configuring a trust list
// handed the spoof back to anybody who could open a socket to the process: a
// pod on the same network, a port open wider than somebody thought, the CDN
// walked around by IP. The trusted ranges have to be checked against the peer
// too, and chi does not do that for you.
func TestAForwardedAddressFromAnUntrustedPeerIsIgnored(t *testing.T) {
	h := requireDB(t)

	t.Run("the header is ignored and the socket is what gets counted", func(t *testing.T) {
		srv := h.serverWithConfig(t, func(cfg *httpapi.Config) {
			// Configured, and configured for somewhere else: the proxies of
			// this deployment live in 10/8, and this caller is not one.
			cfg.TrustedProxyCIDRs = []string{"10.0.0.0/8"}
			// Not the axis under test. Which address gets counted is.
			cfg.SignupsPerIPPerHour = 1000
		})

		res, email := signupFrom(t, srv, "203.0.113.10:50004",
			map[string]string{"X-Forwarded-For": "198.51.100.1"})
		if res.Status != http.StatusCreated {
			t.Fatalf("got %d %s, want 201", res.Status, res.Raw)
		}
		if got := h.recordedSignupIP(t, email); got != "203.0.113.10" {
			t.Fatalf("recorded %q, want the socket address 203.0.113.10: a caller "+
				"who is not behind any of the configured proxies wrote its own "+
				"X-Forwarded-For and the service believed it, so configuring a "+
				"trust list at all is what reopened the spoof", got)
		}
	})

	t.Run("so the cap still bites through a forged chain", func(t *testing.T) {
		srv := h.serverWithConfig(t, func(cfg *httpapi.Config) {
			cfg.TrustedProxyCIDRs = []string{"10.0.0.0/8"}
			cfg.SignupsPerIPPerHour = 5
		})
		const socket = "203.0.113.60:50005"

		for i := 0; i < 6; i++ {
			res, _ := signupFrom(t, srv, socket, map[string]string{
				"X-Forwarded-For": fmt.Sprintf("198.51.100.%d", 150+i),
			})
			if i < 5 {
				if res.Status != http.StatusCreated {
					t.Fatalf("signup %d: got %d %s, want 201", i+1, res.Status, res.Raw)
				}
				continue
			}
			if res.Status != http.StatusTooManyRequests ||
				res.code() != string(domain.CodeRateLimited) {
				t.Fatalf("the sixth signup from %s was accepted: a trust list "+
					"configured for 10/8 let a caller outside it buy a bucket "+
					"per request anyway: got %d %s", socket, res.Status, res.Raw)
			}
		}
	})
}

// TestSignupsAreAlsoCappedPerEmail covers the axis the IP count cannot reach.
// A caller with a supply of addresses — a botnet, a carrier NAT pool — walks
// past a per-IP cap without noticing it; the address they are trying to take
// is the one thing they cannot vary.
func TestSignupsAreAlsoCappedPerEmail(t *testing.T) {
	h := requireDB(t)
	srv := h.serverWithConfig(t, func(cfg *httpapi.Config) {
		cfg.SignupsPerIPPerHour = 1000 // out of the way; this is not the axis under test
		cfg.SignupsPerEmailPerHour = 3
	})

	email := fmt.Sprintf("repeat-%s@example.com", uuid.NewString()[:12])
	body := map[string]any{
		"farm": map[string]any{
			"name": "Finca repetida", "timezone": "America/Bogota",
			"currency": "COP", "priceCents": 100000,
		},
		"owner": map[string]any{
			"email": email, "name": "Owner", "password": longEnoughPassword(),
		},
	}

	post := func(remoteAddr string) response {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		req := httptest.NewRequest(http.MethodPost, "/v1/signup", strings.NewReader(string(raw)))
		req.RemoteAddr = remoteAddr
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		out := response{Status: rec.Code, Raw: rec.Body.String()}
		if out.Raw != "" {
			_ = json.Unmarshal([]byte(out.Raw), &out.Body)
		}
		return out
	}

	// Three tries, each from an address the previous one never used.
	for i := 0; i < 3; i++ {
		if res := post(fmt.Sprintf("203.0.113.%d:50003", 30+i)); res.Status != http.StatusCreated {
			t.Fatalf("signup %d for %s: got %d %s, want 201", i+1, email, res.Status, res.Raw)
		}
	}
	// The fourth, from yet another address, is still refused: the cap follows
	// the address being registered, not the socket it arrives on.
	res := post("203.0.113.33:50003")
	if res.Status != http.StatusTooManyRequests ||
		res.code() != string(domain.CodeRateLimited) {
		t.Fatalf("a fourth signup for %s from a fresh address was accepted: the "+
			"per-email cap does not exist, so a caller with a supply of addresses "+
			"pays nothing: got %d %s", email, res.Status, res.Raw)
	}
}
