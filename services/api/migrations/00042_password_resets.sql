-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- Password reset by email.
--
-- Until now a password could not be changed at all: there was no endpoint
-- for it, and the advice on /olvide-mi-clave (ask the owner, Configuración →
-- Usuarios) pointed at a screen that cannot do it. An owner who forgot the
-- password had nobody who could help.
--
-- Where a mailer is configured, "olvidé mi clave" sends a link to the
-- address. The link carries a secret whose sha256 is all this table keeps,
-- like refresh_tokens and email_verifications. It is single-use and short
-- lived, and asking for a new one spends every older one, so the newest
-- email is the only one that works.
--
-- # Why no RLS
--
-- Same reason as users, login_failures and the passkeys of 00041: the whole
-- flow happens before there is a session, so before there is a farm. The
-- address (asking) and the secret (spending) are the caller's only
-- identifiers, and a policy keyed on current_farm() would make every lookup
-- come back empty.
-- ---------------------------------------------------------------------------

CREATE TABLE password_resets (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_password_resets_user ON password_resets (user_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS password_resets;
-- +goose StatementEnd
