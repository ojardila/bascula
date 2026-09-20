-- +goose Up
-- +goose StatementBegin

-- OAuth 2.1 for the MCP tunnel. ChatGPT's connector UI will not take a
-- pasted bearer; it discovers this service through the well-known documents
-- and then runs authorization-code + PKCE. The tokens it receives are the
-- same JWTs POST /v1/auth/login already issues — there is no second identity.
--
-- No farm_id, and therefore no RLS. Same argument as login_failures (00023):
-- registration and the code exchange happen before there is a session, so a
-- policy keyed on current_farm() would make every lookup miss. Nothing here
-- is a farm's data. Codes expire in minutes and are deleted on use.

CREATE TABLE oauth_clients (
    id            text PRIMARY KEY,
    name          text NOT NULL DEFAULT '',
    redirect_uris text[] NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_codes (
    code                   text PRIMARY KEY,
    client_id              text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    redirect_uri           text NOT NULL,
    code_challenge         text NOT NULL,
    code_challenge_method  text NOT NULL,
    resource               text NOT NULL DEFAULT '',
    access_token           text NOT NULL,
    expires_at             timestamptz NOT NULL
);

CREATE INDEX oauth_codes_expires_at ON oauth_codes (expires_at);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS oauth_codes;
DROP TABLE IF EXISTS oauth_clients;
-- +goose StatementEnd
