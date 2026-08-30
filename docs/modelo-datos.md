# Báscula — multitenant PostgreSQL schema (delivery 1)

## 0. Headline decisions

| Point | Decision |
|---|---|
| IDs | **UUIDv7** generated on the client, `uuid` column |
| Isolation | **RLS** with `farm_id` + composite FKs |
| Money | `BIGINT` in the minor unit + `currency` on the farm |
| Date | `timestamptz` + `local_day date` (trigger) + `week_start` GENERATED |
| Migrations | **goose**, embedded, job that runs before the rollout |

## 1. DDL

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE farm_role         AS ENUM ('owner','admin','weigher');
CREATE TYPE ledger_kind       AS ENUM ('devengo','pago','anticipo','deduccion','ajuste','reverso');
CREATE TYPE pay_method        AS ENUM ('efectivo','transferencia','otro');
CREATE TYPE settlement_status AS ENUM ('open','void');

-- Monday of the ISO week of a local day. IMMUTABLE => usable in GENERATED.
CREATE FUNCTION week_start(d date) RETURNS date
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT d - (EXTRACT(ISODOW FROM d)::int - 1) $$;

CREATE TABLE farms (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'America/Bogota',
  currency    char(3) NOT NULL DEFAULT 'COP',
  minor_unit  smallint NOT NULL DEFAULT 2 CHECK (minor_unit BETWEEN 0 AND 4),
  suspended_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT farms_tz_valid CHECK (now() AT TIME ZONE timezone IS NOT NULL)
);

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL,
  password_hash text NOT NULL,
  is_superadmin boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_users_email ON users (lower(email));

CREATE TABLE memberships (
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    farm_role NOT NULL,
  PRIMARY KEY (farm_id, user_id)
);
CREATE INDEX ix_memberships_user ON memberships (user_id);
-- Every farm keeps at least one owner (enforced in the API; see the note in §6).

CREATE TABLE devices (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  label text, last_seen_at timestamptz,
  UNIQUE (farm_id, id)
);

CREATE TABLE people (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  last_name text, document_type text, doc_id text, tag text, image_url text,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (farm_id, id)                       -- target of the composite FKs
);
CREATE UNIQUE INDEX ux_people_doc  ON people (farm_id, document_type, doc_id)
  WHERE deleted_at IS NULL AND doc_id IS NOT NULL;
CREATE UNIQUE INDEX ux_people_tag  ON people (farm_id, tag) WHERE deleted_at IS NULL AND tag IS NOT NULL;

CREATE TABLE crops (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL, type text, variety text,
  dimension numeric(10,3) CHECK (dimension IS NULL OR dimension > 0),
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (farm_id, id)
);

CREATE TABLE farm_config (
  farm_id uuid PRIMARY KEY REFERENCES farms(id) ON DELETE CASCADE,
  crop_type text NOT NULL, label text NOT NULL, unit text NOT NULL,
  yield_unit text NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor > 0),   -- no longer REAL
  language text NOT NULL DEFAULT 'es' CHECK (language IN ('es','en','pt'))
);   -- replaces `config` with CHECK (id = 1): the singleton is now per farm

CREATE TABLE week_prices (                                -- formerly cost_overrides
  farm_id uuid NOT NULL REFERENCES farms(id),
  week_start date NOT NULL CHECK (week_start = week_start(week_start)),
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  PRIMARY KEY (farm_id, week_start)
);

CREATE TABLE pickups (
  id uuid PRIMARY KEY,
  farm_id  uuid NOT NULL REFERENCES farms(id),
  person_id uuid NOT NULL, crop_id uuid NOT NULL,
  weight   numeric(9,3) NOT NULL CHECK (weight > 0),
  occurred_at timestamptz NOT NULL,
  local_day   date NOT NULL,
  week_start  date GENERATED ALWAYS AS (week_start(local_day)) STORED,
  device_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, person_id) REFERENCES people(farm_id, id),
  FOREIGN KEY (farm_id, crop_id)   REFERENCES crops (farm_id, id),
  UNIQUE (farm_id, id)
);
CREATE INDEX ix_pickups_person_day ON pickups (farm_id, person_id, local_day);
CREATE INDEX ix_pickups_week       ON pickups (farm_id, week_start);
CREATE INDEX ix_pickups_crop_day   ON pickups (farm_id, crop_id, local_day);  -- IRL/outlier index

CREATE TABLE settlements (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  person_id uuid NOT NULL,
  period_start date NOT NULL, period_end date NOT NULL,
  gross_minor bigint NOT NULL CHECK (gross_minor > 0),
  status settlement_status NOT NULL DEFAULT 'open',
  note text, created_at timestamptz NOT NULL DEFAULT now(), voided_at timestamptz,
  CHECK (period_end >= period_start),
  CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  FOREIGN KEY (farm_id, person_id) REFERENCES people(farm_id, id),
  UNIQUE (farm_id, id)
);
CREATE INDEX ix_settlements_person ON settlements (farm_id, person_id, created_at DESC);

