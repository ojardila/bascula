package httpapi

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/blob"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// Config is what the server needs from the environment.
type Config struct {
	// DevEcho makes signup and verification return the email token in the
	// response body, because there is no mail sender in sprint 1. It must be
	// off in production and the server refuses to start otherwise.
	DevEcho bool
	// SignupsPerIPPerHour caps the most exposed surface in the system.
	SignupsPerIPPerHour int
	// SignupsPerEmailPerHour caps the same surface along the axis the IP count
	// cannot reach. An IP is a resource the caller picks — a botnet, a mobile
	// carrier's NAT pool, a proxy range listed one CIDR too wide — but the
	// address they want an account at is the thing they came for, and they
	// cannot vary it and still get what they wanted.
	SignupsPerEmailPerHour int
	// MaxFarmsPerEmail caps how many farms one address can own.
	MaxFarmsPerEmail int
	// LoginFailuresPerEmailPerIP and LoginFailuresPerIP are the two axes of
	// the login limiter, counted over LoginFailureWindow. They are separate
	// numbers because they bound different attacks and one of them cannot
	// stand in for the other: one IP walking through ten thousand addresses
	// never trips a tight per-account count, and a patient search against one
	// address never trips a loose per-IP one.
	//
	// The per-IP number is the loose one on purpose. A farm office is one
	// router: the owner, the administrator and three weighers share an address,
	// they all mistype on the same Monday morning, and a limit tight enough to
	// stop a spray would lock the whole farm out of its own payroll. The
	// per-account number is the tight one, because ten wrong passwords in a
	// quarter of an hour from one place is already not the person whose
	// password it is.
	//
	// The tight axis counts the PAIR and not the address, and that is the
	// difference between a limiter and a weapon: an address alone is a number
	// a stranger can fill on somebody else's behalf. store.CountLoginFailures
	// has the argument and what it concedes.
	LoginFailuresPerEmailPerIP int
	LoginFailuresPerIP         int
	// LoginFailureWindow is how far back the counts look. It is also how long
	// a lockout lasts, because the two are the same fact: the count drains as
	// the window slides, so nothing has to expire anything.
	LoginFailureWindow time.Duration
	// TrustedProxyCIDRs lists, in CIDR form, the reverse proxies allowed to
	// speak for somebody else's address. It is empty by default, and that is
	// the point of it.
	//
	// The client IP is not something the network hands us. It is whatever the
	// last hop we believe says it is, and a header is only evidence if
	// something we control overwrites it on every request. Trusting one by
	// default means trusting the caller — and the caller is exactly who the
	// per-IP signup limit exists to bound. One header per request and the
	// counter never reaches its cap, while signup_attempts, the only record of
	// who tried, fills up with addresses that were never real and stops being
	// usable as evidence of anything.
	//
	// So the trust is deployment configuration, written by whoever knows the
	// topology, not a library default. With no CIDRs the address is the one
	// that opened the socket, full stop, which is also the correct answer for
	// a service reachable directly. An operator behind nginx or a CDN lists
	// the ranges the connections actually arrive from; most CDNs publish
	// theirs.
	//
	// These must be the ranges the CONNECTIONS come from, not the ranges the
	// clients are in, because the list is checked against r.RemoteAddr before
	// the header is read at all — see fromTrustedPeer. Listing a range that
	// does not contain the proxy's own address buys nothing; listing one too
	// wide hands the header to everything inside it.
	TrustedProxyCIDRs []string
	// UploadDir is where internal/blob writes uploaded objects. It exists
	// because this environment has no object storage; the design document
	// says S3/R2 and internal/blob is the seam that makes swapping to it one
	// file. Empty means a directory under the system temp, which is right for
	// a test and wrong for anything else — see the note in cmd/api.
	UploadDir string
}

// DefaultConfig is the production posture.
func DefaultConfig() Config {
	return Config{
		DevEcho:                    false,
		SignupsPerIPPerHour:        5,
		SignupsPerEmailPerHour:     5,
		MaxFarmsPerEmail:           3,
		LoginFailuresPerEmailPerIP: 10,
		LoginFailuresPerIP:         50,
		LoginFailureWindow:         15 * time.Minute,
	}
}

type Server struct {
	pool   *pgxpool.Pool
	signer *auth.Signer
	cfg    Config
	blobs  blob.Store
	router chi.Router
	// importSlots is the season import's share of the pool, and it is a share
	// rather than a queue. See store.MaxImportsAtOnce and handleImportSeason.
	importSlots chan struct{}
}

// New builds the server. A failure to prepare the upload directory is fatal
// rather than deferred: a service that starts and then cannot accept a single
// receipt photo is a service that fails in front of a customer instead of in
// front of an operator.
func New(pool *pgxpool.Pool, signer *auth.Signer, cfg Config) *Server {
	s := &Server{
		pool: pool, signer: signer, cfg: cfg,
		importSlots: make(chan struct{}, store.MaxImportsAtOnce),
	}
	disk, err := blob.NewDisk(cfg.UploadDir)
	if err != nil {
		panic(err)
	}
	s.blobs = disk
	s.router = s.buildRouter()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.router.ServeHTTP(w, r)
}

