-- +goose Up
-- +goose StatementBegin

-- A farm's slug is public: it is the first label of its web address. Two
-- callers need to ask about one without a token and without a membership:
--
--   * the signup form, to say "that address is taken" while the owner types;
--   * the provisioning watcher, which copies a new farm into the dedicated
--     stack that was launched for it and needs the farm and owner ids to do so.
--
-- p_farms hides every farm from a caller with no tenant, so the lookup is a
-- SECURITY DEFINER function that answers ids only. Nothing a stranger could
-- not already learn from DNS comes out of it.
CREATE FUNCTION farm_by_slug(p_slug text)
RETURNS TABLE (farm_id uuid, owner_id uuid, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT f.id,
         (SELECT m.user_id FROM memberships m
           WHERE m.farm_id = f.id AND m.role = 'owner'
           ORDER BY m.user_id LIMIT 1),
         f.created_at
    FROM farms f
   WHERE f.slug = lower(p_slug)
$$;

REVOKE ALL ON FUNCTION farm_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION farm_by_slug(text) TO bascula_app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS farm_by_slug(text);
-- +goose StatementEnd
