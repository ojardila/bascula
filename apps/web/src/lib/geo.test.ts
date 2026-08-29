import { describe, expect, it } from "vitest";
import {
  areaHaOf, asGeometry, bboxOf, closeRing, distanceM, fitView, formatLatLon,
  geometriesIntersect, niceDistance, openRing, outerRings, parseDegrees, perimeterM,
  polygonFromRing, project, ringAreaM2, ringProblem, selfIntersection, unproject,
  type LinearRing, type Position,
} from "./geo";

/**
 * The one square this whole file is calibrated against.
 *
 * It is the example in `openapi.yaml`'s `GeoJsonGeometry` schema, and the
 * expected hectares are not a number somebody liked the look of: they were
 * read off the running server, which measured it with `ST_Area` on a
 * `geography` column. Every assertion below that mentions 122,506 is anchored
 * to that observation.
 *
 *     PUT /v1/plots/{id}/boundary  ->  computedAreaHa: 122.506
 */
const OPENAPI_SQUARE: LinearRing = [
  [-75.88, 5.66],
  [-75.87, 5.66],
  [-75.87, 5.67],
  [-75.88, 5.67],
  [-75.88, 5.66],
];

/** The bow tie that `ST_IsValid` refuses: "Self-intersection[-75.875 5.665]". */
const BOWTIE: LinearRing = [
  [-75.88, 5.66],
  [-75.87, 5.67],
  [-75.87, 5.66],
  [-75.88, 5.67],
];

describe("measuring what was drawn", () => {
  it("agrees with PostGIS on the square from the API contract", () => {
    // 122,506 ha is what the server answered for this exact ring. Five
    // significant figures is far tighter than anything the screen shows, and
    // that is the point: the live preview must not visibly move when the
    // server's own figure replaces it.
    expect(ringAreaM2(OPENAPI_SQUARE) / 10_000).toBeCloseTo(122.506, 2);
  });

  it("is not the naive spherical sum, which is half a hectare out per hundred", () => {
    // Geodetic latitudes on a sphere of the authalic radius give 123,04 ha for
    // the same ring. If this assertion ever starts failing because the value
    // drifted towards 123, the authalic latitude conversion was dropped.
    expect(ringAreaM2(OPENAPI_SQUARE) / 10_000).toBeLessThan(122.8);
  });

  it("does not care which way round the ring was drawn", () => {
    const backwards = [...OPENAPI_SQUARE].reverse();
    expect(ringAreaM2(backwards)).toBeCloseTo(ringAreaM2(OPENAPI_SQUARE), 3);
  });

  it("measures an open ring and a closed one the same", () => {
    expect(ringAreaM2(openRing(OPENAPI_SQUARE))).toBeCloseTo(ringAreaM2(OPENAPI_SQUARE), 6);
  });

  it("subtracts a hole from the polygon that contains it", () => {
    const hole: LinearRing = [
      [-75.877, 5.663],
      [-75.873, 5.663],
      [-75.873, 5.667],
      [-75.877, 5.667],
      [-75.877, 5.663],
    ];
    const withHole = areaHaOf({ type: "Polygon", coordinates: [OPENAPI_SQUARE, hole] });
    const solid = areaHaOf({ type: "Polygon", coordinates: [OPENAPI_SQUARE] });
    expect(withHole).toBeLessThan(solid);
    expect(solid - withHole).toBeCloseTo(ringAreaM2(hole) / 10_000, 3);
  });

  it("measures the fence in metres", () => {
    // Four sides of about 1,1 km each at this latitude.
    expect(perimeterM(OPENAPI_SQUARE)).toBeCloseTo(4426, -2);
    expect(distanceM([-75.88, 5.66], [-75.87, 5.66])).toBeCloseTo(1107, -1);
  });

  it("gives fewer than three corners no area at all", () => {
    expect(ringAreaM2([[-75.88, 5.66], [-75.87, 5.66]])).toBe(0);
  });
});

describe("refusing what PostGIS would refuse, before the round trip", () => {
  it("names the two sides of a bow tie", () => {
    const cross = selfIntersection(BOWTIE);
    expect(cross).not.toBeNull();
    // Sides 0→1 and 2→3 are the ones that cross.
    expect(cross).toEqual([0, 2]);
  });

  it("calls a bow tie a self-intersection, in Spanish, with the sides", () => {
    const problem = ringProblem(BOWTIE);
    expect(problem?.kind).toBe("selfIntersects");
    expect(problem?.message).toMatch(/se cruza a sí mismo/);
    expect(problem?.message).not.toMatch(/Self-intersection/);
  });

  it("passes a plain square", () => {
    expect(ringProblem(OPENAPI_SQUARE)).toBeNull();
    expect(selfIntersection(OPENAPI_SQUARE)).toBeNull();
  });

  it("asks for a third corner rather than talking about geometry", () => {
    expect(ringProblem([[-75.88, 5.66], [-75.87, 5.66]])?.kind).toBe("tooFewVertices");
  });

  it("catches three corners in a straight line, which enclose nothing", () => {
    const collinear: LinearRing = [
      [-75.88, 5.66],
      [-75.87, 5.66],
      [-75.86, 5.66],
    ];
    expect(ringProblem(collinear)?.kind).toBe("noArea");
  });
});