// Router exposes the mux so the contract test can walk it.
func (s *Server) Router() chi.Router { return s.router }

func (s *Server) buildRouter() chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	// The client address, established once here and read back with
	// middleware.GetClientIP. Nothing downstream reads a header for it and
	// nothing overwrites r.RemoteAddr, which stays what it has always been:
	// the peer of the TCP connection.
	//
	// This used to be middleware.RealIP, which chi now ships deprecated as
	// spoofable — GHSA-3fxj-6jh8-hvhx, GHSA-rjr7-jggh-pgcp, GHSA-9g5q-2w5x-hmxf.
	// It replaced r.RemoteAddr with True-Client-IP, X-Real-IP or the LEFTMOST
	// X-Forwarded-For entry, whether or not anything in front of this process
	// sets them, and the leftmost entry of X-Forwarded-For is the one value in
	// the chain that is always the client's own invention. Since clientIP
	// feeds the per-IP signup limit, a single header made that limit count a
	// different bucket on every request.
	//
	// The order below is the entire policy:
	//
	//   1. The socket address, so there is always an answer.
	//   2. The X-Forwarded-For walk, and ONLY if an operator configured
	//      trusted proxies AND this particular connection came from one of
	//      them. It walks the chain right to left, skipping hops inside the
	//      trusted ranges, and the first address outside them is the client.
	//      It overwrites step 1 only when it finds one.
	//
	// With no TrustedProxyCIDRs step 2 does not exist and no header can move
	// the address at all. X-Real-IP and True-Client-IP are not read in either
	// case: a proxy that sets one also sets X-Forwarded-For, and adding a
	// second accepted spelling only widens what an attacker may try.
	//
	// The "AND this particular connection came from one of them" is fromTrustedPeer,
	// and it is not decoration. See its own note: chi's XFF walk never looks at
	// r.RemoteAddr, so without the gate the configured path — the one an
	// operator behind nginx is told to take — would hand the header back to
	// anybody who can open a socket to this process.
	r.Use(middleware.ClientIPFromRemoteAddr)
	if len(s.cfg.TrustedProxyCIDRs) > 0 {
		r.Use(fromTrustedPeer(s.cfg.TrustedProxyCIDRs,
			middleware.ClientIPFromXFF(s.cfg.TrustedProxyCIDRs...)))
	}
	r.Use(middleware.Recoverer)

	for _, rt := range s.Routes() {
		handler := rt.Handler
		if rt.Action == auth.ActionHealth {
			// Health touches no database and needs no transaction: it must
			// answer even when the tenant machinery cannot.
			r.Method(rt.Method, rt.Pattern, handler)
			continue
		}
		// The chain, in this order and no other:
		//   Auth      reads the token and attaches the caller
		//   Tenant    opens the transaction and SET LOCAL app.farm_id
		//   Require   checks the permission table, and refuses loudly if the
		//             tenant context never got established
		chained := s.requireAction(rt.Action)(handler)
		chained = tenant.Middleware(s.pool, func(w http.ResponseWriter, r *http.Request, err error) {
			writeError(w, r, err)
		})(chained)
		chained = s.authenticate(chained)
		r.Method(rt.Method, rt.Pattern, chained)
	}
	return r
}

// fromTrustedPeer runs the X-Forwarded-For walk only for a connection that
// arrived from one of the configured proxies, and otherwise leaves the client
// address exactly as ClientIPFromRemoteAddr set it.
//
// # Why this exists at all
//
// middleware.ClientIPFromXFF contains no reference to r.RemoteAddr. It walks
// the header, skips the hops inside the trusted prefixes, and stores the first
// address outside them — without ever asking who opened the connection. That
// is the right primitive for a process that CANNOT be reached except through
// its proxy, which chi says out loud in the sibling middleware's doc: "Guarantee
// at the network layer (security group / firewall) that only your proxies can
// reach this server."
//
// This service does not have that guarantee written down anywhere, and the
// first version of this fix shipped without it. The result was a hole with a
// trapdoor: the closed default was safe, and the moment an operator did what
// the note on TRUSTED_PROXY_CIDRS tells them to do behind nginx or a CDN,
// anybody who could reach the process directly — a pod on the same network, a
// port that is open wider than somebody thinks, the CDN bypassed by IP — got
// the spoof back. A trust list that widens what an attacker can do is worse
// than no trust list, because it reads like the fix.
//
// So the list is used twice, for the two different questions it answers:
// "may this connection speak for somebody else" (here, against the peer) and
// "which hops in the chain are ours" (inside the walk). Both must be yes.
//
// The peer is unmapped before the check for the same reason chi unmaps the
// header values: a v4 client on a dual-stack listener arrives as
// ::ffff:a.b.c.d, and netip.Prefix.Contains says false for a v4-mapped address
// against a v4 prefix, so without this a trusted proxy would silently stop
// being trusted the day the listener gained an IPv6 socket. The zone goes for
// the same reason.
//
// Panics at startup on an invalid prefix, and says which one. cmd/api validates
// TRUSTED_PROXY_CIDRS and refuses to boot before it ever gets here, so the
// environment path cannot reach this — but httpapi.New is a public constructor
// and the middleware it wraps panics from inside chi with no mention of the
// value or the variable it came from. A constructor that panics is the
// contract here already (see the blob directory in New), so the fix is to make
// the panic legible rather than to turn a misconfigured trust list into a
// server that boots. Dropping the bad entry silently is the one answer that is
// not available: a prefix that quietly stops being parsed is a proxy that
// quietly stops being trusted, and the symptom is a rate limit counting the
// proxy instead of the caller.
func fromTrustedPeer(trustedIPPrefixes []string, xff func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	prefixes := make([]netip.Prefix, len(trustedIPPrefixes))
	for i, p := range trustedIPPrefixes {
		parsed, err := netip.ParsePrefix(p)
		if err != nil {
			panic(fmt.Sprintf("httpapi: TrustedProxyCIDRs[%d] = %q is not a CIDR "+
				"prefix (%v). It must be a network, not a bare address: use "+
				"10.1.2.3/32 for a single proxy. See TRUSTED_PROXY_CIDRS.", i, p, err))
		}
		prefixes[i] = parsed
	}
	return func(next http.Handler) http.Handler {
		walked := xff(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if peerIsTrusted(r.RemoteAddr, prefixes) {
				walked.ServeHTTP(w, r)
				return
			}
			// Not a proxy of ours. Whatever it wrote in the header is its own
			// claim about itself, and the address already established from the
			// socket stands.
			next.ServeHTTP(w, r)
		})
	}
}

