# Báscula — esquema PostgreSQL multitenant (entrega 1)

## 0. Decisiones de cabecera

| Punto | Decisión |
|---|---|
| IDs | **UUIDv7** generado en el cliente, columna `uuid` |
| Aislamiento | **RLS** con `farm_id` + FKs compuestas |
| Dinero | `BIGINT` en unidad menor + `currency` en la finca |
| Fecha | `timestamptz` + `local_day date` (trigger) + `week_start` GENERATED |
| Migraciones | **goose**, embebido, job previo al rollout |

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
-- Toda finca conserva al menos un owner (se valida en el API; ver §6 nota).

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
  UNIQUE (farm_id, id)                       -- destino de las FK compuestas
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
  price_minor bigint NOT NULL CHECK (price_minor > 0),   -- ya no REAL
  language text NOT NULL DEFAULT 'es' CHECK (language IN ('es','en','pt'))
);   -- reemplaza `config` con CHECK (id = 1): el singleton ahora es por finca

CREATE TABLE week_prices (                                -- ex cost_overrides
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
CREATE INDEX ix_pickups_crop_day   ON pickups (farm_id, crop_id, local_day);  -- índice IRL/outlier

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
  CHECK (amount_minor = round(weight * price_minor)::bigint)   -- el renglón cuadra o no entra
);
-- EL CANDADO: una pesada pertenece a una sola liquidación viva.
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
-- Un movimiento se reversa una sola vez.
CREATE UNIQUE INDEX ux_ledger_reverses ON ledger (reverses_id) WHERE reverses_id IS NOT NULL;
```

## 2. Aislamiento: RLS, no `WHERE farm_id`

**Recomiendo RLS.** El `WHERE` es una convención: basta una consulta nueva a las 11 p.m. para que la nómina de la finca A aparezca en la B, y eso no falla ruidosamente sino en silencio. RLS convierte el olvido en un `0 rows` en vez de una fuga. El costo real es bajo: la policy es una igualdad sobre `farm_id`, indexada, y el planner la empuja al índice.

Trade-off honesto: depurar se vuelve confuso (una fila "no existe" cuando la GUC no está puesta), los `EXPLAIN` traen un filtro extra, y hay que recordar que el dueño de las tablas y cualquier rol `BYPASSRLS` la ignoran — por eso el API corre con un rol propio sin esos privilegios. Las FKs compuestas de arriba son el segundo cinturón: aunque alguien burlara la policy, no puede coser una pesada de una finca a una persona de otra.

```sql
CREATE ROLE bascula_app NOLOGIN;   -- sin BYPASSRLS, no dueño de las tablas
GRANT USAGE ON SCHEMA public TO bascula_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bascula_app;

CREATE FUNCTION current_farm() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('bascula.farm_id', true),'')::uuid $$;
CREATE FUNCTION current_role_name() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('bascula.role', true),'') $$;

-- Para cada tabla con farm_id:
ALTER TABLE pickups ENABLE ROW LEVEL SECURITY;
ALTER TABLE pickups FORCE ROW LEVEL SECURITY;
CREATE POLICY p_tenant ON pickups USING (farm_id = current_farm())
                                  WITH CHECK (farm_id = current_farm());

-- El dinero además por rol: el pesador no ve la nómina de nadie.
ALTER TABLE ledger ENABLE ROW LEVEL SECURITY; ALTER TABLE ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY p_ledger ON ledger
  USING (farm_id = current_farm() AND current_role_name() IN ('owner','admin'))
  WITH CHECK (farm_id = current_farm() AND current_role_name() IN ('owner','admin'));

-- Precios: sólo el owner escribe.
ALTER TABLE week_prices ENABLE ROW LEVEL SECURITY; ALTER TABLE week_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY p_wp_read  ON week_prices FOR SELECT USING (farm_id = current_farm());
CREATE POLICY p_wp_write ON week_prices FOR ALL
  USING (farm_id = current_farm() AND current_role_name() = 'owner')
  WITH CHECK (farm_id = current_farm() AND current_role_name() = 'owner');

