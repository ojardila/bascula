-- +goose Up
-- +goose StatementBegin

CREATE TABLE farms (
  id           uuid PRIMARY KEY,
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  timezone     text NOT NULL DEFAULT 'America/Bogota',
  currency     char(3) NOT NULL DEFAULT 'COP',
  minor_unit   smallint NOT NULL DEFAULT 2 CHECK (minor_unit BETWEEN 0 AND 4),
  phone        text,
  country      text,
  city         text,
  address      text,
  area_ha      numeric(10, 3) CHECK (area_ha IS NULL OR area_ha > 0),
  suspended_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- A bad IANA name raises here rather than silently shifting every local_day.
  CONSTRAINT farms_tz_valid CHECK (now() AT TIME ZONE timezone IS NOT NULL)
);

CREATE TABLE users (
  id                uuid PRIMARY KEY,
  email             text NOT NULL,
  name              text NOT NULL DEFAULT '',
  password_hash     text NOT NULL,
  is_superadmin     boolean NOT NULL DEFAULT false,
  email_verified_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_users_email ON users (lower(email));

CREATE TABLE memberships (
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    farm_role NOT NULL,
  PRIMARY KEY (farm_id, user_id)
);
CREATE INDEX ix_memberships_user ON memberships (user_id);
-- "A farm keeps at least one owner" lives in the API, not here: its error
-- message is part of the UX.

-- Opaque refresh tokens, 60 days, rotated on every use. Only the sha256 of the
-- secret is stored, so a dump of this table does not hand out sessions.
-- Reuse detection: presenting a token that was already rotated revokes the
-- whole family, which is how a lent phone gets killed from the web.
CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY,
  family_id    uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  farm_id      uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  device_id    uuid,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  rotated_at   timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX ix_refresh_family ON refresh_tokens (family_id);
CREATE INDEX ix_refresh_user ON refresh_tokens (user_id, farm_id);

-- Email verification for the open self-signup (decision 2). The farm is active
-- immediately, but the owner cannot open a session until the address is proven.
CREATE TABLE email_verifications (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  farm_id    uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_email_verifications_user ON email_verifications (user_id);

-- Signups per IP and per email, so the most exposed surface in the system has
-- a floor of rate limiting that survives a process restart.
CREATE TABLE signup_attempts (
  id         uuid PRIMARY KEY,
  ip         inet NOT NULL,
  email      text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  succeeded  boolean NOT NULL
);
CREATE INDEX ix_signup_attempts_ip ON signup_attempts (ip, at DESC);
CREATE INDEX ix_signup_attempts_email ON signup_attempts (lower(email), at DESC);

CREATE TABLE farm_config (
  farm_id     uuid PRIMARY KEY REFERENCES farms(id) ON DELETE CASCADE,
  crop_type   text NOT NULL DEFAULT 'cafe',
  label       text NOT NULL DEFAULT 'Recoleccion',
  unit        text NOT NULL DEFAULT 'kg',
  yield_unit  text NOT NULL DEFAULT 'kg',
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  language    text NOT NULL DEFAULT 'es' CHECK (language IN ('es', 'en', 'pt'))
);

-- The weekly collection price, ex cost_overrides on the phone. The week is
-- always a Monday; the CHECK makes that impossible to get wrong.
CREATE TABLE week_prices (
  farm_id     uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  week_start  date NOT NULL CHECK (week_start = week_start(week_start)),
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  PRIMARY KEY (farm_id, week_start)
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS week_prices;
DROP TABLE IF EXISTS farm_config;
DROP TABLE IF EXISTS signup_attempts;
DROP TABLE IF EXISTS email_verifications;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS farms;
-- +goose StatementEnd
