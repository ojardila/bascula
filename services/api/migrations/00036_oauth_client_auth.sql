-- +goose Up
-- +goose StatementBegin

-- Dynamic client registration grows up to RFC 7591. A client may ask to be
-- confidential (client_secret_post / client_secret_basic) instead of public;
-- it then gets a secret, stored here only as its SHA-256. The registered
-- metadata is kept as it was echoed back, and the scope a client asked for is
-- carried on the authorization code so the token endpoint can grant it.
ALTER TABLE oauth_clients
    ADD COLUMN secret_hash                bytea,
    ADD COLUMN token_endpoint_auth_method text  NOT NULL DEFAULT 'none',
    ADD COLUMN scope                      text  NOT NULL DEFAULT '',
    ADD COLUMN metadata                   jsonb NOT NULL DEFAULT '{}';

ALTER TABLE oauth_codes
    ADD COLUMN scope text NOT NULL DEFAULT '';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE oauth_codes DROP COLUMN IF EXISTS scope;
ALTER TABLE oauth_clients
    DROP COLUMN IF EXISTS metadata,
    DROP COLUMN IF EXISTS scope,
    DROP COLUMN IF EXISTS token_endpoint_auth_method,
    DROP COLUMN IF EXISTS secret_hash;
-- +goose StatementEnd
