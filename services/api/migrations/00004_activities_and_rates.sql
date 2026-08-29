-- +goose Up
-- +goose StatementBegin

-- kilo, arroba, canasta, and whatever a farm invents. A table and not an enum
-- on purpose: a "canasta" weighs something different on every farm, and
-- kg_factor is what makes two farms comparable.
CREATE TABLE work_units (
  id        uuid PRIMARY KEY,
  farm_id   uuid NOT NULL REFERENCES farms(id),
  code      text NOT NULL CHECK (length(btrim(code)) > 0),
  label     text NOT NULL,
  kg_factor numeric(10, 4) CHECK (kg_factor IS NULL OR kg_factor > 0),
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_work_units_code ON work_units (farm_id, lower(code));

-- Activity categories: a per-farm catalogue seeded with three values, not a
-- closed type. RSP-011 says the picker comes with an option to create a new
-- one, and with an enum every farm that invents "poscosecha" would be an
-- ALTER TYPE in production. Idempotent by (farm_id, lower(name)).
CREATE TABLE activity_categories (
  id         uuid PRIMARY KEY,
  farm_id    uuid NOT NULL REFERENCES farms(id),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_activity_categories_name ON activity_categories (farm_id, lower(name));

-- Supertype. The pay scheme is the discriminator and it is tied down by a
-- composite foreign key, so a contract activity cannot grow a unit price.
CREATE TABLE activities (
  id          uuid PRIMARY KEY,
  farm_id     uuid NOT NULL REFERENCES farms(id),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  category_id uuid NOT NULL,
  pay_scheme  pay_scheme NOT NULL,
  -- The work unit belongs to the activity, not to its price. Two reasons, and
  -- the second is the one that matters: a farm changing from kilos to arrobas
  -- is a different activity, not a new rate; and the weigher has to know he is
  -- weighing kilos while being unable to read a single price, which he could
  -- not do if the unit lived behind the rate tables' role check.
  unit_id     uuid REFERENCES work_units(id),
  -- Only a work_unit activity may take its price from the weekly price table.
  rate_source rate_source NOT NULL DEFAULT 'activity_dated'
    CHECK (rate_source IN ('activity_dated', 'weekly_price')),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (rate_source <> 'weekly_price' OR pay_scheme = 'unidad_trabajo'),
  CHECK ((pay_scheme = 'unidad_trabajo') = (unit_id IS NOT NULL)),
  FOREIGN KEY (farm_id, category_id) REFERENCES activity_categories(farm_id, id),
  UNIQUE (farm_id, id),
  UNIQUE (id, pay_scheme)
);
CREATE UNIQUE INDEX ux_activities_name ON activities (farm_id, lower(name)) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- Dated rates (decision 4 in docs/decisiones.md).
--
-- activity_pay_* no longer holds one loose price: it holds a history of rates,
-- each in force from `valid_from` until the next row's valid_from. Because a
-- period is terminated by its successor there is no way to express two
-- overlapping prices, and the primary key (activity_id, valid_from) is exactly
-- the index that forbids trying. A work record freezes the rate in force on its day.
-- ---------------------------------------------------------------------------

CREATE TABLE activity_pay_contract (
  activity_id uuid NOT NULL,
  valid_from  date NOT NULL,
  pay_scheme  pay_scheme NOT NULL DEFAULT 'contrato' CHECK (pay_scheme = 'contrato'),
  total_minor bigint NOT NULL CHECK (total_minor > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_pay_contract_pkey PRIMARY KEY (activity_id, valid_from),
  FOREIGN KEY (activity_id, pay_scheme) REFERENCES activities(id, pay_scheme) ON DELETE CASCADE
);

CREATE TABLE activity_pay_time (
  activity_id uuid NOT NULL,
  valid_from  date NOT NULL,
  pay_scheme  pay_scheme NOT NULL DEFAULT 'tiempo' CHECK (pay_scheme = 'tiempo'),
  unit        time_unit NOT NULL,
  custom_qty  numeric(8, 2),
  custom_unit text,
  rate_minor  bigint NOT NULL CHECK (rate_minor > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((unit = 'personalizado') = (custom_qty IS NOT NULL AND custom_unit IS NOT NULL)),
  CHECK (custom_qty IS NULL OR custom_qty > 0),
  CONSTRAINT activity_pay_time_pkey PRIMARY KEY (activity_id, valid_from),
  FOREIGN KEY (activity_id, pay_scheme) REFERENCES activities(id, pay_scheme) ON DELETE CASCADE
);

CREATE TABLE activity_pay_work_unit (
  activity_id uuid NOT NULL,
  valid_from  date NOT NULL,
  pay_scheme  pay_scheme NOT NULL DEFAULT 'unidad_trabajo' CHECK (pay_scheme = 'unidad_trabajo'),
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_pay_work_unit_pkey PRIMARY KEY (activity_id, valid_from),
  FOREIGN KEY (activity_id, pay_scheme) REFERENCES activities(id, pay_scheme) ON DELETE CASCADE
);

-- No activity without at least one rate period. Deferred, because the API
-- inserts the activity and its first rate in the same transaction.
CREATE FUNCTION activity_has_pay() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (
        SELECT 1 FROM activity_pay_contract  WHERE activity_id = NEW.id
    UNION ALL
        SELECT 1 FROM activity_pay_time      WHERE activity_id = NEW.id
    UNION ALL
        SELECT 1 FROM activity_pay_work_unit WHERE activity_id = NEW.id)
  THEN
    RAISE EXCEPTION 'activity % has no pay scheme row', NEW.id;
  END IF;
  RETURN NULL;
END $fn$;

CREATE CONSTRAINT TRIGGER t_activity_pay AFTER INSERT ON activities
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION activity_has_pay();

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS t_activity_pay ON activities;
DROP FUNCTION IF EXISTS activity_has_pay();
DROP TABLE IF EXISTS activity_pay_work_unit;
DROP TABLE IF EXISTS activity_pay_time;
DROP TABLE IF EXISTS activity_pay_contract;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS activity_categories;
DROP TABLE IF EXISTS work_units;
-- +goose StatementEnd
