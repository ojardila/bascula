-- +goose Up
-- +goose StatementBegin

-- PRODUCTS AND INVENTORY — RSP-018 … RSP-025.
--
-- The one decision this migration exists to enforce: STOCK ON HAND IS DERIVED.
-- There is no `products.stock` column and there never will be. A stored total
-- is a total that some day disagrees with the facts underneath it, and when it
-- does, nobody can tell which of the two is lying. Exactly the argument that
-- put the ledger in 00006 and left `balance` off `employees`.
--
-- So the facts are `stock_moves`, they are append-only, and every question
-- about "how much is there" is a SUM over them (`stock_levels`). Correcting a
-- mistake is inserting its opposite, never editing the original — the same
-- discipline, with the same trigger and the same REVOKE behind it.

-- What a movement is FOR, and the sign that follows from it. This one is an
-- enum and not a catalogue because the server branches on it: `stock_sign`
-- below reads it, the sales module writes 'venta' and nothing else, and a farm
-- inventing 'donacion' would be a value no code knows what to do with. The
-- rule from docs/decisiones.md holds: what the code branches on is an enum,
-- what a form offers with an "add it" button is a table.
CREATE TYPE stock_reason AS ENUM
  ('cosecha', 'compra', 'venta', 'consumo', 'merma', 'traslado', 'ajuste');

-- The farm's own day. Go never computes it, for the reason written on
-- set_work_record_local_day in 00005: a 19:30 harvest in Bogotá is 00:30 UTC
-- the next day, and the storeman calls it today.
CREATE FUNCTION farm_today(farm uuid) RETURNS date LANGUAGE plpgsql STABLE AS $fn$
DECLARE tz text;
BEGIN
  SELECT timezone INTO tz FROM farms WHERE id = farm;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'farm % not visible while computing its local day', farm;
  END IF;
  RETURN (now() AT TIME ZONE tz)::date;
END $fn$;

-- ---------------------------------------------------------------------------
-- Catalogues (RSP-019: "select, with the option to create one")
-- ---------------------------------------------------------------------------
-- Product categories and storage units are per-farm tables and not Postgres
-- enums, the same call the team made for crop types and activity categories:
-- the use case puts an "add it if it is not there" button next to both, and a
-- closed type turns every farm's invented value into an ALTER TYPE in
-- production.

