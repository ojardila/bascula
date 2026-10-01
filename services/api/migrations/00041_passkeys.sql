-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- Passkeys: an optional second way through the login door.
--
-- A person may add one or more passkeys to their account from Configuración
-- and then sign in with the phone's fingerprint, face or screen lock instead
-- of typing the password. The password keeps working; nothing here replaces
-- it, and an account with no passkey behaves exactly as before.
--
-- # Why no RLS
--
-- Same reason as users and login_failures: a passkey sign-in reads this table
-- before there is a session, so before there is a farm. The credential is the
-- caller's only identifier at that point, and a policy keyed on current_farm()
-- would make every lookup come back empty. Every statement that touches it in
-- a signed-in request names the caller's own user_id.
--
-- # rp_id
--
-- The WebAuthn relying party the credential was created for: the host the
-- person was on ({slug}.bascula.engp.io, or the apex). A dedicated farm stack
-- has a database of its own, so a passkey bound to the parent domain would be
-- offered by the phone on every farm and recognised by one. Binding it to the
-- host keeps the phone from offering a passkey this database does not hold,
-- and the lookup checks it again so a credential made for one address never
-- opens another served by the same process.
--
-- # only_farm_id
--
-- A passkey never opens more than the session that created it could. A farm
-- with its own owner password (farm_owner_credentials, 00032/00037) opens
-- only with that password; a passkey added from a session on such a farm is
-- pinned to it here. NULL means "the farms the account password opens", which
-- excludes every farm that has its own password.
-- ---------------------------------------------------------------------------

CREATE TABLE passkeys (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rp_id         text NOT NULL,
  credential_id bytea NOT NULL,
  only_farm_id  uuid REFERENCES farms(id) ON DELETE CASCADE,
  name          text NOT NULL,
  -- The library's credential record (public key, sign count, flags,
  -- transports, AAGUID) as JSON, so a new field upstream is not a migration.
  record        jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE UNIQUE INDEX ux_passkeys_credential ON passkeys (credential_id);
CREATE INDEX ix_passkeys_user ON passkeys (user_id, rp_id);

-- A sign-in challenge is handed out sealed and stateless, so asking for one
-- writes nothing (the door is public). What makes it single-use is this
-- table: a successful passkey sign-in records the challenge it answered, and
-- a second sign-in with the same one is refused. Only successes write here,
-- and the nightly sweep drops rows whose challenge has expired anyway.
CREATE TABLE passkey_used_challenges (
  challenge_hash bytea PRIMARY KEY,
  expires_at     timestamptz NOT NULL
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS passkey_used_challenges;
DROP TABLE IF EXISTS passkeys;
-- +goose StatementEnd
