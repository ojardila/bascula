-- +goose Up
-- +goose StatementBegin

-- The cross-tenant registry is a different product with its own legal risk, so
-- it gets its own schema, its own credentials, and no access to the farm
-- tables. It is created empty on purpose: this sprint builds nothing inside it
-- (decision 1 in docs/decisiones.md).
--
-- When it is built, it will hold exactly two things and nothing else:
--   * employment_spans — presence, by month, opt-in per farm. No free text, no
--     flag, no score: there is nowhere here to write a judgement about a
--     person, and that is the defence. A schema is harder to bypass than a
--     policy document.
--   * lookups — append-only, who asked and why, readable BY THE WORKER. If
--     that screen is not built, the registry does not get switched on.
--
-- What never crosses into this schema: employees, employee_notes, ledger,
-- work_records, balances, debts, advances, kilos, productivity, phone, address,
-- photo, or the names of the farms. Not even for the super-admin.
CREATE SCHEMA registry;

-- The API role cannot touch the registry's tables directly. When the service
-- exists it will expose SECURITY DEFINER functions, so that a lookup cannot
-- happen without the lookup being logged.
REVOKE ALL ON SCHEMA registry FROM PUBLIC;
REVOKE ALL ON SCHEMA registry FROM bascula_app;
GRANT USAGE ON SCHEMA registry TO bascula_app;

COMMENT ON SCHEMA registry IS
  'Cross-tenant worker registry. Employment spans and the lookup log only. '
  'No notes, no alerts, no judgements: see docs/decisiones.md decision 1.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP SCHEMA IF EXISTS registry CASCADE;
-- +goose StatementEnd