-- El super-admin administra fincas, no las lee por dentro.
ALTER TABLE farms ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_farms ON farms USING (
  id = current_farm() OR current_setting('bascula.superadmin', true) = 'on');
```

Cada request abre transacción y hace `SET LOCAL bascula.farm_id = ...; SET LOCAL bascula.role = ...` desde el token, **nunca** desde un parámetro del cliente. `SET LOCAL` muere con la transacción, así que un pool no filtra contexto entre conexiones.

## 3. Identificadores

**UUIDv7, columna `uuid` (16 bytes), generada en el teléfono.** v4 es aleatorio: cada insert cae en una hoja distinta del B-tree, dispersa el WAL y fragmenta el índice — con años de pesadas eso se nota. v7 lleva el timestamp en los bits altos, así que inserta al final como un `bigserial` y además hace que `ORDER BY id` sea casi cronológico. ULID no aporta nada sobre v7 salvo la codificación en texto; si se quiere mostrar en base32, se codifica en el borde y se sigue guardando `uuid`. Nada de `text`: 36 bytes y comparación por colación.

Los enteros locales existentes **no viajan**. El móvil añade una columna `uuid` a cada tabla y hace backfill (`uuidv7` sembrado con el `createdAt` de la fila, así el orden se conserva), mantiene su PK entera para sus joins locales, y sincroniza por UUID. En el servidor no hay tabla de mapeo: el UUID es la identidad desde el primer push. `device_id` + UUID hacen el push idempotente — reenviar es `ON CONFLICT (id) DO NOTHING`.

Costo: ~8 bytes más por fila y por entrada de índice frente a `bigint`. En una finca de 50 recolectores y 3 pesadas diarias son ~55 000 filas/año; irrelevante.

## 4. Fechas y zonas

Tres columnas, cada una con un trabajo:

- `occurred_at timestamptz` — el instante. Verdad absoluta, ordena y audita.
- `local_day date` — el día **en la zona de la finca**. Es lo que el recolector llama "hoy".
- `week_start date GENERATED` — el lunes, derivado de `local_day`. Nunca se escribe a mano.

La zona vive en `farms.timezone` (IANA), porque una finca en Colombia y otra en Brasil no comparten día. No se puede usar en una GENERATED (depende de otra tabla), así que la calcula un trigger — el punto es que **el código Go nunca escribe `local_day`**, que es exactamente como se coló el bug del móvil:

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

Con esto, la pesada de las 19:30 en Bogotá (00:30 UTC del día siguiente) queda con `local_day` del día correcto, y **todos** los reportes agrupan por columnas indexadas en vez de recalcular `date(x,'localtime')` en cada consulta. `WEEK_BY_DAY_SQL` pasa a ser `WHERE week_start = $1 GROUP BY local_day`, sargable.

Cambiar `farms.timezone` no reescribe el histórico: es una decisión de negocio, y hacerlo movería pagos ya hechos. Se prohíbe si la finca tiene liquidaciones.

## 5. Dinero

**Confirmado: `BIGINT` en unidad menor entera.** Ningún `numeric` ni `float`. `bigint` es exacto, atómico en sumas, y el saldo del `ledger` es una suma pura. El techo (9.2×10¹⁸) sobra: son 92 billones de pesos.

Para otra moneda: `farms.currency` + `farms.minor_unit`, y las columnas se llaman `*_minor`, no `*_cents` — porque el COP no tiene centavos de verdad y el CLP tampoco. **Una finca, una moneda**; nada multi-moneda dentro de una finca, que exigiría tasas de cambio con fecha y no hay caso de uso. Formatear es del borde; la BD sólo guarda el entero y el código ISO.

## 6. Lo que va en la base, no en Go

Todo lo de arriba con nombre de constraint es deliberado. Lo crítico:

```sql
-- 1. Signo por tipo: ledger_sign (arriba). Un 'pago' positivo no entra jamás.
-- 2. Doble pago: ux_items_pickup_live (arriba). Es el candado, y ahora es del servidor.
-- 3. Un reverso no se reversa dos veces: ux_ledger_reverses (arriba)
--    + que un reverso no sea reversable en absoluto, y que su monto sea el opuesto exacto:
CREATE FUNCTION check_reverso() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o ledger;
BEGIN
  IF NEW.reverses_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO o FROM ledger WHERE id = NEW.reverses_id FOR UPDATE;
  IF NOT FOUND                     THEN RAISE EXCEPTION 'reverso sin origen'; END IF;
  IF o.kind = 'reverso'            THEN RAISE EXCEPTION 'un reverso no se reversa'; END IF;
  IF o.farm_id <> NEW.farm_id
     OR o.person_id <> NEW.person_id THEN RAISE EXCEPTION 'reverso cruzado'; END IF;
  IF NEW.amount_minor <> -o.amount_minor THEN RAISE EXCEPTION 'el reverso no cancela el origen'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER t_ledger_reverso BEFORE INSERT ON ledger
  FOR EACH ROW EXECUTE FUNCTION check_reverso();

