/**
 * «Rendimiento» — one person's harvest, on their profile.
 *
 * Asked for in one sentence: "necesito ver también en el perfil de cada
 * empleado gráficas de rendimiento de recolección". Four blocks, top to bottom,
 * in the order a farm owner asks the questions:
 *
 *   1. three big numbers — this week, kilos per day worked, and the change
 *      against last week written out in words;
 *   2. kilos per settlement week for twelve weeks, with the farm's average per
 *      picker as a line, so "is 180 kg good?" has an answer on the same chart;
 *   3. the days of this week;
 *   4. the lotes of the last four weeks.
 *
 * THE DESIGN RULES. The people reading this are often around fifty, on a phone
 * in the sun as often as at a desk. So: big type, one green, a dark line for the
 * one comparison, numbers written ON the bars instead of read off an axis, and
 * a sentence under the weekly chart that says what the selected bar means. No
 * legend boxes, no gridline forest, no second axis. Drawn in plain SVG like the
 * rest of the harvest charts (see features/harvest/charts.tsx for why there is
 * no chart library).
 *
 * THE NUMBERS COME FROM THE SERVER, all of them — /v1/workers/{id}/performance.
 * This file draws and words them; it adds nothing up except the "y N lotes más".
 */
import { useState } from "react";
import {
  Alert,
  Box,
  Card,
  CardContent,
  Grid,
  Paper,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import ScaleOutlinedIcon from "@mui/icons-material/ScaleOutlined";
import { GREEN, GREEN_DARK, moneyFont } from "../../theme";
import { useAsync } from "../../lib/useAsync";
import { workerPerformance } from "../../api/harvest";
import type {
  WirePerformanceDay,
  WirePerformancePlot,
  WirePerformanceWeek,
} from "../../api/wire";
import { formatDate, formatWeekRange, parseDay } from "../../lib/dates";
import { useWidth } from "../harvest/charts";
import { count } from "../../lib/plural";
import {
  DAY_SHORT,
  comparisonSpan,
  daysWorkedText,
  kgText,
  weekChange,
} from "./performance";

const WEEKS = 12;
const TOP_PLOTS = 5;
const INK = "#1a1c19";
const INK_MUTED = "#5f665c";
const AVG_LINE = "#43483f";
const GRID = "#e4ebe1";
const TRACK = "rgba(46,125,50,.12)";

export function WorkerPerformance({ workerId }: Readonly<{ workerId: string }>) {
  const { data, error, denied } = useAsync(
    () => workerPerformance(workerId, WEEKS),
    [workerId],
  );

  // The section is a guest on the profile: a failure here must not take the
  // profile down with it, and a 403 (the role cannot see it) just hides it.
  if (denied) return null;

  return (
    <Card sx={{ mt: 3 }} id="rendimiento">
      <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography variant="h2" component="h2" gutterBottom>
          Rendimiento
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {data?.team && (
          <Alert
            severity="info"
            variant="outlined"
            sx={{ fontSize: 17, mb: 2 }}
          >
            <strong>Su parte</strong>: los kilos del equipo {data.team.name}{" "}
            divididos entre sus {data.team.members} integrantes, cada día que
            estuvo en el equipo.
          </Alert>
        )}
        {!error && !data && <Loading />}
        {data && data.lastRecordOn === null && <Empty />}
        {data && data.lastRecordOn !== null && (
          <Body
            today={data.today}
            lastRecordOn={data.lastRecordOn}
            summary={data.summary}
            weeks={data.weeks}
            days={data.days}
            plots={data.plots}
            unattributedKg={data.unattributedKg}
            recordsNotInKg={data.recordsNotInKg}
            share={!!data.team}
            teamMembers={data.kind === "equipo" ? data.members : 0}
          />
        )}
      </CardContent>
    </Card>
  );
}

function Loading() {
  return (
    <Stack spacing={2} aria-label="Cargando el rendimiento">
      <Grid container spacing={2}>
        {[0, 1, 2].map((i) => (
          <Grid key={i} size={{ xs: 12, sm: 4 }}>
            <Skeleton variant="rounded" height={116} />
          </Grid>
        ))}
      </Grid>
      <Skeleton variant="rounded" height={240} />
    </Stack>
  );
}

function Empty() {
  return (
    <Stack
      spacing={1.5}
      sx={{
        alignItems: "center",
        py: 5,
        textAlign: "center",
      }}
    >
      <ScaleOutlinedIcon sx={{ fontSize: 56, color: GREEN, opacity: 0.6 }} />
      <Typography sx={{ fontSize: 20, fontWeight: 600 }}>
        Todavía no hay recolecciones registradas para esta persona
      </Typography>
      <Typography
        sx={{
          color: "text.secondary",
          fontSize: 17,
          maxWidth: 440,
        }}
      >
        Cuando se registren sus pesadas, aquí verá cuántos kilos recoge por
        semana y por día.
      </Typography>
    </Stack>
  );
}

type Summary = NonNullable<
  Awaited<ReturnType<typeof workerPerformance>>
>["summary"];

function Body(props: Readonly<{
  today: string;
  lastRecordOn: string;
  summary: Summary;
  weeks: WirePerformanceWeek[];
  days: WirePerformanceDay[];
  plots: WirePerformancePlot[];
  unattributedKg: number | null;
  recordsNotInKg: number;
  /** A member's profile: every figure is their share of the team. */
  share?: boolean;
  /** A team's profile: how many people the kilos are between. */
  teamMembers?: number;
}>) {
  const {
    summary,
    weeks,
    days,
    plots,
    today,
    share = false,
    teamMembers = 0,
  } = props;
  const anyInWindow = weeks.some((w) => w.kg !== null);
  const change = weekChange(summary.thisWeekKg, summary.lastWeekToDateKg);
  const daysThisWeek = days.filter((d) => (d.kg ?? 0) > 0).length;

  return (
    <Stack spacing={3}>
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, sm: 4 }}>
          <BigNumber
            label={
              share
                ? "Su parte esta semana"
                : teamMembers > 1
                  ? "Esta semana, juntos"
                  : "Esta semana"
            }
            value={kgText(summary.thisWeekKg ?? 0)}
            note={
              daysThisWeek === 0
                ? "Todavía sin recolección."
                : teamMembers > 1
                  ? `${kgText((summary.thisWeekKg ?? 0) / teamMembers)} c/u · ${daysWorkedText(daysThisWeek)} hasta hoy.`
                  : `${daysWorkedText(daysThisWeek)} hasta hoy.`
            }
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 4 }}>
          <BigNumber
            label="Promedio por día trabajado"
            value={
              summary.kgPerDayWorked === null
                ? "—"
                : kgText(summary.kgPerDayWorked)
            }
            note={
              summary.kgPerDayWorked === null
                ? "Sin días trabajados en 4 semanas."
                : `Últimas 4 semanas, ${daysWorkedText(summary.recentDaysWorked)}.`
            }
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <BigNumber
            label="Frente a la semana pasada"
            value={
              change.direction === "same"
                ? "Igual"
                : `${change.arrow} ${kgText(change.diffKg)}`
            }
            valueColor={change.direction === "up" ? GREEN_DARK : INK}
            sentence={change.tail}
            ariaLabel={`Frente a la semana pasada: ${change.sentence}.`}
            note={comparisonSpan(today)}
          />
        </Grid>
      </Grid>

      {!anyInWindow ? (
        <Alert severity="info" variant="outlined" sx={{ fontSize: 17 }}>
          No tiene recolecciones en las últimas {WEEKS} semanas. La última fue
          el {formatDate(props.lastRecordOn)}.
        </Alert>
      ) : (
        <>
          <Section
            title="Kilos por semana"
            hint={`Las últimas ${WEEKS} semanas de liquidación, de lunes a domingo.`}
          >
            <WeeklyChart
              weeks={weeks}
              today={today}
              teamMembers={teamMembers}
            />
          </Section>

          <Grid container spacing={3}>
            <Grid size={{ xs: 12, md: 6 }}>
              <Section title="Kilos por día, esta semana">
                <DaysChart days={days} />
              </Section>
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <Section title="Kilos por lote" hint="Últimas 4 semanas.">
                <PlotBars plots={plots} unattributedKg={props.unattributedKg} />
              </Section>
            </Grid>
          </Grid>
        </>
      )}

      {props.recordsNotInKg > 0 && (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {count(props.recordsNotInKg, "registro", "registros")} en unidades sin
          equivalencia en kilos no se{" "}
          {props.recordsNotInKg === 1 ? "cuenta" : "cuentan"} en estas gráficas.
        </Typography>
      )}
    </Stack>
  );
}

