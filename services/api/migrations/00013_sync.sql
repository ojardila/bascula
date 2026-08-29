-- +goose Up
-- +goose StatementBegin

-- The change feed, and the operation log that makes a resend safe.
-- docs/sincronizacion.md §3.4 and §4.2 specify both tables; this file is that
-- specification, with the two things it left implicit made explicit: who may
-- read the feed, and what the feed says about a farm that already had rows in
-- it before the feed existed.

CREATE TABLE sync_log (
  seq     bigserial PRIMARY KEY,
  farm_id uuid   NOT NULL REFERENCES farms(id),
  entity  text   NOT NULL,
  row_id  uuid   NOT NULL,
  op      text   NOT NULL CHECK (op IN ('upsert','append')),
  -- The transaction that wrote this row. It is what closes the hole a bare
  -- sequence leaves: nextval() hands out numbers BEFORE commit, so a reader
  -- can see seq 100 committed while seq 99 is still in flight, take cursor
  -- 100, and never see 99 again. See horizon_seq() below.
  xact    xid8   NOT NULL DEFAULT pg_current_xact_id(),
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sync_log_farm ON sync_log (farm_id, seq);
CREATE UNIQUE INDEX ux_sync_log_row ON sync_log (farm_id, entity, row_id, seq);
-- Retention is 180 days (§3.4). Pruning is a scheduled job, not a migration,
-- and the pull answers CURSOR_TOO_OLD from the oldest seq still present, so
-- the two cannot disagree about what was kept.
CREATE INDEX ix_sync_log_at ON sync_log (at);

-- The feed is append-only for the same reason the ledger is: an edited feed
-- row is a change a phone can never be told about again.
CREATE FUNCTION sync_log_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'sync_log is append-only' USING ERRCODE = 'restrict_violation';
END $fn$;
CREATE TRIGGER t_sync_log_append_only BEFORE UPDATE OR DELETE ON sync_log
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log_is_append_only();
REVOKE UPDATE, DELETE ON sync_log FROM bascula_app;

-- §4.2 — the registry of operations. The server, before applying an envelope,
-- looks here; if the opId is present it returns `result` LITERALLY without
-- executing anything. This is what covers the operations layer 1 cannot:
-- voids and reversals, whose second attempt has a different answer from the
-- first. Retention 30 days: a retry after 30 days is not a retry.
CREATE TABLE sync_ops (
  op_id     uuid PRIMARY KEY,
  farm_id   uuid NOT NULL REFERENCES farms(id),
  device_id uuid NOT NULL,
  status    text NOT NULL CHECK (status IN ('applied','duplicate','rejected')),
  result    jsonb NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sync_ops_device ON sync_ops (farm_id, device_id, at DESC);

-- ---------------------------------------------------------------------------
-- The writers. Triggers and not Go, for the same reason local_day is a
-- trigger: a row written by a route nobody foresaw still has to appear in the
-- feed. A feed maintained by convention is a feed with a hole in it.
--
-- The feed row carries identity only. The body is composed at pull time from
-- the real table, so a row corrected five times is sent once, in its current
-- state, and the feed can never become a second copy of the money that
-- diverges from the first.
-- ---------------------------------------------------------------------------

-- Entity names are the wire names from §3, not the table names: the phone
-- knows `worker`, `crop` and `workRecord`.
CREATE FUNCTION sync_log_write() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  entity text := TG_ARGV[0];
  op     text := TG_ARGV[1];
  rid    uuid;
  fid    uuid;
BEGIN
  fid := NEW.farm_id;
  -- Which column names the row depends on the table, and there are three
  -- shapes. settlement_items deliberately reports its PARENT: §3.3 says a
  -- settlement travels whole, with its lines, always — a header worth
  -- $1.187.500 with nothing under it is the bug user_version = 4 existed to
  -- fix.
  CASE entity
    WHEN 'settlementItem' THEN
      entity := 'settlement';
      rid := NEW.settlement_id;
    WHEN 'weekPrice' THEN
      -- week_prices is keyed by (farm_id, week_start) and has no id. A
      -- deterministic uuid derived from the week keeps the feed's row_id
      -- meaningful: the same week is the same feed row for ever.
      rid := md5(NEW.farm_id::text || '|weekPrice|' || NEW.week_start::text)::uuid;
    WHEN 'farmConfig' THEN
      rid := NEW.farm_id;
    ELSE
      rid := NEW.id;
  END CASE;

  INSERT INTO sync_log (farm_id, entity, row_id, op) VALUES (fid, entity, rid, op);
  RETURN NULL;
END $fn$;

CREATE TRIGGER t_sync_employees        AFTER INSERT OR UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION sync_log_write('worker', 'upsert');
CREATE TRIGGER t_sync_plots            AFTER INSERT OR UPDATE ON plots
  FOR EACH ROW EXECUTE FUNCTION sync_log_write('plot', 'upsert');
CREATE TRIGGER t_sync_plot_crops       AFTER INSERT OR UPDATE ON plot_crops
  FOR EACH ROW EXECUTE FUNCTION sync_log_write('crop', 'upsert');
CREATE TRIGGER t_sync_work_records     AFTER INSERT OR UPDATE ON work_records
  FOR EACH ROW EXECUTE FUNCTION sync_log_write('workRecord', 'upsert');
CREATE TRIGGER t_sync_week_prices      AFTER INSERT OR UPDATE ON week_prices
  FOR EACH ROW EXECUTE FUNCTION sync_log_write('weekPrice', 'upsert');
CREATE TRIGGER t_sync_farm_config      AFTER INSERT OR UPDATE ON farm_config
  FOR EACH ROW EXECUTE FUNCTION sync_log_write('farmConfig', 'upsert');
CREATE TRIGGER t_sync_settlements      AFTER INSERT OR UPDATE ON settlements
  FOR EACH ROW EXECUTE FUNCTION sync_log_write('settlement', 'upsert');
CREATE TRIGGER t_sync_settlement_items AFTER INSERT OR UPDATE ON settlement_items
  FOR EACH ROW EXECUTE FUNCTION sync_log_write('settlementItem', 'upsert');
-- The ledger is append-only, so `append` is not a nicety: it tells the phone
-- it may apply the row without looking for one to replace.
CREATE TRIGGER t_sync_ledger           AFTER INSERT ON ledger
  FOR EACH ROW EXECUTE FUNCTION sync_log_write('ledgerEntry', 'append');

-- ---------------------------------------------------------------------------
-- The horizon (§3.4).
--
-- The lowest seq still owned by a transaction that may not have committed.
-- Everything strictly below it is final, in order, for ever. A row held back
-- by the horizon is not lost: it appears in the next poll, in its place. What
-- the horizon buys is the one property that makes "a single number" enough —
-- the cursor never jumps over a change.
-- ---------------------------------------------------------------------------
CREATE FUNCTION sync_horizon(p_farm uuid, p_after bigint) RETURNS bigint
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT MIN(seq) FROM sync_log
      WHERE farm_id = p_farm AND seq > p_after
        AND xact >= pg_snapshot_xmin(pg_current_snapshot())),
    (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log WHERE farm_id = p_farm))
