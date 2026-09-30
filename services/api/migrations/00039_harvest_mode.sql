-- +goose Up
-- +goose StatementBegin

-- «Modo cosecha»: a farm-level switch the owner or the administrator turns on
-- during the harvest. While it is on, the farm's home screen («Cosecha»)
-- shows the harvest-week dashboard (GET /v1/reports/harvest-dashboard); while
-- it is off, the home screen is exactly what it was before.
--
-- It is a display preference, not a permission: nothing on the server reads
-- it to allow or refuse anything. Default off, so every existing farm — and a
-- farm created a minute ago — keeps the home screen it has. Adding a column
-- with a constant default is a catalogue-only change in Postgres 11+, so this
-- is safe on every farm's database regardless of size.
ALTER TABLE farm_config ADD COLUMN harvest_mode boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN farm_config.harvest_mode IS
  '«Modo cosecha»: the home screen shows the harvest-week dashboard. Display only. See migration 00039.';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE farm_config DROP COLUMN IF EXISTS harvest_mode;
-- +goose StatementEnd