function BigNumber({
  label,
  value,
  sentence,
  note,
  valueColor = INK,
  ariaLabel,
}: Readonly<{
  label: string;
  value: string;
  sentence?: string;
  note: string;
  valueColor?: string;
  ariaLabel?: string;
}>) {
  return (
    <Paper
      variant="outlined"
      aria-label={ariaLabel}
      sx={{
        p: { xs: 1.5, sm: 2 },
        height: "100%",
        borderRadius: 3,
        bgcolor: "#fbfcfa",
      }}
    >
      <Typography
        sx={{
          fontSize: { xs: 15, sm: 16 },
          fontWeight: 600,
          color: INK_MUTED,
          lineHeight: 1.3,
        }}
      >
        {label}
      </Typography>
      <Typography
        sx={{
          fontSize: { xs: 30, sm: 36 },
          fontWeight: 700,
          lineHeight: 1.15,
          color: valueColor,
          my: 0.5,
          whiteSpace: "nowrap",
          ...moneyFont,
        }}
      >
        {value}
      </Typography>
      {sentence && (
        <Typography
          sx={{
            fontSize: 18,
            fontWeight: 600,
            color: valueColor,
            lineHeight: 1.3,
          }}
        >
          {sentence}
        </Typography>
      )}
      <Typography sx={{ fontSize: 15, color: INK_MUTED }}>{note}</Typography>
    </Paper>
  );
}

