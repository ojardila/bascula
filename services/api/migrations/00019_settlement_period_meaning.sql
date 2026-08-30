-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- The two ends of a settlement's period do not mean the same kind of thing.
--
-- 00006 wrote `CHECK (period_end >= period_start)` and nothing else, which is
-- correct and says almost nothing: it is all that HOLDS between two facts of
-- different kinds, so a reader of the schema was left to assume the obvious
-- symmetry, and the obvious symmetry is wrong.
--
--   period_start is the period actually COVERED — the Monday of the earliest
--   payable taken in. Settling `from = 1970-01-01` means "everything
--   outstanding", and 1970 printed on the receipt would be nonsense, so the
--   start is pulled forward to where the money actually begins.
--
--   period_end is the range that was ASKED for. Nothing pulls it back. `to` is
--   a statement about the period being closed, not about which day inside it
--   happened to have work: a settlement run to the end of August covered to
--   the end of August, and recording it as covering to the 22nd because that
--   is when the last weighing fell would say something the person who approved
--   the figure was never told.
--
-- This matters beyond taste because the column is filled from two sides. The
-- server writes it in store.CreateSettlement; the season import writes it from
-- whatever the handset sends. If the two ever disagreed about what the column
-- means, nothing would fail — no constraint, no test, no screen — and a farm's
-- settlements would simply be describing two different periods under one name.
-- So it is written down here, in openapi.yaml, and on the handset's side.
--
-- Comments and nothing else: no data changes, no constraint changes.
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN settlements.period_start IS
  'The period actually COVERED: the Monday of the earliest payable taken in, '
  'not the window the caller asked over.';

COMMENT ON COLUMN settlements.period_end IS
  'The range that was ASKED for (the request''s `to`), NOT the last day '
  'covered. Deliberately asymmetric with period_start; see openapi.yaml, '
  'schema Settlement.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
COMMENT ON COLUMN settlements.period_start IS NULL;
COMMENT ON COLUMN settlements.period_end IS NULL;
-- +goose StatementEnd
