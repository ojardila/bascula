-- +goose Up
-- +goose StatementBegin

CREATE TABLE settlements (
  id           uuid PRIMARY KEY,
  farm_id      uuid NOT NULL REFERENCES farms(id),
  employee_id  uuid NOT NULL,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  gross_minor  bigint NOT NULL CHECK (gross_minor > 0),
  status       settlement_status NOT NULL DEFAULT 'open',
  note         text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  voided_at    timestamptz,
  CHECK (period_end >= period_start),
  CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  FOREIGN KEY (farm_id, employee_id) REFERENCES employees(farm_id, id),
  UNIQUE (farm_id, id)
);
CREATE INDEX ix_settlements_employee ON settlements (farm_id, employee_id, created_at DESC);

-- One line per payable taken into a settlement.
--
-- `payable_kind` has exactly one possible value today and is still there: the
-- day a bonus or a piece of equipment becomes payable, this column is what
-- lets it into a settlement without touching the anti double-pay index. The
-- CHECK keeps it honest until then, and the composite foreign key still ties
-- every line to a real work record of the same farm.
CREATE TABLE settlement_items (
  id            uuid PRIMARY KEY,
  farm_id       uuid NOT NULL REFERENCES farms(id),
  settlement_id uuid NOT NULL,
  payable_id    uuid NOT NULL,
  payable_kind  text NOT NULL DEFAULT 'work_record' CHECK (payable_kind = 'work_record'),
  week_start    date NOT NULL,
  quantity      numeric(12, 3) NOT NULL CHECK (quantity > 0),
  price_minor   bigint NOT NULL CHECK (price_minor > 0),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  voided_at     timestamptz,
  FOREIGN KEY (farm_id, settlement_id) REFERENCES settlements(farm_id, id),
  FOREIGN KEY (farm_id, payable_id)     REFERENCES work_records(farm_id, id),
  -- The line adds up or it does not go in.
  CHECK (amount_minor = round(quantity * price_minor)::bigint),
  UNIQUE (farm_id, id)
);

-- THE LOCK. A payable belongs to exactly one live settlement. Voided lines stay
-- on the record but release their payable, so a voided settlement can be
-- redone. This is the one invariant that could not be duplicated, and it is why
-- there is a single payable table.
CREATE UNIQUE INDEX ux_items_payable_live ON settlement_items (payable_id) WHERE voided_at IS NULL;
CREATE INDEX ix_items_settlement ON settlement_items (settlement_id);

CREATE TABLE ledger (
  id            uuid PRIMARY KEY,
  farm_id       uuid NOT NULL REFERENCES farms(id),
  employee_id   uuid NOT NULL,
  kind          ledger_kind NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor <> 0),
  local_day     date NOT NULL,
  settlement_id uuid,
  method        pay_method,
  note          text,
  reverses_id   uuid REFERENCES ledger(id),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, employee_id)   REFERENCES employees(farm_id, id),
  FOREIGN KEY (farm_id, settlement_id) REFERENCES settlements(farm_id, id),
  -- Sign by kind. A positive 'pago' never gets in.
  CONSTRAINT ledger_sign CHECK (
       (kind = 'devengo' AND amount_minor > 0)
    OR (kind IN ('pago', 'anticipo', 'deduccion') AND amount_minor < 0)
    OR (kind IN ('ajuste', 'reverso'))),
  CONSTRAINT ledger_reverso_shape CHECK ((kind = 'reverso') = (reverses_id IS NOT NULL)),
  CONSTRAINT ledger_method_shape  CHECK (method IS NULL OR kind IN ('pago', 'anticipo')),
  CONSTRAINT ledger_devengo_has_settlement CHECK (kind <> 'devengo' OR settlement_id IS NOT NULL),
  UNIQUE (farm_id, id)
);
CREATE INDEX ix_ledger_employee ON ledger (farm_id, employee_id, local_day DESC, created_at DESC);
CREATE INDEX ix_ledger_settlement ON ledger (settlement_id) WHERE settlement_id IS NOT NULL;
-- A movement is reversed once and only once.
CREATE UNIQUE INDEX ux_ledger_reverses ON ledger (reverses_id) WHERE reverses_id IS NOT NULL;

-- A reversal cancels its origin exactly, cannot itself be reversed, and cannot
-- cross farms or people.
CREATE FUNCTION check_reverso() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE o ledger;
BEGIN
  IF NEW.reverses_id IS NULL THEN RETURN NEW; END IF;
  -- No FOR UPDATE here: a row lock needs the UPDATE privilege, which the app
  -- role does not have and must not have. It is not needed either — the ledger
  -- is append-only, so the origin row cannot change under us, and two
  -- concurrent reversals of the same movement collide on ux_ledger_reverses.
  SELECT * INTO o FROM ledger WHERE id = NEW.reverses_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reversal without origin';
  END IF;
  IF o.kind = 'reverso' THEN
    RAISE EXCEPTION 'a reversal cannot be reversed';
  END IF;
  IF o.farm_id <> NEW.farm_id OR o.employee_id <> NEW.employee_id THEN
    RAISE EXCEPTION 'reversal crosses farm or employee';
  END IF;
  IF NEW.amount_minor <> -o.amount_minor THEN
    RAISE EXCEPTION 'the reversal does not cancel its origin';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER t_ledger_reverso BEFORE INSERT ON ledger
  FOR EACH ROW EXECUTE FUNCTION check_reverso();

-- The ledger is append-only, and that is not a team habit.
--
-- docs/modelo-datos.md proposes DO INSTEAD NOTHING rules here. A rule would
-- work, but it makes an UPDATE a silent no-op: the statement reports success,
-- zero rows change, and nobody finds out until the money does not add up. A
-- trigger says the same thing out loud, and it applies to every role including
-- the owner of the table, which is the property the rule was chosen for.
CREATE FUNCTION ledger_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'the ledger is append-only: cancel a movement with a reversal'
    USING ERRCODE = 'restrict_violation';
END $fn$;

CREATE TRIGGER t_ledger_append_only BEFORE UPDATE OR DELETE ON ledger
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_is_append_only();

-- And the app role does not carry the privileges in the first place.
REVOKE UPDATE, DELETE ON ledger FROM bascula_app;
-- Same for the rest of the money trail, except settlement_items.voided_at,
-- which is how the lock is released.
REVOKE DELETE ON settlement_items, settlements, work_records FROM bascula_app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS t_ledger_append_only ON ledger;
DROP FUNCTION IF EXISTS ledger_is_append_only();
DROP TRIGGER IF EXISTS t_ledger_reverso ON ledger;
DROP FUNCTION IF EXISTS check_reverso();
DROP TABLE IF EXISTS ledger;
DROP TABLE IF EXISTS settlement_items;
DROP TABLE IF EXISTS settlements;
-- +goose StatementEnd
