package httpapi

import (
	"net/http"
	"strings"

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
	// MaxFarmsPerEmail caps how many farms one address can own.
	MaxFarmsPerEmail int
	// UploadDir is where internal/blob writes uploaded objects. It exists
	// because this environment has no object storage; the design document
	// says S3/R2 and internal/blob is the seam that makes swapping to it one
	// file. Empty means a directory under the system temp, which is right for
	// a test and wrong for anything else — see the note in cmd/api.
	UploadDir string
}

// DefaultConfig is the production posture.
func DefaultConfig() Config {
	return Config{DevEcho: false, SignupsPerIPPerHour: 5, MaxFarmsPerEmail: 3}
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
	r.Use(middleware.RealIP)
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
