package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// maxImportBytes is a season, not a page. A farm's year is on the order of
// 55 000 rows; at the shape below that is a few megabytes of JSON, and the
// ordinary 1 MB body cap that protects every other endpoint would refuse it.
//
// It is still a cap, because the alternative to a large number is no number,
// and no number is how a single request takes a process down.
const maxImportBytes = 64 << 20

// The time this one route is allowed to take, and it is TWO numbers on purpose.
//
// # The problem
//
// cmd/api sets ReadTimeout: 30s on the whole server. That deadline is armed on
// the connection before the handler is entered and covers the body, so the
// season import — 48 022 rows and 11,7 MB in the rehearsal the handset pair
// ran — is cut off mid-upload on any link slower than about 3 Mbit. The phone
// had already raised its own patience to 25 minutes; it never got to use a
// second of it, because this deadline fires first and belongs to us.
//
// # Why the global timeout is not raised
//
// Because it protects every other route from exactly the attack this one needs
// an exemption from: a connection that dribbles a byte a minute holds a
// goroutine, a socket and a file descriptor for as long as the deadline allows.
// Raising ReadTimeout to 25 minutes hands that to anonymous callers on all 117
// routes. The exemption is bought here instead, on the one route that needs it,
// AFTER the permission table has run — so the caller is an authenticated owner
// of a real farm, and there is exactly one of those in the room.
//
// # Why two numbers and not one
//
// importReadIdle is the real defence. A deadline of "25 minutes from now" is
// still 25 minutes of a connection that may have stopped sending anything at
// all; a deadline that moves forward only WHILE BYTES ARRIVE cannot be held
// open by silence. So the connection gets a fresh 60 seconds each time the
// upload makes progress, and importReadBudget is the wall it can never move
// past — the phone's own measured margin, and the answer to a client that
// sends one byte a second for ever.
const (
	importReadBudget = 25 * time.Minute
	importReadIdle   = 60 * time.Second

	// importAnswerBudget is what is left for the import itself and for writing
	// the reply. It is a WRITE deadline, and forgetting it is the subtle half
	// of this fix: net/http arms WriteTimeout when the request header has been
	// read, and it covers everything after — so a 25-minute body under the
	// 60-second WriteTimeout in cmd/api would upload perfectly, import
	// perfectly, commit, and then fail to send the answer. The season would be
	// on the server and the handset would never be told.
	importAnswerBudget = 10 * time.Minute
)

// extendImportDeadlines buys this connection the budget above.
//
// It reports whether it managed to. On a plain net/http server it always does;
// under httptest.NewRecorder, which is not a connection at all, the controller
// answers ErrNotSupported and the server's own ReadTimeout stands. That is a
// degradation and not a failure — every in-process test posts its body in one
// piece — so it is logged and the request continues rather than being refused
// over a facility it does not need.
func extendImportDeadlines(w http.ResponseWriter, r *http.Request) bool {
	rc := http.NewResponseController(w)
	hard := time.Now().Add(importReadBudget)
	if err := rc.SetReadDeadline(time.Now().Add(importReadIdle)); err != nil {
		slog.Warn("season import: could not extend the read deadline; "+
			"the server's global ReadTimeout applies", "err", err)
		return false
	}
	if err := rc.SetWriteDeadline(hard.Add(importAnswerBudget)); err != nil {
		slog.Warn("season import: could not extend the write deadline", "err", err)
	}
	r.Body = &progressBody{rc: rc, body: r.Body, hard: hard}
	return true
}

// progressBody pushes the connection's read deadline forward as the upload
// makes progress, and never past `hard`.
type progressBody struct {
	rc   *http.ResponseController
	body io.ReadCloser
	hard time.Time
	// set is when the current deadline was granted. The deadline is only
	// re-armed once half the idle window has gone: a json.Decoder reads a
	// 12 MB body in thousands of small chunks, and one setsockopt per chunk
	// would be thousands of syscalls to answer a question whose resolution is
	// half a minute.
	set time.Time
}

func (b *progressBody) Read(p []byte) (int, error) {
	n, err := b.body.Read(p)
	if n > 0 {
		now := time.Now()
		if now.Sub(b.set) >= importReadIdle/2 {
			next := now.Add(importReadIdle)
			if next.After(b.hard) {
				// Past the wall the deadline stops moving, so the upload is
				// cut off there whether or not it is still making progress.
				next = b.hard
			}
			_ = b.rc.SetReadDeadline(next)
			b.set = now
		}
	}
	return n, err
}

func (b *progressBody) Close() error { return b.body.Close() }

