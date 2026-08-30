-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- The way out of a void settlement that still claims a weighing.
--
-- Migration 00013's fix to the season import closed the door that CREATED this
-- shape: an imported settlement with status `void` whose lines never got a
-- voided_at. It did nothing about the farms that already have one, and there
-- was no route that could:
--
--   * POST /v1/settlements/{id}/void answers 409 SETTLEMENT_ALREADY_VOID
--     before it touches a single line, because a second void with no
--     idempotency key is a second attempt to hand the money back and that
--     function is not allowed to guess;
--   * ux_items_payable_live is a partial unique index on (payable_id) WHERE
--     voided_at IS NULL, so while the line lives the weighing under it can
--     never enter another settlement;
--   * DELETE is revoked from bascula_app on settlements and settlement_items,
--     so nobody can cut the line out from underneath.
--
-- The pesada is therefore stuck for ever: worked, unpayable, and invisible in
-- every "pendiente" list because the lock says it is already claimed. That is
-- somebody's day of picking.
--
-- This table is the release, and it exists because the release must be a
-- RECORD and not a repair somebody did with psql at midnight. Freeing a
-- weighing claimed by a settlement that can no longer pay it puts money back
-- into circulation: it becomes payable again, and the next settlement will pay
-- it. An operation that moves money and leaves no trace is the one thing this
-- schema has refused everywhere else — see employee_reactivations, and the
-- reversal that cancels a devengo rather than deleting it.
-- ---------------------------------------------------------------------------

CREATE TABLE settlement_releases (
  id            uuid PRIMARY KEY,
  farm_id       uuid NOT NULL REFERENCES farms(id),
  settlement_id uuid NOT NULL,
  -- What the act actually did, counted rather than described. A release that
  -- freed nothing and a release that freed twelve weighings are not the same
  -- event, and a reader six months later has only this row to tell them apart.
  items_released  integer NOT NULL CHECK (items_released >= 0),
  -- WHICH weighings came back. The count says how much was repaired; this says
  -- what to go and look at, which is what an audit is for. It is also what
  -- makes a resend exact: the second call returns the same list rather than
  -- recomputing one from a table that has since moved on.
  payable_ids   uuid[] NOT NULL DEFAULT '{}',
  -- The earning this release had to cancel because the original void never
  -- did. Zero is a real answer here — most void settlements did reverse their
  -- devengo — so it is NOT NULL and defaults to nothing.
  reversed_minor  bigint  NOT NULL DEFAULT 0,
  -- Why. Free text and NOT NULL and non-empty on purpose: the operator has to
  -- write down what they were looking at. This is the field the audit reads.
  reason        text NOT NULL CHECK (length(btrim(reason)) > 0),
  released_by   uuid REFERENCES users(id),
  at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, settlement_id) REFERENCES settlements(farm_id, id),
  -- Idempotent by (farm_id, id), like every other write in this service: the
  -- caller names the act, and a resend gets the record back instead of
  -- releasing a second time.
  UNIQUE (farm_id, id)
);
CREATE INDEX ix_settlement_releases_settlement
  ON settlement_releases (farm_id, settlement_id, at DESC);

-- Append-only, for the same reason the ledger is. An audit row that can be
-- edited afterwards is an audit row that says whatever the last writer wanted
-- it to say.
CREATE FUNCTION settlement_releases_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'settlement_releases is append-only: it is the record of a repair'
    USING ERRCODE = 'restrict_violation';
END $fn$;
CREATE TRIGGER t_settlement_releases_append_only
  BEFORE UPDATE OR DELETE ON settlement_releases
  FOR EACH STATEMENT EXECUTE FUNCTION settlement_releases_is_append_only();
REVOKE UPDATE, DELETE ON settlement_releases FROM bascula_app;

-- RLS by hand: the generated loop in 00008 has already run, and "same farm" is
-- not the whole rule. This is money — it says what a settlement stopped
-- claiming — so it carries the same policy settlements and settlement_items
-- carry, and the weigher never reaches it.
ALTER TABLE settlement_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY p_settlement_releases ON settlement_releases
  USING (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'))
  WITH CHECK (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'));

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS t_settlement_releases_append_only ON settlement_releases;
DROP FUNCTION IF EXISTS settlement_releases_is_append_only();
DROP TABLE IF EXISTS settlement_releases;
-- +goose StatementEnd
