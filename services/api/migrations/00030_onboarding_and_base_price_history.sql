-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- The farm's base price gets a history.
--
-- Until now farm_config.price_minor was one number with no date: changing it
-- repriced every unsettled week that had no override of its own, including
-- weeks the owner thought were long closed. The onboarding design (approved
-- 2026-09) asks for "precio del kilo, desde el lunes X", so the base price is
-- now effective-dated, exactly like activity_pay_work_unit already is.
--
-- The price of a week is resolved as:
--   week_prices override for that Monday
--   > the farm_prices row with the latest valid_from <= that Monday
--   > farm_config.price_minor (the current price; also what a weigher's
--     projection falls back to, since he cannot read either money table).
--
-- Settled lines are never touched: settlement_items froze their price when
-- they were settled, so a new base price only moves unsettled work.
-- ---------------------------------------------------------------------------
CREATE TABLE farm_prices (
  farm_id     uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  valid_from  date NOT NULL CHECK (EXTRACT(ISODOW FROM valid_from) = 1),
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (farm_id, valid_from)
);

-- Every existing farm keeps the price it has, "since always". 2000-01-03 is a
-- Monday well before any weighing this system has stored.
INSERT INTO farm_prices (farm_id, valid_from, price_minor)
SELECT farm_id, DATE '2000-01-03', price_minor FROM farm_config;

ALTER TABLE farm_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE farm_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY p_farm_prices_read ON farm_prices FOR SELECT
  USING (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'));
CREATE POLICY p_farm_prices_write ON farm_prices FOR ALL
  USING (farm_id = current_farm() AND current_role_name() = 'owner')
  WITH CHECK (farm_id = current_farm() AND current_role_name() = 'owner');

COMMENT ON TABLE farm_prices IS
  'The farm base price of a kilo, effective from a Monday. Money: readable by '
  'the owner and the administrator only, like week_prices. See migration 00030.';

-- A farm signed up from the landing gets a default price nobody chose. The
-- onboarding tour asks the owner to confirm it; this is how it knows whether
-- it has been confirmed. Farms that already exist are treated as confirmed.
ALTER TABLE farm_config ADD COLUMN price_confirmed_at timestamptz;
UPDATE farm_config SET price_confirmed_at = now();

-- ---------------------------------------------------------------------------
-- Guided tour progress, per user and farm, so a tour resumes on any device.
-- ---------------------------------------------------------------------------
CREATE TABLE user_tours (
  farm_id    uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tour       text NOT NULL CHECK (tour ~ '^[a-z][a-z0-9_-]{0,39}$'),
  step       int  NOT NULL DEFAULT 0 CHECK (step >= 0 AND step <= 100),
  status     text NOT NULL CHECK (status IN ('active', 'later', 'dismissed', 'done')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (farm_id, user_id, tour)
);

ALTER TABLE user_tours ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tours FORCE ROW LEVEL SECURITY;
CREATE POLICY p_user_tours_own ON user_tours FOR ALL
  USING (farm_id = current_farm() AND user_id = current_user_id())
  WITH CHECK (farm_id = current_farm() AND user_id = current_user_id());
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS user_tours;
ALTER TABLE farm_config DROP COLUMN IF EXISTS price_confirmed_at;
DROP TABLE IF EXISTS farm_prices;
-- +goose StatementEnd
