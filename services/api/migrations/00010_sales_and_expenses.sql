-- +goose Up
-- +goose StatementBegin

-- VENTAS (RSP-026 … RSP-029) y GASTOS (RSP-030 … RSP-033).
--
-- One warning before the DDL, because it is the mistake this schema is shaped
-- to make impossible:
--
--   A GASTO IS NOT A DEUDA.
--
-- RSP-030 calls the cost of a spraying a gasto. RSP-007 calls what an employee
-- owes the farm a deuda. The document uses one word for the coffee and the
-- milk. They are not the same thing and they must not meet: an expense is the
-- farm's own accounting, a debt is a line in one person's ledger. Wire them
-- together and recording the cost of the spraying takes money out of somebody's
-- wages — silently, correctly according to the code, and wrongly according to
-- the person who does not get paid.
--
-- So `expenses` has no employee_id. Not "we don't set it": the column does not
-- exist, there is no foreign key from here to `employees`, and nothing in this
-- file can reach `ledger`. A debt goes through POST /v1/deductions and only
-- through there. A test in internal/apitest fixes it from the other side.

-- ---------------------------------------------------------------------------
-- Customers (RSP-027: "Cliente — select, ej. cooperativa")
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id            uuid PRIMARY KEY,
  farm_id       uuid NOT NULL REFERENCES farms(id),
  name          text NOT NULL CHECK (length(btrim(name)) > 0),
  document_type text,
  doc_id        text,
  phone         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_customers_name ON customers (farm_id, lower(name))
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
CREATE TABLE sales (
  id           uuid PRIMARY KEY,
  farm_id      uuid NOT NULL REFERENCES farms(id),
  product_id   uuid NOT NULL,
  customer_id  uuid,
  warehouse_id uuid NOT NULL,          -- which shelf it left; the movement needs one
  qty          numeric(14, 3) NOT NULL CHECK (qty > 0),
  -- Money is an integer in the minor unit, everywhere, always. RSP-027 says
  -- "Valor — double"; a double is how you lose a peso per sale and find out at
  -- the end of the year. Same call as every other amount in this schema.
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  receipt_id   uuid,                   -- foto del comprobante
  note         text,
  local_day    date NOT NULL,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  voided_at    timestamptz,
  FOREIGN KEY (farm_id, product_id)   REFERENCES products(farm_id, id),
  FOREIGN KEY (farm_id, customer_id)  REFERENCES customers(farm_id, id),
  FOREIGN KEY (farm_id, warehouse_id) REFERENCES warehouses(farm_id, id),
  FOREIGN KEY (farm_id, receipt_id)   REFERENCES attachments(farm_id, id),
  UNIQUE (farm_id, id)
);
CREATE INDEX ix_sales_day      ON sales (farm_id, local_day DESC, created_at DESC);
CREATE INDEX ix_sales_product  ON sales (farm_id, product_id);
CREATE INDEX ix_sales_customer ON sales (farm_id, customer_id) WHERE customer_id IS NOT NULL;

-- Now that `sales` exists, the movement's pointer at it becomes a real key.
-- The pair of constraints — this one and stock_venta_has_sale in 00009 — is
-- what makes "a sale and its movement, in the same transaction" a property of
-- the database rather than a habit of one handler.
ALTER TABLE stock_moves
  ADD CONSTRAINT stock_moves_sale_fkey
  FOREIGN KEY (farm_id, sale_id) REFERENCES sales(farm_id, id);

CREATE FUNCTION set_sale_local_day() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.local_day IS NULL THEN
    NEW.local_day := farm_today(NEW.farm_id);
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER t_sales_local_day BEFORE INSERT ON sales
  FOR EACH ROW EXECUTE FUNCTION set_sale_local_day();

-- A sale is never deleted and never un-voided. Voiding it writes the opposite
-- stock movement; there is no second act that could put the movement back,
-- because ux_moves_reverses lets a movement be reversed exactly once. A sale
-- recorded by mistake and voided is followed by a new sale, not by an undo of
-- the undo.
CREATE FUNCTION sales_no_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'a sale is voided, never deleted' USING ERRCODE = 'restrict_violation';
END $fn$;

CREATE TRIGGER t_sales_no_delete BEFORE DELETE ON sales
  FOR EACH STATEMENT EXECUTE FUNCTION sales_no_delete();

CREATE FUNCTION sales_void_is_final() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS NULL THEN
    RAISE EXCEPTION 'a voided sale is not restored: record a new one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL AND (NEW.qty <> OLD.qty OR NEW.amount_minor <> OLD.amount_minor) THEN
    RAISE EXCEPTION 'a voided sale is not edited' USING ERRCODE = 'restrict_violation';
  END IF;
  -- The quantity is the other half of a stock movement that is already
  -- written and cannot be edited. Changing it here would leave the warehouse
  -- claiming one number and the sales list another.
  IF NEW.qty <> OLD.qty THEN
    RAISE EXCEPTION 'the quantity of a sale is fixed by its stock movement: void it and record it again'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER t_sales_void_final BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION sales_void_is_final();

