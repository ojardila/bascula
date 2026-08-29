-- +goose Up
-- +goose StatementBegin

-- Attachments: worker photos and sale receipts. Never bytes in Postgres; the
-- row is a pointer into object storage.
CREATE TABLE attachments (
  id         uuid PRIMARY KEY,
  farm_id    uuid NOT NULL REFERENCES farms(id),
  object_key text NOT NULL UNIQUE,
  mime       text NOT NULL,
  bytes      bigint NOT NULL CHECK (bytes > 0),
  sha256     bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, id)
);

-- PARCELA. `boundary` exists from the first migration but sprint 1 exposes no
-- endpoint that writes it (see docs/plan-sprint-1.md section 2): the column is
-- cheap, the drawing UI is not.
CREATE TABLE plots (
  id           uuid PRIMARY KEY,
  farm_id      uuid NOT NULL REFERENCES farms(id),
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  area_ha      numeric(10, 3) CHECK (area_ha IS NULL OR area_ha > 0),
  department   text,
  municipality text,
  boundary     geography(MultiPolygon, 4326),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT plots_boundary_valid CHECK (boundary IS NULL OR ST_IsValid(boundary::geometry)),
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_plots_name ON plots (farm_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX ix_plots_boundary ON plots USING gist (boundary);

-- Computed hectares, to contrast with the declared ones. Both are returned by
-- the API; they always disagree, and hiding one decides for the owner which
-- one lies.
ALTER TABLE plots ADD COLUMN area_ha_gis numeric(10, 3)
  GENERATED ALWAYS AS (round((ST_Area(boundary) / 10000)::numeric, 3)) STORED;

-- Crop types and varieties are catalogues, not enums: RSP-001 asks for the
-- picker with an "add it if it is not there" button, and a farm that plants
-- something nobody foresaw must not need a migration. Idempotent by
-- (farm_id, lower(name)), so the autocomplete never duplicates.
CREATE TABLE crop_types (
  id         uuid PRIMARY KEY,
  farm_id    uuid NOT NULL REFERENCES farms(id),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_crop_types_name ON crop_types (farm_id, lower(name));

CREATE TABLE varieties (
  id           uuid PRIMARY KEY,
  farm_id      uuid NOT NULL REFERENCES farms(id),
  crop_type_id uuid,
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  FOREIGN KEY (farm_id, crop_type_id) REFERENCES crop_types(farm_id, id),
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_varieties_name ON varieties (farm_id, lower(name));

-- CULTIVO planted in the plot. Labors point at the crop, not the plot: if a
-- plot has coffee and plantain, "how did the coffee do" is only answerable at
-- this grain.
CREATE TABLE plot_crops (
  id           uuid PRIMARY KEY,
  farm_id      uuid NOT NULL REFERENCES farms(id),
  plot_id      uuid NOT NULL,
  crop_type_id uuid NOT NULL,
  variety_id   uuid,
  area_ha    numeric(10, 3) CHECK (area_ha IS NULL OR area_ha > 0),
  planted_on date,
  removed_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (removed_on IS NULL OR planted_on IS NULL OR removed_on >= planted_on),
  FOREIGN KEY (farm_id, plot_id)      REFERENCES plots(farm_id, id),
  FOREIGN KEY (farm_id, crop_type_id) REFERENCES crop_types(farm_id, id),
  FOREIGN KEY (farm_id, variety_id)   REFERENCES varieties(farm_id, id),
  UNIQUE (farm_id, id)
);
CREATE INDEX ix_plot_crops_plot ON plot_crops (farm_id, plot_id) WHERE deleted_at IS NULL;
-- The sum of plot_crops.area_ha is deliberately not checked against
-- plots.area_ha: an associated crop (coffee shaded by plantain) occupies the
-- same hectare twice. That is a UI warning, not a constraint.

-- EMPLEADO. Named `employees` in the database and `/v1/workers` on the wire;
-- see README for the naming map between the two design documents.
CREATE TABLE employees (
  id            uuid PRIMARY KEY,
  farm_id       uuid NOT NULL REFERENCES farms(id),
  name          text NOT NULL CHECK (length(btrim(name)) > 0),
  last_name     text,
  document_type text,
  doc_id        text,
  tag           text,
  phone         text,
  address       text,
  city          text,
  municipality  text,
  country       text DEFAULT 'CO',
  photo_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  FOREIGN KEY (farm_id, photo_id) REFERENCES attachments(farm_id, id),
  UNIQUE (farm_id, id)
);
CREATE UNIQUE INDEX ux_employees_doc ON employees (farm_id, document_type, doc_id)
  WHERE deleted_at IS NULL AND doc_id IS NOT NULL;
CREATE UNIQUE INDEX ux_employees_tag ON employees (farm_id, tag)
  WHERE deleted_at IS NULL AND tag IS NOT NULL;

-- Notes are born private and have no exit route out of the farm. There is no
-- column here that the registry service reads, and that is deliberate:
-- see decision 1 in docs/decisiones.md.
CREATE TABLE employee_notes (
  id          uuid PRIMARY KEY,
  farm_id     uuid NOT NULL REFERENCES farms(id),
  employee_id uuid NOT NULL,
  noted_on    date NOT NULL,
  body        text NOT NULL,
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility = 'private'),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, employee_id) REFERENCES employees(farm_id, id),
  UNIQUE (farm_id, id)
);
CREATE INDEX ix_notes_employee ON employee_notes (farm_id, employee_id, noted_on DESC);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS employee_notes;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS plot_crops;
DROP TABLE IF EXISTS varieties;
DROP TABLE IF EXISTS crop_types;
DROP TABLE IF EXISTS plots;
DROP TABLE IF EXISTS attachments;
-- +goose StatementEnd