CREATE TABLE product_categories (
  id         uuid PRIMARY KEY,
  farm_id    uuid NOT NULL REFERENCES farms(id),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_product_categories_name ON product_categories (farm_id, lower(name));

-- Bulto, kilo, litro, caja.
--
-- docs/modelo-datos.md gives this table `code` + `label`, the shape of
-- `work_units`. It gets one `name` instead, and the difference is not
-- cosmetic: `work_units` carries `kg_factor` because a "canasta" weighs
-- something different on every farm and the factor is what makes two farms
-- comparable. A storage unit converts to nothing and is only ever shown in a
-- picker, so a second identifier would be a second thing to keep in step for
-- no reader. Recorded here rather than tidied away.
CREATE TABLE storage_units (
  id         uuid PRIMARY KEY,
  farm_id    uuid NOT NULL REFERENCES farms(id),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_storage_units_name ON storage_units (farm_id, lower(name));

-- WAREHOUSES. A place, nothing more: what is in it is derived from the movements
-- that name it.
CREATE TABLE warehouses (
  id         uuid PRIMARY KEY,
  farm_id    uuid NOT NULL REFERENCES farms(id),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_warehouses_name ON warehouses (farm_id, lower(name));

-- ---------------------------------------------------------------------------
-- Products (RSP-019 … RSP-021)
-- ---------------------------------------------------------------------------

CREATE TABLE products (
  id              uuid PRIMARY KEY,
  farm_id         uuid NOT NULL REFERENCES farms(id),
  name            text NOT NULL CHECK (length(btrim(name)) > 0),
  category_id     uuid,
  storage_unit_id uuid NOT NULL,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  FOREIGN KEY (farm_id, category_id)     REFERENCES product_categories(farm_id, id),
  FOREIGN KEY (farm_id, storage_unit_id) REFERENCES storage_units(farm_id, id),
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_products_name ON products (farm_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX ix_products_category ON products (farm_id, category_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Stock movements (RSP-025) — the facts stock on hand is derived from
-- ---------------------------------------------------------------------------

CREATE TABLE stock_moves (
  id             uuid PRIMARY KEY,
  farm_id        uuid NOT NULL REFERENCES farms(id),
  product_id     uuid NOT NULL,
  warehouse_id   uuid NOT NULL,
  -- Where it came out of. RSP-025 asks for the plot and the crop on the inventory
  -- form; both are optional because a bought sack of fertiliser came out of no
  -- plot at all.
  plot_id        uuid,
  plot_crop_id   uuid,
  qty            numeric(14, 3) NOT NULL CHECK (qty <> 0),
  reason         stock_reason NOT NULL,
  note           text,
  work_record_id uuid,          -- the labour that produced it, when there was one
  sale_id        uuid,          -- constrained in 00010, where `sales` exists
  reverses_id    uuid REFERENCES stock_moves(id),
  local_day      date NOT NULL,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, product_id)     REFERENCES products(farm_id, id),
  FOREIGN KEY (farm_id, warehouse_id)   REFERENCES warehouses(farm_id, id),
  FOREIGN KEY (farm_id, plot_id)        REFERENCES plots(farm_id, id),
  FOREIGN KEY (farm_id, plot_crop_id)   REFERENCES plot_crops(farm_id, id),
  FOREIGN KEY (farm_id, work_record_id) REFERENCES work_records(farm_id, id),

  -- The sign follows from the reason, and the database is what says so. A
  -- sale that increases stock is not a validation the API forgot to write; it
  -- is a row Postgres refuses.
  CONSTRAINT stock_sign CHECK (
       (reason IN ('cosecha', 'compra')        AND qty > 0)
    OR (reason IN ('venta', 'consumo', 'merma') AND qty < 0)
    OR (reason IN ('traslado', 'ajuste'))),

  -- A 'venta' movement is the shadow of a sale and cannot exist without one.
  -- That is what keeps sales and stock on hand from contradicting each other:
  -- there is no way to write the movement without the sale, and the sales
  -- handler writes both in one transaction.
  CONSTRAINT stock_venta_has_sale CHECK (reason <> 'venta' OR sale_id IS NOT NULL),

  -- A crop belongs to the plot it was named with. Without this a movement
  -- could say "lote 3, café del lote 7" and every per-plot report would be
  -- quietly wrong.
  CONSTRAINT stock_crop_needs_plot CHECK (plot_crop_id IS NULL OR plot_id IS NOT NULL),

  UNIQUE (farm_id, id)
);
CREATE INDEX ix_moves_stock ON stock_moves (farm_id, product_id, warehouse_id);
CREATE INDEX ix_moves_day   ON stock_moves (farm_id, local_day DESC, created_at DESC);
CREATE INDEX ix_moves_sale  ON stock_moves (farm_id, sale_id) WHERE sale_id IS NOT NULL;
-- A movement is undone once and only once, exactly like a ledger entry.
CREATE UNIQUE INDEX ux_moves_reverses ON stock_moves (reverses_id) WHERE reverses_id IS NOT NULL;

-- A crop must actually be planted in the plot the movement names.
CREATE FUNCTION check_stock_move_crop() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.plot_crop_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM plot_crops pc
        WHERE pc.id = NEW.plot_crop_id AND pc.plot_id = NEW.plot_id) THEN
    RAISE EXCEPTION 'crop % is not planted in plot %', NEW.plot_crop_id, NEW.plot_id;
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER t_stock_moves_crop BEFORE INSERT ON stock_moves
  FOR EACH ROW EXECUTE FUNCTION check_stock_move_crop();

-- A reversal cancels its origin exactly and cannot itself be reversed. Word
-- for word the rule check_reverso() applies to the ledger, because it is the
-- same rule: the only way back through an append-only table is its opposite.
CREATE FUNCTION check_stock_reverso() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE o stock_moves;
BEGIN
  IF NEW.reverses_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO o FROM stock_moves WHERE id = NEW.reverses_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reversal without origin';
  END IF;
  IF o.reverses_id IS NOT NULL THEN
    RAISE EXCEPTION 'a reversal cannot be reversed';
  END IF;
  IF o.farm_id <> NEW.farm_id OR o.product_id <> NEW.product_id
     OR o.warehouse_id <> NEW.warehouse_id THEN
    RAISE EXCEPTION 'reversal crosses farm, product or warehouse';
  END IF;
  IF NEW.qty <> -o.qty THEN
    RAISE EXCEPTION 'the reversal does not cancel its origin';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER t_stock_moves_reverso BEFORE INSERT ON stock_moves
  FOR EACH ROW EXECUTE FUNCTION check_stock_reverso();

-- The farm's day, written by the database or not at all.
CREATE FUNCTION set_stock_move_local_day() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.local_day IS NULL THEN
    NEW.local_day := farm_today(NEW.farm_id);
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER t_stock_moves_local_day BEFORE INSERT ON stock_moves
  FOR EACH ROW EXECUTE FUNCTION set_stock_move_local_day();

-- Append-only, said out loud. A DO INSTEAD NOTHING rule would report success
-- and change nothing, and the day that matters is the day somebody "corrects"
-- a movement and the warehouse count silently stops matching the shelf.
CREATE FUNCTION stock_moves_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'stock movements are append-only: correct one with its opposite'
    USING ERRCODE = 'restrict_violation';
END $fn$;

CREATE TRIGGER t_stock_moves_append_only BEFORE UPDATE OR DELETE ON stock_moves
  FOR EACH STATEMENT EXECUTE FUNCTION stock_moves_is_append_only();

REVOKE UPDATE, DELETE ON stock_moves FROM bascula_app;

-- STOCK ON HAND. A view, so there is exactly one definition of "how much is
-- there" and no job that could fall behind.
--
-- security_invoker is not optional: a view is otherwise executed with the
-- rights of the role that created it, which here is the migration superuser,
-- and every farm would read every other farm's warehouse through it. Postgres
-- 15 and up; the compose image is 17.
CREATE VIEW stock_levels WITH (security_invoker = true) AS
  SELECT farm_id, product_id, warehouse_id, SUM(qty) AS qty
    FROM stock_moves
   GROUP BY farm_id, product_id, warehouse_id
  HAVING SUM(qty) <> 0;

-- ---------------------------------------------------------------------------
-- Sticker batches (RSP-025)
-- ---------------------------------------------------------------------------
-- "Al guardar, el sistema imprime los stickers." The server prints nothing —
-- it has no printer, and a server that blocks on one is a server that fails
-- when the printer is out of paper. It produces the batch, the batch has an
-- id, and whatever holds the paper asks for it. Two ends of a wire instead of
-- one process pretending to be both.
CREATE TABLE label_batches (
  id            uuid PRIMARY KEY,
  farm_id       uuid NOT NULL REFERENCES farms(id),
  stock_move_id uuid NOT NULL,
  label_count   int NOT NULL CHECK (label_count > 0 AND label_count <= 500),
  printed_at    timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, stock_move_id) REFERENCES stock_moves(farm_id, id),
  UNIQUE (farm_id, id)
);
CREATE INDEX ix_label_batches_move ON label_batches (farm_id, stock_move_id);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- The generated loop in 00008 has already run, so these say it themselves. And
-- they say more than "same farm": docs/modelo-datos.md §9 puts stock_moves out
-- of the weigher's reach with the same shape as the ledger, and the permission
-- table says the same thing one layer up. Denying it in the middleware is the
-- message; denying it here is the guarantee.
DO $rls$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['product_categories', 'storage_units', 'warehouses',
                               'products', 'stock_moves', 'label_batches'])
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
DROP VIEW IF EXISTS stock_levels;
DROP TABLE IF EXISTS label_batches;
DROP TRIGGER IF EXISTS t_stock_moves_append_only ON stock_moves;
DROP FUNCTION IF EXISTS stock_moves_is_append_only();
DROP TRIGGER IF EXISTS t_stock_moves_local_day ON stock_moves;
DROP FUNCTION IF EXISTS set_stock_move_local_day();
DROP TRIGGER IF EXISTS t_stock_moves_reverso ON stock_moves;
DROP FUNCTION IF EXISTS check_stock_reverso();
DROP TRIGGER IF EXISTS t_stock_moves_crop ON stock_moves;
DROP FUNCTION IF EXISTS check_stock_move_crop();
DROP TABLE IF EXISTS stock_moves;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS warehouses;
DROP TABLE IF EXISTS storage_units;
DROP TABLE IF EXISTS product_categories;
DROP FUNCTION IF EXISTS farm_today(uuid);
DROP TYPE IF EXISTS stock_reason;
-- +goose StatementEnd
