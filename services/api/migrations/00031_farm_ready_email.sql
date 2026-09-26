-- +goose Up
-- +goose StatementBegin

-- "Avísenme por correo cuando esté lista": the owner who does not want to
-- watch the waiting screen asks for one email when the farm's own address is
-- ready. The request and the fact that it was sent live on the farm record.
--
--   ready_email_requested_at  when the owner asked; NULL means they did not.
--   ready_email_sent_at       when the email went out. Set BEFORE sending (a
--                             claim) and cleared again if the send failed, so
--                             two watchers never send it twice.
ALTER TABLE farms
  ADD COLUMN ready_email_requested_at timestamptz,
  ADD COLUMN ready_email_sent_at      timestamptz;

-- The waiting screen has no session (the person just registered), and
-- p_farms hides every farm from a caller with no tenant. So, like
-- farm_by_slug in 00029, these are SECURITY DEFINER functions that answer only
-- what they must. The owner's address comes out only of the claim, which the
-- server calls once the farm is ready, and it sends to that address alone.

CREATE FUNCTION farm_ready_email_request(p_slug text)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE farms
     SET ready_email_requested_at = coalesce(ready_email_requested_at, now())
   WHERE slug = lower(p_slug)
  RETURNING true
$$;

CREATE FUNCTION farm_ready_email_state(p_slug text)
RETURNS TABLE (requested boolean, sent boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ready_email_requested_at IS NOT NULL, ready_email_sent_at IS NOT NULL
    FROM farms
   WHERE slug = lower(p_slug)
$$;

-- Marks the email as sent and returns where to send it, or no row when it was
-- not requested or already went out.
CREATE FUNCTION farm_ready_email_claim(p_slug text)
RETURNS TABLE (email text, owner_name text, farm_name text)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH claimed AS (
    UPDATE farms
       SET ready_email_sent_at = now()
     WHERE slug = lower(p_slug)
       AND ready_email_requested_at IS NOT NULL
       AND ready_email_sent_at IS NULL
    RETURNING id, name
  )
  SELECT u.email::text, u.name::text, c.name::text
    FROM claimed c
    JOIN LATERAL (
      SELECT m.user_id FROM memberships m
       WHERE m.farm_id = c.id AND m.role = 'owner'
       ORDER BY m.user_id LIMIT 1
    ) o ON true
    JOIN users u ON u.id = o.user_id
$$;

CREATE FUNCTION farm_ready_email_release(p_slug text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE farms SET ready_email_sent_at = NULL WHERE slug = lower(p_slug)
$$;

-- What a restarted process should keep watching: requested, not sent, and
-- recent enough that provisioning could still finish.
CREATE FUNCTION farm_ready_email_pending(p_since timestamptz)
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT slug FROM farms
   WHERE ready_email_requested_at IS NOT NULL
     AND ready_email_sent_at IS NULL
     AND slug IS NOT NULL
     AND created_at >= p_since
$$;

REVOKE ALL ON FUNCTION farm_ready_email_request(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION farm_ready_email_state(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION farm_ready_email_claim(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION farm_ready_email_release(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION farm_ready_email_pending(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION farm_ready_email_request(text) TO bascula_app;
GRANT EXECUTE ON FUNCTION farm_ready_email_state(text) TO bascula_app;
GRANT EXECUTE ON FUNCTION farm_ready_email_claim(text) TO bascula_app;
GRANT EXECUTE ON FUNCTION farm_ready_email_release(text) TO bascula_app;
GRANT EXECUTE ON FUNCTION farm_ready_email_pending(timestamptz) TO bascula_app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS farm_ready_email_pending(timestamptz);
DROP FUNCTION IF EXISTS farm_ready_email_release(text);
DROP FUNCTION IF EXISTS farm_ready_email_claim(text);
DROP FUNCTION IF EXISTS farm_ready_email_state(text);
DROP FUNCTION IF EXISTS farm_ready_email_request(text);
ALTER TABLE farms
  DROP COLUMN IF EXISTS ready_email_sent_at,
  DROP COLUMN IF EXISTS ready_email_requested_at;
-- +goose StatementEnd
