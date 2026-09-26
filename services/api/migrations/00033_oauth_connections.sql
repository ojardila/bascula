-- +goose Up
-- +goose StatementBegin

-- "Conectar con ChatGPT": a session issued through the OAuth dance (an MCP
-- client such as ChatGPT) is an ordinary refresh-token family, as revocable
-- as a handset's. This column says which OAuth client obtained it, so the
-- owner can list and revoke THOSE sessions from Configuración without
-- touching the phones and browsers logged in to the same account.
--
-- NULL means a web or handset login. Rotation copies it forward, so every
-- token in a family carries the client that started it.
ALTER TABLE refresh_tokens
  ADD COLUMN oauth_client_id text REFERENCES oauth_clients(id) ON DELETE SET NULL;

CREATE INDEX ix_refresh_oauth ON refresh_tokens (user_id, farm_id)
  WHERE oauth_client_id IS NOT NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS ix_refresh_oauth;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS oauth_client_id;
-- +goose StatementEnd
