-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- «Equipos»: people who pick into one sack and are paid as one account
-- (docs/use-cases/teams.md, approved by the owner 2026-09-30).
--
-- A team is a row in `employees` with kind = 'equipo'. It is the PAYEE: its
-- weighings, settlements, ledger balance, advances, payments and special kilo
-- price are all keyed by its employee id, exactly like a person's, so none of
-- the money machinery changes. Its members are ordinary people
-- (kind = 'persona') listed in team_members with the days they belong.
--
-- Rules, enforced below:
--   - a team is never a member, and a member is always a person;
--   - a person belongs to at most ONE team on any given day (memberships of
--     one person never overlap);
--   - a member has no personal harvest work while in a team: weighings go to
--     the team (enforced in store.CreateWorkRecord, which answers
--     WORKER_IN_TEAM).
--
-- The statistics count heads, not accounts: a team-day is as many
-- person-days as the team had members that day (picker_ids/team_heads), so
-- the farm's kilos per person per day and the 70% flag stay honest.
-- ---------------------------------------------------------------------------

ALTER TABLE employees ADD COLUMN kind text NOT NULL DEFAULT 'persona'
  CHECK (kind IN ('persona', 'equipo'));

COMMENT ON COLUMN employees.kind IS
  '''persona'' (a person) or ''equipo'' (a team: one payee, members in team_members). See migration 00040.';

CREATE TABLE team_members (
  id          uuid PRIMARY KEY,
  farm_id     uuid NOT NULL REFERENCES farms(id),
  team_id     uuid NOT NULL,
  employee_id uuid NOT NULL,
  from_day    date NOT NULL,
  to_day      date,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (to_day IS NULL OR to_day >= from_day),
  CHECK (team_id <> employee_id),
  FOREIGN KEY (farm_id, team_id)     REFERENCES employees(farm_id, id),
  FOREIGN KEY (farm_id, employee_id) REFERENCES employees(farm_id, id),
  UNIQUE (farm_id, id)
);
CREATE INDEX ix_team_members_team   ON team_members (farm_id, team_id, from_day);
CREATE INDEX ix_team_members_person ON team_members (farm_id, employee_id, from_day);

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
CREATE POLICY p_tenant ON team_members
  USING (farm_id = current_farm()) WITH CHECK (farm_id = current_farm());

COMMENT ON TABLE team_members IS
  'Who belongs to a team (employees.kind = equipo), from_day..to_day inclusive; '
  'to_day NULL = still a member. A person is in at most one team on a day. See migration 00040.';

-- The shape rules. A trigger and not an exclusion constraint so no extension
-- (btree_gist) has to be created on every farm's database. The advisory lock
-- serialises two memberships of the same person written at once.
CREATE FUNCTION team_members_check() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  team_kind   text;
  member_kind text;
  clash       uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('team_members:' || NEW.employee_id::text));
  SELECT kind INTO team_kind FROM employees WHERE id = NEW.team_id;
  SELECT kind INTO member_kind FROM employees WHERE id = NEW.employee_id;
  IF team_kind IS DISTINCT FROM 'equipo' THEN
    RAISE EXCEPTION 'team_members: % is not a team', NEW.team_id USING ERRCODE = 'check_violation',
      CONSTRAINT = 'team_members_team_kind';
  END IF;
  IF member_kind IS DISTINCT FROM 'persona' THEN
    RAISE EXCEPTION 'team_members: % is not a person', NEW.employee_id USING ERRCODE = 'check_violation',
      CONSTRAINT = 'team_members_member_kind';
  END IF;
  SELECT tm.team_id INTO clash FROM team_members tm
   WHERE tm.employee_id = NEW.employee_id AND tm.id <> NEW.id
     AND tm.from_day <= coalesce(NEW.to_day, 'infinity'::date)
     AND coalesce(tm.to_day, 'infinity'::date) >= NEW.from_day
   LIMIT 1;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'team_members: % already belongs to team % on those days', NEW.employee_id, clash
      USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'team_members_one_team';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER t_team_members_check BEFORE INSERT OR UPDATE ON team_members
  FOR EACH ROW EXECUTE FUNCTION team_members_check();

-- A team that changes members is a changed worker for the offline feed: the
-- handset's copy of the team carries its members.
CREATE FUNCTION team_members_sync() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  r team_members;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  INSERT INTO sync_log (farm_id, entity, row_id, op) VALUES (r.farm_id, 'worker', r.team_id, 'upsert');
  INSERT INTO sync_log (farm_id, entity, row_id, op) VALUES (r.farm_id, 'worker', r.employee_id, 'upsert');
  RETURN NULL;
END $fn$;

CREATE TRIGGER t_sync_team_members AFTER INSERT OR UPDATE OR DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION team_members_sync();

-- The people behind one account on one day: the members of a team that day,
-- or the employee itself (a person, or a team with nobody listed that day).
CREATE FUNCTION picker_ids(p_employee uuid, p_day date) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $fn$
  SELECT tm.employee_id FROM team_members tm
   WHERE tm.team_id = p_employee AND tm.from_day <= p_day
     AND (tm.to_day IS NULL OR tm.to_day >= p_day)
  UNION ALL
  SELECT p_employee
   WHERE NOT EXISTS (SELECT 1 FROM team_members tm
                      WHERE tm.team_id = p_employee AND tm.from_day <= p_day
                        AND (tm.to_day IS NULL OR tm.to_day >= p_day))
$fn$;

COMMENT ON FUNCTION picker_ids(uuid, date) IS
  'The people behind one payee on one day: a team''s members, else the employee itself. See migration 00040.';

-- How many heads one account had on one day (1 for a person). PL/pgSQL so the
-- reports' planner does not inline it into every weighing (see 00034).
CREATE FUNCTION team_heads(p_employee uuid, p_day date) RETURNS integer
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM team_members tm
   WHERE tm.team_id = p_employee AND tm.from_day <= p_day
     AND (tm.to_day IS NULL OR tm.to_day >= p_day);
  RETURN greatest(n, 1);
END $fn$;

COMMENT ON FUNCTION team_heads(uuid, date) IS
  'Heads behind one payee on one day: a team''s member count (at least 1), 1 for a person. See migration 00040.';

-- «¿Quién recibe la plata?»: on a payment or advance to a team, the member who
-- took the cash. Informational (printed on the receipt); the balance is the
-- team's. Append-only like the rest of the ledger.
ALTER TABLE ledger ADD COLUMN received_by uuid;
ALTER TABLE ledger ADD CONSTRAINT ledger_received_by_fkey
  FOREIGN KEY (farm_id, received_by) REFERENCES employees(farm_id, id);
ALTER TABLE ledger ADD CONSTRAINT ledger_received_by_shape
  CHECK (received_by IS NULL OR kind IN ('pago', 'anticipo'));

COMMENT ON COLUMN ledger.received_by IS
  'Payment or advance to a team: the member who received the cash. Informational. See migration 00040.';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_received_by_shape;
ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_received_by_fkey;
ALTER TABLE ledger DROP COLUMN IF EXISTS received_by;
DROP FUNCTION IF EXISTS team_heads(uuid, date);
DROP FUNCTION IF EXISTS picker_ids(uuid, date);
DROP TABLE IF EXISTS team_members;
DROP FUNCTION IF EXISTS team_members_sync();
DROP FUNCTION IF EXISTS team_members_check();
ALTER TABLE employees DROP COLUMN IF EXISTS kind;
-- +goose StatementEnd
