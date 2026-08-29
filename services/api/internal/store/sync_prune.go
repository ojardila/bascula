package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Pruning the change feed. docs/sincronizacion.md §3.4.
//
// # What is removed, and why nothing is lost
//
// The feed row carries IDENTITY ONLY: a farm, an entity name, a row id and a
// sequence number. The body is composed at pull time from the real table. That
// design decision, taken so the feed could never become a second copy of the
// money that drifts from the first, has a consequence nobody wrote down and
// which is what makes this job safe:
//
//	a feed row that has a NEWER row for the same (farm, entity, row_id)
//	carries exactly the same information as that newer row, and always will.
//
// Both compose the same body from the same table. A worker corrected forty
// times leaves forty rows in sync_log and thirty-nine of them are duplicates of
// the fortieth. So the sweep deletes SUPERSEDED rows and only those.
//
// The consequences are worth stating plainly, because the alternative — a
// blunt "delete everything older than N days" — has none of them:
//
//   - Cursor 0 stays a complete bootstrap. Every live row of every table still
//     has exactly one feed entry, which is the property migration 00013's
//     backfill established and the reason /v1/sync/bootstrap has not been
//     needed yet. A blunt date cut destroys it on the first sweep, and then a
//     handset pulling from zero is told the farm is empty — the single most
//     dangerous answer this protocol can give.
//   - The ledger is never pruned. Its feed rows are `append` and there is one
//     per entry, so none is ever superseded. That is correct rather than
//     unfortunate: a bootstrap has to carry every movement.
//   - A handset that falls behind converges to the current state either way,
//     because what it receives is the state now and not a replay of history.
//
// # The horizon: 180 days
//
// Superseded rows carry no information, so in principle they could be swept
// the moment they are superseded. They are not, and the reason is the ONE cost
// pruning has: deleting the row a handset's cursor is sitting on raises the
// oldest retained seq above that cursor, and the next pull answers
// CURSOR_TOO_OLD and sends the handset through a full bootstrap. Nothing is
// lost, but a farm on a phone connection re-downloads its season.
//
// So the horizon is not "how long is the data useful", it is "how long may a
// handset be away before we make it start over". Two weeks without signal is
// ordinary on a farm — that is the whole premise of the offline design — so
// two weeks is the floor, not the target. A month would still catch a handset
// that spent the between-season lull in a drawer. 180 days is one full harvest
// cycle: a phone that has not synchronised since the previous season is a
// phone that should bootstrap, and everything shorter than that has a plausible
// farm behind it that should not.
//
// It costs almost nothing to be generous here, because what is retained is one
// row per entity anyway: the sweep is bounded by the number of rows a farm has,
// not by the number of edits it makes. That asymmetry is why the horizon can
// be set by the handset's needs rather than by the disk's.
const (
	// SyncLogRetentionDays is the age below which a superseded feed row is
	// kept anyway, so that a handset which has been away that long can still
	// catch up incrementally.
	SyncLogRetentionDays = 180

	// SyncOpsRetentionDays is §4.2's own number, and its reasoning is
	// different: sync_ops exists so that RESENDING an envelope returns the
	// same answer instead of performing the act twice. A resend thirty days
	// after the fact is not a resend — no handset holds an outbox that long,
	// and no operator meant to replay a month-old void. Keeping the rows for
	// ever would keep a table that grows with every write for no benefit
	// anybody can name.
	SyncOpsRetentionDays = 30
)

// PruneReport is what one sweep did, in rows.
type PruneReport struct {
	SyncLogDeleted int64
	SyncOpsDeleted int64
	Took           time.Duration
}

func (p PruneReport) String() string {
	return fmt.Sprintf("sync_log -%d, sync_ops -%d, in %s",
		p.SyncLogDeleted, p.SyncOpsDeleted, p.Took.Round(time.Millisecond))
}

// PruneSync runs one sweep. It takes the ADMIN pool, not the application pool,
// and that is a property rather than an inconvenience:
//
//   - sync_log is append-only. DELETE is revoked from bascula_app and a
//     trigger raises on any attempt. Migration 00014 teaches that trigger one
//     exception, guarded by a session flag — but the REVOKE is untouched, so a
//     request-serving process still cannot delete a feed row no matter what
//     flag it sets. The exception is only reachable by the role that owns the
//     schema, which is the role that runs migrations, out of band.
//   - it is cross-tenant by nature. Every other statement in this service is
//     narrowed to one farm by RLS; a sweep is not about a farm at all.
//
// So it runs the way migrations run: a separate invocation, with the admin
// URL, from a scheduler. `api -prune`.
func PruneSync(ctx context.Context, admin *pgxpool.Pool, logDays, opsDays int) (PruneReport, error) {
	var rep PruneReport
	started := time.Now()

	if logDays <= 0 {
		logDays = SyncLogRetentionDays
	}
	if opsDays <= 0 {
		opsDays = SyncOpsRetentionDays
	}

	tx, err := admin.Begin(ctx)
	if err != nil {
		return rep, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// SET LOCAL: the permission to delete from sync_log dies with this
	// transaction, whatever happens next.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.sync_prune', 'on', true)`); err != nil {
		return rep, err
	}

	tag, err := tx.Exec(ctx, `
		DELETE FROM sync_log s
		 WHERE s.at < now() - make_interval(days => $1)
		   AND EXISTS (SELECT 1 FROM sync_log newer
		                WHERE newer.farm_id = s.farm_id
		                  AND newer.entity  = s.entity
		                  AND newer.row_id  = s.row_id
		                  AND newer.seq     > s.seq)`, logDays)
	if err != nil {
		return rep, err
	}
	rep.SyncLogDeleted = tag.RowsAffected()

	tag, err = tx.Exec(ctx, `
		DELETE FROM sync_ops WHERE at < now() - make_interval(days => $1)`, opsDays)
	if err != nil {
		return rep, err
	}
	rep.SyncOpsDeleted = tag.RowsAffected()

	if err := tx.Commit(ctx); err != nil {
		return rep, err
	}
	rep.Took = time.Since(started)
	return rep, nil
}