CREATE TABLE settlement_items (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  settlement_id uuid NOT NULL, pickup_id uuid NOT NULL,
  week_start date NOT NULL, weight numeric(9,3) NOT NULL CHECK (weight > 0),
  price_minor  bigint NOT NULL CHECK (price_minor > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  voided_at timestamptz,
  FOREIGN KEY (farm_id, settlement_id) REFERENCES settlements(farm_id, id),
  FOREIGN KEY (farm_id, pickup_id)     REFERENCES pickups(farm_id, id),
  CHECK (amount_minor = round(weight * price_minor)::bigint)   -- the line adds up or it does not go in
);
-- THE LOCK: a weighing belongs to exactly one live settlement.
CREATE UNIQUE INDEX ux_items_pickup_live ON settlement_items (pickup_id) WHERE voided_at IS NULL;
CREATE INDEX ix_items_settlement ON settlement_items (settlement_id);

CREATE TABLE ledger (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  person_id uuid NOT NULL,
  kind ledger_kind NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  local_day date NOT NULL,
  settlement_id uuid, method pay_method, note text,
  reverses_id uuid REFERENCES ledger(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, person_id)     REFERENCES people(farm_id, id),
  FOREIGN KEY (farm_id, settlement_id) REFERENCES settlements(farm_id, id),
  CONSTRAINT ledger_sign CHECK (
       (kind = 'devengo' AND amount_minor > 0)
    OR (kind IN ('pago','anticipo','deduccion') AND amount_minor < 0)
    OR (kind IN ('ajuste','reverso'))),
  CONSTRAINT ledger_reverso_shape CHECK ((kind = 'reverso') = (reverses_id IS NOT NULL)),
  CONSTRAINT ledger_method_shape  CHECK (method IS NULL OR kind IN ('pago','anticipo')),
  CONSTRAINT ledger_devengo_has_settlement CHECK (kind <> 'devengo' OR settlement_id IS NOT NULL)
);
CREATE INDEX ix_ledger_person ON ledger (farm_id, person_id, local_day DESC, created_at DESC);
CREATE INDEX ix_ledger_sett   ON ledger (settlement_id) WHERE settlement_id IS NOT NULL;
-- An entry is reversed exactly once.
CREATE UNIQUE INDEX ux_ledger_reverses ON ledger (reverses_id) WHERE reverses_id IS NOT NULL;
```

## 2. Isolation: RLS, not `WHERE farm_id`

**I recommend RLS.** The `WHERE` is a convention: one new query written at 11 p.m. is enough
for farm A's payroll to show up in farm B, and that does not fail loudly, it fails silently.
RLS turns the oversight into `0 rows` instead of a leak. The real cost is low: the policy is
an equality on `farm_id`, indexed, and the planner pushes it down to the index.

Honest trade-off: debugging gets confusing (a row "does not exist" when the GUC is not set),
`EXPLAIN` output carries an extra filter, and you have to remember that the table owner and
any `BYPASSRLS` role ignore it — which is why the API runs under its own role without those
privileges. The composite FKs above are the second belt: even if someone got around the
policy, they cannot stitch a weighing from one farm to a person from another.

```sql
CREATE ROLE bascula_app NOLOGIN;   -- no BYPASSRLS, not the table owner
GRANT USAGE ON SCHEMA public TO bascula_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bascula_app;

CREATE FUNCTION current_farm() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('bascula.farm_id', true),'')::uuid $$;
CREATE FUNCTION current_role_name() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('bascula.role', true),'') $$;

-- For every table with farm_id:
ALTER TABLE pickups ENABLE ROW LEVEL SECURITY;
ALTER TABLE pickups FORCE ROW LEVEL SECURITY;
CREATE POLICY p_tenant ON pickups USING (farm_id = current_farm())
                                  WITH CHECK (farm_id = current_farm());

-- Money is also gated by role: the weigher sees nobody's payroll.
ALTER TABLE ledger ENABLE ROW LEVEL SECURITY; ALTER TABLE ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY p_ledger ON ledger
  USING (farm_id = current_farm() AND current_role_name() IN ('owner','admin'))
  WITH CHECK (farm_id = current_farm() AND current_role_name() IN ('owner','admin'));

-- Prices: only the owner writes.
ALTER TABLE week_prices ENABLE ROW LEVEL SECURITY; ALTER TABLE week_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY p_wp_read  ON week_prices FOR SELECT USING (farm_id = current_farm());
CREATE POLICY p_wp_write ON week_prices FOR ALL
  USING (farm_id = current_farm() AND current_role_name() = 'owner')
  WITH CHECK (farm_id = current_farm() AND current_role_name() = 'owner');

-- The super-admin administers farms, he does not read inside them.
ALTER TABLE farms ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_farms ON farms USING (
  id = current_farm() OR current_setting('bascula.superadmin', true) = 'on');
```

Every request opens a transaction and runs `SET LOCAL bascula.farm_id = ...; SET LOCAL
bascula.role = ...` from the token, **never** from a client parameter. `SET LOCAL` dies with
the transaction, so a pool cannot leak context between connections.

## 3. Identifiers

**UUIDv7, `uuid` column (16 bytes), generated on the phone.** v4 is random: every insert
lands on a different B-tree leaf, scatters the WAL and fragments the index — with years of
weighings that shows. v7 carries the timestamp in the high bits, so it inserts at the end
like a `bigserial` and also makes `ORDER BY id` almost chronological. ULID adds nothing over
v7 except the text encoding; if you want to show it in base32, encode at the edge and keep
storing `uuid`. No `text`: 36 bytes and comparison by collation.

The existing local integers **do not travel**. The mobile app adds a `uuid` column to each
table and backfills it (`uuidv7` seeded with the row's `createdAt`, so the ordering is
preserved), keeps its integer PK for its local joins, and syncs by UUID. On the server there
is no mapping table: the UUID is the identity from the first push. `device_id` + UUID make
the push idempotent — resending is `ON CONFLICT (id) DO NOTHING`.

Cost: ~8 more bytes per row and per index entry compared to `bigint`. On a farm with 50
pickers and 3 weighings a day that is ~55,000 rows/year; irrelevant.

## 4. Dates and time zones

Three columns, each with one job:

- `occurred_at timestamptz` — the instant. Absolute truth, orders and audits.
- `local_day date` — the day **in the farm's time zone**. It is what the picker calls
  "today".
- `week_start date GENERATED` — the Monday, derived from `local_day`. Never written by hand.

The zone lives in `farms.timezone` (IANA), because a farm in Colombia and one in Brazil do
not share a day. It cannot be used in a GENERATED column (it depends on another table), so a
trigger computes it — the point is that **the Go code never writes `local_day`**, which is
exactly how the bug crept into the mobile app:

```sql
CREATE FUNCTION set_local_day() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tz text;
BEGIN
  SELECT timezone INTO tz FROM farms WHERE id = NEW.farm_id;
  NEW.local_day := (NEW.occurred_at AT TIME ZONE tz)::date;
  RETURN NEW;