REVOKE DELETE ON sales FROM bascula_app;

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------
CREATE TABLE expenses (
  id           uuid PRIMARY KEY,
  farm_id      uuid NOT NULL REFERENCES farms(id),
  concept      text NOT NULL CHECK (length(btrim(concept)) > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  local_day    date NOT NULL,
  -- RSP-031: "Tipo de gasto — select: actividad o lote/cultivo."
  activity_id  uuid,
  plot_id      uuid,
  plot_crop_id uuid,
  receipt_id   uuid,
  note         text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  FOREIGN KEY (farm_id, activity_id)  REFERENCES activities(farm_id, id),
  FOREIGN KEY (farm_id, plot_id)      REFERENCES plots(farm_id, id),
  FOREIGN KEY (farm_id, plot_crop_id) REFERENCES plot_crops(farm_id, id),
  FOREIGN KEY (farm_id, receipt_id)   REFERENCES attachments(farm_id, id),

  -- Charged to an activity, or to a plot/crop. Not to both, not to neither.
  -- "Neither" is the case worth naming: an expense imputed to nothing is a
  -- number that shows up in the total and in no breakdown, and the year-end
  -- difference between the two is what nobody can explain in March.
  CONSTRAINT expense_target CHECK (
    (activity_id IS NOT NULL)::int
    + (COALESCE(plot_id, plot_crop_id) IS NOT NULL)::int = 1),

  CONSTRAINT expense_crop_needs_plot CHECK (plot_crop_id IS NULL OR plot_id IS NOT NULL),

  UNIQUE (farm_id, id)
);
CREATE INDEX ix_expenses_day      ON expenses (farm_id, local_day DESC, created_at DESC);
CREATE INDEX ix_expenses_activity ON expenses (farm_id, activity_id) WHERE activity_id IS NOT NULL;
CREATE INDEX ix_expenses_plot     ON expenses (farm_id, plot_id)     WHERE plot_id IS NOT NULL;

CREATE FUNCTION set_expense_local_day() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.local_day IS NULL THEN
    NEW.local_day := farm_today(NEW.farm_id);
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER t_expenses_local_day BEFORE INSERT OR UPDATE OF local_day ON expenses
  FOR EACH ROW EXECUTE FUNCTION set_expense_local_day();

-- Same rule as the stock movement: a crop belongs to the plot it was named
-- with, or the per-plot cost report is quietly wrong.
CREATE FUNCTION check_expense_crop() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.plot_crop_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM plot_crops pc
        WHERE pc.id = NEW.plot_crop_id AND pc.plot_id = NEW.plot_id) THEN
    RAISE EXCEPTION 'crop % is not planted in plot %', NEW.plot_crop_id, NEW.plot_id;
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER t_expenses_crop BEFORE INSERT OR UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION check_expense_crop();

-- Expenses are the farm's own accounting, so unlike a sale they carry no stock
-- movement and an "eliminar" really is only a flag (RSP-033). DELETE is still
-- revoked: inactive is a state, not an absence.
REVOKE DELETE ON expenses FROM bascula_app;

-- ---------------------------------------------------------------------------
-- Row level security — the weigher's deny list, again in the database
-- ---------------------------------------------------------------------------
DO $rls$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['customers', 'sales', 'expenses'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_tenant ON %I '
      'USING (farm_id = current_farm() AND current_role_name() IN (''owner'', ''admin'')) '
      'WITH CHECK (farm_id = current_farm() AND current_role_name() IN (''owner'', ''admin''))', t);
  END LOOP;
END $rls$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS t_expenses_crop ON expenses;
DROP FUNCTION IF EXISTS check_expense_crop();
DROP TRIGGER IF EXISTS t_expenses_local_day ON expenses;
DROP FUNCTION IF EXISTS set_expense_local_day();
DROP TABLE IF EXISTS expenses;
ALTER TABLE stock_moves DROP CONSTRAINT IF EXISTS stock_moves_sale_fkey;
DROP TRIGGER IF EXISTS t_sales_void_final ON sales;
DROP FUNCTION IF EXISTS sales_void_is_final();
DROP TRIGGER IF EXISTS t_sales_no_delete ON sales;
DROP FUNCTION IF EXISTS sales_no_delete();
DROP TRIGGER IF EXISTS t_sales_local_day ON sales;
DROP FUNCTION IF EXISTS set_sale_local_day();
DROP TABLE IF EXISTS sales;
DROP TABLE IF EXISTS customers;
-- +goose StatementEnd
