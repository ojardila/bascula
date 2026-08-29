-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- Decision 8 (docs/decisiones.md): a worker who was taken off the payroll and
-- turns up with NEW work comes back on by himself.
--
-- The owner decided that against the team's advice, and he attached one
-- condition to it, which is what this file is mostly about: the reactivation
-- is RECORDED — with the work that provoked it and the device it came from —
-- so the person who took the decision to deactivate can see that it was undone
-- and why. Undoing a human decision in silence is the one thing that must not
-- happen here.
--
-- Two columns and one table. `deleted_by` is the missing half of the record:
-- without it the audit row can say what undid the decision but not whose
-- decision it was.
-- ---------------------------------------------------------------------------

ALTER TABLE employees ADD COLUMN deleted_by uuid REFERENCES users(id);

CREATE TABLE employee_reactivations (
  id             uuid PRIMARY KEY,
  farm_id        uuid NOT NULL REFERENCES farms(id),
  employee_id    uuid NOT NULL,
  -- The labour that provoked it. NOT NULL: an automatic reactivation with no
  -- cause attached is exactly the silent undo this table exists to prevent.
  work_record_id uuid NOT NULL,
  -- The handset that sent the work. NULL means the web console, and `source`
  -- is what says so — a null here is never "we do not know", it is "there was
  -- no device, somebody typed it into a browser".
  device_id      uuid,
  source         text NOT NULL CHECK (source IN ('sync', 'web')),
  -- The deactivation that was undone, and who took it. Copied rather than
  -- referenced because employees.deleted_at is cleared by the very statement
  -- that writes this row: after the reactivation there is nothing left on the
  -- employee to point at.
  deactivated_at timestamptz NOT NULL,
  deactivated_by uuid REFERENCES users(id),
  -- The session the work arrived through. Not "who decided": nobody decided.
  reactivated_by uuid REFERENCES users(id),
  at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, employee_id)    REFERENCES employees(farm_id, id),
  FOREIGN KEY (farm_id, work_record_id) REFERENCES work_records(farm_id, id)
);
CREATE INDEX ix_employee_reactivations_farm
  ON employee_reactivations (farm_id, at DESC);
CREATE INDEX ix_employee_reactivations_employee
  ON employee_reactivations (farm_id, employee_id, at DESC);

-- RLS by hand, because the generated loop in 00008 has already run and because
-- "same farm" is not the whole rule.
--
-- Reading is administrator-only: the row names who deactivated whom, which is
-- personnel history and sits next to employee_notes rather than next to the
-- worker list. Writing is open to every role, and it has to be — the weighing
-- that triggers a reactivation is pushed by the WEIGHER's handset, inside the
-- weigher's own transaction. A policy that let only an administrator insert
-- here would turn decision 8 into a 500 on the scale.
ALTER TABLE employee_reactivations ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_reactivations FORCE ROW LEVEL SECURITY;
CREATE POLICY p_employee_reactivations_read ON employee_reactivations FOR SELECT
  USING (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'));
CREATE POLICY p_employee_reactivations_write ON employee_reactivations FOR INSERT
  WITH CHECK (farm_id = current_farm());

-- ---------------------------------------------------------------------------
-- Pruning the feed (docs/sincronizacion.md §3.4).
--
-- sync_log is append-only and DELETE is revoked from bascula_app, which is
-- right and which also means nothing can prune it. Both defences stay; what
-- changes is that the trigger recognises one deliberate exception.
--
-- The flag is not a hole. bascula_app can set it — any session can set a GUC —
-- and it still cannot delete a single row, because the REVOKE is untouched.
-- The exception is only reachable by a role that already has DELETE on the
-- table, which is the schema owner running the pruning job out of band, the
-- same way migrations run out of band.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_log_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.sync_prune', true) = 'on' THEN
    -- Statement-level BEFORE triggers ignore the return value; not raising is
    -- what lets the statement through.
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'sync_log is append-only' USING ERRCODE = 'restrict_violation';
END $fn$;

-- The index the prune walks. ix_sync_log_at orders by time across every farm,
-- which is the wrong shape for "is this row superseded": that question is asked
-- per (farm, entity, row) and answered by ux_sync_log_row, which already
-- exists. What is missing is a cheap way to find the candidates by age within
-- a farm, so that the sweep does not read the whole table.
CREATE INDEX ix_sync_log_farm_at ON sync_log (farm_id, at);

-- ---------------------------------------------------------------------------
-- The phase 4 switch (docs/sincronizacion.md §8, "el corte").
--
-- For the hour the season import runs, the handsets go into money-read-only by
-- remote control: weighings keep being recorded, because the cut cannot stop
-- the scale, and settling, paying and voiding stop. It rides down in the
-- handshake's `capabilities`, next to settleOffline and writeWeekPrices, and it
-- is a per-farm column rather than a build flag for the reason the whole
-- capabilities block exists: turning it on must not require shipping an app to
-- a phone that is in somebody's pocket at the far end of a coffee farm.
--
-- It is not a permission and nothing may treat it as one. The server refuses a
-- weigher's ledger push and a settlement whose gross has moved whether this is
-- on or off; what this buys is that nobody is looking at a live pay button
-- during the one hour the two databases disagree.
-- ---------------------------------------------------------------------------
ALTER TABLE farms ADD COLUMN money_read_only boolean NOT NULL DEFAULT false;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE farms DROP COLUMN IF EXISTS money_read_only;
DROP INDEX IF EXISTS ix_sync_log_farm_at;
CREATE OR REPLACE FUNCTION sync_log_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'sync_log is append-only' USING ERRCODE = 'restrict_violation';
END $fn$;
DROP TABLE IF EXISTS employee_reactivations;
ALTER TABLE employees DROP COLUMN IF EXISTS deleted_by;
-- +goose StatementEnd