function Section({
  title,
  hint,
  children,
}: Readonly<{
  title: string;
  hint?: string;
  children: React.ReactNode;
}>) {
  return (
    <Box>
      <Typography variant="h3" component="h3">
        {title}
      </Typography>
      {hint && (
        <Typography sx={{ fontSize: 15, color: INK_MUTED, mb: 1 }}>
          {hint}
        </Typography>
      )}
      <Box sx={{ mt: hint ? 0 : 1 }}>{children}</Box>
    </Box>
  );
}

function ceilNice(max: number): number {
  if (max <= 0) return 10;
  const mag = 10 ** Math.floor(Math.log10(max));
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const n = max / mag;
  return (steps.find((s) => s >= n) ?? 10) * mag;
}

/** "14–20 sep", without the year unless the week needs it. */
function weekName(monday: string, today: string): string {
  return formatWeekRange(monday, parseDay(today));
}

/**
 * Twelve bars and one line. The bars are this person, the line is the farm's
 * average per picker for the same week. The newest week is selected from the
 * start, so the sentence below the chart is never empty; tapping a bar (a
 * phone) or pointing at it (a mouse) selects that week instead.
 */
function WeeklyChart({
  weeks,
  today,
  teamMembers = 0,
}: Readonly<{
  weeks: WirePerformanceWeek[];
  today: string;
  teamMembers?: number;
}>) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [selected, setSelected] = useState(weeks.length - 1);
  const height = 240;
  const pad = { top: 16, right: 8, bottom: 30, left: 48 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const top = ceilNice(
    Math.max(0, ...weeks.map((w) => Math.max(w.kg ?? 0, w.farmAvgKg ?? 0))),
  );
  const slot = plotW / Math.max(1, weeks.length);
  const barW = Math.max(8, Math.min(40, slot * 0.64));
  const cx = (i: number) => pad.left + slot * i + slot / 2;
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;
  // Week names are wide ("28 sep – 4 oct"); label as many as fit, always the newest.
  const every = Math.max(
    1,
    Math.ceil(weeks.length / Math.max(1, Math.floor(plotW / 100))),
  );
  const avgPoints = weeks
    .map((w, i) => (w.farmAvgKg === null ? null : { i, v: w.farmAvgKg }))
    .filter((p): p is { i: number; v: number } => p !== null);
  const last = weeks.length - 1;
  const runningAvg = !weeks[last]?.finished
    ? avgPoints.find((p) => p.i === last)
    : undefined;
  const finishedAvg = runningAvg
    ? avgPoints.filter((p) => p.i !== last)
    : avgPoints;
  // Keep a label inside the drawing: the newest one sits at the right edge.
  const labelX = (i: number, text: string) => {
    const half = (text.length * 7) / 2;
    return Math.min(Math.max(cx(i), pad.left + half), width - half);
  };

  const sel = weeks[selected];
  const summary = weeks
    .map(
      (w) =>
        `${weekName(w.weekStart, today)}: ${w.kg === null ? "sin kilos" : kgText(w.kg)}`,
    )
    .join("; ");

  return (
    <Box ref={ref} sx={{ width: "100%" }}>
      <Stack
        direction="row"
        spacing={2.5}
        sx={{ mb: 1, flexWrap: "wrap" }}
        useFlexGap
      >
        <Legend
          swatch={
            <Box
              sx={{ width: 14, height: 14, borderRadius: 0.75, bgcolor: GREEN }}
            />
          }
          text="Sus kilos"
        />
        <Legend
          swatch={
            <Box
              sx={{ width: 22, height: 0, borderTop: `3px solid ${AVG_LINE}` }}
            />
          }
          text="Promedio por persona en la finca"
        />
      </Stack>
      {width > 0 && (
        <Box
          component="svg"
          role="img"
          aria-label={`Kilos por semana. ${summary}`}
          sx={{
            width: width,
            height: height,
            display: "block",
          }}
        >
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line
                x1={pad.left}
                x2={pad.left + plotW}
                y1={y(top * f)}
                y2={y(top * f)}
                stroke={GRID}
              />
              <text
                x={pad.left - 8}
                y={y(top * f) + 5}
                textAnchor="end"
                fontSize={13}
                fill={INK_MUTED}
                style={moneyFont}
              >
                {Math.round(top * f).toLocaleString("es-CO")}
              </text>
            </g>
          ))}
          {weeks.map((w, i) => {
            const v = w.kg ?? 0;
            const h = Math.max(0, y(0) - y(v));
            const isSel = i === selected;
            return (
              <g key={w.weekStart}>
                {/* The whole slot is the target, so a thumb finds it. */}
                <rect
                  x={pad.left + slot * i}
                  y={pad.top}
                  width={slot}
                  height={plotH}
                  fill={isSel ? "rgba(46,125,50,.07)" : "transparent"}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelected(i)}
                  onMouseEnter={() => setSelected(i)}
                />
                {w.kg !== null && (
                  <rect
                    x={cx(i) - barW / 2}
                    y={y(v)}
                    width={barW}
                    height={h}
                    rx={3}
                    fill={GREEN}
                    opacity={w.finished ? 1 : 0.5}
                    pointerEvents="none"
                  />
                )}
              </g>
            );
          })}
          {/* The running week's average is a partial week too: the hop into
              it is dashed, so it does not read as the farm collapsing. */}
          {finishedAvg.length > 1 && (
            <path
              d={finishedAvg
                .map((p, k) => `${k === 0 ? "M" : "L"}${cx(p.i)},${y(p.v)}`)
                .join(" ")}
              fill="none"
              stroke={AVG_LINE}
              strokeWidth={2.5}
              strokeLinejoin="round"
              pointerEvents="none"
            />
          )}
          {runningAvg && finishedAvg.length > 0 && (
            <path
              d={`M${cx(finishedAvg[finishedAvg.length - 1].i)},${y(finishedAvg[finishedAvg.length - 1].v)} L${cx(runningAvg.i)},${y(runningAvg.v)}`}
              fill="none"
              stroke={AVG_LINE}
              strokeWidth={2}
              strokeDasharray="5 4"
              pointerEvents="none"
            />
          )}
          {avgPoints.map((p) => (
            <circle
              key={p.i}
              cx={cx(p.i)}
              cy={y(p.v)}
              r={3.5}
              fill="#fff"
              stroke={AVG_LINE}
              strokeWidth={2}
              pointerEvents="none"
            />
          ))}
          {weeks.map((w, i) =>
            (weeks.length - 1 - i) % every === 0 ? (
              <text
                key={`x${w.weekStart}`}
                x={labelX(i, weekName(w.weekStart, today))}
                y={height - 8}
                textAnchor="middle"
                fontSize={13}
                fill={i === selected ? INK : INK_MUTED}
                fontWeight={i === selected ? 700 : 400}
              >
                {weekName(w.weekStart, today)}
              </text>
            ) : null,
          )}
        </Box>
      )}
      {sel && (
        <Paper
          variant="outlined"
          sx={{ mt: 1, px: 2, py: 1.25, bgcolor: "#fbfcfa", borderRadius: 2 }}
          aria-live="polite"
        >
          <Typography sx={{ fontSize: 17, fontWeight: 700 }}>
            Semana del {weekName(sel.weekStart, today)}
            {!sel.finished && (
              <Box component="span" sx={{ fontWeight: 400, color: INK_MUTED }}>
                {" "}
                · en curso
              </Box>
            )}
          </Typography>
          <Typography sx={{ fontSize: 17 }}>
            {sel.kg === null
              ? "No recogió en esta semana."
              : `Recogió ${kgText(sel.kg)} en ${daysWorkedText(sel.daysWorked)}${teamMembers > 1 ? `, juntos: ${kgText(sel.kg / teamMembers)} c/u` : ""}.`}
          </Typography>
          {sel.farmAvgKg !== null && (
            <Typography sx={{ fontSize: 16, color: INK_MUTED }}>
              Promedio de la finca: {kgText(sel.farmAvgKg)} por persona, entre{" "}
              {count(sel.farmPickers, "persona", "personas")}.
            </Typography>
          )}
        </Paper>
      )}
    </Box>
  );
}

