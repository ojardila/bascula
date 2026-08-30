-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- week_prices is money, and its read policy never said so.
--
-- 00008 wrote it as "Prices: everyone in the farm reads, only the owner
-- writes", next to ledger, settlements and settlement_items, every one of
-- which is `farm_id = current_farm() AND current_role_name() IN ('owner',
-- 'admin')`. The comment above those three is the rule this one broke: "Money
-- is farm-scoped AND role-scoped: the weigher does not see anybody's payroll.
-- Denying it in the middleware is the message; denying it here is the
-- guarantee."
--
-- The price of a kilo is not a shade less sensitive than a settlement — it is
-- the multiplicand of every settlement on the farm. Everything else in the
-- codebase already treats it that way and this one policy did not:
--
--   * ActionPricesRead is {admins, Money} in auth/perm.go, so GET
--     /v1/prices/weeks/{monday} answers 403 to a weigher;
--   * handleGetFarm removes priceCents from his /v1/farm;
--   * composeFarmConfig removes it from his sync body;
--   * SyncEntity.money() lists weekPrice, so the feed consumes the seq of a
--     price change and sends him no row for it, "exactly as for a settlement".
--
-- Four locks on one door, and the door had no lock at all one level down. The
-- SELECT was reachable through store.WeekPrice, which
-- store.priceWorkRecords calls for every unsettled record priced by the week —
-- and every weighing is priced by the week, by construction. So the weigher's
-- own work-record list carried quantity x price, and a weighing of one kilo
-- WAS the price of a kilo. The projection in handlers_work_records.go is what
-- fixes the response; this is what makes the column unreachable, so the next
-- query written against it inherits the rule instead of having to remember it.
--
-- # Nothing legitimate loses a read
--
-- Every other caller of WeekPrice is already administrator-only: the settlement
-- preview and CreateSettlement (ActionSettlements*, all Money), the reports
-- (ActionReportsRead, Money), the season import (ActionImportSeason, owner),
-- and GET /v1/prices/weeks/* itself. The sync pull is the one path a weigher
-- reaches, and it skips weekPrice by role BEFORE composing a body, so it never
-- issues the SELECT at all.
--
-- Under the new policy WeekPrice still succeeds for a weigher: it COALESCEs to
-- farm_config.price_minor, which is farm-scoped only. That fallback is why the
-- policy alone is not the fix and the projection is not decoration — the two
-- close different halves of the same door, which is how every other rule in
-- this schema is written.
--
-- The write policy is untouched. It was already owner-only and correct.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS p_week_prices_read ON week_prices;
CREATE POLICY p_week_prices_read ON week_prices FOR SELECT
  USING (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'));

COMMENT ON TABLE week_prices IS
  'The price of a kilo for one week. Money: readable by the owner and the '
  'administrator only, like the ledger and the settlements. See migration '
  '00020.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP POLICY IF EXISTS p_week_prices_read ON week_prices;
CREATE POLICY p_week_prices_read ON week_prices FOR SELECT
  USING (farm_id = current_farm());
COMMENT ON TABLE week_prices IS NULL;
-- +goose StatementEnd
