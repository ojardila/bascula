package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// The registry of who has consumed the feed, and under which role.
//
// docs/sincronizacion.md gives the handset ONE integer, and that is the right
// design: a watermark per table needs updated_at everywhere, cannot tell a
// deletion from a row that never existed, and breaks on clocks. But one integer
// carries no answer to the question this file exists for — "cursor 412, seen by
// whom?" — and the pull needs that answer, because it SKIPS rows by role and
// consumes their seq anyway.
//
// The skip itself is right. A weigher whose cursor stopped at the first payroll
// of the season would never receive another change, so the seq has to move. What
// was missing is that the skip is PERMANENT: sync_log gets one row per write, the
// ledger's trigger is AFTER INSERT on an append-only table, and no second event
// about that row will ever exist. Promote that weigher, or hand his handset to
// the foreman, and the new role's first pull answers `changes: []`, `behind: 0` —
// an incomplete book, and a server insisting it is complete.
//
// So the server keeps its own copy of each reader's cursor beside the role it was
// served under. When those disagree with who is asking now, the reader is sent
// back to 0 — which the backfill in migration 00013 makes a full bootstrap rather
// than an empty farm.
//
// # A role change reaches every device the account holds
//
// A promotion is a fact about an ACCOUNT and a demotion likewise, so when one is
// noticed, every reader row of that account on that farm is marked at once — not
// only the handset that happened to notice. Otherwise the phone that pulled first
// would clear the flag and the tablet in the office would keep its incomplete
// book, which is the original bug with one more step in front of it.
//
// # Who writes and who only looks
//
// The PULL writes: it is the endpoint that delivers changes, so it is the only
// one entitled to say what a reader has received. The HANDSHAKE only looks. A
// handshake that cleared an order would let a phone talk its way out of a replay
// without receiving a single row, and the purge instruction that travels with the
// order would go with it.

// NilDevice is the device id of a caller that names none. It is a real reader —
// "this account's unnamed client" — and not a null meaning "unknown", for the
// same reason nothing else in this codebase lets a zero stand in for a missing
// answer.
//
// Two unnamed clients of one account share it, and therefore share a reader:
// whichever pulls first clears an order for both. That is the one case this
// registry cannot separate, and the way out of it is for the client to name its
// device — the pull takes `deviceId`, and a handset that sends it gets a reader
// of its own.
const NilDevice = "00000000-0000-0000-0000-000000000000"

// Why a reader is being sent back to the beginning. Codes, not sentences: the
// translation lives in the client, like every other code in this contract.
const (
	// ReplayDeviceUnknown — this account has never been seen consuming this
	// farm's feed at all, and it is presenting a cursor. The server cannot know
	// what role that cursor was served under, and "cannot know" is not "the same
	// as now". Every reader in the field is unknown exactly once, on its first
	// pull after migration 00017.
	ReplayDeviceUnknown = "device_unknown"
	// ReplayRoleChanged — the same account, a different role. The promoted
	// weigher, and the demoted administrator.
	ReplayRoleChanged = "role_changed"
	// ReplayDeviceReassigned — this handset has consumed this farm's feed
	// before, for SOMEBODY ELSE. The phone that changed hands.
	ReplayDeviceReassigned = "device_reassigned"
)

// ReplayOrder is what the server tells a reader to do about its cursor.
//
// FromCursor is a pointer so that "no replay owed" cannot be read as "replay
// from 0": those are opposite instructions, and a zero standing in for the
// absence of one would be this file's own bug, restated in its fix.
type ReplayOrder struct {
	Required   bool   `json:"required"`
	FromCursor *int64 `json:"fromCursor"`
	Reason     string `json:"reason,omitempty"`
	// PurgeMoney tells the handset to DROP the settlements and ledger movements
	// it is holding before it replays. It is set when the reader may be holding
	// rows its current role would not be sent today: a demotion, or a handset
	// that has changed hands. A promotion never sets it — there is nothing on
	// that phone the new role may not see.
	//
	// It names the money entities and nothing else. It is not a wipe and must
	// never become one: the handset's outbox is work that has reached no other
	// machine, and instructing a phone to throw that away would lose weighings
	// that exist nowhere else.
	PurgeMoney bool `json:"purgeMoney"`
	// PreviousRole is what the cursor had been served under, when the server
	// knows. Empty for an account it has never seen.
	PreviousRole domain.Role `json:"previousRole,omitempty"`
}

// Owed reports whether this reader has a replay outstanding.
func (r ReplayOrder) Owed() bool { return r.Reason != "" }

// SyncReaderDevice picks the device a request speaks for: the one it named, or
// the one its token was issued to, or the account's unnamed client.
//
// The token is consulted second and not first on purpose. A handset that names
// a device in the request is telling the server which cursor it holds, and a
// token minted months ago on some other install is weaker evidence than that.
func SyncReaderDevice(named, fromToken string) string {
	if named != "" {
		return named
	}
	if fromToken != "" {
		return fromToken
	}
	return NilDevice
}