END $$;
CREATE TRIGGER t_pickups_local_day BEFORE INSERT OR UPDATE OF occurred_at, farm_id
  ON pickups FOR EACH ROW EXECUTE FUNCTION set_local_day();
```

With this, the 19:30 weighing in Bogotá (00:30 UTC the next day) ends up with the right
`local_day`, and **every** report groups by indexed columns instead of recomputing
`date(x,'localtime')` on each query. `WEEK_BY_DAY_SQL` becomes
`WHERE week_start = $1 GROUP BY local_day`, sargable.

Changing `farms.timezone` does not rewrite history: it is a business decision, and doing so
would move payments that have already been made. It is forbidden if the farm has
settlements.

## 5. Money

**Confirmed: `BIGINT` in whole minor units.** No `numeric` and no `float`. `bigint` is
exact, atomic under addition, and the `ledger` balance is a plain sum. The ceiling
(9.2×10¹⁸) is more than enough: 92 trillion pesos.

For another currency: `farms.currency` + `farms.minor_unit`, and the columns are named
`*_minor`, not `*_cents` — because COP has no real cents and neither does CLP. **One farm,
one currency**; nothing multi-currency inside a farm, which would require dated exchange
rates and has no use case. Formatting belongs to the edge; the DB only stores the integer
and the ISO code.

## 6. What goes in the database, not in Go

Everything above that carries a constraint name is deliberate. The critical parts:

```sql
-- 1. Sign by kind: ledger_sign (above). A positive 'pago' never gets in.
-- 2. Double payment: ux_items_pickup_live (above). It is the lock, and now it belongs to the server.
-- 3. A reverso is not reversed twice: ux_ledger_reverses (above)
--    plus a reverso not being reversible at all, and its amount being the exact opposite:
CREATE FUNCTION check_reverso() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o ledger;
BEGIN
  IF NEW.reverses_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO o FROM ledger WHERE id = NEW.reverses_id FOR UPDATE;
  -- The messages below stay in Spanish: they are server-facing error strings.
  IF NOT FOUND                     THEN RAISE EXCEPTION 'reverso sin origen'; END IF;
  IF o.kind = 'reverso'            THEN RAISE EXCEPTION 'un reverso no se reversa'; END IF;
  IF o.farm_id <> NEW.farm_id
     OR o.person_id <> NEW.person_id THEN RAISE EXCEPTION 'reverso cruzado'; END IF;
  IF NEW.amount_minor <> -o.amount_minor THEN RAISE EXCEPTION 'el reverso no cancela el origen'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER t_ledger_reverso BEFORE INSERT ON ledger
  FOR EACH ROW EXECUTE FUNCTION check_reverso();

-- 4. The ledger is append-only, and that is not a team habit:
CREATE RULE ledger_no_update AS ON UPDATE TO ledger DO INSTEAD NOTHING;
CREATE RULE ledger_no_delete AS ON DELETE TO ledger DO INSTEAD NOTHING;
REVOKE UPDATE, DELETE ON ledger FROM bascula_app;
-- Same for settlement_items, except for voided_at:
REVOKE DELETE ON settlement_items, settlements, pickups FROM bascula_app;
```

What I do **not** put in the database: the weekly price calculation, the review rules
(`RULE_*`), the IRL index. They are business policy, they change, and I want to test them in
Go, not in plpgsql. Nor "a farm keeps one owner": that lives in the API because its error
message is part of the UX.

## 7. Migrations

**goose.** Over golang-migrate: it supports migrations written in Go (needed for the UUID
backfill and for recomputing `local_day` on an imported history), it embeds into the API
binary with `embed.FS`, and it lets you mark a migration `-- +goose NO TRANSACTION` for what
Postgres refuses to run in a transaction (`CREATE INDEX CONCURRENTLY`). Atlas is more
powerful — declarative, with diffing — but its "desired state" model fights RLS, triggers and
hand-written rules, which is exactly where this schema's security lives. I want migrations
that read like SQL.

Convention: `db/migrations/00007_add_week_prices.sql`, sequential numbering (not timestamps:
the team is small and a number clash is a visible git conflict, which beats two migrations
applying in a different order in each environment). Every file with `-- +goose Up` and
`-- +goose Down`; Down exists, but in production you go forward, not back.

Deployment: **its own step, before the rollout**, not at process startup — five replicas
starting at once and all running migrations is a race. `goose up` in a job with a short
`LOCK TIMEOUT` and a short `statement_timeout` so an ALTER cannot block payroll.
Expand/contract schema: add a nullable column → deploy code that writes it → backfill → set
NOT NULL with `NOT VALID` + `VALIDATE CONSTRAINT`. Indexes in production always
`CONCURRENTLY`.

## 8. What I would not build now

- **Partitioning** of `pickups` or `ledger` by farm or by date. A large farm does ~60,000
  weighings a year. Postgres does not break a sweat until the millions. Partitioning today is
  maintenance complexity in exchange for nothing, and it also breaks the composite FKs.
- **Read replicas.** There is no read load, and a replica introduces replication lag exactly
  where you cannot have it: reading a balance that does not yet include the payment just made
  is a money error.
- **Speculative indexes.** Only the ones that serve queries that already exist in
  `schema.ts`. Every index is paid for on every INSERT — and this system writes often, from
  phones with a limited battery.
- **A materialized view of balances.** The balance is derived with a `SUM` over dozens of
  rows per person. Materializing it reintroduces exactly the problem the ledger solved: a
  total that can drift away from its events.
- **Schema per farm.** It isolates better, but N schemas × M migrations is an operation this
  team cannot sustain, and the super-admin would need cross-schema queries.
- **Generic auditing** (history triggers on every table). The `ledger` is already the
  auditable record of what matters. `created_by` on the ledger covers the rest for now.
- **`citext`, full-text search, PostGIS.** Nobody has asked for them.

---

# Báscula — multitenant PostgreSQL schema (revision 2)

## 0. What changes from revision 1

Kept: UUIDv7, RLS, `bigint` in the minor unit, `timestamptz` + `local_day` + `week_start`
GENERATED, goose. One thing breaks: **`crops` disappears** and **`pickups` becomes a special
case of `labors`**.

## 1. New and modified DDL

```sql
CREATE TYPE activity_category AS ENUM ('siembra','mantenimiento','cosecha','otra');
CREATE TYPE pay_scheme        AS ENUM ('contrato','tiempo','unidad_trabajo');
CREATE TYPE time_unit         AS ENUM ('jornal','semanal','quincenal','mensual','personalizado');
CREATE TYPE stock_reason      AS ENUM ('cosecha','compra','venta','consumo','merma','traslado','ajuste');
```

### Farm, plots and crops

```sql
ALTER TABLE farms ADD COLUMN phone text, ADD COLUMN country text,
  ADD COLUMN city text, ADD COLUMN address text,
  ADD COLUMN area_ha numeric(10,3) CHECK (area_ha IS NULL OR area_ha > 0);

