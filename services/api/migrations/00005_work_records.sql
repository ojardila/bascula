-- +goose Up
-- +goose StatementBegin

-- WORK RECORD — the one payable entity. A weighing is a work record of a `cosecha`
-- activity paid per work unit with date_from = date_to; there is no `pickups`
-- table. Two payable tables would mean two anti double-pay locks and no way
-- for one settlement to take both, and a picker who also did a day's clearing
-- needs one settlement, not two. See docs/arquitectura-api.md section 1.
CREATE TABLE work_records (
  id            uuid PRIMARY KEY,
  farm_id       uuid NOT NULL REFERENCES farms(id),
  employee_id   uuid NOT NULL,
  activity_id   uuid NOT NULL,
  pay_scheme    pay_scheme NOT NULL,   -- denormalised, pinned by composite FK
  rate_source   rate_source NOT NULL,
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  local_day     date NOT NULL,         -- written by trigger, in the farm's zone
  end_local_day date NOT NULL,         -- written by trigger
  week_start    date GENERATED ALWAYS AS (week_start(local_day)) STORED,
  quantity      numeric(12, 3) NOT NULL CHECK (quantity > 0),
  unit_id       uuid REFERENCES work_units(id),
  price_minor   bigint CHECK (price_minor IS NULL OR price_minor > 0),
  amount_minor  bigint CHECK (amount_minor IS NULL OR amount_minor > 0),
  note          text,
  device_id     uuid,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  FOREIGN KEY (farm_id, employee_id) REFERENCES employees(farm_id, id),
  FOREIGN KEY (farm_id, activity_id) REFERENCES activities(farm_id, id),
  FOREIGN KEY (activity_id, pay_scheme) REFERENCES activities(id, pay_scheme),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (end_local_day >= local_day),

  -- The shape of a work record follows its pay scheme. A contract record cannot grow
  -- a unit; a per-kilo record cannot lose one. quantity is always present:
  -- amount = round(quantity * rate) holds for all three modes, with
  -- quantity = 1 for a contract.
  CONSTRAINT work_record_shape CHECK (
    CASE pay_scheme
      WHEN 'contrato'       THEN unit_id IS NULL AND quantity = 1
      WHEN 'tiempo'         THEN unit_id IS NULL
      WHEN 'unidad_trabajo' THEN unit_id IS NOT NULL
    END),

  -- When the price freezes, and the single-day rule that follows from it
  -- (decision 4). A work record whose price is derived from a date must be one day:
  -- a wage from Tuesday to Tuesday has no single week and no single validity
  -- period, and deriving a price over a range is exactly the ambiguity that
  -- ends in a mispayment. Ranges are legal, but only with a frozen price.
  CONSTRAINT work_record_rate_shape CHECK (
    CASE rate_source
      WHEN 'weekly_price'   THEN price_minor IS NULL AND amount_minor IS NULL
                                 AND pay_scheme = 'unidad_trabajo'
                                 AND end_local_day = local_day
      WHEN 'activity_dated' THEN price_minor IS NOT NULL AND amount_minor IS NOT NULL
                                 AND end_local_day = local_day
      WHEN 'explicit'       THEN price_minor IS NOT NULL AND amount_minor IS NOT NULL
    END),

  -- The line adds up or it does not go in. Same rule the phone already runs:
  -- Math.round(weight * costPerUnitCents).
  CONSTRAINT work_record_amount_math CHECK (
    amount_minor IS NULL OR amount_minor = round(quantity * price_minor)::bigint),

  UNIQUE (farm_id, id)
);
CREATE INDEX ix_work_records_emp_day  ON work_records (farm_id, employee_id, local_day DESC);
CREATE INDEX ix_work_records_week     ON work_records (farm_id, week_start);
CREATE INDEX ix_work_records_activity ON work_records (farm_id, activity_id, local_day);
CREATE INDEX ix_work_records_created_by ON work_records (farm_id, created_by);

CREATE TABLE work_record_plots (
  work_record_id uuid NOT NULL,
  plot_id  uuid NOT NULL,
  farm_id  uuid NOT NULL,
  PRIMARY KEY (work_record_id, plot_id),
  FOREIGN KEY (farm_id, work_record_id) REFERENCES work_records(farm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (farm_id, plot_id)  REFERENCES plots(farm_id, id)
);

CREATE TABLE work_record_plot_crops (
  work_record_id uuid NOT NULL,
  plot_crop_id uuid NOT NULL,
  farm_id      uuid NOT NULL,
  PRIMARY KEY (work_record_id, plot_crop_id),
  FOREIGN KEY (farm_id, work_record_id) REFERENCES work_records(farm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (farm_id, plot_crop_id) REFERENCES plot_crops(farm_id, id)
);
CREATE INDEX ix_wrpc_crop ON work_record_plot_crops (farm_id, plot_crop_id);

-- The local day is the farm's day, and Go never writes it. That is exactly how
-- the bug got into the phone: a 19:30 weighing in Bogota is 00:30 UTC the next
-- day, and the picker calls it today.
CREATE FUNCTION set_work_record_local_day() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE tz text;
BEGIN
  SELECT timezone INTO tz FROM farms WHERE id = NEW.farm_id;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'farm % not visible while computing local_day', NEW.farm_id;
  END IF;
  NEW.local_day := (NEW.started_at AT TIME ZONE tz)::date;
  NEW.end_local_day := (COALESCE(NEW.ended_at, NEW.started_at) AT TIME ZONE tz)::date;
  RETURN NEW;
END $fn$;

CREATE TRIGGER t_work_records_local_day
  BEFORE INSERT OR UPDATE OF started_at, ended_at, farm_id ON work_records
  FOR EACH ROW EXECUTE FUNCTION set_work_record_local_day();

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS t_work_records_local_day ON work_records;
DROP FUNCTION IF EXISTS set_work_record_local_day();
DROP TABLE IF EXISTS work_record_plot_crops;
DROP TABLE IF EXISTS work_record_plots;
DROP TABLE IF EXISTS work_records;
-- +goose StatementEnd
