/**
 * The geometry the map screen needs, and nothing else.
 *
 * WHY THIS EXISTS AT ALL, when PostGIS is right there
 *
 * The server is the authority on a polygon: `ST_IsValid` decides whether it
 * can be stored and `ST_Area` decides how many hectares it is. Nothing here
 * overrides either. What this file buys is the half-second between a person
 * dragging a corner and a round trip: while somebody is drawing, the area has
 * to move under their hand, and a ring that crosses itself has to be said so
 * *before* the save, in the place where the mistake is, rather than coming
 * back as a 400 with an English reason attached.
 *
 * So every number here is a PREVIEW and is labelled as one in the interface.
 * The moment the server answers, its `computedAreaHa` replaces ours. Two
 * measurements of the same shape that differ in the third decimal are exactly
 * the kind of thing that makes an owner stop trusting both.
 *
 * HOW CLOSE IS THE PREVIEW
 *
 * Close enough that the two figures do not visibly disagree. `ringAreaM2` is
 * the spherical-excess sum applied on the AUTHALIC SPHERE — every latitude is
 * first mapped through the authalic latitude, which is the standard way of
 * measuring an ellipsoidal area on a sphere and is what `geography`'s
 * `ST_Area` is doing underneath.
 *
 * This was checked against the running server rather than assumed. The
 * 0,01° × 0,01° square at 5,66 N that `openapi.yaml` uses as its example comes
 * back from PostGIS as 122,506 ha; this file computes 122,5055 ha. The naive
 * version of the same sum — geodetic latitudes on a sphere of the authalic
 * radius, which is what most quick implementations do — gives 123,04 ha, and
 * a preview that jumps by half a hectare the moment you press Guardar is
 * exactly the kind of thing that makes an owner distrust both numbers on a
 * screen whose entire subject is two numbers disagreeing.
 *
 * CONVENTIONS
 *
 * A position is `[lon, lat]` in that order, in degrees, WGS 84. That is
 * GeoJSON's order and it is the opposite of how people say it out loud, which
 * is why every function that takes a bare pair is named for it and every
 * screen label says "latitud" and "longitud" in words.
 *
 * Rings arrive from the server CLOSED (first position repeated last) and are
 * held in the editor OPEN, because a vertex the user can drag twice is a bug
 * waiting to happen. `closeRing`/`openRing` are the only two places that know.
 */

export type Position = [number, number];
export type LinearRing = Position[];

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: LinearRing[];
}

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: LinearRing[][];
}

export type Geometry = PolygonGeometry | MultiPolygonGeometry;

/** WGS 84, which is what "GeoJSON coordinates" means on this wire. */
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const E2 = WGS84_F * (2 - WGS84_F);
const E = Math.sqrt(E2);

/** `q(φ)` of Snyder: the ellipsoid's authalic-latitude numerator. */
function authalicQ(phiRad: number): number {
  const s = Math.sin(phiRad);
  return (
    (1 - E2) *
    (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)))
  );
}

const Q_POLE = authalicQ(Math.PI / 2);

/** The radius of the sphere with the same surface as WGS 84: 6 371 007,2 m. */
export const EARTH_RADIUS_M = WGS84_A * Math.sqrt(Q_POLE / 2);

/** Geodetic latitude to authalic latitude, both in radians. */
function authalicLatitude(phiRad: number): number {
  return Math.asin(Math.max(-1, Math.min(1, authalicQ(phiRad) / Q_POLE)));
}

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function isPosition(u: unknown): u is Position {
  return (
    Array.isArray(u) &&
    u.length >= 2 &&
    typeof u[0] === "number" &&
    typeof u[1] === "number" &&
    Number.isFinite(u[0]) &&
    Number.isFinite(u[1])
  );
}

function isRing(u: unknown): u is LinearRing {
  return Array.isArray(u) && u.length > 0 && u.every(isPosition);
}

/**
 * `Plot.boundary` is `unknown` on purpose: it is whatever the server put on
 * the wire, and a screen that trusts it blindly renders `undefined` into an
 * SVG path and shows an empty box with no explanation. Everything that draws
 * goes through here first.
 */
