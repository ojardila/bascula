-- +goose Up
-- +goose StatementBegin

-- A farm's DNS label. One shared database still; the tenant stays farm_id in
-- the JWT and RLS. The slug is how a host like sanjose.bascula.engp.io names
-- the farm at login. It is set at create and not renamed.

ALTER TABLE farms ADD COLUMN slug text;

UPDATE farms AS f
   SET slug = v.slug
  FROM (
    WITH prepared AS (
      SELECT
        id,
        NULLIF(
          trim(both '-' FROM regexp_replace(
            regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'),
            '-+', '-', 'g'
          )),
          ''
        ) AS base
      FROM farms
    ),
    reserved AS (
      SELECT unnest(ARRAY[
        'www', 'api', 'admin', 'mcp', 'app', 'int', 'bascula',
        'static', 'assets', 'health', 'oauth', 'well-known',
        'mail', 'staging', 'prod', 'dev'
      ]) AS slug
    ),
    candidate AS (
      SELECT
        p.id,
        CASE
          WHEN p.base IS NULL
            OR char_length(p.base) < 2
            OR char_length(p.base) > 63
            OR EXISTS (SELECT 1 FROM reserved r WHERE r.slug = p.base)
          THEN CASE
            WHEN p.base IS NULL OR char_length(COALESCE(p.base, '')) < 2
            THEN left(p.id::text, 8)
            ELSE left(trim(both '-' FROM left(p.base, 54)), 54)
                 || '-' || left(p.id::text, 8)
          END
          ELSE p.base
        END AS slug
      FROM prepared p
    ),
    ranked AS (
      SELECT id, slug,
             row_number() OVER (PARTITION BY slug ORDER BY id) AS n
        FROM candidate
    )
    SELECT
      id,
      CASE
        WHEN n = 1 THEN left(slug, 63)
        ELSE left(trim(both '-' FROM left(slug, 54)), 54)
             || '-' || left(id::text, 8)
      END AS slug
    FROM ranked
  ) AS v
 WHERE f.id = v.id;

ALTER TABLE farms
  ALTER COLUMN slug SET NOT NULL,
  ADD CONSTRAINT farms_slug_format
    CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 2 AND 63),
  ADD CONSTRAINT farms_slug_key UNIQUE (slug);

COMMENT ON COLUMN farms.slug IS
  'Stable DNS label for the farm. Set at create; not renamed.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE farms DROP CONSTRAINT IF EXISTS farms_slug_key;
ALTER TABLE farms DROP CONSTRAINT IF EXISTS farms_slug_format;
ALTER TABLE farms DROP COLUMN IF EXISTS slug;
-- +goose StatementEnd