$$;

-- ---------------------------------------------------------------------------
-- RLS.
--
-- The generated loop in 00008 has already run, so these two get their policies
-- by hand — and they would need to anyway, because "same farm" is not the
-- whole rule for either.
--
-- The feed row carries an entity name and a uuid and no money. It is still
-- readable by every role rather than only by the money roles, because the
-- weigher's phone has to advance its cursor past a settlement it will never be
-- shown; the BODY is what the pull refuses him, composed from tables his own
-- policies already close (p_ledger, p_settlements). Denying the seq as well
-- would strand his cursor behind the first payroll of the season.
-- ---------------------------------------------------------------------------
ALTER TABLE sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log FORCE ROW LEVEL SECURITY;
CREATE POLICY p_sync_log ON sync_log
  USING (farm_id = current_farm())
  WITH CHECK (farm_id = current_farm());

ALTER TABLE sync_ops ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_ops FORCE ROW LEVEL SECURITY;
CREATE POLICY p_sync_ops ON sync_ops
  USING (farm_id = current_farm())
  WITH CHECK (farm_id = current_farm());

-- ---------------------------------------------------------------------------
-- The backfill: what the feed says about a farm that existed before it.
--
-- Without this, a phone handshaking with cursor 0 would receive nothing at all
-- and conclude the farm is empty — which is the single most dangerous answer
-- this endpoint can give. With it, cursor 0 IS the bootstrap, in dependency
-- order, and §3.4's separate /v1/sync/bootstrap route is not needed until the
-- day pruning actually removes something.
--
-- Order matters and is the receiving order decision of 2026-08-29: references
-- come down first — config, people, plots, crops, prices — and only then work
-- and money. A weighing that names a person the phone has not got yet is not a
-- conflict, it is an incomplete pull.
-- ---------------------------------------------------------------------------
INSERT INTO sync_log (farm_id, entity, row_id, op)
SELECT farm_id, 'farmConfig', farm_id, 'upsert' FROM farm_config;
INSERT INTO sync_log (farm_id, entity, row_id, op)
SELECT farm_id, 'worker', id, 'upsert' FROM employees ORDER BY created_at, id;
INSERT INTO sync_log (farm_id, entity, row_id, op)
SELECT farm_id, 'plot', id, 'upsert' FROM plots ORDER BY created_at, id;
INSERT INTO sync_log (farm_id, entity, row_id, op)
SELECT farm_id, 'crop', id, 'upsert' FROM plot_crops ORDER BY created_at, id;
INSERT INTO sync_log (farm_id, entity, row_id, op)
SELECT farm_id, 'weekPrice',
       md5(farm_id::text || '|weekPrice|' || week_start::text)::uuid, 'upsert'
  FROM week_prices ORDER BY week_start;
INSERT INTO sync_log (farm_id, entity, row_id, op)
SELECT farm_id, 'workRecord', id, 'upsert' FROM work_records ORDER BY created_at, id;
INSERT INTO sync_log (farm_id, entity, row_id, op)
SELECT farm_id, 'settlement', id, 'upsert' FROM settlements ORDER BY created_at, id;
INSERT INTO sync_log (farm_id, entity, row_id, op)
SELECT farm_id, 'ledgerEntry', id, 'append' FROM ledger ORDER BY created_at, id;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS t_sync_ledger ON ledger;
DROP TRIGGER IF EXISTS t_sync_settlement_items ON settlement_items;
DROP TRIGGER IF EXISTS t_sync_settlements ON settlements;
DROP TRIGGER IF EXISTS t_sync_farm_config ON farm_config;
DROP TRIGGER IF EXISTS t_sync_week_prices ON week_prices;
DROP TRIGGER IF EXISTS t_sync_work_records ON work_records;
DROP TRIGGER IF EXISTS t_sync_plot_crops ON plot_crops;
DROP TRIGGER IF EXISTS t_sync_plots ON plots;
DROP TRIGGER IF EXISTS t_sync_employees ON employees;
DROP FUNCTION IF EXISTS sync_log_write();
DROP FUNCTION IF EXISTS sync_horizon(uuid, bigint);
DROP TRIGGER IF EXISTS t_sync_log_append_only ON sync_log;
DROP FUNCTION IF EXISTS sync_log_is_append_only();
DROP TABLE IF EXISTS sync_ops;
DROP TABLE IF EXISTS sync_log;
-- +goose StatementEnd
