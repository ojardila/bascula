-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- A refusal is not an outcome worth remembering.
--
-- sync_ops is the idempotency registry of §4.2: an opId that has been seen
-- returns its stored answer LITERALLY and executes nothing. That is exactly
-- right for an envelope that CHANGED something — a resent void must not hand
-- the money back twice — and it was being applied to envelopes that changed
-- nothing at all.
--
-- A rejected envelope is rolled back to its savepoint before the batch moves
-- on. There is no side effect for a replay to duplicate. But the rejection was
-- written to this table all the same, and from then on the opId was sealed
-- two different ways:
--
--   * resend the same bytes, and the stored refusal comes back for ever,
--     however long ago the cause was fixed;
--   * fix the bytes, and the fingerprint added in 00015 no longer matches, so
--     the answer is IDEMPOTENCY_KEY_REUSED — which §4.3 files under "never
--     retry, it is a client bug".
--
-- Both doors shut on an act that was never performed. The outbox row could
-- never leave the handset, and the only way out was a new opId, which the
-- phone has no reason to mint for an op it never completed.
--
-- Two statements, in this order.
--
-- FIRST, free the ones already cemented. These rows carry no side effect by
-- definition, so deleting them loses nothing that exists: the next resend is
-- evaluated afresh, which is what should have happened all along.
DELETE FROM sync_ops WHERE status = 'rejected';

-- SECOND, make the regression impossible in the database rather than only in
-- Go. store.RecordSyncOp now drops rejections on the floor; this is the check
-- that fails loudly if a future writer forgets, instead of quietly sealing
-- somebody's weighing out of the system again.
ALTER TABLE sync_ops DROP CONSTRAINT sync_ops_status_check;
ALTER TABLE sync_ops ADD CONSTRAINT sync_ops_status_check
  CHECK (status IN ('applied', 'duplicate'));

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sync_ops DROP CONSTRAINT sync_ops_status_check;
ALTER TABLE sync_ops ADD CONSTRAINT sync_ops_status_check
  CHECK (status IN ('applied', 'duplicate', 'rejected'));
-- +goose StatementEnd