export function asGeometry(u: unknown): Geometry | null {
  if (!u || typeof u !== "object") return null;
  const g = u as { type?: unknown; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates) && g.coordinates.every(isRing)) {
    return { type: "Polygon", coordinates: g.coordinates as LinearRing[] };
  }
  if (
    g.type === "MultiPolygon" &&
    Array.isArray(g.coordinates) &&
    g.coordinates.every((p) => Array.isArray(p) && p.every(isRing))
  ) {
    return { type: "MultiPolygon", coordinates: g.coordinates as LinearRing[][] };
  }
  return null;
}

/** Every polygon in a geometry, as a list of rings (outer first, then holes). */
export function polygonsOf(g: Geometry): LinearRing[][] {
  return g.type === "Polygon" ? [g.coordinates] : g.coordinates;
}

/** The outer ring of every polygon. Holes are counted in areas, not drawn. */
export function outerRings(g: Geometry): LinearRing[] {
  return polygonsOf(g)
    .map((p) => p[0])
    .filter((r): r is LinearRing => Array.isArray(r) && r.length > 0);
}

/* ------------------------------------------------------------------ */
/* Rings, open and closed                                              */
/* ------------------------------------------------------------------ */

const samePoint = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];

/** Drops the repeated last position, if there is one. */
export function openRing(ring: LinearRing): LinearRing {
  if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) return ring.slice(0, -1);
  return ring.slice();
}

/** Repeats the first position at the end, which is what GeoJSON requires. */
export function closeRing(ring: LinearRing): LinearRing {
  if (ring.length === 0) return [];
  if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) return ring.slice();
  return [...ring, ring[0]];
}

/**
 * An open ring of at least three vertices, as a GeoJSON Polygon.
 *
 * The server promotes a Polygon to a MultiPolygon on the way into the column
 * (`ST_Multi`), so a plot in two pieces round-trips as a MultiPolygon and this
 * editor reads it back. It only ever WRITES a single Polygon: a drawing tool
 * that can produce disjoint pieces by accident is a drawing tool nobody can
 * check.
 */
export function polygonFromRing(ring: LinearRing): PolygonGeometry {
  return { type: "Polygon", coordinates: [closeRing(ring)] };
}

/* ------------------------------------------------------------------ */
/* Area                                                                */
/* ------------------------------------------------------------------ */

/**
 * Area of one ring, in square metres, always positive.
 *
 *   A = R² / 2 · Σ (λ_{i+1} − λ_i) · (2 + sin β_i + sin β_{i+1})
 *
 * The spherical-excess sum every mapping library uses, with one difference
 * that is worth the eight extra lines: β is the AUTHALIC latitude, not the
 * geodetic one, and R is the authalic radius. That pair is what turns a
 * spherical formula into an ellipsoidal measurement, and it is what closes the
 * half-percent gap against PostGIS at these latitudes.
 *
 * Sign carries the winding, which nothing here needs, so it is dropped.
 */
export function ringAreaM2(ring: LinearRing): number {
  const r = closeRing(ring);
  if (r.length < 4) return 0;
  let sum = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const [lon1, lat1] = r[i];
    const [lon2, lat2] = r[i + 1];
    sum +=
      (lon2 - lon1) *
      DEG *
      (2 + Math.sin(authalicLatitude(lat1 * DEG)) + Math.sin(authalicLatitude(lat2 * DEG)));
  }
  return Math.abs((sum * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** Hectares of a whole geometry: outer rings less their holes. */
export function areaHaOf(g: Geometry): number {
  let m2 = 0;
  for (const poly of polygonsOf(g)) {
    poly.forEach((ring, i) => {
      m2 += i === 0 ? ringAreaM2(ring) : -ringAreaM2(ring);
    });
  }
  return Math.max(0, m2) / 10_000;
}

/** Hectares of one open ring, which is what the editor holds while drawing. */
export const areaHaOfRing = (ring: LinearRing): number => ringAreaM2(ring) / 10_000;

/**
 * The perimeter in metres, so the panel can say "1.240 m de linde".
 *
 * A farmer measures a fence in metres of wire, and it is the one figure on the
 * screen they can check against something they already own.
 */
export function perimeterM(ring: LinearRing): number {
  const r = closeRing(ring);
  let total = 0;
  for (let i = 0; i < r.length - 1; i++) total += distanceM(r[i], r[i + 1]);
  return total;
}

/** Great-circle distance between two positions, in metres. */
export function distanceM(a: Position, b: Position): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const lat1 = a[1] * DEG;
  const lat2 = b[1] * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* ------------------------------------------------------------------ */
/* Validity                                                            */
/* ------------------------------------------------------------------ */

/** Do segments p1→p2 and p3→p4 cross, endpoints excluded? */
function segmentsCross(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
  const d = (a: Position, b: Position, c: Position) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  // Collinear touching counts as crossing only when the touch is not a shared
  // endpoint; the caller has already excluded adjacent segments.
  const onSegment = (a: Position, b: Position, p: Position) =>
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1]);
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

/**
 * The two edges that cross, as indices into the OPEN ring, or null.
 *
 * Returning *which* two is the whole point: the editor paints them red, so the
 * person is looking at the mistake rather than reading about it. This is
 * `ST_IsValid`'s "Self-intersection" case, which is the one a hand-drawn
 * boundary actually produces — a bow tie made by dropping a corner on the
 * wrong side of the plot.
 */
export function selfIntersection(ring: LinearRing): [number, number] | null {
  const r = openRing(ring);
  const n = r.length;
  if (n < 4) return null;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Adjacent edges share a vertex by construction, and the last edge is
      // adjacent to the first.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(r[i], r[(i + 1) % n], r[j], r[(j + 1) % n])) return [i, j];
    }
  }
  return null;
}

