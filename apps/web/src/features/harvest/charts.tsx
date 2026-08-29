/**
 * The two charts the harvest module draws, by hand, in SVG.
 *
 * WHY NOT A CHART LIBRARY. The app ships MUI and nothing else for graphics,
 * and the two shapes needed here — a season curve and a sparkline — are about
 * eighty lines between them. A charting dependency would add more weight to a
 * farm's first load than the whole harvest module does, to draw two charts.
 *
 * THE RULES THIS FOLLOWS, AND WHY EACH ONE IS HERE
 *
 * ONE MEASURE PER CHART, NEVER TWO SCALES. The owner asked for kilos AND
 * value on the season screen. That is the classic invitation to a dual-axis
 * chart, where the two y-scales are aligned arbitrarily and the picture
 * invents a correlation the data does not contain. So it is drawn as two
 * charts stacked on one shared x-axis — same weeks, same left edge, read
 * together, no invented relationship.
 *
 * A GAP IS NOT A ZERO. A week whose value could not be priced is a BREAK in
 * the value line, not a dip to the floor. This is the charting half of the
 * rule the rest of the module obeys: a line that dives to zero says the farm
 * earned nothing that week, which is a different and much worse claim than
 * "we could not price it".
 *
 * THE RUNNING WEEK IS DRAWN AS UNFINISHED. Its segment is dashed and its point
 * hollow. A partial week plotted like a finished one makes every Monday look
 * like a collapse.
 *
 * Labels are selective — the peak and the last point, not a number on every
 * dot — and the grid is a solid hairline, because dashes on a grid read as a
 * threshold that is not there.
 */
import { useEffect, useRef, useState } from "react";
import { Box, Paper, Stack, Typography } from "@mui/material";
import { GREEN, GREEN_DARK, moneyFont } from "../../theme";

/** Measure the container, so the SVG is drawn at real pixels and stays crisp. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A browser always has this; a rendering environment that does not gets a
    // chart sized once rather than a component that throws on mount.
    if (typeof ResizeObserver === "undefined") {
      setWidth(Math.round(el.getBoundingClientRect().width) || 640);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(Math.max(0, Math.round(w)));
    });
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export interface CurvePoint {
  key: string;
  /** Short axis label, e.g. "24 ago". */
  label: string;
  /** `null` means "not known", and is drawn as a gap. Never as zero. */
  value: number | null;
  /** The running week: drawn dashed and hollow. */
  partial?: boolean;
}

interface CurveProps {
  points: CurvePoint[];
  height?: number;
  /** Formats the tooltip and the direct labels. */
  format: (v: number) => string;
  /** Index of the point to call out, e.g. the peak. */
  highlight?: number;
  highlightLabel?: string;
  color?: string;
  /** Announced to a screen reader in place of the drawing. */
  summary: string;
  onSelect?: (key: string) => void;
}

const PAD = { top: 18, right: 14, bottom: 24, left: 46 };
const AXIS = "#dde5da";
const INK_MUTED = "#7a8378";

/** Nice-ish round ceiling, so the axis reads in human numbers. */
function ceilNice(max: number): number {
  if (max <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / mag) * mag;
}

/**
 * The curve. One measure, one colour, no legend — the card's title names the
 * series, and a legend box for a single series is furniture.
 */
