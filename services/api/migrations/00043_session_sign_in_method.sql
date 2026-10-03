-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- «Sesiones abiertas»: how each session was opened, and on what.
--
-- A session is a refresh-token family (00002). Until now a family said who
-- and which farm, but not how the person got in or on which browser, so a
-- person could not look at their open sessions and recognise them, and an
-- owner could not tell a passkey sign-in from a password one.
--
-- sign_in_method is how the family was opened: 'password', 'passkey', or
-- 'oauth' (an assistant such as ChatGPT, through /oauth/token). A reset link
-- opens no session (the person signs in with the new password afterwards),
-- so it has no value of its own. NULL is a family from before this column.
-- Rotation copies it forward, like oauth_client_id, so every token in a
-- family carries the way it was opened.
--
-- user_agent is the browser or app that last used the family (the newest
-- token's request), cut to 300 characters. It is shown, never trusted: it
-- only helps a person say "that is my phone".
-- ---------------------------------------------------------------------------

ALTER TABLE refresh_tokens
  ADD COLUMN sign_in_method text
    CHECK (sign_in_method IN ('password', 'passkey', 'oauth')),
  ADD COLUMN user_agent text
    CHECK (char_length(user_agent) <= 300);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE refresh_tokens
  DROP COLUMN IF EXISTS user_agent,
  DROP COLUMN IF EXISTS sign_in_method;
-- +goose StatementEnd