CREATE TABLE plots (                                   -- PARCELA / field
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  area_ha numeric(10,3) CHECK (area_ha IS NULL OR area_ha > 0),
  department text, municipality text,
  boundary geography(MultiPolygon,4326),               -- see §D
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_plots_name ON plots (farm_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX ix_plots_boundary ON plots USING gist (boundary);

CREATE TABLE plot_crops (                              -- CROP planted in the plot
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  plot_id uuid NOT NULL,
  crop_type text NOT NULL,                             -- coffee, cocoa...
  variety text,
  area_ha numeric(10,3) CHECK (area_ha IS NULL OR area_ha > 0),
  planted_on date, removed_on date,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  CHECK (removed_on IS NULL OR planted_on IS NULL OR removed_on >= planted_on),
  FOREIGN KEY (farm_id, plot_id) REFERENCES plots(farm_id, id),
  UNIQUE (farm_id, id)
);
CREATE INDEX ix_plot_crops_plot ON plot_crops (farm_id, plot_id) WHERE deleted_at IS NULL;
```

The sum of `plot_crops.area_ha` is not constrained against `plots.area_ha` in the database:
an intercropped planting (coffee with plantain for shade) occupies the same hectare twice.
It is a UI warning, not a CHECK.

### Employees

```sql
ALTER TABLE people RENAME TO employees;                -- keeps ids, FKs and indexes
ALTER TABLE employees
  ADD COLUMN phone text, ADD COLUMN address text, ADD COLUMN city text,
  ADD COLUMN municipality text, ADD COLUMN country text DEFAULT 'CO',
  ADD COLUMN photo_id uuid REFERENCES attachments(id);

CREATE TABLE employee_notes (                          -- dated notes
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  employee_id uuid NOT NULL, noted_on date NOT NULL, body text NOT NULL,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, employee_id) REFERENCES employees(farm_id, id)
);
CREATE INDEX ix_notes_employee ON employee_notes (farm_id, employee_id, noted_on DESC);

CREATE TABLE attachments (                             -- photos and receipts
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  object_key text NOT NULL UNIQUE,                     -- S3/R2; never bytes in the DB
  mime text NOT NULL, bytes bigint NOT NULL CHECK (bytes > 0),
  sha256 bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, id)
);
```

### Activities: three ways of paying without twenty null columns

Supertype + three subtypes, with the discriminator tied down by a composite FK. Each variant
has **only** its own columns, all `NOT NULL`.

```sql
CREATE TABLE activities (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL, category activity_category NOT NULL,
  pay_scheme pay_scheme NOT NULL,
  archived_at timestamptz,
  UNIQUE (farm_id, id),
  UNIQUE (id, pay_scheme)                              -- target of the discriminator
);

CREATE TABLE activity_pay_contract (
  activity_id uuid PRIMARY KEY,
  pay_scheme pay_scheme NOT NULL DEFAULT 'contrato' CHECK (pay_scheme = 'contrato'),
  total_minor bigint NOT NULL CHECK (total_minor > 0),
  FOREIGN KEY (activity_id, pay_scheme) REFERENCES activities(id, pay_scheme) ON DELETE CASCADE
);

CREATE TABLE activity_pay_time (
  activity_id uuid PRIMARY KEY,
  pay_scheme pay_scheme NOT NULL DEFAULT 'tiempo' CHECK (pay_scheme = 'tiempo'),
  unit time_unit NOT NULL,
  custom_qty numeric(8,2), custom_unit text,           -- only for 'personalizado'
  rate_minor bigint NOT NULL CHECK (rate_minor > 0),
  CHECK ((unit = 'personalizado') = (custom_qty IS NOT NULL AND custom_unit IS NOT NULL)),
  CHECK (custom_qty IS NULL OR custom_qty > 0),
  FOREIGN KEY (activity_id, pay_scheme) REFERENCES activities(id, pay_scheme) ON DELETE CASCADE
);