-- 4. El ledger es append-only, y eso no es una costumbre del equipo:
CREATE RULE ledger_no_update AS ON UPDATE TO ledger DO INSTEAD NOTHING;
CREATE RULE ledger_no_delete AS ON DELETE TO ledger DO INSTEAD NOTHING;
REVOKE UPDATE, DELETE ON ledger FROM bascula_app;
-- Igual para settlement_items, salvo el voided_at:
REVOKE DELETE ON settlement_items, settlements, pickups FROM bascula_app;
```

Lo que **no** meto en la base: el cálculo del precio de la semana, las reglas de revisión (`RULE_*`), el índice IRL. Son política de negocio, cambian, y quiero probarlas en Go, no en plpgsql. Tampoco "una finca conserva un owner": eso vive en el API porque su mensaje de error es parte de la UX.

## 7. Migraciones

**goose.** Sobre golang-migrate: soporta migraciones en Go (necesarias para el backfill de UUIDs y para recalcular `local_day` de un histórico importado), embebe con `embed.FS` en el binario del API, y permite marcar una migración `-- +goose NO TRANSACTION` para lo que Postgres no deja transaccionar (`CREATE INDEX CONCURRENTLY`). Atlas es más potente — declarativo, con diff — pero su modelo de "estado deseado" pelea con RLS, triggers y reglas escritas a mano, que es justo donde vive la seguridad de este esquema. Quiero migraciones que se lean como SQL.

Convención: `db/migrations/00007_add_week_prices.sql`, numeración secuencial (no timestamps: el equipo es pequeño y un choque de número es un conflicto de git visible, que es mejor que dos migraciones que se aplican en orden distinto en cada ambiente). Cada archivo con `-- +goose Up` y `-- +goose Down`; el Down existe pero en producción se avanza, no se retrocede.

Despliegue: **paso propio, antes del rollout**, no en el arranque del proceso — cinco réplicas arrancando a la vez corriendo migraciones es una carrera. `goose up` en un job con `LOCK TIMEOUT` corto y `statement_timeout` corto para que un ALTER no bloquee la nómina. Esquema expand/contract: agregar columna nullable → desplegar código que la escribe → backfill → poner NOT NULL con `NOT VALID` + `VALIDATE CONSTRAINT`. Índices en producción siempre `CONCURRENTLY`.

## 8. Lo que NO haría ahora

- **Particionado** de `pickups` o `ledger` por finca o por fecha. Una finca grande hace ~60 000 pesadas al año. Postgres no se despeina hasta los millones. Particionar hoy es complejidad de mantenimiento a cambio de nada, y además rompe las FKs compuestas.
- **Réplicas de lectura.** No hay carga de lectura, y una réplica introduce lag replicativo justo donde no se puede tener: leer un saldo que aún no incluye el pago recién hecho es un error de dinero.
- **Índices especulativos.** Sólo los que sirven a consultas que ya existen en `schema.ts`. Cada índice se paga en cada INSERT — y este sistema es de escritura frecuente desde teléfonos con batería contada.
- **Vista materializada de saldos.** El saldo se deriva con un `SUM` sobre decenas de filas por persona. Materializarlo reintroduce exactamente el problema que el ledger resolvió: un total que puede desincronizarse de sus eventos.
- **Esquema por finca.** Aísla mejor, pero N esquemas × M migraciones es una operación que este equipo no puede sostener, y el super-admin necesitaría consultas cruzadas.
- **Auditoría genérica** (triggers de historial en toda tabla). El `ledger` ya es el registro auditable de lo que importa. `created_by` en el ledger cubre el resto por ahora.
- **`citext`, búsqueda full-text, PostGIS.** Nadie los ha pedido.

---

# Báscula — esquema PostgreSQL multitenant (revisión 2)

## 0. Qué cambia respecto de la revisión 1

Se mantienen: UUIDv7, RLS, `bigint` en unidad menor, `timestamptz` + `local_day` + `week_start` GENERATED, goose. Se rompe una cosa: **`crops` desaparece** y **`pickups` se convierte en un caso particular de `labors`**.

## 1. DDL nuevo y modificado

```sql
CREATE TYPE activity_category AS ENUM ('siembra','mantenimiento','cosecha','otra');
CREATE TYPE pay_scheme        AS ENUM ('contrato','tiempo','unidad_trabajo');
CREATE TYPE time_unit         AS ENUM ('jornal','semanal','quincenal','mensual','personalizado');
CREATE TYPE stock_reason      AS ENUM ('cosecha','compra','venta','consumo','merma','traslado','ajuste');
```

### Finca, parcelas y cultivos

```sql
ALTER TABLE farms ADD COLUMN phone text, ADD COLUMN country text,
  ADD COLUMN city text, ADD COLUMN address text,
  ADD COLUMN area_ha numeric(10,3) CHECK (area_ha IS NULL OR area_ha > 0);

