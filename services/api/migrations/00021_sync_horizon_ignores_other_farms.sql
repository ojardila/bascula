-- +goose Up
--
-- The feed's horizon held back rows that were already committed.
--
-- It asked `xact >= pg_snapshot_xmin(pg_current_snapshot())`, and xmin is the
-- oldest transaction still running ANYWHERE IN THE DATABASE. So the test was
-- not "did this row's transaction commit?" but "did it start after the oldest
-- thing still running started?" — which is true of every recent row whenever
-- any long write is open, no matter whose.
--
-- The season import holds exactly such a transaction, by design, for as long
-- as an owner's upload takes: up to twenty-five minutes. During it the horizon
-- collapses to the import's own seq, every other farm's feed stops moving, and
-- their phones are told they are up to date — `changes: [], more: false` is
-- indistinguishable from having nothing to fetch. Reproduced: a committed row
-- at seq N was withheld while an unrelated write transaction stayed open, and
-- delivered the moment it closed.
--
-- `pg_visible_in_snapshot` asks the question that was meant all along. A row
-- is held back only while its own transaction is genuinely not visible — still
-- in flight, or aborted — and a transaction that committed is final whatever
-- else the database happens to be doing.
--
-- The property this protects is unchanged and is the reason the cursor can be
-- a single number: the phone must never step over a change. Holding back too
-- much was safe for correctness and catastrophic for liveness; this holds back
-- exactly what is unsafe.
CREATE OR REPLACE FUNCTION sync_horizon(p_farm uuid, p_after bigint) RETURNS bigint
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT MIN(seq) FROM sync_log
      WHERE farm_id = p_farm AND seq > p_after
        AND NOT pg_visible_in_snapshot(xact, pg_current_snapshot())),
    (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log WHERE farm_id = p_farm))
$$;

-- +goose Down
CREATE OR REPLACE FUNCTION sync_horizon(p_farm uuid, p_after bigint) RETURNS bigint
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT MIN(seq) FROM sync_log
      WHERE farm_id = p_farm AND seq > p_after
        AND xact >= pg_snapshot_xmin(pg_current_snapshot())),
    (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log WHERE farm_id = p_farm))
$$;