// handleImportSeason is §8 phases 3 and 4: the season that is already on a
// handset, moved onto the server WITHOUT changing a single identifier.
//
// Why it exists at all, in one sentence from decisiones.md: "una liquidación
// creada en el servidor reclamaría pesadas que el servidor no tiene". Until
// this has run, settling on the server is settling against half a season.
//
// Three things about this handler and none of them is incidental.
//
// It is the OWNER's, and it is Money. It writes payroll, settlements and the
// ledger of a whole season in one act; an administrator does not get to do
// that, and a weigher is not within a mile of it.
//
// It writes in the request transaction and reconciles inside it. An answer of
// 4xx never commits — that is what tenant.Middleware does — so a reconciliation
// that fails leaves the server byte-for-byte as it was. The handset is not
// touched by any of this, which is the entire safety argument of phase 4:
// "el teléfono no se ha modificado, así que no hay nada que deshacer".
//
// It is idempotent by (farm_id, id) like every other write here, and it reports
// what it skipped rather than what it "merged". The rehearsal of phase 3 is
// meant to be run until it comes out clean.
func (s *Server) handleImportSeason(w http.ResponseWriter, r *http.Request) {
	// FIRST, before a single byte of the body is read and before any patience
	// is granted: a slot.
	//
	// This handler is going to hold its pool connection, inside a transaction,
	// for as long as the upload takes — the tenant middleware opened that
	// transaction before the handler was called, and there is no byte of the
	// body in hand yet. Twenty-five minutes of `idle in transaction` is the
	// deadline this route grants itself, and eleven of these at once is every
	// connection in the pool. Measured: the ordinary requests do not fail, they
	// WAIT — 17.8 seconds on a laptop with the upload compressed into 25, which
	// at the real deadline is the whole service stopped for every farm while
	// /health goes on saying ok. See the note on store.MaxImportsAtOnce.
	//
	// So: at most three at a time, and the pool carries three connections above
	// the ordinary ten to lend them. The fourth is refused HERE, before it has
	// read anything or waited for anything, and it gives its own connection
	// straight back.
	//
	// Refused rather than queued, and that is the deliberate half. A queue would
	// hold this request's connection while it waited, which is the problem
	// wearing a different hat; and an owner told "come back in a few minutes" at
	// the start of a 25-minute upload is far better served than one who waits
	// half an hour to find out.
	select {
	case s.importSlots <- struct{}{}:
		defer func() { <-s.importSlots }()
	default:
		refuseImport(w, r)
		return
	}

	// The route's own deadline. See importReadBudget. It is done here rather
	// than in a middleware so that it happens AFTER authentication and after
	// the permission table — the long patience belongs to an owner uploading a
	// season, not to whoever opens a socket.
	extendImportDeadlines(w, r)

	var in store.SeasonImport
	dec := json.NewDecoder(io.LimitReader(r.Body, maxImportBytes))
	dec.DisallowUnknownFields()
	dec.UseNumber()
	if err := dec.Decode(&in); err != nil {
		writeError(w, r, domain.BadRequest(decodeMessage(err)).WithCause(err))
		return
	}
	if in.DeviceID == "" {
		writeError(w, r, domain.BadRequest(
			"deviceId is required: an import is a named handset's season, not an anonymous file"))
		return
	}
	// A file with no balances is a file with no reconciliation, and an import
	// with no reconciliation is exactly the thing this endpoint exists to
	// refuse. It is not a convenience field.
	if len(in.Balances) == 0 {
		writeError(w, r, domain.BadRequest(
			"balances is required: it is what the import is checked against, to the cent"))
		return
	}

	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	farmID, err := tenant.FarmID(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	p, _ := auth.PrincipalFrom(r.Context())

	report, err := store.ImportSeason(r.Context(), tx, farmID, p.UserID, in, newID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// refuseImport answers the fourth import, and spends a little care on HOW.
//
// The first version of this simply wrote the 429 and returned, which is what
// every other refusal in this service does and is wrong here for one reason:
// the client is in the middle of sending twelve megabytes. A handler that
// answers without reading the body leaves the server closing a socket the
// client is still writing to, and what the client gets is not a 429 — it is a
// broken pipe. Measured, with a 2.9 MB body sent at full speed on a laptop:
// `URLError: [Errno 32] Broken pipe`, and no status line at all.
//
// An owner who is told "no se pudo subir" learns nothing, retries at once, and
// is refused again the same way. That is a worse fault than the one the gate
// exists to prevent, and it would have been invisible in any test that posts a
// small body.
//
// So the refusal reads the upload to its end and throws it away, and then
// answers. The two things that make that affordable:
//
//   - The pool connection goes back FIRST. tenant.ReleaseEarly ends the
//     transaction before the draining starts, so this request costs a goroutine
//     and a socket while it waits, and none of the thing the whole gate is
//     protecting.
//   - No deadline is extended. The 25-minute patience is granted further down,
//     to an import that is actually going to happen; a refused one lives under
//     the server's ordinary 30-second ReadTimeout like every other route. A
//     body too slow to arrive inside that is cut off — the same broken pipe as
//     before, for the slowest uploads only, rather than for all of them.
func refuseImport(w http.ResponseWriter, r *http.Request) {
	tenant.ReleaseEarly(r.Context())
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, maxImportBytes))

	w.Header().Set("Retry-After", "300")
	writeError(w, r, domain.Coded(http.StatusTooManyRequests, domain.CodeRateLimited,
		"another season is being imported right now; the server takes a few at a "+
			"time so one upload cannot slow the whole service down. Try again in "+
			"a few minutes — nothing has been written and nothing is lost").
		WithDetails(map[string]any{"importsAtOnce": store.MaxImportsAtOnce}))
}
