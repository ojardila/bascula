-- +goose Up
--
-- One point per plot, in place of a drawn boundary.
--
-- `boundary` stays exactly as it is, with its data, its index and its route.
-- Nothing is dropped here: a farm that already drew polygons keeps them, and
-- the only change is that the web stops asking a person to draw one.
--
-- The reason it stops asking: the drawing surface has no basemap. It is a grey
-- rectangle -- deliberately, since no tile source is same-origin and none of
-- them work on a farm with no signal -- so an owner was tracing a shape over
-- nothing, from memory, with a finger. What that produced was `computedAreaHa`,
-- whose only consumer displays it next to the `areaHa` the same person had
-- already typed. Nothing computes pay, yield or anything else from the shape.
--
-- A point costs one tap standing in the plot, needs no basemap of our own to be
-- worth having, and answers the question an owner actually asks a map -- where
-- is it, how do I get back -- by handing the coordinates to whatever maps app
-- the phone already has, which does have satellite imagery and directions.
--
-- geography(Point) rather than two float columns so that distance between
-- plots stays a database question, and so a point and a boundary are the same
-- kind of thing to PostGIS.
ALTER TABLE plots
  ADD COLUMN location geography(Point, 4326);

COMMENT ON COLUMN plots.location IS
  'Where the plot is: one point, captured by standing in it. Independent of '
  'boundary, which stays for farms that drew one.';

-- No GiST index. `boundary` has one because ST_Intersects over polygons is run
-- to warn about overlaps; nothing queries plots by location, and an index on a
-- column with at most a few dozen rows per farm would only cost writes.

-- +goose Down
ALTER TABLE plots DROP COLUMN location;
