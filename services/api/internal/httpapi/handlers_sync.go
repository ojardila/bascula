package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// The sync endpoints. docs/sincronizacion.md §3.
//
// The phone already synchronises, but against an adapter that assembles the
// protocol out of the ordinary routes. That works and it is wrong in one
// specific way: the adapter decides ordering, batching and idempotency on the
// handset, so two handsets can disagree about what happened and neither is the
// authority. Here there is one authority — the server's commit order, exposed
// as a per-farm sequence — and the handset carries one integer.

// MinPhoneSchemaVersion is `user_version = 6`: the local schema that has the
// UUID columns, the logical delete on pickups, the materialised local day and
// the cents-valued price. Below that the handset cannot even name a row in a
// way this server understands, so it is turned away before it pushes a byte.
const MinPhoneSchemaVersion = 6

// maxPushOps is §3.2's ceiling. The phone slices. On a farm's network a large
// batch is a batch that never finishes, and one that half-finishes is worse.
const maxPushOps = 200

const defaultPullLimit = 500

func (s *Server) handleSyncHandshake(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceID      string `json:"deviceId"`
		AppVersion    string `json:"appVersion"`
		SchemaVersion int    `json:"schemaVersion"`
		Cursor        int64  `json:"cursor"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.DeviceID == "" {
		writeError(w, r, domain.BadRequest("deviceId is required"))
		return
	}
	if body.SchemaVersion < MinPhoneSchemaVersion {
		// Not a 400: the handset is not malformed, it is old, and the
		// difference decides what it does next — update, and do not push.
		writeError(w, r, domain.Conflict(domain.CodeSchemaTooOld,
			"this handset's local schema predates the sync columns; update before synchronising").
			WithDetails(map[string]any{
				"minimumSchemaVersion": MinPhoneSchemaVersion,
				"schemaVersion":        body.SchemaVersion,
			}))
		return
	}

	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	farm, err := store.GetFarm(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	cursor, err := store.SyncCursor(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	// The same refusal the pull makes, made here where the handset asks first.
	// `behind: 0` against a cursor no sequence ever handed out is the status
	// chip of §7.1 reporting "up to date" to a phone that will never receive
	// another change.
	if body.Cursor > cursor {
		writeError(w, r, domain.Conflict(domain.CodeCursorTooOld,
			"that cursor is ahead of this farm's feed and cannot have come from this server; "+
				"pull again from cursor 0").
			WithDetails(map[string]any{"cursor": body.Cursor, "serverCursor": cursor}))
		return
	}
	p, _ := auth.PrincipalFrom(r.Context())

	// Who is holding this cursor, and is it the same reader the feed served it
	// to? See store/sync_readers.go. The handshake only LOOKS: clearing an order
	// here would let a handset talk its way out of a replay without receiving a
	// single row, and the purge instruction that travels with the order would go
	// with it.
	device, err := readerDevice(r, body.DeviceID, p)
	if err != nil {
		writeError(w, r, err)
		return
	}
	replay, err := store.SyncReaderInspect(r.Context(), tx, p.UserID, device, p.Role, body.Cursor)
	if err != nil {
		writeError(w, r, err)
		return
	}

	// `behind` is counted from where the handset will actually resume, and that
	// is the whole point of counting it here. A phone that owes a replay resumes
	// at 0, so measuring its distance from a cursor it is about to abandon would
	// put "up to date" on the status chip of §7.1 in front of somebody whose book
	// has a hole in it — which is the finding this registry exists to close,
	// reappearing one field to the left.
	from := body.Cursor
	if replay.Required {
		from = 0
	}
	behind, err := store.SyncBehind(r.Context(), tx, from)
	if err != nil {
		writeError(w, r, err)
		return
	}

	// `capabilities` is not courtesy. It is what turns buttons off in an app
	// already in a farm's pocket, without shipping a new build the day §10
	// changes its mind. It is NOT authorisation: the server still answers 403
	// whether or not the button is visible, because hiding a button is not a
	// permission.
	writeJSON(w, http.StatusOK, map[string]any{
		"farmId":     farm.ID,
		"timezone":   farm.Timezone,
		"currency":   farm.Currency,
		"minorUnit":  farm.MinorUnit,
		"serverTime": time.Now().UTC(),
		"cursor":     cursor,
		"behind":     behind,
		"role":       p.Role,
		// Never absent and never null: a handset that cannot tell "no replay
		// owed" from "the server did not say" has to guess, and the safe guess
		// is the expensive one. `required: false` is the ordinary answer.
		"replay": replay,
		"capabilities": map[string]any{
			// Decision 5: the phone stops settling without signal. Cash in the
			// field is an `anticipo`, which claims no payable, takes no lock,
			// and is amortised to the cent when the settlement runs.
			"settleOffline": false,
			// Decision 6: lots and the weekly price are the web's alone. Two
			// people setting a different price for the same week is the one
			// conflict with no correct answer — either price underpays
			// somebody.
			"writePlots":      false,
			"writeWeekPrices": false,
			// §8 phase 4 — the cut. The handset goes into money-read-only by
			// remote control: weighings keep being recorded, because the cut
			// cannot stop the scale, and settling, paying and voiding stop.
			// It is off until an operator turns it on for the hour the import
			// runs; it is a per-farm flag and not a build, which is the whole
			// point of it living in the handshake.
			//
			// It is NOT authorisation and must not be read as any. The server
			// answers 403 to a weigher's ledger push whether or not this is
			// true — see pushLedgerEntry — and refuses a settlement whose
			// gross has moved whether or not the button was visible. What this
			// buys is that the person holding the phone during the cut is not
			// looking at a live pay button.
			// Dereferenced, never sent as null: a capability the handset
			// cannot read as true or false is a button it does not know
			// whether to draw, and the safe guess it would make is the wrong
			// one half the time.
			"moneyReadOnly": farm.MoneyReadOnly != nil && *farm.MoneyReadOnly,
		},
	})
}

// readerDevice resolves which handset a sync request speaks for.
//
// The device is not decoration here: it is half the key of the reader registry
// (store/sync_readers.go), and the half that stops one person's laptop
// convincing the server that their handset has received a change. A caller that
// names none is the account's unnamed client, which is a reader like any other
// and not an unknown.
//
// A deviceId that is not a uuid is a 400 rather than a silent fallback. Falling
// back would file that handset under the unnamed reader, where it would share a
// cursor with every other client of the same account — the exact confusion this
// key exists to prevent, arrived at by being helpful.
func readerDevice(r *http.Request, named string, p *auth.Principal) (string, error) {
	if named != "" {
		if _, err := uuid.Parse(named); err != nil {
			return "", domain.BadRequest(
				"deviceId is a uuid: it is what tells one handset's cursor from another's")
		}
		return named, nil
	}
	fromToken := ""
	if p != nil && p.DeviceID != "" {
		if _, err := uuid.Parse(p.DeviceID); err == nil {
			fromToken = p.DeviceID
		}
	}
	return store.SyncReaderDevice("", fromToken), nil
}

// handleSyncPull is the feed. One number in, the changes after it out.
func (s *Server) handleSyncPull(w http.ResponseWriter, r *http.Request) {
	cursor, err := int64Param(r, "cursor", 0)
	if err != nil {
		writeError(w, r, err)
		return
	}
	limit, err := int64Param(r, "limit", defaultPullLimit)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if limit <= 0 || limit > defaultPullLimit {
		limit = defaultPullLimit
	}

	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	// The cursor fell below what is still retained (§3.4). Skipping the gap
	// silently would lose changes for ever, so the handset is told to start
	// again from zero — which, because the feed was backfilled when it was
	// created, is a complete bootstrap rather than an empty farm.
	oldest, err := store.SyncOldestSeq(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if cursor > 0 && oldest > 0 && cursor < oldest-1 {
		writeError(w, r, domain.Conflict(domain.CodeCursorTooOld,
			"that cursor is older than the retained feed; pull again from cursor 0").
			WithDetails(map[string]any{"cursor": cursor, "oldestRetainedSeq": oldest}))
		return
	}

	// And the other end of the same wound. A cursor AHEAD of the feed cannot
	// have come from this server: the sequence only goes up and only this
	// server hands it out. Answering "you are up to date" to a handset holding
	// 9 223 372 036 854 775 807 is telling it, truthfully for ever, that it
	// will never receive another change — a phone permanently and silently
	// out of sync, which is the same failure CURSOR_TOO_OLD exists to refuse
	// at the bottom. It is told to start again from zero, which the backfill
	// makes a complete bootstrap rather than an empty farm.
	head, err := store.SyncCursor(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if cursor > head {
		writeError(w, r, domain.Conflict(domain.CodeCursorTooOld,
			"that cursor is ahead of this farm's feed and cannot have come from this server; "+
				"pull again from cursor 0").
			WithDetails(map[string]any{"cursor": cursor, "serverCursor": head}))
		return
	}

	p, _ := auth.PrincipalFrom(r.Context())

	// The third refusal, and it belongs after the other two: a cursor that is
	// older than the feed or ahead of it is wrong for reasons that have nothing
	// to do with who is holding it, and answering REPLAY_REQUIRED to a handset
	// at maxint64 would hide a different fault behind this one.
	//
	// This one is about WHO. The pull skips rows by role and consumes their seq
	// anyway — it must, or a weigher's cursor would stop at the first payroll of
	// the season — and that skip is permanent, because sync_log has one row per
	// write and no second event ever comes. So a cursor served to a weigher is
	// not a cursor an administrator may resume from, and this is where that is
	// said out loud instead of being answered with an empty batch.
	device, err := readerDevice(r, r.URL.Query().Get("deviceId"), p)
	if err != nil {
		writeError(w, r, err)
		return
	}
	replay, err := store.SyncReaderCheck(r.Context(), tx, p.UserID, device, p.Role, cursor)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if replay.Required {
		// The order has to SURVIVE this response, and this response is a 409,
		// which the tenant middleware rolls back. Everything this transaction
		// has written up to here is the order itself — the pull has read and
		// nothing else — which is exactly the obligation KeepChanges puts on
		// its caller.
		//
		// Without it the order would be recomputed on every attempt, which
		// sounds equivalent and is not: `purgeMoney` is raised by a comparison
		// that only holds while the reader is unregistered, and the pull that
		// PERFORMS the replay arrives at cursor 0, where that comparison no
		// longer fires. The handset would replay and keep the previous holder's
		// payroll on it.
		tenant.KeepChanges(r.Context())
		writeError(w, r, domain.Conflict(domain.CodeReplayRequired,
			"this handset's cursor was served under a different role or to a "+
				"different session; pull again from cursor 0").
			WithDetails(map[string]any{
				"cursor": cursor, "replayFrom": 0, "reason": replay.Reason,
				"purgeMoney": replay.PurgeMoney, "previousRole": replay.PreviousRole,
				"role": p.Role,
			}))
		return
	}

	changes, next, more, err := store.SyncChanges(r.Context(), tx, cursor, int(limit), p.Role)
	if err != nil {
		writeError(w, r, err)
		return
	}
	// What was served, recorded against the role that served it. This is the
	// only endpoint entitled to write that down, because it is the only one that
	// hands over a change.
	if err := store.SyncReaderAdvance(r.Context(), tx, p.UserID, device, p.Role, next); err != nil {
		writeError(w, r, err)
		return
	}

	out := map[string]any{"changes": changes, "cursor": next, "more": more}

	// A replay that was owed and is being performed by this very request. The
	// handset is receiving the whole feed again from 0, so this is the moment —
	// and the only moment — at which `purgeMoney` is both safe and meaningful:
	// what it drops is about to arrive again, minus whatever this role may not
	// see.
	if replay.Owed() && cursor == 0 {
		from := int64(0)
		out["replay"] = store.ReplayOrder{
			Required: true, FromCursor: &from, Reason: replay.Reason,
			PurgeMoney: replay.PurgeMoney, PreviousRole: replay.PreviousRole,
		}
	}

	// The balances checksum travels only in the last batch, when the handset
	// is already up to date — comparing a total against a half-applied feed
	// would report a mismatch that is not one. And it is a checksum: the phone
	// recomputes and compares, and if they differ it flags the worker rather
	// than copying the number. A total that arrives on the wire and is stored
	// is exactly what this design has refused three documents running.
	if !more && (p.Role == domain.RoleOwner || p.Role == domain.RoleAdmin) {
		balances, err := store.SyncBalances(r.Context(), tx)
		if err != nil {
			writeError(w, r, err)
			return
		}
		out["balances"] = balances
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

type pushOp struct {
	// OpID is THE IDEMPOTENCY KEY of the envelope. Not of the row — the row
	// has its own uuid — of the act. It is what makes voiding and reversing
	// safe to resend, because their second attempt is a second act and not a
	// repetition of the first.
	OpID    string          `json:"opId"`
	Entity  string          `json:"entity"`
	Op      string          `json:"op"`
	Payload json.RawMessage `json:"payload"`
}

// handleSyncPush takes an ordered batch of envelopes and answers 200 with one
// result per envelope. ALWAYS 200: the state of each operation is in its own
// row, because a batch of two hundred weighings where one names a worker the
// web deleted has to get the other hundred and ninety-nine in.
//
// Every envelope runs in its own SAVEPOINT for exactly that reason. A rejection
// does not take the batch down with it.
func (s *Server) handleSyncPush(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceID string   `json:"deviceId"`
		Ops      []pushOp `json:"ops"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	if body.DeviceID == "" {
		writeError(w, r, domain.BadRequest("deviceId is required"))
		return
	}
	if len(body.Ops) > maxPushOps {
		writeError(w, r, domain.BadRequest(
			"a push carries at most "+strconv.Itoa(maxPushOps)+" ops; slice the batch"))
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

	results := make([]store.SyncOpResult, 0, len(body.Ops))
	for _, op := range body.Ops {
		if op.OpID == "" {
			results = append(results, rejected("", domain.BadRequest(
				"every op needs an opId: it is the key a resend is recognised by")))
			continue
		}
		// The shape is checked BEFORE the registry is consulted, because
		// sync_ops.op_id is a uuid column: a lookup with `no-soy-un-uuid` in
		// it is a cast error, and a cast error aborts the REQUEST transaction
		// — not the savepoint, which has not been opened yet. One malformed
		// envelope then took the whole batch down with a 404, against the
		// "always 200, one result per envelope" this handler documents four
		// lines above.
		if _, err := uuid.Parse(op.OpID); err != nil {
			results = append(results, rejected(op.OpID, domain.BadRequest(
				"an opId is a uuid: it is the key a resend is recognised by")))
			continue
		}

		// §4.2, and it comes first. If this envelope has been seen, its stored
		// answer is returned LITERALLY and nothing is executed. The alternative
		// — re-running it — is how a resent void hands the money back twice.
		//
		// "Seen" means the same act, not merely the same key. The fingerprint
		// carries the question so that a key reused for a DIFFERENT act is
		// refused instead of being handed the first act's row id — which is
		// how a phone was told `applied` about a weighing that was never
		// written and then dropped it from its outbox.
		fp := store.SyncOpFingerprint(op.Entity, op.Op, op.Payload)
		prior, err := store.FindSyncOp(r.Context(), tx, op.OpID, fp)
		if err != nil {
			if errors.Is(err, store.ErrOpIDReused) {
				results = append(results, rejected(op.OpID, err))
				continue
			}
			writeError(w, r, err)
			return
		}
		if prior != nil {
			results = append(results, *prior)
			continue
		}

		res := s.applyPushOp(r, tx, farmID, body.DeviceID, p, op)
		results = append(results, res)

		// A refusal is not remembered — it wrote nothing, so a resend has
		// nothing to duplicate, and a handset that corrects the body must get
		// a verdict on the body it corrected rather than yesterday's. The rule
		// lives in RecordSyncOp so no caller can forget it.
		if err := store.RecordSyncOp(r.Context(), tx, farmID, op.OpID, body.DeviceID, fp, res); err != nil {
			writeError(w, r, err)
			return
		}
	}

	cursor, err := store.SyncCursor(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cursor": cursor, "results": results})
}

// applyPushOp runs one envelope inside its own savepoint.
func (s *Server) applyPushOp(r *http.Request, tx pgx.Tx, farmID, deviceID string,
	p *auth.Principal, op pushOp) store.SyncOpResult {

	ctx := r.Context()
	sp, err := tx.Begin(ctx)
	if err != nil {
		return rejected(op.OpID, domain.Internal("could not open a savepoint").WithCause(err))
	}

	res := applyPushEntity(ctx, sp, farmID, deviceID, p, op)
	if res.Status == "rejected" {
		// Roll back to the savepoint and keep the batch alive. Whatever this
		// envelope half-wrote is gone; the hundred and ninety-nine before it
		// are not.
		_ = sp.Rollback(ctx)
		return res
	}
	if err := sp.Commit(ctx); err != nil {
		return rejected(op.OpID, domain.Internal("could not release the savepoint").WithCause(err))
	}
	return res
}

func applyPushEntity(ctx context.Context, tx pgx.Tx, farmID, deviceID string,
	p *auth.Principal, op pushOp) store.SyncOpResult {

	switch op.Entity {
	case "worker":
		if op.Op != "upsert" {
			return rejected(op.OpID, domain.BadRequest("a worker travels as an upsert"))
		}
		return pushWorker(ctx, tx, farmID, p, op)

	case "workRecord":
		if op.Op != "upsert" {
			return rejected(op.OpID, domain.BadRequest("a work record travels as an upsert"))
		}
		return pushWorkRecord(ctx, tx, farmID, deviceID, p, op)

	case "ledgerEntry":
		// §3.2: the ledger is `append` and everything else is `upsert`. There
		// is no `delete` at all — a deletion is an upsert carrying deletedAt —
		// because a physical delete leaves no headstone and rises again on the
		// next pull.
		if op.Op != "append" {
			return rejected(op.OpID, domain.BadRequest("a ledger movement travels as an append"))
		}
		return pushLedgerEntry(ctx, tx, farmID, p, op)

	// The read-only half of §2, refused with its reason rather than ignored.
	// A push the server drops in silence is a phone that thinks it saved
	// something.
	case "plot", "crop", "weekPrice", "farmConfig", "settlement":
		return rejected(op.OpID, domain.BadRequest(
			"`"+op.Entity+"` is read-only on the handset: lots and the weekly price "+
				"are set on the web (decision 6), and settlements are created by "+
				"POST /v1/settlements with the cursor up to date (decision 5)"))
	}
	return rejected(op.OpID, domain.BadRequest("unknown entity `"+op.Entity+"`"))
}

// pushWorker writes the phone's half of the people table — and it is the SAME
// door as PATCH /v1/workers, so it answers to the same rule.
//
// A weigher has no REST route that creates, renames, re-documents or
// deactivates a person: ActionWorkersWrite is `admins`. Leaving that check off
// the push made the two doors disagree, and the push is the one that is open
// to a handset in a jacket pocket. The refusal is FORBIDDEN and not a database
// error for the reason §4.3 gives — INTERNAL is "retry with backoff, for ever",
// and a handset retrying a forbidden write until the battery dies is worse than
// being told to stop.
func pushWorker(ctx context.Context, tx pgx.Tx, farmID string, p *auth.Principal, op pushOp) store.SyncOpResult {
	if p == nil || !auth.Allowed(p.Role, auth.ActionWorkersWrite) {
		return rejected(op.OpID, domain.Forbidden(
			"a weigher does not add, rename or deactivate people; that is the same rule "+
				"PATCH /v1/workers answers to, and the channel does not change it"))
	}
	var payload struct {
		ID           string  `json:"id"`
		Name         string  `json:"name"`
		LastName     *string `json:"lastName"`
		DocumentType *string `json:"documentType"`
		DocID        *string `json:"docId"`
		Tag          *string `json:"tag"`
		CreatedAt    *string `json:"createdAt"`
		DeletedAt    *string `json:"deletedAt"`
	}
	if err := decodePayload(op.Payload, &payload); err != nil {
		return rejected(op.OpID, err)
	}
	if payload.ID == "" || payload.Name == "" {
		return rejected(op.OpID, domain.BadRequest("a worker needs id and name"))
	}

	e, created, err := store.UpsertSyncWorker(ctx, tx, farmID, store.Employee{
		ID: payload.ID, Name: payload.Name, LastName: payload.LastName,
		DocumentType: payload.DocumentType, DocID: payload.DocID, Tag: payload.Tag,
	})
	if err != nil {
		return rejected(op.OpID, err)
	}

	// The status transition. A deletion is logical on both sides, so this is a
	// flag and never a DELETE.
	if payload.DeletedAt != nil && e.DeletedAt == nil {
		if err := store.SoftDeleteEmployee(ctx, tx, e.ID, principalUserID(p)); err != nil && err != store.NoRows {
			return rejected(op.OpID, err)
		}
	}
	return applied(op.OpID, e.ID, created)
}

func pushWorkRecord(ctx context.Context, tx pgx.Tx, farmID, batchDevice string,
	p *auth.Principal, op pushOp) store.SyncOpResult {

	var payload struct {
		ID         string      `json:"id"`
		WorkerID   string      `json:"workerId"`
		CropID     string      `json:"cropId"`
		Quantity   json.Number `json:"quantity"`
		OccurredAt string      `json:"occurredAt"`
		Note       *string     `json:"note"`
		DeviceID   *string     `json:"deviceId"`
		DeletedAt  *string     `json:"deletedAt"`
	}
	if err := decodePayload(op.Payload, &payload); err != nil {
		return rejected(op.OpID, err)
	}
	if payload.ID == "" || payload.WorkerID == "" {
		return rejected(op.OpID, domain.BadRequest("a work record needs id and workerId"))
	}

	// Already here: layer 1 did its job, and this is a resend after a lost
	// response. The one thing it must not do is create a second weighing —
	// and it cannot, because a retry cannot invent a second uuid: the uuid was
	// generated when the button was pressed, not when the request was sent.
	if existing, err := store.GetWorkRecord(ctx, tx, payload.ID); err == nil {
		if payload.DeletedAt != nil && existing.DeletedAt == nil {
			if err := store.SoftDeleteWorkRecord(ctx, tx, payload.ID); err != nil {
				return rejected(op.OpID, err)
			}
			return applied(op.OpID, payload.ID, true)
		}
		return duplicate(op.OpID, payload.ID)
	}

	// A deletion of something that never arrived. Nothing to do and nothing
	// wrong: the row and its own deletion crossed in one batch.
	if payload.DeletedAt != nil {
		return duplicate(op.OpID, payload.ID)
	}

	// §5.6 and the receiving order of 2026-08-29. A worker who was deactivated
	// on the web still resolves — the delete is logical, the composite foreign
	// key holds, and the weighing goes in. A worker who is ABSENT is a
	// different thing: it is an incomplete pull, not a conflict, and the phone
	// retries once the references have come down.
	if _, err := store.GetEmployee(ctx, tx, payload.WorkerID); err != nil {
		return rejected(op.OpID, domain.NotFound(
			"that worker is not on this farm yet; pull the references first"))
	}

	if payload.OccurredAt == "" {
		return rejected(op.OpID, domain.BadRequest(
			"occurredAt is required: the instant travels with its offset, never a bare day"))
	}
	// §3.2. The instant travels; the farm's calendar day is written by the
	// trigger from the farm's own timezone, and Go never computes it. That
	// agreement is what makes golden case 04 — the Sunday evening weighing —
	// come out the same on both sides.
	occurred, err := time.Parse(time.RFC3339, payload.OccurredAt)
	if err != nil {
		return rejected(op.OpID, domain.BadRequest(
			"occurredAt must be an RFC3339 instant with its offset"))
	}
	qty, ok := new(big.Rat).SetString(payload.Quantity.String())
	if !ok || qty.Sign() <= 0 {
		return rejected(op.OpID, domain.BadRequest("quantity must be a positive number"))
	}
	// numeric(12, 3), and the push is the door the scale actually arrives
	// through: a handset that lets somebody type a fourth decimal place would
	// otherwise have it rounded here, silently, into a different weight and a
	// different amount than the phone computed. BAD_REQUEST is §4.3's "never
	// retry — it is a client bug", which is exactly what it is.
	if err := domain.CheckNumeric("quantity", payload.Quantity.String(),
		domain.QuantityPrecision, domain.QuantityScale); err != nil {
		return rejected(op.OpID, err)
	}

	activityID, err := store.HarvestActivityID(ctx, tx)
	if err != nil {
		return rejected(op.OpID, err)
	}
	activity, err := store.GetActivity(ctx, tx, activityID)
	if err != nil {
		return rejected(op.OpID, err)
	}

	var cropIDs []string
	if payload.CropID != "" {
		if _, err := store.GetPlotCrop(ctx, tx, payload.CropID); err != nil {
			return rejected(op.OpID, domain.NotFound(
				"that crop is not on this farm yet; pull the references first"))
		}
		cropIDs = []string{payload.CropID}
	}

	device := payload.DeviceID
	if device == nil && batchDevice != "" {
		device = &batchDevice
	}
	record := store.WorkRecord{
		ID: payload.ID, EmployeeID: payload.WorkerID, ActivityID: activity.ID,
		PayScheme: activity.PayScheme, RateSource: domain.RateWeeklyPrice,
		Quantity: payload.Quantity, UnitID: activity.UnitID, Note: payload.Note,
		DeviceID: device, StartedAt: occurred, PlotCropIDs: cropIDs,
	}
	if p != nil && p.UserID != "" {
		record.CreatedBy = &p.UserID
	}
	out, err := store.CreateWorkRecord(ctx, tx, farmID, record)
	if err != nil {
		// The lookup above came back empty and the insert says otherwise. That
		// is not a contradiction: a weigher only reads back the records he
		// recorded himself, so a weighing pushed from a second handset by a
		// second user is invisible to him and still very much there. It is a
		// duplicate, and calling it an error would keep it in his outbox for
		// ever.
		if store.IsUniqueViolation(err, "") {
			return duplicate(op.OpID, payload.ID)
		}
		return rejected(op.OpID, err)
	}

	// Decision 8. The weighing is in; if it belongs to somebody who had been
	// taken off the payroll and it happened AFTER that decision, the person
	// comes back on, and the reactivation is recorded with this weighing and
	// this handset against it. A weighing older than the deactivation leaves
	// the decision standing — see store.ReactivateForWork.
	//
	// The failure is not swallowed: an unrecorded reactivation is exactly the
	// silent undo the owner's condition forbids, so if the audit row cannot be
	// written the whole envelope is rejected and nothing was reactivated.
	if _, err := store.ReactivateForWork(ctx, tx, farmID, store.NewReactivation{
		ID: newID(), EmployeeID: payload.WorkerID, WorkRecordID: out.ID,
		WorkedAt: occurred, DeviceID: device, Source: "sync", By: principalUserID(p),
	}); err != nil {
		return rejected(op.OpID, err)
	}
	return applied(op.OpID, out.ID, true)
}

// pushLedgerEntry takes money that already left somebody's pocket.
//
// §2.3: a `pago`, an `anticipo` or a `deduccion` is a FACT. Somebody handed
// over cash. Refusing its arrival does not undo the fact, it only makes the
// database lie. So the balance is NOT checked here — this channel behaves as
// allowOverpayment, which is what the phone already does and what golden case
// 07 fixes: the balance goes negative and the excess behaves as an advance.
//
// This opens no door to double payment. A payment claims no payable and takes
// no lock, and two duplicate payments from human error are visible at a glance
// in the worker's history — a problem for people, not for a merge algorithm.
func pushLedgerEntry(ctx context.Context, tx pgx.Tx, farmID string,
	p *auth.Principal, op pushOp) store.SyncOpResult {

	// The weigher's RLS policy would refuse this insert anyway, but it would
	// refuse it as a database error — and §4.3 puts INTERNAL in the column
	// "retry with backoff, for ever". A handset that retries a forbidden write
	// until the battery dies is a worse outcome than the write being refused.
	// So it is refused here, with the code that means "stop".
	if p != nil && p.Role == domain.RoleWeigher {
		return rejected(op.OpID, domain.Forbidden(
			"a weigher does not move money; cash handed over in the field is "+
				"recorded by somebody who may see a balance"))
	}

	var payload struct {
		ID          string  `json:"id"`
		WorkerID    string  `json:"workerId"`
		Kind        string  `json:"kind"`
		AmountCents int64   `json:"amountCents"`
		Date        string  `json:"date"`
		Method      *string `json:"method"`
		Note        *string `json:"note"`
	}
	if err := decodePayload(op.Payload, &payload); err != nil {
		return rejected(op.OpID, err)
	}
	if payload.ID == "" || payload.WorkerID == "" {
		return rejected(op.OpID, domain.BadRequest("a ledger movement needs id and workerId"))
	}
	if payload.AmountCents == 0 {
		return rejected(op.OpID, domain.BadRequest("amountCents cannot be zero"))
	}

	kind := domain.LedgerKind(payload.Kind)
	switch kind {
	case domain.KindPayment, domain.KindAdvance, domain.KindDeduction, domain.KindAdjust:
	case domain.KindEarning:
		// §2: a `devengo` is produced by POST /v1/settlements and comes DOWN.
		// A handset that could write one could pay a week the server never
		// agreed to.
		return rejected(op.OpID, domain.BadRequest(
			"a `devengo` is written by POST /v1/settlements and only travels down"))
	default:
		return rejected(op.OpID, domain.BadRequest(
			"kind must be pago, anticipo, deduccion or ajuste"))
	}

	amount := payload.AmountCents
	if kind != domain.KindAdjust {
		if amount < 0 {
			amount = -amount
		}
		amount = -amount
	}
	if payload.Method != nil && !domain.PayMethod(*payload.Method).Valid() {
		return rejected(op.OpID, domain.BadRequest("method must be efectivo, transferencia or otro"))
	}
	if kind == domain.KindDeduction && payload.Method != nil {
		return rejected(op.OpID, domain.BadRequest("a deduction has no payment method"))
	}

	var day *time.Time
	if payload.Date != "" {
		d, err := time.Parse("2006-01-02", payload.Date)
		if err != nil {
			return rejected(op.OpID, domain.BadRequest("date must be YYYY-MM-DD"))
		}
		day = &d
	}
	if _, err := store.GetEmployee(ctx, tx, payload.WorkerID); err != nil {
		return rejected(op.OpID, domain.NotFound(
			"that worker is not on this farm yet; pull the references first"))
	}

	want := store.NewLedgerEntry{
		ID: payload.ID, EmployeeID: payload.WorkerID, Kind: kind, AmountMinor: amount,
		LocalDay: day, Method: payload.Method, Note: payload.Note,
	}
	if p != nil && p.UserID != "" {
		want.CreatedBy = p.UserID
	}
	entry, created, err := store.AddLedgerEntry(ctx, tx, farmID, want)
	if err != nil {
		return rejected(op.OpID, err)
	}
	return applied(op.OpID, entry.ID, created)
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

func applied(opID, rowID string, created bool) store.SyncOpResult {
	if !created {
		return duplicate(opID, rowID)
	}
	return store.SyncOpResult{OpID: opID, Status: "applied", ID: rowID}
}

func duplicate(opID, rowID string) store.SyncOpResult {
	return store.SyncOpResult{OpID: opID, Status: "duplicate", ID: rowID}
}

// rejected renders a refusal into the row's own result. The batch still
// answers 200 — §3.2 — because the state of an op belongs in its row and not
// in the status line of the request that carried two hundred of them.
func rejected(opID string, err error) store.SyncOpResult {
	de, ok := domain.AsError(err)
	if !ok {
		de = domain.Internal("unexpected error").WithCause(err)
	}
	return store.SyncOpResult{
		OpID:   opID,
		Status: "rejected",
		Error: &store.SyncOpError{
			Code: de.Code, Message: de.Message, Details: de.Details,
		},
	}
}

// decodePayload is strict on purpose. §4.3 puts BAD_REQUEST in the column
// "never retry — it is a client bug", so a field the server does not know has
// to be an error the mobile pair sees on the first run, not a value silently
// dropped that shows up as a missing note three weeks later.
func decodePayload(raw json.RawMessage, v any) error {
	if len(raw) == 0 {
		return domain.BadRequest("an op needs a payload")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	dec.UseNumber()
	if err := dec.Decode(v); err != nil {
		return domain.BadRequest(decodeMessage(err)).WithCause(err)
	}
	return nil
}

func int64Param(r *http.Request, name string, fallback int64) (int64, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 {
		return 0, domain.BadRequest(name + " must be a non-negative integer")
	}
	return n, nil
}