CREATE TABLE plots (                                   -- PARCELA / lote
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  area_ha numeric(10,3) CHECK (area_ha IS NULL OR area_ha > 0),
  department text, municipality text,
  boundary geography(MultiPolygon,4326),               -- ver §D
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_plots_name ON plots (farm_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX ix_plots_boundary ON plots USING gist (boundary);

CREATE TABLE plot_crops (                              -- CULTIVO sembrado en la parcela
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  plot_id uuid NOT NULL,
  crop_type text NOT NULL,                             -- café, cacao…
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

La suma de `plot_crops.area_ha` no se restringe contra `plots.area_ha` en la base: un cultivo asociado (café con plátano de sombrío) ocupa la misma hectárea dos veces. Es una advertencia de UI, no un CHECK.

### Empleados

```sql
ALTER TABLE people RENAME TO employees;                -- conserva ids, FKs e índices
ALTER TABLE employees
  ADD COLUMN phone text, ADD COLUMN address text, ADD COLUMN city text,
  ADD COLUMN municipality text, ADD COLUMN country text DEFAULT 'CO',
  ADD COLUMN photo_id uuid REFERENCES attachments(id);

CREATE TABLE employee_notes (                          -- anotaciones con fecha
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  employee_id uuid NOT NULL, noted_on date NOT NULL, body text NOT NULL,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, employee_id) REFERENCES employees(farm_id, id)
);
CREATE INDEX ix_notes_employee ON employee_notes (farm_id, employee_id, noted_on DESC);

CREATE TABLE attachments (                             -- fotos y comprobantes
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  object_key text NOT NULL UNIQUE,                     -- S3/R2; nunca bytes en la BD
  mime text NOT NULL, bytes bigint NOT NULL CHECK (bytes > 0),
  sha256 bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, id)
);
```

### Actividades: tres formas de pago sin veinte columnas nulas

Supertipo + tres subtipos, con el discriminador amarrado por FK compuesta. Cada variante tiene **sólo** sus columnas, todas `NOT NULL`.

```sql
CREATE TABLE activities (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL, category activity_category NOT NULL,
  pay_scheme pay_scheme NOT NULL,
  archived_at timestamptz,
  UNIQUE (farm_id, id),
  UNIQUE (id, pay_scheme)                              -- destino del discriminador
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
  custom_qty numeric(8,2), custom_unit text,           -- sólo para 'personalizado'
  rate_minor bigint NOT NULL CHECK (rate_minor > 0),
  CHECK ((unit = 'personalizado') = (custom_qty IS NOT NULL AND custom_unit IS NOT NULL)),
  CHECK (custom_qty IS NULL OR custom_qty > 0),
  FOREIGN KEY (activity_id, pay_scheme) REFERENCES activities(id, pay_scheme) ON DELETE CASCADE
);

CREATE TABLE work_units (                              -- kilo, arroba, canasta, y las que inventen
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

-- Ninguna actividad sin su fila de pago (diferido: el API inserta las dos juntas).
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

`work_units` es una tabla y no un enum a propósito: "canasta" pesa distinto en cada finca, y `kg_factor` es lo que permite comparar rendimiento entre fincas que pagan por arroba y por kilo.

### Labores — la tabla que absorbe `pickups`

```sql
CREATE TABLE labors (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  employee_id uuid NOT NULL, activity_id uuid NOT NULL,
  pay_scheme pay_scheme NOT NULL,                      -- denormalizado, amarrado por FK
  started_at timestamptz NOT NULL, ended_at timestamptz,
  local_day date NOT NULL,                             -- trigger, zona de la finca
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
CREATE INDEX ix_lpc_crop ON labor_plot_crops (farm_id, plot_crop_id);  -- índice IRL / outliers
```

### Productos, bodegas e inventario

Existencias **derivadas de movimientos**, igual que el saldo se deriva del ledger. Un stock materializado es un total que se desincroniza de sus hechos, y ya sabemos qué opinamos de eso.

```sql
CREATE TABLE product_categories (
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  name text NOT NULL, UNIQUE (farm_id, id), UNIQUE (farm_id, lower(name)));

CREATE TABLE storage_units (                           -- bulto, kg, litro, caja
  id uuid PRIMARY KEY, farm_id uuid NOT NULL REFERENCES farms(id),
  code text NOT NULL, label text NOT NULL,
  UNIQUE (farm_id, id), UNIQUE (farm_id, lower(code)));

CREATE TABLE warehouses (                              -- bodegas
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
  plot_id uuid, plot_crop_id uuid,                     -- de qué lote/cultivo salió
  qty numeric(14,3) NOT NULL CHECK (qty <> 0),         -- signo: + entra, − sale
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

### Ventas y gastos

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
  receipt_id uuid,                                     -- foto del comprobante
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
  -- se imputa a una actividad, o a un lote/cultivo, no a las dos cosas ni a ninguna
  CONSTRAINT expense_target CHECK (
    (activity_id IS NOT NULL)::int + (COALESCE(plot_id, plot_crop_id) IS NOT NULL)::int = 1));
```

---

## A) `pickups` vs `labors`: **se unifican, conservando el id**

Una pesada **es** una labor de una actividad `cosecha` pagada por unidad de trabajo. Mantener las dos tablas significa dos caminos hacia el mismo dinero: dos lugares donde aplicar el precio semanal, dos candados anti doble-pago, y el día que alguien liquide una labor de mantenimiento por contrato descubriremos que `settlement_items` sólo sabe bloquear pesadas. Unificar convierte el candado en general: **ninguna labor de ninguna actividad se paga dos veces**.

El coste de migrar es menor de lo que parece, porque **el id se conserva**:

```sql
-- 1. Una actividad sintética "Recolección" por finca, con el precio general vigente.
INSERT INTO work_units (id, farm_id, code, label, kg_factor)
  SELECT uuidv7(), f.id, 'kg', 'Kilo', 1 FROM farms f;
INSERT INTO activities (id, farm_id, name, category, pay_scheme)
  SELECT uuidv7(), f.id, 'Recolección', 'cosecha', 'unidad_trabajo' FROM farms f;
INSERT INTO activity_pay_work_unit (activity_id, unit_id, price_minor)
  SELECT a.id, w.id, c.price_minor
    FROM activities a JOIN work_units w USING (farm_id) JOIN farm_config c USING (farm_id)
   WHERE a.name = 'Recolección' AND w.code = 'kg';

-- 2. Cada pesada pasa a labor CON SU MISMO UUID.
INSERT INTO labors (id, farm_id, employee_id, activity_id, pay_scheme, started_at,
                    local_day, quantity, unit_id, price_minor, amount_minor, device_id, created_at)
  SELECT p.id, p.farm_id, p.person_id, a.id, 'unidad_trabajo', p.occurred_at,
         p.local_day, p.weight, w.id, apw.price_minor,
         round(p.weight * apw.price_minor)::bigint, p.device_id, p.created_at
    FROM pickups p
    JOIN activities a ON a.farm_id = p.farm_id AND a.name = 'Recolección'
    JOIN activity_pay_work_unit apw ON apw.activity_id = a.id
    JOIN work_units w ON w.id = apw.unit_id;

-- 3. settlement_items sigue apuntando al mismo uuid; sólo cambia el nombre y la FK.
ALTER TABLE settlement_items RENAME COLUMN pickup_id TO labor_id;
ALTER TABLE settlement_items DROP CONSTRAINT settlement_items_farm_id_pickup_id_fkey,
  ADD FOREIGN KEY (farm_id, labor_id) REFERENCES labors(farm_id, id);
ALTER INDEX ux_items_pickup_live RENAME TO ux_items_labor_live;
DROP TABLE pickups;

-- 4. El móvil sigue leyendo `pickups` mientras se reescribe.
CREATE VIEW pickups AS
  SELECT l.id, l.farm_id, l.employee_id AS person_id, l.quantity AS weight,
         l.started_at AS occurred_at, l.local_day, l.week_start,
         (SELECT plot_crop_id FROM labor_plot_crops x WHERE x.labor_id = l.id LIMIT 1) AS crop_id
    FROM labors l WHERE l.pay_scheme = 'unidad_trabajo';
```

**Cero remapeo de ids, cero reescritura de liquidaciones, cero riesgo sobre dinero ya pagado.** La migración es un `INSERT…SELECT` y dos `ALTER`. Lo que sí hay que reescribir son las consultas de reportes de `schema.ts` (índice IRL, reglas de revisión, semana), porque `cropId` ahora vive en un join. Ese trabajo es de lectura, no de dinero, y se puede hacer con la vista puesta.

Un matiz: `settlement_items` gana `CHECK (pay_scheme = 'unidad_trabajo' OR …)`. No — mejor no restringir: que una labor por contrato entre a una liquidación es exactamente lo que queremos habilitar.

## B) A qué apunta el histórico de pagos

**Nada del histórico de pagos apunta hoy a un cultivo.** `settlements`, `settlement_items` y `ledger` referencian persona, liquidación y pesada; `cropId` sólo vive en `pickups`, que es reporte. Esa es la respuesta corta y es la buena noticia: **la migración de parcela/cultivo no toca dinero.**

Las labores apuntan al **cultivo** (`plot_crops`), no a la parcela, y la parcela se deriva por join. Es el grano más fino: si una parcela tiene café y plátano, "cuánto rindió el café" sólo se puede responder desde el cultivo. `labor_plots` existe además porque una labor de mantenimiento (guadañar) es sobre el lote entero, sin cultivo asignable.

La migración conserva el uuid en el **cultivo**, que es a donde apuntaban las pesadas:

```sql
-- Cada `crops` de hoy se abre en una parcela nueva + un cultivo que HEREDA EL UUID.
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

Queda una parcela por cada `crop` viejo, que es literalmente lo que el usuario tenía en la cabeza al crearlos ("Café lote 1"). Fusionar parcelas que en realidad eran la misma es trabajo manual del dueño, con una pantalla, no una adivinanza del script.

## C) SIG: **PostGIS desde el inicio**

Recomiendo `geography(MultiPolygon,4326)`, no GeoJSON en `jsonb`.

El argumento decisivo no es la consulta espacial, es la **validez**. Sin PostGIS la base acepta cualquier `jsonb`: polígonos sin cerrar, anillos que se cruzan, coordenadas invertidas (lat/lon al revés es el error clásico y silencioso). Cuando dentro de un año se migre a geometría real, habrá que arreglar a mano polígonos que un usuario dibujó hace meses y ya no recuerda. Postponer no ahorra el trabajo, lo encarece y lo vuelve arqueología.

Y la consulta espacial está más cerca de lo que parece: el teléfono ya tiene GPS, y "en qué lote estoy pesando" es una pregunta de un `ST_Contains` — que además elimina un desplegable de la pantalla de báscula, que es donde el pesador se equivoca.

`MultiPolygon` y no `Polygon` porque una parcela partida por una vía o una quebrada son dos anillos y el usuario la piensa como una sola.

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
ALTER TABLE plots ADD CONSTRAINT plots_boundary_valid
  CHECK (boundary IS NULL OR ST_IsValid(boundary::geometry));
-- Superficie calculada, para contrastar con la que el usuario declaró.
ALTER TABLE plots ADD COLUMN area_ha_gis numeric(10,3)
  GENERATED ALWAYS AS (round((ST_Area(boundary)/10000)::numeric, 3)) STORED;
-- ¿En qué lote estoy?
-- SELECT id FROM plots WHERE ST_Contains(boundary::geometry, ST_Point($lon,$lat,4326)::geometry);
```

Coste operativo honesto: PostGIS es la extensión que más duele en un `pg_upgrade` (hay que actualizarla en un orden específico), agrega ~50 MB a la imagen de desarrollo, y obliga a que el proveedor la ofrezca — RDS, Cloud SQL, Supabase y Neon la tienen; un Postgres pelado en un VPS necesita un paquete más. Es un coste real y acotado. `boundary` es nullable: una finca puede operar sin dibujar un solo polígono, y la extensión no bloquea nada.

## D) El requisito cross-tenant (RSP-009)

Esto no es una excepción al aislamiento; es **un sistema distinto** que comparte servidor. Va en su propio esquema, con sus propias reglas, y el rol del API no lo toca directamente.

### Separación física

```sql
CREATE SCHEMA registry;
REVOKE ALL ON SCHEMA registry FROM bascula_app;      -- sin acceso directo a las tablas
GRANT USAGE ON SCHEMA registry TO bascula_app;       -- sólo para llamar las funciones

-- La identidad es un HASH con pepper de servidor. Un volcado de esta tabla
-- no entrega una lista de cédulas.
CREATE TABLE registry.identities (
  id_hash bytea PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Presencia, no juicio. Nótese lo que NO hay: ni texto libre, ni puntaje,
-- ni booleano, ni monto, ni "motivo de salida". No se puede opinar aquí.
CREATE TABLE registry.employment_spans (
  id uuid PRIMARY KEY,
  id_hash bytea NOT NULL REFERENCES registry.identities(id_hash),
  farm_id uuid NOT NULL,
  started_on date NOT NULL, ended_on date,
  disclosable boolean NOT NULL DEFAULT false,        -- la finca de origen decide
  CHECK (ended_on IS NULL OR ended_on >= started_on),
  UNIQUE (id_hash, farm_id, started_on)
);
CREATE INDEX ix_spans_hash ON registry.employment_spans (id_hash);

-- Toda consulta deja rastro. Append-only, sin excepciones.
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

-- Única puerta: SECURITY DEFINER. No se puede consultar sin registrar la consulta.
CREATE FUNCTION registry.lookup(p_doc_type text, p_doc_id text, p_reason text)
RETURNS TABLE (farm_name text, started_on date, ended_on date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = registry, public AS $$
DECLARE h bytea; n int;
BEGIN
  h := digest(current_setting('bascula.pepper') || p_doc_type || '|' || p_doc_id, 'sha256');
  SELECT count(*) INTO n FROM registry.lookups
    WHERE by_farm_id = current_farm() AND at > now() - interval '1 day';
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

Nada de `employees`, `employee_notes`, `ledger` ni `labors` cruza al registro. Lo que sale es: **esta identificación trabajó en tal finca entre tales fechas, si esa finca aceptó publicarlo.** Ni saldos, ni rendimiento, ni anotaciones.

### El riesgo, dicho sin rodeos

**Este requisito, mal construido, es una lista negra.** Un recolector al que una finca marque mal puede quedar fuera de la economía de la cosecha en toda la región, sin saber que existe el registro, sin poder verlo y sin poder apelar. En Colombia eso además cae de lleno en la Ley 1581 de 2012: dato personal, tratado sin autorización, con una decisión automatizada que lo afecta.

Por eso las defensas están en el esquema y no en una política escrita:

1. **No hay dónde escribir una opinión.** `employment_spans` no tiene columna de texto libre, ni bandera, ni score. Si mañana alguien pide "un campito para observaciones", la respuesta es no, y el motivo es este párrafo.
2. **`disclosable` por defecto en `false`.** El registro no publica nada; la finca de origen opta por publicar. Sin opt-in, la función devuelve cero filas.
3. **El consultante queda registrado, siempre.** `reason` obligatorio, mínimo 10 caracteres, y `registry.lookups` es append-only por regla, no por costumbre.
4. **Rate limit en la propia función**, para que el registro no se pueda recorrer entero.
5. **El trabajador tiene derecho a ver quién lo consultó.** `ix_lookups_hash` existe para eso: una pantalla donde el empleado, identificándose, ve la lista. Si esa pantalla no se construye, yo no habilitaría el registro.

Y una recomendación de producto que es también de datos: las "alertas de seguridad" de RSP-009 deben dispararse **hacia el trabajador y hacia el auditor**, no ser un semáforo sobre la persona. Una alerta que le dice al patrón "cuidado con este" es la lista negra con otro nombre.

Si el dueño no acepta el opt-in ni la visibilidad para el trabajador, mi recomendación es **no construir el cross-tenant** y resolver el caso real (verificar que alguien ya trabajó allí) pidiendo la referencia a la otra finca por fuera del sistema.

---

## Ajustes a las secciones anteriores

**§2 RLS.** Las policies se generan en bucle sobre toda tabla con `farm_id`, y un test de CI falla si alguna queda sin policy — con veinte tablas nuevas, esto ya no se puede llevar a mano:

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

El **pesador** gana restricción en `labors`: ve sólo lo que él registró.

```sql
CREATE POLICY p_labors_weigher ON labors FOR SELECT
  USING (farm_id = current_farm() AND (current_role_name() IN ('owner','admin')
      OR created_by = current_setting('bascula.user_id')::uuid));
```

`ventas`, `gastos` y `stock_moves` quedan fuera del pesador con la misma forma que `ledger`.

**§6 Constraints en la base.** Se suman: `labor_shape` (la forma de una labor depende de su esquema de pago, y no hay manera de guardar una labor por contrato con precio unitario), `expense_target` (un gasto se imputa a una cosa y sólo una), `stock_sign` (una venta no puede aumentar existencias), el discriminador por FK compuesta de las actividades, y `plots_boundary_valid`.

**§8 Lo que sigo sin hacer.** Todo lo de la revisión 1, más: nada de contabilidad de doble partida para gastos y ventas (el dueño pidió un registro, no un libro contable); ningún costeo por hectárea materializado; ninguna sincronización del registro cross-tenant fuera de un job nocturno idempotente.