CREATE TABLE work_units (                              -- kilo, arroba, canasta, and whatever they invent
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  code text NOT NULL, label text NOT NULL,
  kg_factor numeric(10,4) CHECK (kg_factor IS NULL OR kg_factor > 0),  -- arroba = 12.5
  UNIQUE (farm_id, id), UNIQUE (farm_id, lower(code))
);

CREATE TABLE activity_pay_work_unit (
  activity_id uuid PRIMARY KEY,
  pay_scheme pay_scheme NOT NULL DEFAULT 'unidad_trabajo' CHECK (pay_scheme = 'unidad_trabajo'),
  unit_id uuid NOT NULL REFERENCES work_units(id),
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  FOREIGN KEY (activity_id, pay_scheme) REFERENCES activities(id, pay_scheme) ON DELETE CASCADE
);

-- No activity without its pay row (deferred: the API inserts both together).
CREATE FUNCTION activity_has_pay() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM activity_pay_contract   WHERE activity_id = NEW.id
       UNION ALL SELECT 1 FROM activity_pay_time       WHERE activity_id = NEW.id
       UNION ALL SELECT 1 FROM activity_pay_work_unit  WHERE activity_id = NEW.id)
  THEN RAISE EXCEPTION 'actividad % sin forma de pago', NEW.id; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER t_activity_pay AFTER INSERT ON activities
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION activity_has_pay();
```

`work_units` is a table and not an enum on purpose: a "canasta" weighs something different
on every farm, and `kg_factor` is what makes it possible to compare yield between farms that
pay by arroba and farms that pay by kilo.

### Work records — the table that absorbs `pickups`

```sql
CREATE TABLE labors (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  employee_id uuid NOT NULL, activity_id uuid NOT NULL,
  pay_scheme pay_scheme NOT NULL,                      -- denormalized, tied down by FK
  started_at timestamptz NOT NULL, ended_at timestamptz,
  local_day date NOT NULL,                             -- trigger, farm time zone
  end_local_day date,
  week_start date GENERATED ALWAYS AS (week_start(local_day)) STORED,
  quantity numeric(12,3), unit_id uuid REFERENCES work_units(id),
  price_minor bigint, amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  device_id uuid, note text,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, employee_id) REFERENCES employees(farm_id, id),
  FOREIGN KEY (farm_id, activity_id) REFERENCES activities(farm_id, id),
  FOREIGN KEY (activity_id, pay_scheme) REFERENCES activities(id, pay_scheme),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT labor_shape CHECK (
    CASE pay_scheme
      WHEN 'contrato' THEN quantity IS NULL AND price_minor IS NULL AND unit_id IS NULL
      WHEN 'tiempo'   THEN unit_id IS NULL AND quantity > 0 AND price_minor > 0
                           AND amount_minor = round(quantity * price_minor)::bigint
      WHEN 'unidad_trabajo' THEN unit_id IS NOT NULL AND quantity > 0 AND price_minor > 0
                           AND amount_minor = round(quantity * price_minor)::bigint
    END),
  UNIQUE (farm_id, id)
);
CREATE INDEX ix_labors_emp_day  ON labors (farm_id, employee_id, local_day DESC);
CREATE INDEX ix_labors_week     ON labors (farm_id, week_start);
CREATE INDEX ix_labors_activity ON labors (farm_id, activity_id, local_day);