function Legend({ swatch, text }: Readonly<{ swatch: React.ReactNode; text: string }>) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: "center",
      }}
    >
      {swatch}
      <Typography sx={{ fontSize: 15, color: INK_MUTED }}>{text}</Typography>
    </Stack>
  );
}

/**
 * Seven bars, the kilos written on top; no axis to read. Also the daily chart
 * of the farm's harvest week in «Modo cosecha» (features/harvest/HarvestDashboard).
 */
export function DaysChart({
  days,
  caption = "Kilos recogidos cada día, de lunes a domingo.",
}: Readonly<{
  days: Pick<WirePerformanceDay, "day" | "kg" | "future">[];
  caption?: string;
}>) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const height = 200;
  const pad = { top: 26, bottom: 30 };
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(0, ...days.map((d) => d.kg ?? 0));
  const slot = width / 7;
  const barW = Math.max(14, Math.min(44, slot * 0.6));
  const y = (v: number) => pad.top + plotH - (max > 0 ? (v / max) * plotH : 0);
  const summary = days
    .map(
      (d, i) =>
        `${DAY_SHORT[i]}: ${d.kg === null ? (d.future ? "todavía no" : "sin kilos") : kgText(d.kg)}`,
    )
    .join("; ");

  return (
    <Box ref={ref} sx={{ width: "100%" }}>
      {width > 0 && (
        <Box
          component="svg"
          role="img"
          aria-label={`Kilos por día esta semana. ${summary}`}
          sx={{
            width: width,
            height: height,
            display: "block",
          }}
        >
          <line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke={GRID} />
          {days.map((d, i) => {
            const cx = slot * i + slot / 2;
            const v = d.kg ?? 0;
            return (
              <g key={d.day}>
                {v > 0 && (
                  <rect
                    x={cx - barW / 2}
                    y={y(v)}
                    width={barW}
                    height={y(0) - y(v)}
                    rx={3}
                    fill={GREEN}
                  />
                )}
                <text
                  x={cx}
                  y={v > 0 ? y(v) - 7 : y(0) - 7}
                  textAnchor="middle"
                  fontSize={14}
                  fontWeight={v > 0 ? 700 : 400}
                  fill={v > 0 ? INK : INK_MUTED}
                  style={moneyFont}
                >
                  {v > 0
                    ? Math.round(v).toLocaleString("es-CO")
                    : d.future
                      ? ""
                      : "0"}
                </text>
                <text
                  x={cx}
                  y={height - 8}
                  textAnchor="middle"
                  fontSize={14}
                  fill={d.future ? "#a3aaa0" : INK_MUTED}
                >
                  {DAY_SHORT[i]}
                </text>
              </g>
            );
          })}
        </Box>
      )}
      <Typography sx={{ fontSize: 15, color: INK_MUTED }}>{caption}</Typography>
    </Box>
  );
}

