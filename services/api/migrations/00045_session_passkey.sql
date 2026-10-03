-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- Which passkey opened a session, so removing the passkey closes it.
--
-- 00043 records that a family was opened with a passkey, but not with which
-- one. Removing a passkey stopped new sign-ins with it and left every session
-- it had already opened alive for up to sixty days: a person who removes the
-- passkey of a lost phone expects that phone to be signed out.
--
-- passkey_id is the passkey a 'passkey' family was opened with; NULL for any
-- other method and for families from before this column. Rotation copies it
-- forward, like sign_in_method, so every token in the family carries it.
--
-- # Why no foreign key
--
-- The column has to outlive the passkey for as long as it takes to close the
-- sessions it opened. ON DELETE SET NULL would erase exactly the link the
-- removal needs, and ON DELETE CASCADE would delete refresh tokens instead of
-- revoking them, losing reuse detection on the family.
-- ---------------------------------------------------------------------------

ALTER TABLE refresh_tokens ADD COLUMN passkey_id uuid;

CREATE INDEX ix_refresh_tokens_passkey ON refresh_tokens (passkey_id)
  WHERE passkey_id IS NOT NULL AND revoked_at IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS ix_refresh_tokens_passkey;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS passkey_id;
-- +goose StatementEnd
