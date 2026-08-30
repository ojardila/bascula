-- +goose Up
--
-- A farm can retire a unit it stopped using, and rename one it mistyped.
--
-- Until now `work_units` had one door in and none out: POST created, GET
-- listed, and nothing edited or removed. The owner's words were "no hay forma
-- de borrar o editar" -- and the table has held `code`, `label` and `kg_factor`
-- since migration 00004, so a farm that typed "canata" lived with it.
--
-- Retiring is NOT deleting, and the difference is somebody's pay. `unit_id` is
-- referenced by work_records (00005) and activities (00004). A record that says
-- "40 canastas" means nothing once the canasta is gone -- it would read as 40
-- of something nobody can name, in a row that decided what a picker was owed.
-- So a unit that any history points at can only be archived: it disappears from
-- the pickers, and every record already written still reads correctly.
--
-- A unit nothing points at can be deleted outright. There is nothing to
-- protect, and leaving a farm unable to remove a typo is how catalogues fill
-- with noise nobody dares touch.
ALTER TABLE work_units
  ADD COLUMN archived_at timestamptz;

COMMENT ON COLUMN work_units.archived_at IS
  'When the farm retired this unit. Archived units are hidden from the pickers '
  'and still resolve for every record that already referenced them.';

-- The uniqueness of a code is over LIVE units only. A farm that archived
-- "canasta" and later starts using canastas again must be able to create it,
-- and the old records keep pointing at the old row with its own kg_factor --
-- which is the honest outcome, because a canasta that changed size IS a
-- different unit and its old weights were never the new ones.
DROP INDEX IF EXISTS ux_work_units_code;
CREATE UNIQUE INDEX ux_work_units_code_live
  ON work_units (farm_id, lower(code))
  WHERE archived_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS ux_work_units_code_live;
CREATE UNIQUE INDEX ux_work_units_code ON work_units (farm_id, lower(code));
ALTER TABLE work_units DROP COLUMN archived_at;