/** Horizontal bars, one per lote, the name and the kilos in words above each. */
function PlotBars({
  plots,
  unattributedKg,
}: Readonly<{
  plots: WirePerformancePlot[];
  unattributedKg: number | null;
}>) {
  if (plots.length === 0 && unattributedKg === null) {
    return (
      <Typography sx={{ fontSize: 17, color: INK_MUTED }}>
        No recogió en las últimas 4 semanas.
      </Typography>
    );
  }
  const shown = plots.slice(0, TOP_PLOTS);
  const rest = plots.slice(TOP_PLOTS);
  const max = Math.max(...plots.map((p) => p.kg), unattributedKg ?? 0, 1);
  const restKg = rest.reduce((s, p) => s + p.kg, 0);
  return (
    <Stack spacing={1.75}>
      {shown.map((p) => (
        <Box key={p.plotId}>
          <Stack
            direction="row"
            spacing={1}
            sx={{
              justifyContent: "space-between",
              alignItems: "baseline",
            }}
          >
            <Typography
              sx={{
                fontSize: 17,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {p.name}
            </Typography>
            <Typography
              sx={{
                fontSize: 17,
                fontWeight: 700,
                whiteSpace: "nowrap",
                ...moneyFont,
              }}
            >
              {kgText(p.kg)}
            </Typography>
          </Stack>
          <Box
            sx={{
              height: 14,
              borderRadius: 7,
              bgcolor: TRACK,
              overflow: "hidden",
              mt: 0.5,
            }}
          >
            <Box
              sx={{
                width: `${(p.kg / max) * 100}%`,
                height: "100%",
                borderRadius: 7,
                bgcolor: GREEN,
              }}
            />
          </Box>
        </Box>
      ))}
      {rest.length > 0 && (
        <Typography sx={{ fontSize: 15, color: INK_MUTED }}>
          Y {count(rest.length, "lote más", "lotes más")}, con {kgText(restKg)}{" "}
          en total.
        </Typography>
      )}
      {unattributedKg !== null && (
        <Typography sx={{ fontSize: 15, color: INK_MUTED }}>
          {kgText(unattributedKg)} sin un lote asignado.
        </Typography>
      )}
    </Stack>
  );
}