describe("reading what the server sent", () => {
  it("takes the MultiPolygon the server actually returns", () => {
    // Verified against the live API: the column is a MultiPolygon geography
    // and ST_Multi promotes whatever was sent, so a Polygon written comes back
    // as a MultiPolygon on the next load.
    const g = asGeometry({ type: "MultiPolygon", coordinates: [[OPENAPI_SQUARE]] });
    expect(g?.type).toBe("MultiPolygon");
    expect(outerRings(g!)).toHaveLength(1);
    expect(areaHaOf(g!)).toBeCloseTo(122.506, 2);
  });

  it("refuses everything that is not a polygon, rather than half-drawing it", () => {
    expect(asGeometry(null)).toBeNull();
    expect(asGeometry({ type: "Point", coordinates: [-75.88, 5.66] })).toBeNull();
    expect(asGeometry({ type: "Polygon" })).toBeNull();
    expect(asGeometry({ type: "Polygon", coordinates: [[["a", "b"]]] })).toBeNull();
    expect(asGeometry("{}")).toBeNull();
  });

  it("closes an open ring on the way out and opens a closed one on the way in", () => {
    const open = openRing(OPENAPI_SQUARE);
    expect(open).toHaveLength(4);
    expect(closeRing(open)).toHaveLength(5);
    expect(closeRing(closeRing(open))).toHaveLength(5);
    expect(polygonFromRing(open).coordinates[0]).toHaveLength(5);
  });
});

describe("overlaps, which are a warning and never a refusal", () => {
  const at = (west: number) =>
    polygonFromRing([
      [west, 5.66],
      [west + 0.01, 5.66],
      [west + 0.01, 5.67],
      [west, 5.67],
    ]);

  it("sees two lots drawn on the same ground", () => {
    expect(geometriesIntersect(at(-75.9), at(-75.895))).toBe(true);
  });

  it("leaves two lots that share nothing alone", () => {
    expect(geometriesIntersect(at(-75.9), at(-75.8))).toBe(false);
  });

  it("sees a small lot entirely inside a big one, which crosses no line", () => {
    const big = polygonFromRing([
      [-75.9, 5.6],
      [-75.8, 5.6],
      [-75.8, 5.7],
      [-75.9, 5.7],
    ]);
    expect(geometriesIntersect(big, at(-75.87))).toBe(true);
  });
});

describe("the canvas: degrees in, pixels out", () => {
  const vp = { width: 800, height: 400 };
  const view = { center: [-75.6, 5.0] as Position, mPerPx: 1 };

  it("puts the centre in the middle", () => {
    expect(project(view.center, view, vp)).toEqual([400, 200]);
  });

  it("survives the round trip", () => {
    const back = unproject(613, 77, view, vp);
    const [x, y] = project(back, view, vp);
    expect(x).toBeCloseTo(613, 6);
    expect(y).toBeCloseTo(77, 6);
  });

  it("puts north up, so a bigger latitude is a smaller y", () => {
    const [, yNorth] = project([-75.6, 5.001], view, vp);
    expect(yNorth).toBeLessThan(200);
  });

  it("keeps the scale honest: one metre per pixel means one metre per pixel", () => {
    const [x] = project([-75.6 + 100 / 111_320, 5.0], view, vp);
    // 100 m east of the centre, at a metre per pixel, less the cosine of the
    // latitude — a few pixels of slack for the difference between the
    // ellipsoid and the sphere.
    expect(x - 400).toBeGreaterThan(95);
    expect(x - 400).toBeLessThan(105);
  });

  it("fits a shape into the canvas with room around it", () => {
    const fitted = fitView(bboxOf(polygonFromRing(OPENAPI_SQUARE))!, vp);
    const corners = OPENAPI_SQUARE.map((p) => project(p, fitted, vp));
    for (const [x, y] of corners) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(vp.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(vp.height);
    }
  });

  it("picks a grid a person can count in, never 37,4 m", () => {
    expect([1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000])
      .toContain(niceDistance(0.4, 90));
  });
});

describe("saying a coordinate out loud", () => {
  it("uses hemispheres and commas, not minus signs and dots", () => {
    expect(formatLatLon([-75.8801, 5.66412])).toBe("5,66412 N · 75,88010 O");
    expect(formatLatLon([12.5, -3.25])).toBe("3,25000 S · 12,50000 E");
  });

  it("reads back what a person types, comma or dot", () => {
    expect(parseDegrees("5,664")).toBeCloseTo(5.664);
    expect(parseDegrees("-75.88")).toBeCloseTo(-75.88);
    expect(parseDegrees("")).toBeNull();
    expect(parseDegrees("norte")).toBeNull();
  });
});