CREATE TABLE labor_plots (
  labor_id uuid NOT NULL, plot_id uuid NOT NULL, farm_id uuid NOT NULL,
  PRIMARY KEY (labor_id, plot_id),
  FOREIGN KEY (farm_id, labor_id) REFERENCES labors(farm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (farm_id, plot_id)  REFERENCES plots(farm_id, id)
);
CREATE TABLE labor_plot_crops (
  labor_id uuid NOT NULL, plot_crop_id uuid NOT NULL, farm_id uuid NOT NULL,
  PRIMARY KEY (labor_id, plot_crop_id),
  FOREIGN KEY (farm_id, labor_id)      REFERENCES labors(farm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (farm_id, plot_crop_id)  REFERENCES plot_crops(farm_id, id)
);
CREATE INDEX ix_lpc_crop ON labor_plot_crops (farm_id, plot_crop_id);  -- IRL / outlier index
```

### Products, warehouses and inventory

Stock **derived from movements**, the same way the balance is derived from the ledger. A
materialized stock is a total that drifts away from its facts, and we already know what we
think of that.

```sql
CREATE TABLE product_categories (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL, UNIQUE (farm_id, id), UNIQUE (farm_id, lower(name)));

CREATE TABLE storage_units (                           -- bulto, kg, litre, box
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  code text NOT NULL, label text NOT NULL,
  UNIQUE (farm_id, id), UNIQUE (farm_id, lower(code)));

CREATE TABLE warehouses (                              -- warehouses
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL, UNIQUE (farm_id, id), UNIQUE (farm_id, lower(name)));

CREATE TABLE products (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL, category_id uuid, storage_unit_id uuid NOT NULL,
  deleted_at timestamptz,
  FOREIGN KEY (farm_id, category_id)     REFERENCES product_categories(farm_id, id),
  FOREIGN KEY (farm_id, storage_unit_id) REFERENCES storage_units(farm_id, id),
  UNIQUE (farm_id, id));

CREATE TABLE stock_moves (                             -- append-only
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  product_id uuid NOT NULL, warehouse_id uuid NOT NULL,
  plot_id uuid, plot_crop_id uuid,                     -- which plot/crop it came from
  qty numeric(14,3) NOT NULL CHECK (qty <> 0),         -- sign: + in, − out
  reason stock_reason NOT NULL,
  labor_id uuid, sale_id uuid, reverses_id uuid REFERENCES stock_moves(id),
  local_day date NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, product_id)   REFERENCES products(farm_id, id),
  FOREIGN KEY (farm_id, warehouse_id) REFERENCES warehouses(farm_id, id),
  FOREIGN KEY (farm_id, plot_crop_id) REFERENCES plot_crops(farm_id, id),
  CONSTRAINT stock_sign CHECK (
       (reason IN ('cosecha','compra')            AND qty > 0)
    OR (reason IN ('venta','consumo','merma')     AND qty < 0)
    OR (reason IN ('traslado','ajuste'))));
CREATE INDEX ix_moves_stock ON stock_moves (farm_id, product_id, warehouse_id);
CREATE UNIQUE INDEX ux_moves_reverses ON stock_moves (reverses_id) WHERE reverses_id IS NOT NULL;

CREATE VIEW stock_levels AS
  SELECT farm_id, product_id, warehouse_id, plot_crop_id, SUM(qty) AS qty
    FROM stock_moves GROUP BY 1,2,3,4;
```

### Sales and expenses

```sql
CREATE TABLE customers (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL, document_type text, doc_id text, phone text,
  UNIQUE (farm_id, id));

CREATE TABLE sales (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  product_id uuid NOT NULL, customer_id uuid,
  qty numeric(14,3) NOT NULL CHECK (qty > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  receipt_id uuid,                                     -- photo of the receipt
  local_day date NOT NULL, note text,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  FOREIGN KEY (farm_id, product_id)  REFERENCES products(farm_id, id),
  FOREIGN KEY (farm_id, customer_id) REFERENCES customers(farm_id, id),
  FOREIGN KEY (farm_id, receipt_id)  REFERENCES attachments(farm_id, id),
  UNIQUE (farm_id, id));

CREATE TABLE expenses (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  concept text NOT NULL, amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  local_day date NOT NULL,
  activity_id uuid, plot_id uuid, plot_crop_id uuid,
  receipt_id uuid, created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, activity_id)  REFERENCES activities(farm_id, id),
  FOREIGN KEY (farm_id, plot_id)      REFERENCES plots(farm_id, id),
  FOREIGN KEY (farm_id, plot_crop_id) REFERENCES plot_crops(farm_id, id),
  -- charged to an activity, or to a plot/crop, not to both and not to neither
  CONSTRAINT expense_target CHECK (
    (activity_id IS NOT NULL)::int + (COALESCE(plot_id, plot_crop_id) IS NOT NULL)::int = 1));
```

---

## A) `pickups` vs `labors`: **they merge, keeping the id**

A weighing **is** a work record of a `cosecha` activity paid by work unit. Keeping both
tables means two paths to the same money: two places to apply the weekly price, two
double-payment locks, and the day someone settles a maintenance work record paid by contract
we will discover that `settlement_items` only knows how to lock weighings. Merging makes the
lock general: **no work record of any activity is ever paid twice**.

The cost of migrating is lower than it looks, because **the id is preserved**:

```sql
-- 1. One synthetic "Recolección" activity per farm, with the current general price.
INSERT INTO work_units (id, farm_id, code, label, kg_factor)
  SELECT uuidv7(), f.id, 'kg', 'Kilo', 1 FROM farms f;
INSERT INTO activities (id, farm_id, name, category, pay_scheme)
  SELECT uuidv7(), f.id, 'Recolección', 'cosecha', 'unidad_trabajo' FROM farms f;
INSERT INTO activity_pay_work_unit (activity_id, unit_id, price_minor)
  SELECT a.id, w.id, c.price_minor
    FROM activities a JOIN work_units w USING (farm_id) JOIN farm_config c USING (farm_id)
   WHERE a.name = 'Recolección' AND w.code = 'kg';

-- 2. Every weighing becomes a labor WITH THE SAME UUID.
INSERT INTO labors (id, farm_id, employee_id, activity_id, pay_scheme, started_at,
                    local_day, quantity, unit_id, price_minor, amount_minor, device_id, created_at)
  SELECT p.id, p.farm_id, p.person_id, a.id, 'unidad_trabajo', p.occurred_at,
         p.local_day, p.weight, w.id, apw.price_minor,
         round(p.weight * apw.price_minor)::bigint, p.device_id, p.created_at
    FROM pickups p
    JOIN activities a ON a.farm_id = p.farm_id AND a.name = 'Recolección'
    JOIN activity_pay_work_unit apw ON apw.activity_id = a.id
    JOIN work_units w ON w.id = apw.unit_id;

-- 3. settlement_items still points at the same uuid; only the name and the FK change.
ALTER TABLE settlement_items RENAME COLUMN pickup_id TO labor_id;
ALTER TABLE settlement_items DROP CONSTRAINT settlement_items_farm_id_pickup_id_fkey,
  ADD FOREIGN KEY (farm_id, labor_id) REFERENCES labors(farm_id, id);
ALTER INDEX ux_items_pickup_live RENAME TO ux_items_labor_live;
DROP TABLE pickups;

-- 4. The mobile app keeps reading `pickups` while it is being rewritten.
CREATE VIEW pickups AS
  SELECT l.id, l.farm_id, l.employee_id AS person_id, l.quantity AS weight,
         l.started_at AS occurred_at, l.local_day, l.week_start,
         (SELECT plot_crop_id FROM labor_plot_crops x WHERE x.labor_id = l.id LIMIT 1) AS crop_id
    FROM labors l WHERE l.pay_scheme = 'unidad_trabajo';
```

**Zero id remapping, zero settlement rewriting, zero risk on money already paid.** The
migration is one `INSERT…SELECT` and two `ALTER`s. What does have to be rewritten are the
report queries in `schema.ts` (IRL index, review rules, week), because `cropId` now lives
behind a join. That work is about reading, not about money, and it can be done with the view
in place.

One nuance: `settlement_items` gains `CHECK (pay_scheme = 'unidad_trabajo' OR …)`. No —
better not to restrict it: a work record paid by contract entering a settlement is exactly
what we want to enable.

## B) What the payment history points at

**Nothing in the payment history points at a crop today.** `settlements`,
`settlement_items` and `ledger` reference person, settlement and weighing; `cropId` only
lives in `pickups`, which is reporting. That is the short answer and it is the good news:
**the plot/crop migration does not touch money.**

Work records point at the **crop** (`plot_crops`), not at the plot, and the plot is derived
through a join. That is the finest grain: if a plot has coffee and plantain, "how much did
the coffee yield" can only be answered from the crop. `labor_plots` also exists because a
maintenance work record (brush-cutting) is over the whole field, with no assignable crop.

The migration preserves the uuid on the **crop**, which is what the weighings pointed at:

```sql
-- Each of today's `crops` rows opens into a new plot + a crop that INHERITS THE UUID.
INSERT INTO plots (id, farm_id, name, area_ha, created_at, deleted_at)
  SELECT uuidv7(), c.farm_id, c.name, c.dimension, c.created_at, c.deleted_at FROM crops c;
INSERT INTO plot_crops (id, farm_id, plot_id, crop_type, variety, area_ha, created_at, deleted_at)
  SELECT c.id, c.farm_id, p.id, COALESCE(c.type,'?'), c.variety, c.dimension, c.created_at, c.deleted_at
    FROM crops c JOIN plots p ON p.farm_id = c.farm_id AND p.name = c.name;
INSERT INTO labor_plot_crops (labor_id, plot_crop_id, farm_id)
  SELECT p.id, p.crop_id, p.farm_id FROM pickups_backup p WHERE p.crop_id IS NOT NULL;
INSERT INTO labor_plots (labor_id, plot_id, farm_id)
  SELECT lpc.labor_id, pc.plot_id, lpc.farm_id
    FROM labor_plot_crops lpc JOIN plot_crops pc ON pc.id = lpc.plot_crop_id;
```

What is left is one plot per old `crop`, which is literally what the user had in his head
when he created them ("Café lote 1"). Merging plots that were really the same one is manual
work for the owner, with a screen, not a guess made by the script.

## C) GIS: **PostGIS from the start**

I recommend `geography(MultiPolygon,4326)`, not GeoJSON in `jsonb`.

The decisive argument is not spatial querying, it is **validity**. Without PostGIS the
database accepts any `jsonb`: unclosed polygons, rings that cross themselves, swapped
coordinates (lat/lon the wrong way round is the classic silent error). When you migrate to
real geometry a year from now, you will have to hand-fix polygons a user drew months ago and
no longer remembers. Postponing does not save the work, it makes it more expensive and turns
it into archaeology.

And the spatial query is closer than it looks: the phone already has GPS, and "which field
am I weighing in" is one `ST_Contains` away — which also removes a dropdown from the scale
screen, which is precisely where the weigher makes mistakes.

`MultiPolygon` and not `Polygon` because a plot split by a road or a creek is two rings and
the user thinks of it as one.

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
ALTER TABLE plots ADD CONSTRAINT plots_boundary_valid
  CHECK (boundary IS NULL OR ST_IsValid(boundary::geometry));
-- Computed area, to compare against the one the user declared.
ALTER TABLE plots ADD COLUMN area_ha_gis numeric(10,3)
  GENERATED ALWAYS AS (round((ST_Area(boundary)/10000)::numeric, 3)) STORED;
-- Which field am I in?
-- SELECT id FROM plots WHERE ST_Contains(boundary::geometry, ST_Point($lon,$lat,4326)::geometry);
```

Honest operational cost: PostGIS is the extension that hurts most in a `pg_upgrade` (it has
to be upgraded in a specific order), it adds ~50 MB to the development image, and it forces
the provider to offer it — RDS, Cloud SQL, Supabase and Neon have it; a bare Postgres on a
VPS needs one more package. It is a real and bounded cost. `boundary` is nullable: a farm can
operate without drawing a single polygon, and the extension blocks nothing.

## D) The cross-tenant requirement (RSP-009)

This is not an exception to the isolation; it is **a different system** sharing a server. It
goes in its own schema, with its own rules, and the API role does not touch it directly.

### Physical separation

```sql
CREATE SCHEMA registry;
REVOKE ALL ON SCHEMA registry FROM bascula_app;      -- no direct access to the tables
GRANT USAGE ON SCHEMA registry TO bascula_app;       -- only to call the functions

-- The identity is a HASH with a server-side pepper. A dump of this table
-- does not hand over a list of cédulas.
CREATE TABLE registry.identities (
  id_hash bytea PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Presence, not judgement. Note what is NOT here: no free text, no score,
-- no boolean, no amount, no "reason for leaving". There is nowhere to have an opinion.
CREATE TABLE registry.employment_spans (
  id uuid PRIMARY KEY,
  id_hash bytea NOT NULL REFERENCES registry.identities(id_hash),
  farm_id uuid NOT NULL,
  started_on date NOT NULL, ended_on date,
  disclosable boolean NOT NULL DEFAULT false,        -- the originating farm decides
  CHECK (ended_on IS NULL OR ended_on >= started_on),
  UNIQUE (id_hash, farm_id, started_on)
);
CREATE INDEX ix_spans_hash ON registry.employment_spans (id_hash);

-- Every lookup leaves a trace. Append-only, no exceptions.
CREATE TABLE registry.lookups (
  id uuid PRIMARY KEY,
  id_hash bytea NOT NULL,
  by_user_id uuid NOT NULL, by_farm_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 10),
  result_count int NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_lookups_hash ON registry.lookups (id_hash, at DESC);
CREATE INDEX ix_lookups_farm ON registry.lookups (by_farm_id, at DESC);
CREATE RULE reg_lookups_no_update AS ON UPDATE TO registry.lookups DO INSTEAD NOTHING;
CREATE RULE reg_lookups_no_delete AS ON DELETE TO registry.lookups DO INSTEAD NOTHING;

-- The only door: SECURITY DEFINER. You cannot query without recording the query.
CREATE FUNCTION registry.lookup(p_doc_type text, p_doc_id text, p_reason text)
RETURNS TABLE (farm_name text, started_on date, ended_on date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = registry, public AS $$
DECLARE h bytea; n int;
BEGIN
  h := digest(current_setting('bascula.pepper') || p_doc_type || '|' || p_doc_id, 'sha256');
  SELECT count(*) INTO n FROM registry.lookups
    WHERE by_farm_id = current_farm() AND at > now() - interval '1 day';
  -- Server-facing error message, kept in Spanish: daily lookup limit reached.
  IF n > 50 THEN RAISE EXCEPTION 'límite diario de consultas alcanzado'; END IF;

  RETURN QUERY
    SELECT f.name, s.started_on, s.ended_on
      FROM registry.employment_spans s JOIN public.farms f ON f.id = s.farm_id
     WHERE s.id_hash = h AND s.disclosable AND s.farm_id <> current_farm();

  INSERT INTO registry.lookups (id, id_hash, by_user_id, by_farm_id, reason, result_count)
  VALUES (uuidv7(), h, current_setting('bascula.user_id')::uuid, current_farm(), p_reason,
          (SELECT count(*) FROM registry.employment_spans s
            WHERE s.id_hash = h AND s.disclosable AND s.farm_id <> current_farm()));
END $$;
REVOKE ALL ON FUNCTION registry.lookup FROM public;
GRANT EXECUTE ON FUNCTION registry.lookup TO bascula_app;
```

Nothing from `employees`, `employee_notes`, `ledger` or `labors` crosses into the registry.
What comes out is: **this ID worked on that farm between those dates, if that farm agreed to
publish it.** No balances, no yield, no notes.

### The risk, said without hedging

**This requirement, built badly, is a blacklist.** A picker one farm marks wrongly can be
shut out of the harvest economy across the whole region, without knowing the registry
exists, without being able to see it and without being able to appeal. In Colombia that also
lands squarely under Law 1581 of 2012: personal data, processed without authorization, with
an automated decision that affects him.

That is why the defences are in the schema and not in a written policy:

1. **There is nowhere to write an opinion.** `employment_spans` has no free-text column, no
   flag, no score. If tomorrow someone asks for "a little field for remarks", the answer is
   no, and the reason is this paragraph.
2. **`disclosable` defaults to `false`.** The registry publishes nothing; the originating
   farm opts in to publishing. Without opt-in, the function returns zero rows.
3. **The person doing the lookup is recorded, always.** `reason` is mandatory, at least 10
   characters, and `registry.lookups` is append-only by rule, not by habit.
4. **Rate limit inside the function itself**, so the registry cannot be walked end to end.
5. **The worker has the right to see who looked him up.** `ix_lookups_hash` exists for that:
   a screen where the employee, identifying himself, sees the list. If that screen does not
   get built, I would not enable the registry.

And a product recommendation that is also a data recommendation: the "safety alerts" in
RSP-009 must fire **towards the worker and towards the auditor**, not be a traffic light over
the person. An alert telling the boss "watch out for this one" is the blacklist under another
name.

If the owner will not accept the opt-in and the visibility for the worker, my recommendation
is **not to build the cross-tenant part** and to solve the real case (checking that someone
did work there) by asking the other farm for a reference outside the system.

---

## Adjustments to the earlier sections

**§2 RLS.** The policies are generated in a loop over every table with `farm_id`, and a CI
test fails if any table is left without a policy — with twenty new tables, this can no longer
be done by hand:

```sql
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
            WHERE c.relkind='r' AND a.attname='farm_id' AND c.relnamespace='public'::regnamespace
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant ON %I USING (farm_id = current_farm())
                    WITH CHECK (farm_id = current_farm())', t);
  END LOOP;
END $$;
```

The **weigher** gains a restriction on `labors`: he sees only what he recorded himself.

```sql
CREATE POLICY p_labors_weigher ON labors FOR SELECT
  USING (farm_id = current_farm() AND (current_role_name() IN ('owner','admin')
      OR created_by = current_setting('bascula.user_id')::uuid));
```

`ventas`, `gastos` and `stock_moves` are kept away from the weigher in the same shape as
`ledger`.

**§6 Constraints in the database.** Added: `labor_shape` (the shape of a work record depends
on its pay scheme, and there is no way to store a contract work record with a unit price),
`expense_target` (an expense is charged to one thing and only one), `stock_sign` (a sale
cannot increase stock), the composite-FK discriminator on activities, and
`plots_boundary_valid`.

**§8 What I am still not doing.** Everything from revision 1, plus: no double-entry
accounting for expenses and sales (the owner asked for a record, not a ledger of accounts);
no materialized cost per hectare; no synchronization of the cross-tenant registry outside an
idempotent nightly job.
