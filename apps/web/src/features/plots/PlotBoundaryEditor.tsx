/**
 * The map. Drawn, edited and measured, with no tiles.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO BASEMAP, AND WHY THAT IS NOT A DEGRADED VERSION
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This console is published under a policy that refuses requests to hosts
 * other than its own origin. That is not a setting we can talk our way past:
 * it is the same rule that lets the whole app be served next to the API
 * without CORS (see `vite.config.ts`), and it is the reason `index.html` is
 * the only file in this app that names a third-party host at all.
 *
 * Every tiled basemap — OpenStreetMap, Mapbox, Esri, Google — is a `fetch` per
 * 256-pixel square against somebody else's domain. Under that policy each one
 * is refused before it leaves the browser. So a Leaflet or MapLibre map here
 * is not "a map with slower tiles"; it is a grey rectangle with a working
 * gesture handler, plus 140 kB of tile-cache machinery, plus an owner who
 * quite reasonably concludes the screen is broken. We checked the alternatives
 * before writing this: no tile source is same-origin, no offline tile pack
 * ships with the repository, and the API serves no `/tiles` route.
 *
 * What was built instead is a coordinate canvas: a local equirectangular plane
 * in metres, centred on the lot, with a metric grid, a scale bar, the real
 * latitude and longitude of every corner, and the neighbouring lots of the
 * same farm drawn behind for context. Everything a polygon needs to be correct
 * is here — the shape, the size, the position on the Earth — and nothing on
 * the screen is a picture of something we could not load.
 *
 * Three things carry the "where am I" that satellite imagery would have
 * carried, and they were chosen because each one is honest on its own:
 *
 *   1. THE OTHER LOTS OF THE FARM, in grey with their names. For the second
 *      and every later polygon this is better orientation than an aerial
 *      photograph: the boundary that matters is usually the neighbour's.
 *   2. A BACKGROUND IMAGE THE OWNER SUPPLIES — a drone photo, a scan of the
 *      cadastral plan, a screenshot taken somewhere else. It is pinned to the
 *      map extent it was dropped on, it stays in this browser (never uploaded,
 *      never sent to the server), and it can be moved and faded. The file
 *      comes from the person's own disk, so no policy is being dodged.
 *   3. THE DEVICE'S OWN GPS, via `navigator.geolocation`, for an owner
 *      standing in the lot with a laptop or a phone. A browser permission,
 *      not a network host.
 *
 * If a same-origin tile service ever exists, it drops in behind the grid as
 * one more layer and nothing else in this file changes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE CORNER TABLE IS NOT A DEBUG PANEL
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Every corner is also a row with two number fields. That is the only way this
 * screen is usable with a keyboard or a screen reader — an SVG full of drag
 * handles is unreachable otherwise — and it is the only way a person who read
 * coordinates off a GPS unit in the field can enter what they measured instead
 * of approximating it with a mouse. It is also what the tests drive, because a
 * test that fakes pointer geometry in jsdom tests jsdom.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent,
} from "react";
import {
  Alert, Box, Button, Chip, IconButton, Slider, Stack, TextField, ToggleButton,
  ToggleButtonGroup, Tooltip, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import UndoIcon from "@mui/icons-material/Undo";
import CenterFocusStrongIcon from "@mui/icons-material/CenterFocusStrong";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import ImageOutlinedIcon from "@mui/icons-material/ImageOutlined";
import ZoomInIcon from "@mui/icons-material/ZoomIn";
import ZoomOutIcon from "@mui/icons-material/ZoomOut";
import {
  areaHaOfRing, asGeometry, bboxOf, bboxOfPositions, closeRing, fitView, formatLatLon,
  formatMetres, mPerDegLon, M_PER_DEG_LAT, niceDistance, openRing, outerRings,
  parseDegrees, perimeterM, polygonFromRing, project, ringProblem, unproject,
  type Bbox, type Geometry, type LinearRing, type MapView, type PolygonGeometry,
  type Position, type Viewport,
} from "../../lib/geo";
import { formatArea } from "../../lib/money";

/**
 * Manizales, Caldas. Where a lot with no polygon and no neighbours starts.
 *
 * It is a guess and the screen says so: an owner who draws a shape here
 * without moving the centre gets the right shape at the wrong place, and the
 * hectares would be off by the cosine of the latitude they never chose. The
 * "¿dónde queda el lote?" panel is shown open, not hidden behind a menu, until
 * the centre has been set for real.
 */
