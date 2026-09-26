-- +goose Up
-- +goose StatementBegin

-- One email may own several farms. Every farm is its own world — on a
-- dedicated stack, its own database — so registering a new farm at /empezar
-- with an address that already has an account no longer stops at "ese correo
-- ya tiene cuenta". The shared platform keeps ONE users row per address (and
-- its global password, which is what the main domain checks), adds a
-- membership for the new farm, and records here what the person typed on that
-- registration: the name and the password for THAT farm.
--
-- The seed of the farm's own stack reads this row before the users row, so the
-- owner signs in on {slug}.bascula.engp.io with the password they just chose,
-- and a stranger who registers a farm with somebody else's address gets back
-- only what they typed, never that person's name, phone or password hash.
CREATE TABLE farm_owner_credentials (
  farm_id       uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  phone         text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (farm_id, user_id)
);

ALTER TABLE farm_owner_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE farm_owner_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY p_farm_owner_credentials ON farm_owner_credentials
  USING (farm_id = current_farm())
  WITH CHECK (farm_id = current_farm());

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS farm_owner_credentials;
-- +goose StatementEnd
