-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- What the feed has already been ALLOWED to say to a given reader.
--
-- The hole this closes (audit finding 9), stated exactly:
--
--   store.SyncChanges consumes a seq even when it composes no body for it,
--   which is right — a weigher whose cursor stopped at the first payroll of
--   the season would never receive another change. But the skip is permanent.
--   sync_log has one trigger per table and the ledger's is AFTER INSERT on an
--   append-only table, so a row skipped by role produces no second event, ever.
--   Promote that weigher to administrator, or hand his phone to the foreman,
--   and the new role's first pull answers `changes: []`, `behind: 0`: a handset
--   with an incomplete book being told, truthfully for ever, that it is up to
--   date.
--
-- The previous sprint declined to patch this and was right to: the cursor is
-- one integer and one integer cannot carry "under which role". The missing
-- piece is a REGISTRY of who consumed the feed, which is this table.
--
-- # The key: (farm, user, device)
--
-- The reader of a feed is not a device and not an account, it is the pair. Both
-- halves have to be in the key, and each one catches a different failure:
--
--   * the USER, because a phone that changes hands presents the previous
--     holder's cursor under a new session. Keyed by user, that session simply
--     has no row here, and "no row" is not "up to date" — it is "I have never
--     seen this reader", which orders a replay rather than assuming one.
--   * the DEVICE, because one person may carry a handset and open the console
--     on a laptop, and they hold two independent cursors. Sharing one row
--     between them would let the laptop's progress convince the server that
--     the handset had already received a change it never got.
--
-- A caller that names no device gets the nil uuid, which is a real reader —
-- "this account's unnamed client" — and not a null meaning "unknown". A null
-- here would be exactly the silent zero the rest of this schema refuses.
--
-- # delivered_seq is the SERVER's copy of the cursor
--
-- The phone's cursor is a claim; this column is what the server actually
-- served, under the role recorded beside it. Resetting it to 0 is how a replay
-- is ordered, and clearing `replay_reason` is how the server records that the
-- reader complied. The pull refuses any cursor above 0 while a replay is
-- pending, with REPLAY_REQUIRED, which is the same shape as CURSOR_TOO_OLD and
-- the same recovery: pull from 0, which the backfill of 00013 makes a complete
-- bootstrap rather than an empty farm.
-- ---------------------------------------------------------------------------

CREATE TABLE sync_readers (
  farm_id   uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The nil uuid is the caller that names no device. See the note above: it is
  -- a reader, not an unknown.
  device_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  -- The role under which everything up to delivered_seq was composed. This one
  -- column is the whole fix: it is what a bare cursor could never carry.
  role      farm_role NOT NULL,
  delivered_seq bigint NOT NULL DEFAULT 0 CHECK (delivered_seq >= 0),
  -- NULL means nothing is pending. The three values are codes the handset
  -- branches on, not sentences: the translation lives in the client, like every
  -- other code in this contract.
  replay_reason text CHECK (replay_reason IN
    ('device_unknown', 'role_changed', 'device_reassigned')),
  -- Whether the reader has to DROP what it already holds, on top of replaying.
  -- It is set when the reader may be holding rows its current role would not be
  -- sent today — a promotion never sets it, a demotion and a change of holder
  -- always do. It names the money entities only: settlements and ledger
  -- movements. It is not a wipe, and it must never become one — the handset's
  -- outbox is work that has not reached the server yet, and instructing a phone
  -- to throw that away would lose weighings that exist nowhere else.
  purge_money boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (farm_id, user_id, device_id)
);
-- "Who else has used this handset on this farm", which is how a change of
-- holder is told from a device nobody has ever registered.
CREATE INDEX ix_sync_readers_device ON sync_readers (farm_id, device_id);

-- RLS by hand, because the generated loop in 00008 has already run.
--
-- Every role reaches it, and it has to be that way: the weigher's handset is
-- the one that spends days without signal, and a policy that kept him out of
-- this table would make his pull fail rather than his book complete. There is
-- no money in a row here — a farm, an account, a device, a role name and an
-- integer — and the rule is the plain tenant rule.
ALTER TABLE sync_readers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_readers FORCE ROW LEVEL SECURITY;
CREATE POLICY p_sync_readers ON sync_readers
  USING (farm_id = current_farm())
  WITH CHECK (farm_id = current_farm());

-- ---------------------------------------------------------------------------
-- No backfill, deliberately.
--
-- A row here means "this reader consumed the feed up to N under role R". There
-- is no honest way to write that about a handset that synchronised before this
-- table existed: the server does not know which role was in force when each of
-- those seqs went past. Inventing the current role would be asserting the very
-- thing the audit found to be false.
--
-- So every reader that already exists in the field is unknown on its first
-- pull after this migration, and is told to replay from 0 once. That costs one
-- bootstrap per handset — the feed is one row per live entity, not one per
-- edit, so it is the size of the farm and not the size of its history — and it
-- is the only starting state that is true.
-- ---------------------------------------------------------------------------

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS sync_readers;
-- +goose StatementEnd