export type RingProblem =
  | { kind: "tooFewVertices"; message: string }
  | { kind: "selfIntersects"; message: string; edges: [number, number] }
  | { kind: "noArea"; message: string };

/**
 * Everything the server would refuse, said in Spanish and said early.
 *
 * The wording is the wording of `INVALID_GEOMETRY`, translated: the server's
 * `message` carries `ST_IsValidReason`, which is English and reads like
 * "Self-intersection[-75.88 5.66]". Showing that to an owner is showing them
 * our database.
 */
export function ringProblem(ring: LinearRing): RingProblem | null {
  const r = openRing(ring);
  if (r.length < 3) {
    return {
      kind: "tooFewVertices",
      message: "Un lote necesita al menos tres esquinas. Marque una más.",
    };
  }
  const cross = selfIntersection(r);
  if (cross) {
    return {
      kind: "selfIntersects",
      message:
        "El contorno se cruza a sí mismo: dos lados se pisan y el terreno queda en forma de lazo. Mueva la esquina marcada en rojo.",
      edges: cross,
    };
  }
  if (ringAreaM2(r) < 1) {
    return {
      kind: "noArea",
      message:
        "Las esquinas están en línea recta, así que el contorno no encierra terreno. Separe alguna esquina.",
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Extents and hit-testing                                             */
/* ------------------------------------------------------------------ */

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export function bboxOfPositions(positions: Position[]): Bbox | null {
  if (positions.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of positions) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

export function bboxOf(g: Geometry): Bbox | null {
  return bboxOfPositions(outerRings(g).flat());
}

export const bboxCenter = (b: Bbox): Position => [
  (b.minLon + b.maxLon) / 2,
  (b.minLat + b.maxLat) / 2,
];

/** Metres per degree of latitude. Constant enough at any farm's scale. */
export const M_PER_DEG_LAT = (Math.PI * EARTH_RADIUS_M) / 180;

/** Metres per degree of longitude at a latitude. Shrinks towards the poles. */
export const mPerDegLon = (lat: number): number => M_PER_DEG_LAT * Math.cos(lat * DEG);

/** True when the position is inside the ring. Even-odd, on the flat. */
export function pointInRing(p: Position, ring: LinearRing): boolean {
  const r = openRing(ring);
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    const straddles = yi > p[1] !== yj > p[1];
    if (straddles && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Do two rings share any ground? `ST_Intersects`, roughly.
 *
 * Only the mock needs this — the real server asks PostGIS. It is here rather
 * than in `mocks/` because a mock that cannot answer "do these two lots
 * overlap" would leave the overlap warning untested until production.
 */
export function ringsIntersect(a: LinearRing, b: LinearRing): boolean {
  const ra = openRing(a);
  const rb = openRing(b);
  if (ra.length < 3 || rb.length < 3) return false;
  for (let i = 0; i < ra.length; i++) {
    for (let j = 0; j < rb.length; j++) {
      if (segmentsCross(ra[i], ra[(i + 1) % ra.length], rb[j], rb[(j + 1) % rb.length])) {
        return true;
      }
    }
  }
  // One entirely inside the other crosses nothing.
  return pointInRing(ra[0], rb) || pointInRing(rb[0], ra);
}

export function geometriesIntersect(a: Geometry, b: Geometry): boolean {
  for (const ra of outerRings(a)) {
    for (const rb of outerRings(b)) {
      if (ringsIntersect(ra, rb)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Saying a coordinate out loud                                        */
/* ------------------------------------------------------------------ */

/**
 * "5,66412 N · 75,88010 O" — the hemisphere in words, five decimals.
 *
 * Five decimals is about a metre, which is the resolution of a phone's GPS on
 * a good day and finer than anybody can point at a hillside. Signed decimals
 * ("-75.8801") are what the wire carries and are a needless way to get a lot
 * put in the wrong hemisphere by a typo.
 */
export function formatLatLon(p: Position): string {
  const [lon, lat] = p;
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "O";
  const n = (v: number) => Math.abs(v).toFixed(5).replace(".", ",");
  return `${n(lat)} ${ns} · ${n(lon)} ${ew}`;
}

/** Reads "5,664" or "5.664" or "-75,88". Null when it is not a number. */
export function parseDegrees(raw: string): number | null {
  const cleaned = raw.trim().replace(",", ".");
  if (!cleaned || !/^[+-]?\d*\.?\d*$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Metres, grouped the Colombian way, with no decimals below a kilometre. */
export function formatMetres(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2).replace(".", ",")} km`;
  return `${Math.round(m).toLocaleString("es-CO")} m`;
}

/* ------------------------------------------------------------------ */
/* The view: degrees to pixels and back                                */
/* ------------------------------------------------------------------ */

/**
 * WHY A HAND-ROLLED PROJECTION AND NOT A MAP LIBRARY
 *
 * There are no tiles (see `PlotBoundaryEditor` for that argument), and without
 * tiles a map library is a Web Mercator implementation, a tile cache and a
 * gesture handler, of which we need the third. Web Mercator would also be the
 * wrong projection for the one number this screen exists to produce: it is
 * conformal, so it preserves shape and inflates area by 1/cos²φ, and a coffee
 * lot at 5°N would come out 0.8% large before anybody drew anything.
 *
 * So the canvas is a local equirectangular plane in METRES, centred on the
 * lot: east-west degrees are scaled by cos(latitude) and everything else is
 * linear. Over the two or three kilometres a farm spans, the distortion is
 * below a part in ten thousand — smaller than the width of the line the
 * polygon is drawn with.
 */
export interface MapView {
  /** Where the middle of the canvas is. */
  center: Position;
  /** Metres of ground per pixel of screen. Smaller is closer in. */
  mPerPx: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export function project(p: Position, view: MapView, vp: Viewport): [number, number] {
  const [lon, lat] = p;
  const dxM = (lon - view.center[0]) * mPerDegLon(view.center[1]);
  const dyM = (lat - view.center[1]) * M_PER_DEG_LAT;
  return [vp.width / 2 + dxM / view.mPerPx, vp.height / 2 - dyM / view.mPerPx];
}

export function unproject(x: number, y: number, view: MapView, vp: Viewport): Position {
  const dxM = (x - vp.width / 2) * view.mPerPx;
  const dyM = (vp.height / 2 - y) * view.mPerPx;
  return [
    view.center[0] + dxM / mPerDegLon(view.center[1]),
    view.center[1] + dyM / M_PER_DEG_LAT,
  ];
}

/** The view that puts a bounding box on screen with a margin around it. */
export function fitView(b: Bbox, vp: Viewport, marginPx = 40): MapView {
  const center = bboxCenter(b);
  const widthM = Math.max(1, (b.maxLon - b.minLon) * mPerDegLon(center[1]));
  const heightM = Math.max(1, (b.maxLat - b.minLat) * M_PER_DEG_LAT);
  const usableW = Math.max(1, vp.width - 2 * marginPx);
  const usableH = Math.max(1, vp.height - 2 * marginPx);
  return { center, mPerPx: Math.max(widthM / usableW, heightM / usableH, 0.02) };
}

const NICE_METRES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000];

/**
 * A round number of metres whose pixel width lands near `targetPx`.
 *
 * Used for both the scale bar and the grid. A grid whose squares are "37,4 m"
 * tells nobody anything; one whose squares are 50 m is a unit a person can
 * count in.
 */
export function niceDistance(mPerPx: number, targetPx: number): number {
  const wanted = mPerPx * targetPx;
  for (const candidate of NICE_METRES) if (candidate >= wanted) return candidate;
  return NICE_METRES[NICE_METRES.length - 1];
}
