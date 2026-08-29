-- +goose Up
-- +goose StatementBegin

-- Extensions. pgcrypto for digest() (registry identity hashing), postgis for
-- plot boundaries. PostGIS is adopted from day one on purpose: a polygon in
-- jsonb neither validates nor computes, and backfilling geometry later is
-- archaeology. See docs/modelo-datos.md section C.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

-- The application privilege bundle. NOLOGIN, not the owner of any table, and
-- explicitly NOBYPASSRLS: row level security is the isolation boundary, so the
-- role the API connects with must not be able to step over it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bascula_app') THEN
    CREATE ROLE bascula_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- The login role the API actually connects as. It only inherits bascula_app.
-- The password here is a development default; production overrides it with
-- ALTER ROLE bascula_api PASSWORD '...' out of band and never reads it here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bascula_api') THEN
    CREATE ROLE bascula_api LOGIN PASSWORD 'bascula_api_dev' NOBYPASSRLS;
  END IF;
END $$;
GRANT bascula_app TO bascula_api;

GRANT USAGE ON SCHEMA public TO bascula_app;

-- Every table created from here on is reachable by the app role. The RLS
-- policies in 00008 are what actually narrows this down to one farm.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bascula_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO bascula_app;

-- Monday of the ISO week of a local day. IMMUTABLE so it can back a GENERATED
-- column. This is the Postgres twin of WEEK_OF() in apps/mobile/src/schema.ts:
-- the week is the Monday's ISO date, not a "2026-W33" string.
CREATE FUNCTION week_start(d date) RETURNS date
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT d - (EXTRACT(ISODOW FROM d)::int - 1) $$;

-- The request context, set with SET LOCAL by the tenant middleware and never
-- from a client parameter. SET LOCAL dies with the transaction, so a pooled
-- connection cannot leak one farm's context into the next request.
CREATE FUNCTION current_farm() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.farm_id', true), '')::uuid $$;

CREATE FUNCTION current_role_name() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.role', true), '') $$;

CREATE FUNCTION current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- The closed sets, and only the closed sets. A value the code branches on, and
-- that means nothing if a farm invents one of its own, is an enum. Everything
-- a use case describes with "add it if it is not there" — activity categories,
-- crop types, varieties, work units — is a per-farm catalogue table instead: a
-- closed type would make every new value an ALTER TYPE in production. See the
-- team decision of 2026-08-29 in docs/decisiones.md.
CREATE TYPE farm_role         AS ENUM ('owner', 'admin', 'weigher');
CREATE TYPE ledger_kind       AS ENUM ('devengo', 'pago', 'anticipo', 'deduccion', 'ajuste', 'reverso');
CREATE TYPE pay_method        AS ENUM ('efectivo', 'transferencia', 'otro');
CREATE TYPE settlement_status AS ENUM ('open', 'void');
CREATE TYPE pay_scheme        AS ENUM ('contrato', 'tiempo', 'unidad_trabajo');
CREATE TYPE time_unit         AS ENUM ('jornal', 'semanal', 'quincenal', 'mensual', 'personalizado');

-- How a work record got its price, and therefore when the price was frozen.
--   explicit       the caller sent rateMinor; frozen at write time.
--   activity_dated derived from the activity's rate in force on the record's
--                  day; frozen at write time. Requires a single-day record.
--   weekly_price   derived from week_prices at settlement time (the behaviour
--                  the phone has today). Requires a single-day record.
-- The single-day requirement for the two derived modes is decision 4 in
-- docs/decisiones.md, enforced by work_record_rate_shape in 00005, not by convention.
CREATE TYPE rate_source AS ENUM ('explicit', 'activity_dated', 'weekly_price');

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TYPE IF EXISTS rate_source;
DROP TYPE IF EXISTS time_unit;
DROP TYPE IF EXISTS pay_scheme;
DROP TYPE IF EXISTS settlement_status;
DROP TYPE IF EXISTS pay_method;
DROP TYPE IF EXISTS ledger_kind;
DROP TYPE IF EXISTS farm_role;
DROP FUNCTION IF EXISTS current_user_id();
DROP FUNCTION IF EXISTS current_role_name();
DROP FUNCTION IF EXISTS current_farm();
DROP FUNCTION IF EXISTS week_start(date);
-- +goose StatementEnd
