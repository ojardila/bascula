-- +goose Up
-- +goose StatementBegin

-- The indexes the reports need, and only those.
--
-- apps/mobile/src/schema.ts carries the same note under PICKUP_INDEXES_SQL:
-- `pickups` had no index of any kind on the one table that grows for ever, and
-- the review rules paid for it. `work_records` is that table here, and the
-- reports are the first thing that reads a whole season of it at once.
--
-- What is already there and is NOT duplicated below:
--   ix_work_records_emp_day  (farm_id, employee_id, local_day DESC)
--   ix_work_records_week     (farm_id, week_start)
--   ix_work_records_activity (farm_id, activity_id, local_day)
--   ix_wrpc_crop             (farm_id, plot_crop_id) on work_record_plot_crops

-- Every windowed report scan — the performance index, four of the five review
-- rules, the weekly list — filters on the farm's own calendar day and nothing
-- else. The employee-first index above cannot serve that: local_day is its
-- second column. This is the leading-column version.
--
-- One difference from the phone worth writing down, because it is the reason
-- this index works at all: SQLite had to filter on `date(pk.date,'localtime')`,
-- a call on the column, which no index can serve — which is why every mobile
-- rule carries a second, redundant bound on the raw instant just to become
-- sargable. Postgres stores `local_day` as a column, written by a trigger in
-- the farm's own timezone, so the correct predicate IS the indexable one and
-- the double bound disappears.
CREATE INDEX ix_work_records_day ON work_records (farm_id, local_day)
  WHERE deleted_at IS NULL;

-- The duplicate rule: same person, same load, minutes apart. This is the
-- Postgres twin of ix_pickups_dup, and it exists for exactly the same reason —
-- without it the rule is a self-join that scans the season once per candidate
-- row, which on the phone made that one rule cost more than the other four
-- together and grow faster than linearly.
--
-- created_at, not id, is the last column. On the phone the tie-break was an
-- AUTOINCREMENT integer, so `b.id < a.id` was chronological; here ids are
-- random UUIDs and that comparison would pick an arbitrary member of each
-- pair. See the note on duplicateRuleSQL in internal/store/reports.go.
CREATE INDEX ix_work_records_dup
  ON work_records (farm_id, employee_id, quantity, created_at)
  WHERE deleted_at IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS ix_work_records_dup;
DROP INDEX IF EXISTS ix_work_records_day;
-- +goose StatementEnd