const DEFAULT_CENTER: Position = [-75.5174, 5.0689];

export interface MapNeighbour {
  id: string;
  name: string;
  boundary: Geometry;
}

export interface PlotBoundaryEditorProps {
  /** Used only to key the locally-stored background image. */
  plotId: string;
  /** What the server holds today. Read once: this editor owns the ring after. */
  initialBoundary?: unknown;
  /** Every edit, as a GeoJSON Polygon, or null once the last corner is gone. */
  onChange?: (geometry: PolygonGeometry | null) => void;
  /** Other lots of the farm, drawn behind in grey. */
  neighbours?: MapNeighbour[];
  /** Lots the server says this one now runs into. A warning, never a refusal. */
  overlaps?: Array<{ id: string; name: string }>;
  height?: number;
  readOnly?: boolean;
  /** Shown next to the live measurement so the two hectare figures line up. */
  declaredAreaHa?: number | null;
}

type Mode = "pan" | "draw" | "vertices";

interface Background {
  dataUrl: string;
  bbox: Bbox;
  opacity: number;
}

const BG_KEY = (plotId: string) => `bascula.plotmap.bg.${plotId}`;
/** A data URL much larger than this will not fit in localStorage anyway. */
const BG_MAX_BYTES = 3_000_000;

function loadBackground(plotId: string): Background | null {
  try {
    const raw = localStorage.getItem(BG_KEY(plotId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Background;
    return parsed?.dataUrl && parsed?.bbox ? parsed : null;
  } catch {
    return null;
  }
}

function saveBackground(plotId: string, bg: Background | null) {
  try {
    if (bg === null) localStorage.removeItem(BG_KEY(plotId));
    else localStorage.setItem(BG_KEY(plotId), JSON.stringify(bg));
  } catch {
    // A full or disabled store is not a reason to lose the drawing. The image
    // simply does not survive the reload, which is the lesser failure.
  }
}

/** The width of the canvas, measured, because an SVG has to be told. */
function useMeasuredWidth(fallback: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") {
      // jsdom, and any browser old enough not to have it: the fallback width
      // keeps the projection arithmetic sane instead of dividing by zero.
      if (el.clientWidth > 0) setWidth(el.clientWidth);
      return;
    }
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function PlotBoundaryEditor({
  plotId,
  initialBoundary,
  onChange,
  neighbours = [],
  overlaps = [],
  height = 420,
  readOnly = false,
  declaredAreaHa = null,
}: PlotBoundaryEditorProps) {
  const initialGeometry = useMemo(() => asGeometry(initialBoundary), [initialBoundary]);

  const [ring, setRing] = useState<LinearRing>(() => {
    const rings = initialGeometry ? outerRings(initialGeometry) : [];
    return rings.length ? openRing(rings[0]) : [];
  });
  const [past, setPast] = useState<LinearRing[]>([]);
  const [mode, setMode] = useState<Mode>(() => (ring.length ? "vertices" : "draw"));
  const [selected, setSelected] = useState<number | null>(null);
  const [background, setBackground] = useState<Background | null>(() => loadBackground(plotId));
  const [geolocating, setGeolocating] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const { ref: boxRef, width } = useMeasuredWidth(720);
  const vp: Viewport = useMemo(() => ({ width, height }), [width, height]);
  const svgRef = useRef<SVGSVGElement | null>(null);

  /**
   * The starting view, in order of how much it is worth: the lot's own shape,
   * then everything the farm already has drawn, then the fallback centre.
   */
  const [view, setView] = useState<MapView>(() => {
    const b =
      (initialGeometry && bboxOf(initialGeometry)) ??
      bboxOfPositions(neighbours.flatMap((n) => outerRings(n.boundary).flat()));
    if (b && (b.maxLon > b.minLon || b.maxLat > b.minLat)) {
      return fitView(b, { width: 720, height });
    }
    return { center: b ? [b.minLon, b.minLat] : DEFAULT_CENTER, mPerPx: 0.35 };
  });

  /** True while the centre is still our guess and not the owner's. */
  const centreIsAGuess =
    ring.length === 0 &&
    neighbours.length === 0 &&
    view.center[0] === DEFAULT_CENTER[0] &&
    view.center[1] === DEFAULT_CENTER[1];

  const notify = useCallback(
    (next: LinearRing) => {
      onChange?.(next.length >= 3 ? polygonFromRing(next) : null);
    },
    [onChange],
  );

  const commit = useCallback(
    (next: LinearRing) => {
      setPast((p) => [...p.slice(-49), ring]);
      setRing(next);
      notify(next);
    },
    [ring, notify],
  );

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const previous = p[p.length - 1];
      setRing(previous);
      notify(previous);
      return p.slice(0, -1);
    });
  }, [notify]);

  /* -- geometry, measured live ------------------------------------- */

  const problem = ring.length >= 1 ? ringProblem(ring) : null;
  const crossing = problem?.kind === "selfIntersects" ? problem.edges : null;
  const liveAreaHa = ring.length >= 3 && !crossing ? areaHaOfRing(ring) : null;
  const livePerimeterM = ring.length >= 3 ? perimeterM(ring) : null;

  /* -- pointer plumbing -------------------------------------------- */

  const toCanvas = useCallback((e: { clientX: number; clientY: number }): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return [0, 0];
    return [e.clientX - rect.left, e.clientY - rect.top];
  }, []);

  const drag = useRef<
    | { kind: "vertex"; index: number }
    | { kind: "pan"; from: [number, number]; center: Position }
    | null
  >(null);

  function onSurfacePointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (readOnly) return;
    const [x, y] = toCanvas(e);
    if (mode === "draw") {
      commit([...ring, unproject(x, y, view, vp)]);
      setSelected(ring.length);
      return;
    }
    drag.current = { kind: "pan", from: [x, y], center: view.center };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onSurfacePointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d) return;
    const [x, y] = toCanvas(e);
    if (d.kind === "pan") {
      const dxM = (x - d.from[0]) * view.mPerPx;
      const dyM = (y - d.from[1]) * view.mPerPx;
      setView((v) => ({
        ...v,
        center: [
          d.center[0] - dxM / mPerDegLon(d.center[1]),
          d.center[1] + dyM / M_PER_DEG_LAT,
        ],
      }));
    } else {
      const p = unproject(x, y, view, vp);
      setRing((current) => {
        const next = current.slice();
        next[d.index] = p;
        return next;
      });
    }
  }

  function endDrag() {
    if (drag.current?.kind === "vertex") notify(ring);
    drag.current = null;
  }

  function startVertexDrag(index: number, e: ReactPointerEvent) {
    if (readOnly || mode === "pan") return;
    e.stopPropagation();
    setSelected(index);
    setPast((p) => [...p.slice(-49), ring]);
    drag.current = { kind: "vertex", index };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function zoomBy(factor: number) {
    setView((v) => ({ ...v, mPerPx: Math.min(50, Math.max(0.02, v.mPerPx * factor)) }));
  }

  function onWheel(e: ReactWheelEvent<SVGSVGElement>) {
    // No preventDefault: the surface is not a scroll trap, and a page that
    // cannot be scrolled past a map is worse than a map that needs a button.
    zoomBy(e.deltaY > 0 ? 1.2 : 1 / 1.2);
  }

  /* -- the corner table -------------------------------------------- */

  function setVertex(index: number, axis: 0 | 1, value: number) {
    const next = ring.map((p, i): Position =>
      i === index ? (axis === 0 ? [value, p[1]] : [p[0], value]) : p,
    );
    commit(next);
  }

  function removeVertex(index: number) {
    commit(ring.filter((_, i) => i !== index));
    setSelected(null);
  }

  /** A new corner a few metres from the last one, so it is visible and movable. */
  function addVertex() {
    const last = ring[ring.length - 1];
    const base = last ?? view.center;
    const stepDeg = (view.mPerPx * 60) / M_PER_DEG_LAT;
    const next: Position = [base[0] + stepDeg / Math.cos((base[1] * Math.PI) / 180), base[1]];
    commit([...ring, next]);
    setSelected(ring.length);
  }

  const fitToRing = useCallback(() => {
    const b = bboxOfPositions(
      ring.length ? ring : neighbours.flatMap((n) => outerRings(n.boundary).flat()),
    );
    if (!b) return;
    if (b.maxLon === b.minLon && b.maxLat === b.minLat) {
      setView((v) => ({ ...v, center: [b.minLon, b.minLat] }));
      return;
    }
    setView(fitView(b, vp));
  }, [ring, neighbours, vp]);

  function useDeviceLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setNote("Este navegador no puede darnos la ubicación del equipo.");
      return;
    }
    setGeolocating(true);
    setNote(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeolocating(false);
        setView((v) => ({
          ...v,
          center: [pos.coords.longitude, pos.coords.latitude],
          mPerPx: Math.min(v.mPerPx, 0.5),
        }));
        setNote(
          `Centrado en donde está este equipo, con una precisión de unos ${Math.round(
            pos.coords.accuracy,
          )} m.`,
        );
      },
      (err) => {
        setGeolocating(false);
        setNote(
          err.code === err.PERMISSION_DENIED
            ? "No dio permiso de ubicación. Puede escribir la latitud y la longitud a mano."
            : "No se pudo obtener la ubicación del equipo. Escriba la latitud y la longitud a mano.",
        );
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  /* -- the owner's own background image ----------------------------- */

  function onPickImage(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      if (dataUrl.length > BG_MAX_BYTES) {
        setNote("Esa imagen pesa demasiado. Use una más liviana, de menos de 2 MB.");
        return;
      }
      const bg: Background = { dataUrl, bbox: viewportBbox(view, vp), opacity: 0.6 };
      setBackground(bg);
      saveBackground(plotId, bg);
    };
    reader.readAsDataURL(file);
  }

  function reanchorImage() {
    setBackground((bg) => {
      if (!bg) return bg;
      const next = { ...bg, bbox: viewportBbox(view, vp) };
      saveBackground(plotId, next);
      return next;
    });
  }

  function clearImage() {
    setBackground(null);
    saveBackground(plotId, null);
  }

  /* -- drawing ------------------------------------------------------ */

  const closed = closeRing(ring);
  const points = ring.map((p) => project(p, view, vp));
  const gridStepM = niceDistance(view.mPerPx, 90);
  const barM = niceDistance(view.mPerPx, 120);
  const barPx = barM / view.mPerPx;

  const helpByMode: Record<Mode, string> = {
    pan: "Arrastre para mover el mapa y use la rueda del ratón para acercar.",
    draw: "Haga clic en cada esquina del lote, siguiendo el linde. Puede corregirlas después.",
    vertices: "Arrastre una esquina para moverla, o toque el punto hueco de un lado para partirlo.",
  };

  return (
    <Box>
      {!readOnly && (
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={1.5}
          alignItems={{ md: "center" }}
          sx={{ mb: 1.5 }}
        >
          <ToggleButtonGroup
            size="small"
            exclusive
            value={mode}
            onChange={(_, v) => v && setMode(v as Mode)}
            aria-label="Qué hace el clic sobre el mapa"
          >
            <ToggleButton value="pan">Mover</ToggleButton>
            <ToggleButton value="draw">Dibujar</ToggleButton>
            <ToggleButton value="vertices">Esquinas</ToggleButton>
          </ToggleButtonGroup>

          <Tooltip title="Deshacer el último cambio">
            <span>
              <IconButton size="small" onClick={undo} disabled={past.length === 0} aria-label="Deshacer">
                <UndoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Encuadrar el lote">
            <span>
              <IconButton size="small" onClick={fitToRing} aria-label="Encuadrar el lote">
                <CenterFocusStrongIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <IconButton size="small" onClick={() => zoomBy(1 / 1.4)} aria-label="Acercar">
            <ZoomInIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" onClick={() => zoomBy(1.4)} aria-label="Alejar">
            <ZoomOutIcon fontSize="small" />
          </IconButton>

          <Box sx={{ flex: 1 }} />

          <Button
            size="small"
            color="inherit"
            startIcon={<DeleteOutlineIcon />}
            disabled={ring.length === 0}
            onClick={() => {
              commit([]);
              setSelected(null);
              setMode("draw");
            }}
          >
            Borrar el dibujo
          </Button>
        </Stack>
      )}

      {!readOnly && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
          {helpByMode[mode]}
        </Typography>
      )}

      <Box
        ref={boxRef}
        sx={{
          position: "relative",
          borderRadius: 3,
          overflow: "hidden",
          border: 1,
          borderColor: "divider",
        }}
      >
        <svg
          ref={svgRef}
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={
            ring.length >= 3
              ? `Mapa del lote con ${ring.length} esquinas`
              : "Mapa del lote, todavía sin polígono"
          }
          style={{
            display: "block",
            touchAction: "none",
            cursor: readOnly ? "default" : mode === "draw" ? "crosshair" : "grab",
            background: "#eef2ec",
          }}
          onPointerDown={onSurfacePointerDown}
          onPointerMove={onSurfacePointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onWheel={onWheel}
        >
          {background && (
            <BackgroundImage background={background} view={view} vp={vp} />
          )}

          <MetricGrid view={view} vp={vp} stepM={gridStepM} />

          {neighbours.map((n) => (
            <NeighbourShape key={n.id} neighbour={n} view={view} vp={vp} />
          ))}

          {ring.length >= 2 && (
            <polygon
              points={closed.map((p) => project(p, view, vp).join(",")).join(" ")}
              fill={crossing ? "rgba(211,47,47,0.16)" : "rgba(46,125,50,0.20)"}
              stroke={crossing ? "#d32f2f" : "#2e7d32"}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          )}

          {crossing && (
            <CrossingEdges ring={ring} edges={crossing} view={view} vp={vp} />
          )}

          {!readOnly && mode === "vertices" && ring.length >= 2 &&
            ring.map((p, i) => {
              const q = ring[(i + 1) % ring.length];
              const mid: Position = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
              const [mx, my] = project(mid, view, vp);
              return (
                <circle
                  key={`mid-${i}`}
                  cx={mx}
                  cy={my}
                  r={5}
                  fill="#fff"
                  stroke="#2e7d32"
                  strokeWidth={1.5}
                  style={{ cursor: "copy" }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    const next = [...ring.slice(0, i + 1), mid, ...ring.slice(i + 1)];
                    commit(next);
                    setSelected(i + 1);
                  }}
                />
              );
            })}

          {points.map(([x, y], i) => (
            <g key={`v-${i}`}>
              <circle
                cx={x}
                cy={y}
                r={selected === i ? 8 : 6}
                fill={selected === i ? "#2e7d32" : "#fff"}
                stroke="#2e7d32"
                strokeWidth={2}
                style={{ cursor: readOnly ? "default" : "move" }}
                onPointerDown={(e) => startVertexDrag(i, e)}
              />
              <text x={x + 10} y={y - 8} fontSize={11} fill="#33691e">
                {i + 1}
              </text>
            </g>
          ))}

          <ScaleBar barM={barM} barPx={barPx} height={height} />
          <NorthArrow width={width} />
        </svg>

        <Box
          sx={{
            position: "absolute", left: 8, top: 8, px: 1, py: 0.25,
            bgcolor: "rgba(255,255,255,0.85)", borderRadius: 1, fontSize: 12,
            color: "text.secondary",
          }}
        >
          centro {formatLatLon(view.center)} · cuadrícula {formatMetres(gridStepM)}
        </Box>
      </Box>

      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
        Sin fotografía aérea: esta consola no puede pedir imágenes a servidores de
        internet. El dibujo se hace sobre coordenadas reales, con la cuadrícula y la
        escala en metros, y puede poner de fondo una imagen suya.
      </Typography>

      {/* -- what the shape measures ---------------------------------- */}

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 2 }}>
        <Chip
          size="small"
          color={liveAreaHa === null ? "default" : "primary"}
          label={
            liveAreaHa === null
              ? "Área del polígono: sin calcular"
              : `Área del polígono: ${formatArea(liveAreaHa)} ha`
          }
        />
        {declaredAreaHa !== null && (
          <Chip size="small" variant="outlined" label={`Declarada: ${formatArea(declaredAreaHa)} ha`} />
        )}
        {livePerimeterM !== null && (
          <Chip size="small" variant="outlined" label={`Linde: ${formatMetres(livePerimeterM)}`} />
        )}
        <Chip size="small" variant="outlined" label={`${ring.length} esquinas`} />
      </Stack>

      {problem && ring.length > 0 && (
        <Alert severity={problem.kind === "selfIntersects" ? "error" : "info"} sx={{ mt: 2 }}>
          {problem.message}
        </Alert>
      )}

      {overlaps.length > 0 && (
        <Alert severity="info" sx={{ mt: 2 }}>
          Este polígono se pisa con {overlaps.map((o) => `«${o.name}»`).join(", ")}. No es un
          error y se guardó igual: a veces son dos lotes que de verdad se tocan, o una terraza
          por encima de un cafetal. Si no debería ser así, mueva las esquinas del linde común.
        </Alert>
      )}

      {note && (
        <Alert severity="info" sx={{ mt: 2 }} onClose={() => setNote(null)}>
          {note}
        </Alert>
      )}

      {!readOnly && (
        <>
          {centreIsAGuess && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              Todavía no sabemos dónde queda este lote, así que el mapa está centrado en
              Manizales. Escriba la latitud y la longitud del lote —o use la ubicación del
              equipo si está en la finca— antes de dibujar: la superficie depende de dónde
              esté el terreno, no solo de la forma.
            </Alert>
          )}

          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            alignItems={{ sm: "center" }}
            sx={{ mt: 2 }}
          >
            <TextField
              size="small"
              label="Latitud del centro"
              value={String(view.center[1]).replace(".", ",")}
              onChange={(e) => {
                const v = parseDegrees(e.target.value);
                if (v !== null) setView((s) => ({ ...s, center: [s.center[0], v] }));
              }}
              inputMode="decimal"
              sx={{ maxWidth: 200 }}
            />
            <TextField
              size="small"
              label="Longitud del centro"
              value={String(view.center[0]).replace(".", ",")}
              onChange={(e) => {
                const v = parseDegrees(e.target.value);
                if (v !== null) setView((s) => ({ ...s, center: [v, s.center[1]] }));
              }}
              inputMode="decimal"
              sx={{ maxWidth: 200 }}
            />
            <Button
              size="small"
              startIcon={<MyLocationIcon />}
              onClick={useDeviceLocation}
              disabled={geolocating}
            >
              {geolocating ? "Buscando…" : "Usar la ubicación del equipo"}
            </Button>
          </Stack>

          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            alignItems={{ sm: "center" }}
            sx={{ mt: 2 }}
          >
            <Button size="small" component="label" startIcon={<ImageOutlinedIcon />}>
              Imagen de fondo
              <input
                type="file"
                accept="image/*"
                hidden
                aria-label="Imagen de fondo del mapa"
                onChange={(e) => onPickImage(e.target.files?.[0])}
              />
            </Button>
            {background && (
              <>
                <Box sx={{ width: 160 }}>
                  <Typography variant="caption" color="text.secondary">
                    Transparencia
                  </Typography>
                  <Slider
                    size="small"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={background.opacity}
                    aria-label="Transparencia de la imagen de fondo"
                    onChange={(_, v) =>
                      setBackground((bg) => (bg ? { ...bg, opacity: v as number } : bg))
                    }
                    onChangeCommitted={() => saveBackground(plotId, background)}
                  />
                </Box>
                <Button size="small" onClick={reanchorImage}>
                  Fijar al encuadre actual
                </Button>
                <Button size="small" color="inherit" onClick={clearImage}>
                  Quitar imagen
                </Button>
              </>
            )}
            <Typography variant="caption" color="text.secondary">
              La imagen se queda en este navegador: no se sube al servidor ni la ve nadie más.
            </Typography>
          </Stack>

          {/* -- the corners, as numbers ------------------------------- */}

          <Box sx={{ mt: 3 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
              <Typography variant="h3">Esquinas</Typography>
              <Button size="small" startIcon={<AddIcon />} onClick={addVertex}>
                Agregar esquina
              </Button>
            </Stack>
            {ring.length === 0 && (
              <Typography color="text.secondary" variant="body2">
                Todavía no hay ninguna. Marque las esquinas sobre el mapa, o agréguelas aquí y
                escriba sus coordenadas.
              </Typography>
            )}
            <Stack spacing={1}>
              {ring.map((p, i) => (
                <Stack
                  key={`row-${i}`}
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  onFocus={() => setSelected(i)}
                >
                  <Chip size="small" label={i + 1} />
                  <DegreeField
                    label={`Latitud ${i + 1}`}
                    value={p[1]}
                    onCommit={(v) => setVertex(i, 1, v)}
                  />
                  <DegreeField
                    label={`Longitud ${i + 1}`}
                    value={p[0]}
                    onCommit={(v) => setVertex(i, 0, v)}
                  />
                  <IconButton
                    size="small"
                    aria-label={`Quitar la esquina ${i + 1}`}
                    onClick={() => removeVertex(i)}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
          </Box>
        </>
      )}
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* The layers                                                          */
/* ------------------------------------------------------------------ */

function viewportBbox(view: MapView, vp: Viewport): Bbox {
  const topLeft = unproject(0, 0, view, vp);
  const bottomRight = unproject(vp.width, vp.height, view, vp);
  return {
    minLon: Math.min(topLeft[0], bottomRight[0]),
    maxLon: Math.max(topLeft[0], bottomRight[0]),
    minLat: Math.min(topLeft[1], bottomRight[1]),
    maxLat: Math.max(topLeft[1], bottomRight[1]),
  };
}

function BackgroundImage({
  background, view, vp,
}: { background: Background; view: MapView; vp: Viewport }) {
  const [x1, y1] = project([background.bbox.minLon, background.bbox.maxLat], view, vp);
  const [x2, y2] = project([background.bbox.maxLon, background.bbox.minLat], view, vp);
  return (
    <image
      href={background.dataUrl}
      x={x1}
      y={y1}
      width={Math.max(0, x2 - x1)}
      height={Math.max(0, y2 - y1)}
      opacity={background.opacity}
      preserveAspectRatio="none"
    />
  );
}

/**
 * A grid in metres, not in degrees.
 *
 * Degrees of longitude are 111 km at the equator and shorter everywhere else,
 * so a graticule tells a farmer nothing they can pace out. A 50 m square is a
 * unit somebody can compare against the distance between two rows of coffee.
 */
function MetricGrid({ view, vp, stepM }: { view: MapView; vp: Viewport; stepM: number }) {
  const stepPx = stepM / view.mPerPx;
  if (!Number.isFinite(stepPx) || stepPx < 4) return null;
  const lines: ReactNode[] = [];
  const offsetX = (vp.width / 2) % stepPx;
  const offsetY = (vp.height / 2) % stepPx;
  for (let x = offsetX; x <= vp.width; x += stepPx) {
    lines.push(<line key={`x${x}`} x1={x} y1={0} x2={x} y2={vp.height} stroke="#dbe4d7" strokeWidth={1} />);
  }
  for (let y = offsetY; y <= vp.height; y += stepPx) {
    lines.push(<line key={`y${y}`} x1={0} y1={y} x2={vp.width} y2={y} stroke="#dbe4d7" strokeWidth={1} />);
  }
  return <g>{lines}</g>;
}

function NeighbourShape({
  neighbour, view, vp,
}: { neighbour: MapNeighbour; view: MapView; vp: Viewport }) {
  const rings = outerRings(neighbour.boundary);
  if (rings.length === 0) return null;
  const first = rings[0];
  const label = project(
    [
      first.reduce((s, p) => s + p[0], 0) / first.length,
      first.reduce((s, p) => s + p[1], 0) / first.length,
    ],
    view,
    vp,
  );
  return (
    <g>
      {rings.map((r, i) => (
        <polygon
          key={i}
          points={closeRing(r).map((p) => project(p, view, vp).join(",")).join(" ")}
          fill="rgba(120,120,120,0.10)"
          stroke="#9e9e9e"
          strokeDasharray="5 4"
          strokeWidth={1.5}
        />
      ))}
      <text x={label[0]} y={label[1]} fontSize={12} fill="#757575" textAnchor="middle">
        {neighbour.name}
      </text>
    </g>
  );
}

/** The two sides that cross, painted so the eye lands on the mistake. */
function CrossingEdges({
  ring, edges, view, vp,
}: { ring: LinearRing; edges: [number, number]; view: MapView; vp: Viewport }) {
  const n = ring.length;
  return (
    <g>
      {edges.map((i) => {
        const a = project(ring[i], view, vp);
        const b = project(ring[(i + 1) % n], view, vp);
        return (
          <line
            key={i}
            x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
            stroke="#d32f2f" strokeWidth={4} strokeLinecap="round"
          />
        );
      })}
    </g>
  );
}

function ScaleBar({ barM, barPx, height }: { barM: number; barPx: number; height: number }) {
  const y = height - 22;
  return (
    <g>
      <rect x={12} y={y - 12} width={barPx + 60} height={26} fill="rgba(255,255,255,0.8)" rx={4} />
      <line x1={20} y1={y} x2={20 + barPx} y2={y} stroke="#33691e" strokeWidth={3} />
      <line x1={20} y1={y - 5} x2={20} y2={y + 5} stroke="#33691e" strokeWidth={3} />
      <line x1={20 + barPx} y1={y - 5} x2={20 + barPx} y2={y + 5} stroke="#33691e" strokeWidth={3} />
      <text x={28 + barPx} y={y + 4} fontSize={12} fill="#33691e">
        {formatMetres(barM)}
      </text>
    </g>
  );
}

function NorthArrow({ width }: { width: number }) {
  const x = width - 30;
  return (
    <g>
      <line x1={x} y1={44} x2={x} y2={18} stroke="#33691e" strokeWidth={2} />
      <polygon points={`${x},14 ${x - 5},24 ${x + 5},24`} fill="#33691e" />
      <text x={x} y={58} fontSize={11} fill="#33691e" textAnchor="middle">
        N
      </text>
    </g>
  );
}

/**
 * One coordinate, typed rather than dragged.
 *
 * It keeps its own draft string because the value it edits is a number and the
 * way to a number goes through strings that are not numbers yet: "-", "5," and
 * "5,6" are all on the road to "5,66". A field that reformats on every
 * keystroke makes the second comma impossible to type, which is the classic
 * way a coordinate box ends up unusable for exactly the people who have real
 * coordinates to enter.
 */
function DegreeField({
  label, value, onCommit,
}: { label: string; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(() => String(value).replace(".", ","));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(String(value).replace(".", ","));
  }, [value, editing]);

  return (
    <TextField
      size="small"
      label={label}
      value={draft}
      inputMode="decimal"
      sx={{ maxWidth: 170 }}
      onFocus={() => setEditing(true)}
      onBlur={() => {
        setEditing(false);
        setDraft(String(value).replace(".", ","));
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        const parsed = parseDegrees(e.target.value);
        if (parsed !== null) onCommit(parsed);
      }}
    />
  );
}