// readerRow is one registered reader of this farm's feed.
type readerRow struct {
	DeviceID string
	Role     domain.Role
	Pending  *string
	Purge    bool
}

// SyncReaderInspect answers what this reader owes, without writing anything.
func SyncReaderInspect(ctx context.Context, tx pgx.Tx, userID, deviceID string,
	role domain.Role, requested int64) (ReplayOrder, error) {

	rows, err := loadReaders(ctx, tx, userID, false)
	if err != nil {
		return ReplayOrder{}, err
	}
	return decideReplay(ctx, tx, rows, userID, deviceID, role, requested)
}

// SyncReaderCheck is SyncReaderInspect plus the record of it: the order is put
// on the reader's row — and on every other row of the same account when the
// reason is a role change — so it survives until each of them complies.
//
// It takes the account's rows FOR UPDATE, which serialises the pulls of one
// account against each other. That is the intended cost: two of somebody's
// handsets racing to decide what they have received is not a case worth being
// clever about.
func SyncReaderCheck(ctx context.Context, tx pgx.Tx, userID, deviceID string,
	role domain.Role, requested int64) (ReplayOrder, error) {

	rows, err := loadReaders(ctx, tx, userID, true)
	if err != nil {
		return ReplayOrder{}, err
	}
	order, err := decideReplay(ctx, tx, rows, userID, deviceID, role, requested)
	if err != nil {
		return ReplayOrder{}, err
	}

	// A role change is a fact about the account, so it is written onto every
	// device the account holds and not only onto the one that noticed.
	// COALESCE and OR rather than assignment: a handset that already owed a
	// replay for a stronger reason keeps that reason and keeps its purge.
	if order.Reason == ReplayRoleChanged {
		if _, err := tx.Exec(ctx, `
			UPDATE sync_readers
			   SET role          = $2,
			       delivered_seq = 0,
			       replay_reason = COALESCE(replay_reason, $3),
			       purge_money   = purge_money OR $4,
			       updated_at    = now()
			 WHERE farm_id = current_farm() AND user_id = $1`,
			userID, string(role), ReplayRoleChanged, order.PurgeMoney); err != nil {
			return ReplayOrder{}, err
		}
	}

	// This reader's own row. A reader that is starting from 0 is PERFORMING the
	// replay rather than owing one, so nothing pending is written against it —
	// the caller still gets the order back, because `purgeMoney` has to reach
	// the handset that is about to receive the whole feed again.
	reason := nilIfEmpty(order.Reason)
	purge := order.PurgeMoney
	if requested == 0 {
		reason, purge = nil, false
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sync_readers (farm_id, user_id, device_id, role, delivered_seq,
		                          replay_reason, purge_money)
		VALUES (current_farm(), $1, $2, $3, 0, $4, $5)
		ON CONFLICT (farm_id, user_id, device_id) DO UPDATE
		   SET role          = EXCLUDED.role,
		       replay_reason = EXCLUDED.replay_reason,
		       purge_money   = EXCLUDED.purge_money,
		       updated_at    = now()`,
		userID, deviceID, string(role), reason, purge); err != nil {
		return ReplayOrder{}, err
	}
	return order, nil
}

// decideReplay is the whole judgement, in one place, reading only rows.
//
// The question it answers is narrow: may this cursor be resumed, or does the
// reader have to start again? Everything it needs is the account's registered
// readers and the role asking now.
func decideReplay(ctx context.Context, tx pgx.Tx, rows []readerRow,
	userID, deviceID string, role domain.Role, requested int64) (ReplayOrder, error) {

	var own *readerRow
	for i := range rows {
		if rows[i].DeviceID == deviceID {
			own = &rows[i]
		}
	}

	if own != nil {
		order := ReplayOrder{PreviousRole: own.Role}
		switch {
		case own.Pending != nil:
			// An order already stands and this reader has not complied. It is
			// repeated verbatim rather than recomputed: the reason it was raised
			// for is the reason it is still owed.
			order.Reason, order.PurgeMoney = *own.Pending, own.Purge
		case own.Role != role:
			order.Reason = ReplayRoleChanged
			// Only a role that LOSES sight of money has anything to drop.
			order.PurgeMoney = roleSeesMoney(own.Role) && !roleSeesMoney(role)
		}
		// Otherwise: same reader, same role, nothing owed. A cursor above what
		// this server has served is not policed here — the handshake hands out
		// the head of the feed and a handset may adopt it, and the pull's own
		// CURSOR_TOO_OLD check is what refuses a cursor that cannot have come
		// from this server at all.
		return withRequired(order, requested), nil
	}

	// A reader with no row of its own. At cursor 0 that is simply a new client,
	// and there is nothing to replay or to drop: it is about to receive
	// everything anyway.
	if requested == 0 {
		return ReplayOrder{}, nil
	}

	// It is presenting a cursor this server has no record of serving it, so what
	// the ACCOUNT's other readers say decides how much of a repair that needs.
	reassigned, err := deviceKnownToSomebodyElse(ctx, tx, userID, deviceID)
	if err != nil {
		return ReplayOrder{}, err
	}
	if reassigned {
		// This handset has consumed this farm's feed for somebody else. Whatever
		// money it downloaded belongs to that session and not to this one.
		return withRequired(ReplayOrder{
			Reason: ReplayDeviceReassigned, PurgeMoney: true}, requested), nil
	}
	if len(rows) == 0 {
		// The account has never consumed this farm's feed at all. Nothing is
		// known about what this cursor was served under — including whether it
		// came from this server's registry-less past. For a weigher that is
		// reason enough to drop the money entities: his handset should not be
		// carrying any, so the instruction costs him nothing and closes the case
		// where it does. For an administrator there is nothing he may not see.
		return withRequired(ReplayOrder{
			Reason: ReplayDeviceUnknown, PurgeMoney: !roleSeesMoney(role)}, requested), nil
	}

	// The account IS registered here, on other clients. A second client of a
	// reader whose role has not moved and who owes nothing is not a mystery — it
	// is a laptop beside a handset — and sending it through a bootstrap would be
	// a toll on the ordinary case. But whatever its siblings owe, it owes: an
	// order raised against the account has to reach the client that had not
	// arrived yet when it was raised.
	order := ReplayOrder{PreviousRole: rows[0].Role}
	for _, peer := range rows {
		if peer.Pending != nil {
			order.Reason = *peer.Pending
			order.PurgeMoney = order.PurgeMoney || peer.Purge
		}
		if peer.Role != role && order.Reason == "" {
			order.Reason = ReplayRoleChanged
			order.PurgeMoney = order.PurgeMoney ||
				(roleSeesMoney(peer.Role) && !roleSeesMoney(role))
		}
	}
	return withRequired(order, requested), nil
}

func withRequired(order ReplayOrder, requested int64) ReplayOrder {
	if !order.Owed() {
		return ReplayOrder{}
	}
	if requested > 0 {
		from := int64(0)
		order.Required = true
		order.FromCursor = &from
	}
	return order
}

// loadReaders reads every reader this account has registered on this farm. It
// is a handful of rows — one per client — and reading them together is what lets
// a role change be judged for the account rather than for one handset.
func loadReaders(ctx context.Context, tx pgx.Tx, userID string, lock bool) ([]readerRow, error) {
	q := `SELECT device_id::text, role::text, replay_reason, purge_money
	        FROM sync_readers
	       WHERE farm_id = current_farm() AND user_id = $1
	       ORDER BY device_id`
	if lock {
		q += ` FOR UPDATE`
	}
	rows, err := tx.Query(ctx, q, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []readerRow{}
	for rows.Next() {
		var r readerRow
		var role string
		if err := rows.Scan(&r.DeviceID, &role, &r.Pending, &r.Purge); err != nil {
			return nil, err
		}
		r.Role = domain.Role(role)
		out = append(out, r)
	}
	return out, rows.Err()
}

// deviceKnownToSomebodyElse is how "this phone changed hands" is told from
// "this phone is new". The unnamed-device reader is excluded: it is one row per
// account by construction, so finding another account's would prove nothing.
func deviceKnownToSomebodyElse(ctx context.Context, tx pgx.Tx, userID, deviceID string) (bool, error) {
	if deviceID == NilDevice {
		return false, nil
	}
	var found bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM sync_readers
		                WHERE farm_id = current_farm() AND device_id = $1
		                  AND user_id <> $2)`, deviceID, userID).Scan(&found)
	return found, err
}

// SyncReaderAdvance records what a reader was actually served, and clears any
// order it has just complied with.
//
// It runs after the changes are composed and inside the same transaction, so a
// pull that fails to compose advances nothing: the registry cannot claim to have
// delivered a batch the caller never received.
func SyncReaderAdvance(ctx context.Context, tx pgx.Tx, userID, deviceID string,
	role domain.Role, served int64) error {

	_, err := tx.Exec(ctx, `
		INSERT INTO sync_readers (farm_id, user_id, device_id, role, delivered_seq)
		VALUES (current_farm(), $1, $2, $3, $4)
		ON CONFLICT (farm_id, user_id, device_id) DO UPDATE
		   SET delivered_seq = GREATEST(sync_readers.delivered_seq, EXCLUDED.delivered_seq),
		       role          = EXCLUDED.role,
		       replay_reason = NULL,
		       purge_money   = false,
		       updated_at    = now()`,
		userID, deviceID, string(role), served)
	return err
}

// roleSeesMoney is the same line SyncChanges draws: settlements, ledger
// movements and the weekly price are composed for these roles and skipped for
// the other one.
func roleSeesMoney(r domain.Role) bool {
	return r == domain.RoleOwner || r == domain.RoleAdmin
}
