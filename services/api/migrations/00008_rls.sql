-- +goose Up
-- +goose StatementBegin

-- Isolation is RLS, not `WHERE farm_id`. A WHERE clause is a convention: one
-- new query written at 11pm and farm A's payroll shows up in farm B, and that
-- does not fail loudly, it fails silently. RLS turns the omission into zero
-- rows. The composite foreign keys are the second belt: even past a policy,
-- nobody can stitch a work record of one farm onto a person of another.
--
-- The tables below get their policy written by hand, because they are the ones
-- whose rule is not simply "same farm". Everything else is generated in a loop
-- at the bottom, and a test in CI fails if a table with farm_id has no policy.

-- Farms: reachable by the farm in the token, by the user's own memberships
-- (this is what makes login able to list them before a farm is chosen), and by
-- the super-admin, who administers farms without reading inside them.
ALTER TABLE farms ENABLE ROW LEVEL SECURITY;
ALTER TABLE farms FORCE ROW LEVEL SECURITY;
CREATE POLICY p_farms ON farms
  USING (id = current_farm()
         OR current_setting('app.superadmin', true) = 'on'
         OR EXISTS (SELECT 1 FROM memberships m
                     WHERE m.farm_id = farms.id AND m.user_id = current_user_id()))
  WITH CHECK (id = current_farm() OR current_setting('app.superadmin', true) = 'on');

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY p_memberships ON memberships
  USING (farm_id = current_farm() OR user_id = current_user_id())
  WITH CHECK (farm_id = current_farm());

-- Refresh tokens and email verifications are authentication plumbing, and the
-- login/refresh path reaches them before any farm is known — that is the whole
-- point of a refresh token. Inside a tenant transaction current_farm() is
-- never null, so there the rule is strict; outside one, the only key into
-- these tables is the sha256 of a 32-byte secret the caller had to present.
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY p_refresh_tokens ON refresh_tokens
  USING (current_farm() IS NULL OR farm_id = current_farm())
  WITH CHECK (current_farm() IS NULL OR farm_id = current_farm());

ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY p_email_verifications ON email_verifications
  USING (current_farm() IS NULL OR farm_id = current_farm())
  WITH CHECK (current_farm() IS NULL OR farm_id = current_farm());

-- Money is farm-scoped AND role-scoped: the weigher does not see anybody's
-- payroll. Denying it in the middleware is the message; denying it here is the
-- guarantee.
ALTER TABLE ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY p_ledger ON ledger
  USING (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'))
  WITH CHECK (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'));

ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY p_settlements ON settlements
  USING (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'))
  WITH CHECK (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'));

ALTER TABLE settlement_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_items FORCE ROW LEVEL SECURITY;
CREATE POLICY p_settlement_items ON settlement_items
  USING (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'))
  WITH CHECK (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'));

-- Prices: everyone in the farm reads, only the owner writes.
ALTER TABLE week_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE week_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY p_week_prices_read ON week_prices FOR SELECT
  USING (farm_id = current_farm());
CREATE POLICY p_week_prices_write ON week_prices FOR ALL
  USING (farm_id = current_farm() AND current_role_name() = 'owner')
  WITH CHECK (farm_id = current_farm() AND current_role_name() = 'owner');

-- Notes never reach the weigher, and they never leave the farm at all.
ALTER TABLE employee_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY p_employee_notes ON employee_notes
  USING (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'))
  WITH CHECK (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'));

-- The weigher sees only the work records he recorded.
ALTER TABLE work_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_records FORCE ROW LEVEL SECURITY;
CREATE POLICY p_work_records_read ON work_records FOR SELECT
  USING (farm_id = current_farm()
         AND (current_role_name() IN ('owner', 'admin') OR created_by = current_user_id()));
CREATE POLICY p_work_records_write ON work_records FOR INSERT
  WITH CHECK (farm_id = current_farm());
CREATE POLICY p_work_records_update ON work_records FOR UPDATE
  USING (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'))
  WITH CHECK (farm_id = current_farm());

-- The activity rate tables carry no farm_id — they hang off activities, which
-- do. Narrowing through that subquery inherits the tenant policy, and the role
-- test is what keeps rates out of the weigher's reach.
ALTER TABLE activity_pay_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_pay_contract FORCE ROW LEVEL SECURITY;
CREATE POLICY p_apc ON activity_pay_contract
  USING (current_role_name() IN ('owner', 'admin')
         AND EXISTS (SELECT 1 FROM activities a WHERE a.id = activity_id))
  WITH CHECK (current_role_name() IN ('owner', 'admin')
         AND EXISTS (SELECT 1 FROM activities a WHERE a.id = activity_id));

ALTER TABLE activity_pay_time ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_pay_time FORCE ROW LEVEL SECURITY;
CREATE POLICY p_apt ON activity_pay_time
  USING (current_role_name() IN ('owner', 'admin')
         AND EXISTS (SELECT 1 FROM activities a WHERE a.id = activity_id))
  WITH CHECK (current_role_name() IN ('owner', 'admin')
         AND EXISTS (SELECT 1 FROM activities a WHERE a.id = activity_id));

ALTER TABLE activity_pay_work_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_pay_work_unit FORCE ROW LEVEL SECURITY;
CREATE POLICY p_apwu ON activity_pay_work_unit
  USING (current_role_name() IN ('owner', 'admin')
         AND EXISTS (SELECT 1 FROM activities a WHERE a.id = activity_id))
  WITH CHECK (current_role_name() IN ('owner', 'admin')
         AND EXISTS (SELECT 1 FROM activities a WHERE a.id = activity_id));

-- Everything else with a farm_id gets the plain tenant policy, generated in a
-- loop. With twenty-odd tables this cannot be kept by hand, and a table added
-- next month is covered the day it is created.
DO $rls$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'farm_id' AND a.attnum > 0
     WHERE c.relkind = 'r'
       AND c.relnamespace = 'public'::regnamespace
       AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_tenant ON %I USING (farm_id = current_farm()) '
                   'WITH CHECK (farm_id = current_farm())', t);
  END LOOP;
END $rls$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DO $rls$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname AS tbl, p.polname AS pol
             FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
            WHERE c.relnamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('DROP POLICY %I ON %I', r.pol, r.tbl);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', r.tbl);
  END LOOP;
END $rls$;
-- +goose StatementEnd
