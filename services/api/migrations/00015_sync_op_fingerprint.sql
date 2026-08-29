-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- The idempotency key has to key something.
--
-- §4.2 says an opId that has been seen returns its stored answer LITERALLY and
-- executes nothing. That is exactly right for a RESEND — the same act, sent
-- twice because the first answer was lost — and exactly wrong for a COLLISION:
-- two different acts that arrived under one key.
--
-- The registry could not tell them apart, because it stored the answer and not
-- the question. So a second envelope carrying a DIFFERENT weighing under an
-- opId already used got back `applied`, with the FIRST weighing's id in it. The
-- handset reads `applied`, drops the op from its outbox, and the second
-- weighing is gone — no error anywhere, no row anywhere, and a picker short a
-- day's work.
--
-- `fingerprint` is a sha-256 over (entity, op, payload) — the question. On a
-- resend it matches and the stored answer is returned as before. On a collision
-- it does not, and the envelope is refused with IDEMPOTENCY_KEY_REUSED, which
-- §4.3 puts in the column "never retry — it is a client bug". The phone keeps
-- the row and the pair sees it on the first run.
--
-- NULL on the rows already here. An op recorded before this migration cannot
-- have its question reconstructed, and inventing one would turn every one of
-- them into a collision on the next resend; NULL means "cannot compare", and
-- the old behaviour — return the stored answer — is what it falls back to.
-- Retention on sync_ops is 30 days, so this heals by itself.
-- ---------------------------------------------------------------------------

ALTER TABLE sync_ops ADD COLUMN fingerprint text;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sync_ops DROP COLUMN IF EXISTS fingerprint;
-- +goose StatementEnd
