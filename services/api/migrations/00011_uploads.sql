-- +goose Up
-- +goose StatementBegin

-- FILE UPLOADS. RSP-004 wants a photo of the employee, RSP-027 a photo of the
-- sale receipt, both "hasta 5 MB".
--
-- `attachments` has existed since 00003 as a pointer into object storage —
-- never bytes in Postgres. What it lacked was the middle of the story: a row
-- exists from the moment the client asks where to put the file, and it is not
-- attachable to anything until the bytes have actually arrived and been
-- measured. Two states, and the second one is reached by the server counting,
-- not by the client claiming.
--
-- The 5 MB limit is enforced when the bytes land, and that is the whole point.
-- A limit checked only when the URL is handed out is a limit checked on a
-- number the client typed. `bytes` is written from the server's own count of
-- what it wrote to storage, and this CHECK is the last line of it.

ALTER TABLE attachments
  ADD COLUMN status        text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('pending', 'ready')),
  ADD COLUMN purpose       text,
  ADD COLUMN original_name text,
  ADD COLUMN created_by    uuid REFERENCES users(id),
  ADD COLUMN confirmed_at  timestamptz;

-- `bytes` and `mime` were NOT NULL because until now nothing created a row
-- before the file existed. A pending upload knows neither yet: the size is
-- whatever arrives and the type is whatever the server sniffs out of the first
-- bytes, and taking the client's word for either is how a .exe becomes a
-- "photo".
ALTER TABLE attachments ALTER COLUMN bytes DROP NOT NULL;
ALTER TABLE attachments ALTER COLUMN mime  DROP NOT NULL;

ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_bytes_check;
-- Anything already stored got there with its bytes counted, so it is ready and
-- was confirmed when it was created.
UPDATE attachments SET confirmed_at = created_at WHERE confirmed_at IS NULL;
ALTER TABLE attachments
  ADD CONSTRAINT attachments_size CHECK (
    bytes IS NULL OR (bytes > 0 AND bytes <= 5 * 1024 * 1024)),
  -- A ready attachment has been measured. A pending one has not. There is no
  -- third shape, and in particular no "ready, size unknown".
  ADD CONSTRAINT attachments_ready_shape CHECK (
    (status = 'ready') = (bytes IS NOT NULL AND mime IS NOT NULL AND confirmed_at IS NOT NULL));

CREATE INDEX ix_attachments_pending ON attachments (farm_id, created_at)
  WHERE status = 'pending';

-- Only a finished upload can be hung on anything. Without this the sale would
-- happily point at a receipt whose bytes never arrived, and the screen would
-- show a broken image with no way to tell whether the photo was lost or never
-- taken.
CREATE FUNCTION check_attachment_ready() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE ref uuid; st text;
BEGIN
  -- Through jsonb rather than NEW.photo_id / NEW.receipt_id, so one function
  -- serves three tables whose column is spelled two different ways without
  -- plpgsql having to resolve a field the row type does not have.
  ref := COALESCE(to_jsonb(NEW) ->> 'photo_id', to_jsonb(NEW) ->> 'receipt_id')::uuid;
  IF ref IS NULL THEN RETURN NEW; END IF;
  SELECT status INTO st FROM attachments WHERE id = ref;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attachment % is not visible from this farm', ref;
  END IF;
  IF st <> 'ready' THEN
    RAISE EXCEPTION 'attachment % has no bytes yet', ref
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER t_employees_photo_ready BEFORE INSERT OR UPDATE OF photo_id ON employees
  FOR EACH ROW EXECUTE FUNCTION check_attachment_ready();
CREATE TRIGGER t_sales_receipt_ready BEFORE INSERT OR UPDATE OF receipt_id ON sales
  FOR EACH ROW EXECUTE FUNCTION check_attachment_ready();
CREATE TRIGGER t_expenses_receipt_ready BEFORE INSERT OR UPDATE OF receipt_id ON expenses
  FOR EACH ROW EXECUTE FUNCTION check_attachment_ready();

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS t_expenses_receipt_ready ON expenses;
DROP TRIGGER IF EXISTS t_sales_receipt_ready ON sales;
DROP TRIGGER IF EXISTS t_employees_photo_ready ON employees;
DROP FUNCTION IF EXISTS check_attachment_ready();
DROP INDEX IF EXISTS ix_attachments_pending;
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_ready_shape;
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_size;
ALTER TABLE attachments
  DROP COLUMN IF EXISTS confirmed_at,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS original_name,
  DROP COLUMN IF EXISTS purpose,
  DROP COLUMN IF EXISTS status;
-- +goose StatementEnd
