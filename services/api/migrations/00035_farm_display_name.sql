-- +goose Up
-- +goose StatementBegin

-- The front door of a farm's own address ({slug}.bascula.engp.io) greets the
-- visitor with the farm's name — "San José", not its DNS label "san-jose".
-- Nobody is signed in there yet, and p_farms hides every farm from a caller
-- with no tenant, so like farm_by_slug (00029) this is a SECURITY DEFINER
-- function that answers exactly one thing: the display name. The name is
-- already on that page for anybody who opens the address.
CREATE FUNCTION farm_display_name(p_slug text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT name FROM farms WHERE slug = lower(p_slug)
$$;

REVOKE ALL ON FUNCTION farm_display_name(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION farm_display_name(text) TO bascula_app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS farm_display_name(text);
-- +goose StatementEnd
