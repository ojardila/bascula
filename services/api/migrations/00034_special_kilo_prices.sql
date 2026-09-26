-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- Special kilo prices per lote and per person (phase 2 of the approved
-- onboarding design, 2026-09).
--
-- An exception is a FIXED price, effective from a Monday, exactly like the
-- farm base price in farm_prices (migration 00030). A row with a NULL price
-- ends the exception from that Monday on ("desde este lunes, sin precio
-- especial"), so history is never rewritten to stop one.
--
-- The kilo price of one weighing is resolved by kilo_price() below, first
-- match wins:
--   persona  employee_prices, latest valid_from <= the week
--   lote     plot_prices of the weighing's lote(s); when a weighing names
--            several lotes the lote price applies only if they all agree
--   semana   week_prices override for that Monday
--   finca    farm_prices history, then farm_config
-- (phase 3 puts a single corrected record above all of these.)
--
-- Settled lines are never touched: settlement_items froze their price when
-- they were settled, so a new special price only moves unsettled work.
-- ---------------------------------------------------------------------------
CREATE TABLE plot_prices (
  farm_id     uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  plot_id     uuid NOT NULL,
  valid_from  date NOT NULL CHECK (EXTRACT(ISODOW FROM valid_from) = 1),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (farm_id, plot_id, valid_from),
  FOREIGN KEY (farm_id, plot_id) REFERENCES plots(farm_id, id) ON DELETE CASCADE
);

CREATE TABLE employee_prices (
  farm_id     uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  valid_from  date NOT NULL CHECK (EXTRACT(ISODOW FROM valid_from) = 1),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (farm_id, employee_id, valid_from),
  FOREIGN KEY (farm_id, employee_id) REFERENCES employees(farm_id, id) ON DELETE CASCADE
);

ALTER TABLE plot_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE plot_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY p_plot_prices_read ON plot_prices FOR SELECT
  USING (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'));
CREATE POLICY p_plot_prices_write ON plot_prices FOR ALL
  USING (farm_id = current_farm() AND current_role_name() = 'owner')
  WITH CHECK (farm_id = current_farm() AND current_role_name() = 'owner');

ALTER TABLE employee_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY p_employee_prices_read ON employee_prices FOR SELECT
  USING (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'));
CREATE POLICY p_employee_prices_write ON employee_prices FOR ALL
  USING (farm_id = current_farm() AND current_role_name() = 'owner')
  WITH CHECK (farm_id = current_farm() AND current_role_name() = 'owner');

COMMENT ON TABLE plot_prices IS
  'Fixed kilo price for one lote, effective from a Monday; NULL price ends it. '
  'Money: owner and administrator read, owner writes. See migration 00034.';
COMMENT ON TABLE employee_prices IS
  'Fixed kilo price for one person, effective from a Monday; NULL price ends it. '
  'Money: owner and administrator read, owner writes. See migration 00034.';

-- The one definition of "what a kilo of this weighing is worth", and where
-- that number came from. SECURITY INVOKER (the default): a role that cannot
-- read a money table simply gets the next rule down, as with week_prices.
CREATE FUNCTION kilo_price(p_farm uuid, p_employee uuid, p_record uuid, p_week date)
RETURNS TABLE (price_minor bigint, source text)
LANGUAGE sql STABLE AS $fn$
  SELECT v.price_minor, v.source
    FROM (VALUES
      (1, (SELECT ep.price_minor FROM employee_prices ep
            WHERE ep.farm_id = p_farm AND ep.employee_id = p_employee AND ep.valid_from <= p_week
            ORDER BY ep.valid_from DESC LIMIT 1), 'persona'),
      (2, (SELECT CASE WHEN count(*) > 0 AND count(x.price) = count(*) AND count(DISTINCT x.price) = 1
                       THEN max(x.price) END
             FROM (SELECT (SELECT pp.price_minor FROM plot_prices pp
                            WHERE pp.farm_id = w.farm_id AND pp.plot_id = w.plot_id AND pp.valid_from <= p_week
                            ORDER BY pp.valid_from DESC LIMIT 1) AS price
                     FROM work_record_plots w
                    WHERE w.farm_id = p_farm AND w.work_record_id = p_record) x), 'lote'),
      (3, (SELECT wp.price_minor FROM week_prices wp
            WHERE wp.farm_id = p_farm AND wp.week_start = p_week), 'semana'),
      (4, (SELECT fp.price_minor FROM farm_prices fp
            WHERE fp.farm_id = p_farm AND fp.valid_from <= p_week
            ORDER BY fp.valid_from DESC LIMIT 1), 'finca'),
      (5, (SELECT fc.price_minor FROM farm_config fc WHERE fc.farm_id = p_farm), 'finca')
    ) AS v(rank, price_minor, source)
   WHERE v.price_minor IS NOT NULL
   ORDER BY v.rank
   LIMIT 1
$fn$;

COMMENT ON FUNCTION kilo_price(uuid, uuid, uuid, date) IS
  'Kilo price of one weighing and its source: persona > lote > semana > finca. See migration 00034.';

-- The two special rules alone (persona, then lote), or NULL: the part of
-- kilo_price() that the reports add in front of their own week/farm price.
-- PL/pgSQL on purpose. A SQL function would be inlined into the report query,
-- and the planner then prices its correlated subqueries once per weighing:
-- over a season that estimate crosses jit_above_cost and every report pays
-- for compiling JIT code it never needed (seen as 130ms -> 800ms on /weeks).
CREATE FUNCTION special_kilo_price(p_farm uuid, p_employee uuid, p_record uuid, p_week date)
RETURNS bigint
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  v bigint;
BEGIN
  SELECT ep.price_minor INTO v FROM employee_prices ep
   WHERE ep.farm_id = p_farm AND ep.employee_id = p_employee AND ep.valid_from <= p_week
   ORDER BY ep.valid_from DESC LIMIT 1;
  IF v IS NOT NULL THEN
    RETURN v;
  END IF;
  SELECT CASE WHEN count(*) > 0 AND count(x.price) = count(*) AND count(DISTINCT x.price) = 1
              THEN max(x.price) END INTO v
    FROM (SELECT (SELECT pp.price_minor FROM plot_prices pp
                   WHERE pp.farm_id = w.farm_id AND pp.plot_id = w.plot_id AND pp.valid_from <= p_week
                   ORDER BY pp.valid_from DESC LIMIT 1) AS price
            FROM work_record_plots w
           WHERE w.farm_id = p_farm AND w.work_record_id = p_record) x;
  RETURN v;
END
$fn$;

COMMENT ON FUNCTION special_kilo_price(uuid, uuid, uuid, date) IS
  'Persona or lote kilo price of one weighing, NULL when neither applies. See migration 00034.';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS special_kilo_price(uuid, uuid, uuid, date);
DROP FUNCTION IF EXISTS kilo_price(uuid, uuid, uuid, date);
DROP TABLE IF EXISTS employee_prices;
DROP TABLE IF EXISTS plot_prices;
-- +goose StatementEnd