export function Curve({
  points,
  height = 200,
  format,
  highlight,
  highlightLabel,
  color = GREEN,
  summary,
  onSelect,
}: CurveProps) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const known = points.filter((p) => p.value !== null).map((p) => p.value as number);
  const top = ceilNice(Math.max(...known, 0));

  const x = (i: number) =>
    PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;

  // Segments rather than one path: a run of known points is a line, and a
  // missing one ENDS it. Joining across the gap would draw a value nobody has.
  const segments: { pts: { i: number; v: number }[]; partial: boolean }[] = [];
  let run: { i: number; v: number }[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (run.length) segments.push({ pts: run, partial: false });
      run = [];
      return;
    }
    run.push({ i, v: p.value });
  });
  if (run.length) segments.push({ pts: run, partial: false });

  // The last hop into a still-running week is drawn separately, dashed.
  const lastIsPartial = points.length > 1 && points[points.length - 1].partial === true;

  const line = (pts: { i: number; v: number }[]) =>
    pts.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i)},${y(p.v)}`).join(" ");

  const gridValues = [0, 0.5, 1].map((f) => top * f);

  return (
    <Box ref={ref} sx={{ width: "100%" }}>
      {width > 0 && (
        <Box
          component="svg"
          role="img"
          aria-label={summary}
          width={width}
          height={height}
          sx={{ display: "block", overflow: "visible" }}
          onMouseLeave={() => setHover(null)}
        >
          {/* Grid: solid hairlines, one shade off the surface. */}
          {gridValues.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} stroke={AXIS} strokeWidth={1} />
              <text
                x={PAD.left - 8}
                y={y(v) + 4}
                textAnchor="end"
                fontSize={10}
                fill={INK_MUTED}
                style={moneyFont}
              >
                {format(v)}
              </text>
            </g>
          ))}

          {/* The area under the finished part, faint. */}
          {segments.map((s, si) => {
            const pts = lastIsPartial ? s.pts.filter((p) => p.i !== points.length - 1) : s.pts;
            if (pts.length < 2) return null;
            const d =
              `${line(pts)} L${x(pts[pts.length - 1].i)},${y(0)} L${x(pts[0].i)},${y(0)} Z`;
            return <path key={`a${si}`} d={d} fill={color} opacity={0.1} />;
          })}

          {segments.map((s, si) => {
            const solid = lastIsPartial ? s.pts.filter((p) => p.i !== points.length - 1) : s.pts;
            return (
              <g key={`l${si}`}>
                {solid.length > 1 && (
                  <path d={line(solid)} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
                )}
                {lastIsPartial && s.pts.length > 1 && s.pts[s.pts.length - 1].i === points.length - 1 && (
                  <path
                    d={line(s.pts.slice(-2))}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeDasharray="4 3"
                  />
                )}
              </g>
            );
          })}

          {/* Points. Hollow for the unfinished week, so it cannot be mistaken
              for a finished one that collapsed. */}
          {points.map((p, i) =>
            p.value === null ? null : (
              <circle
                key={p.key}
                cx={x(i)}
                cy={y(p.value)}
                r={hover === i || highlight === i ? 5 : 3.5}
                fill={p.partial ? "#fff" : color}
                stroke={p.partial ? color : "#fff"}
                strokeWidth={2}
              />
            ),
          )}

          {/* Direct labels, selectively: the peak and the newest point. A number
              on every dot is chaos and goes unread. */}
          {highlight !== undefined && points[highlight]?.value != null && (
            <text
              x={x(highlight)}
              y={y(points[highlight].value as number) - 12}
              textAnchor="middle"
              fontSize={10}
              fontWeight={700}
              fill={GREEN_DARK}
            >
              {highlightLabel ?? format(points[highlight].value as number)}
            </text>
          )}

          {/* X labels, thinned so they never collide. */}
          {points.map((p, i) => {
            const every = Math.ceil(points.length / Math.max(2, Math.floor(plotW / 58)));
            if (i % every !== 0 && i !== points.length - 1) return null;
            return (
              <text
                key={`x${p.key}`}
                x={x(i)}
                y={height - 6}
                textAnchor="middle"
                fontSize={10}
                fill={INK_MUTED}
              >
                {p.label}
              </text>
            );
          })}

          {/* Hover targets, wider than the marks. */}
          {points.map((p, i) => (
            <rect
              key={`h${p.key}`}
              x={x(i) - (plotW / Math.max(1, points.length - 1)) / 2}
              y={PAD.top}
              width={Math.max(18, plotW / Math.max(1, points.length - 1))}
              height={plotH}
              fill="transparent"
              style={{ cursor: onSelect ? "pointer" : "default" }}
              onMouseEnter={() => setHover(i)}
              onClick={() => onSelect?.(p.key)}
            />
          ))}

          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke={color}
              strokeWidth={1}
              opacity={0.35}
            />
          )}
        </Box>
      )}

      {hover !== null && (
        <Paper
          variant="outlined"
          sx={{ px: 1.5, py: 0.75, mt: 0.5, display: "inline-block", bgcolor: "#fbfcfa" }}
        >
          <Stack direction="row" spacing={1.5} alignItems="baseline">
            <Typography variant="caption" sx={{ fontWeight: 700 }}>
              {points[hover].label}
            </Typography>
            <Typography variant="caption" sx={{ ...moneyFont }}>
              {points[hover].value === null
                ? "sin dato"
                : format(points[hover].value as number)}
            </Typography>
            {points[hover].partial && (
              <Typography variant="caption" color="warning.dark">
                semana en curso
              </Typography>
            )}
          </Stack>
        </Paper>
      )}
    </Box>
  );
}

/**
 * A row-sized curve for a crop's own weeks. Same rules, no axis, no labels —
 * the numbers beside it carry the values.
 */
export function Sparkline({
  values,
  width = 120,
  height = 30,
  color = GREEN,
  label,
}: {
  /** `null` is a week whose kilos are unknown: it breaks the line, never zeroes it. */
  values: (number | null)[];
  width?: number;
  height?: number;
  color?: string;
  label: string;
}) {
  const known = values.filter((v): v is number => v !== null);
  if (known.length < 2) {
    return (
      <Box sx={{ width, height, display: "grid", placeItems: "center" }}>
        <Typography variant="caption" color="text.disabled">
          {known.length === 0 ? "sin kilos" : "una semana"}
        </Typography>
      </Box>
    );
  }
  const top = Math.max(...known, 1);
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 3 - (v / top) * (height - 6);

  // Runs of known weeks. A hole ends a run rather than being bridged: joining
  // across it would draw a value nobody has.
  const runs: { i: number; v: number }[][] = [];
  let run: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push({ i, v });
  });
  if (run.length) runs.push(run);

  const path = (pts: { i: number; v: number }[]) =>
    pts.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i)},${y(p.v)}`).join(" ");
  const last = runs[runs.length - 1];
  const lastPoint = last[last.length - 1];

  return (
    <Box component="svg" role="img" aria-label={label} width={width} height={height} sx={{ display: "block" }}>
      {runs.map((pts, k) =>
        pts.length > 1 ? (
          <path
            key={`a${k}`}
            d={`${path(pts)} L${x(pts[pts.length - 1].i)},${height} L${x(pts[0].i)},${height} Z`}
            fill={color}
            opacity={0.1}
          />
        ) : null,
      )}
      {runs.map((pts, k) =>
        pts.length > 1 ? (
          <path key={`l${k}`} d={path(pts)} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        ) : null,
      )}
      <circle cx={x(lastPoint.i)} cy={y(lastPoint.v)} r={2.5} fill={color} />
    </Box>
  );
}

/**
 * A horizontal bar for a row in a list. One colour for every row — colouring
 * each bar darker-where-bigger would double-encode the length as hue and burn
 * the only free channel on information the bar already shows.
 */
export function RowBar({ fraction, color = GREEN }: { fraction: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  return (
    <Box sx={{ height: 8, borderRadius: 4, bgcolor: "rgba(46,125,50,.12)", overflow: "hidden" }}>
      <Box sx={{ width: `${pct}%`, height: "100%", borderRadius: 4, bgcolor: color }} />
    </Box>
  );
}