// peerIsTrusted reports whether the peer of this connection falls inside one of
// the configured proxy ranges. An address that will not parse is not trusted:
// the only way to be wrong here that costs anything is to say yes.
func peerIsTrusted(remoteAddr string, prefixes []netip.Prefix) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr // RemoteAddr may already be a bare IP (e.g. in tests).
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	ip = ip.Unmap().WithZone("")
	for _, p := range prefixes {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// authenticate is link one. It never rejects on its own: a public route has no
// token and that is fine. Deciding whether a token was required is the
// permission table's job, one link later.
func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := bearerToken(r)
		if raw == "" {
			next.ServeHTTP(w, r)
			return
		}
		claims, err := s.signer.Parse(raw)
		if err != nil {
			writeError(w, r, err)
			return
		}
		p := &auth.Principal{
			UserID:     claims.Subject,
			FarmID:     claims.FarmID,
			Role:       claims.Role,
			DeviceID:   claims.DeviceID,
			Superadmin: claims.Superadmin,
		}
		next.ServeHTTP(w, r.WithContext(auth.WithPrincipal(r.Context(), p)))
	})
}

// requireAction is link three: the permission table, consulted once, in one
// place. No handler in this service contains a role check.
func (s *Server) requireAction(action auth.Action) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rule, known := auth.Matrix[action]
			if !known {
				// A route whose action is not in the table is a closed door.
				// The contract test makes sure this never ships, but if it
				// does, it fails shut.
				writeError(w, r, domain.Forbidden("action is not in the permission table"))
				return
			}
			if rule.Public {
				next.ServeHTTP(w, r)
				return
			}

			p, ok := auth.PrincipalFrom(r.Context())
			if !ok {
				writeError(w, r, domain.Unauthorized("authentication required"))
				return
			}
			if !rule.TenantOptional && !tenant.HasFarm(r.Context()) {
				// RLS answers with zero rows and no error when app.farm_id is
				// unset. That silence is worse than a failure, so it becomes
				// one.
				writeError(w, r, domain.TenantNotSet())
				return
			}
			// A platform administrator who is not a member of the farm their
			// token names may work the console and nothing else.
			//
			// The tenant middleware lets them past the membership check on
			// purpose — a farm that removed them must not be able to lock the
			// lever holder out of the room the lever is in — but that exemption
			// is about the console, not about the farm. Without this line the
			// token's `role` claim went on describing them as the owner of a
			// farm that had taken them off it, with no membership row left to
			// disagree, and auth.Rule's one-line rule — "a super-admin
			// administers farms from the outside and cannot read inside one" —
			// held only in its first half. The code is MEMBERSHIP_REVOKED
			// because that is exactly what happened and the clients already
			// know the sentence for it.
			if !rule.Superadmin && tenant.PlatformOnly(r.Context()) {
				writeError(w, r, domain.Coded(http.StatusForbidden, domain.CodeMembershipRevoked,
					"that account no longer has access to this farm"))
				return
			}
			if !auth.AllowedFor(p.Role, p.Superadmin, action) {
				if rule.Superadmin {
					// A farm role, however senior, is not a platform role: an
					// owner administering their own farm has no business
					// listing anybody else's.
					writeError(w, r, domain.Forbidden("that action belongs to the platform administrator"))
					return
				}
				writeError(w, r, domain.Forbidden("your role may not perform this action"))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}
