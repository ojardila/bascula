-- +goose Up
-- +goose StatementBegin

-- With mail configured, signup no longer marks the address verified: the
-- owner confirms it from a mailed link, and only then is the farm's own stack
-- built. The waiting screen (public, opened with the provision ticket) has to
-- say "confirme su correo" instead of showing progress that is not coming.
-- Like farm_display_name (00035), a SECURITY DEFINER function that answers
-- exactly one yes/no about one farm, because p_farms and p_memberships hide
-- everything from a caller with no tenant.
CREATE FUNCTION farm_awaiting_owner_email(p_slug text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(bool_and(u.email_verified_at IS NULL), false)
    FROM farms f
    JOIN memberships m ON m.farm_id = f.id AND m.role = 'owner'
    JOIN users u ON u.id = m.user_id
   WHERE f.slug = lower(p_slug)
$$;

REVOKE ALL ON FUNCTION farm_awaiting_owner_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION farm_awaiting_owner_email(text) TO bascula_app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS farm_awaiting_owner_email(text);
-- +goose StatementEnd
