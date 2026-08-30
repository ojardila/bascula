/**
 * "How is the harvest going?" — the screen the owner opens every morning.
 *
 * It has to answer three things before anybody scrolls: is it going up, has it
 * passed its peak, and is it ending. Those are not three charts. They are one
 * sentence at the top — `/v1/reports/harvest-curve` returns the reading, not
 * just the series — with the curve underneath as the evidence for it. A chart
 * alone makes the reader do the reading; the sentence does the reading and the
 * chart lets them check it.
 *
 * Kilos and value are two charts sharing one x-axis, never one chart with two
 * scales. See the note in `charts.tsx`.
 */

import { useNavigate } from "react-router-dom";
import {
  Alert, Box, Card, CardContent, Chip, CircularProgress, Divider, Stack, Table,
  TableBody, TableCell, TableHead, TableRow, Tooltip, Typography,
} from "@mui/material";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import TrendingDownIcon from "@mui/icons-material/TrendingDown";
import TimelineIcon from "@mui/icons-material/Timeline";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useAsync } from "../../lib/useAsync";
import { PermissionDenied } from "../../components/Guards";
import { reportHarvestCurve, reportWeeks } from "../../api/harvest";
import { formatMoney, formatQuantity } from "../../lib/money";
import { formatDayShort, formatWeekRange, weekTag } from "../../lib/dates";
import { useHarvest } from "./HarvestLayout";
import { Kg, Stat, Value } from "./Figures";
import { Curve, RowBar, type CurvePoint } from "./charts";
import { NOT_ENOUGH_SEASON } from "./text";
import { foldTotals, kgForDrawing, valueState } from "./totals";
import { PICKER } from "../../lib/vocab";

export function SeasonPage() {
  const { today, weeks: windowWeeks, canSeeMoney } = useHarvest();
  const navigate = useNavigate();

  const { data, error, denied } = useAsync(
    async () =>
      Promise.all([
        reportWeeks({ limit: windowWeeks }),
        reportHarvestCurve({ weeks: windowWeeks }),
      ]),
    [windowWeeks],
  );

  if (denied) return <PermissionDenied moduleName="ver la cosecha" />;
  if (error) {
    return (
      <Alert severity="error">
        No se pudo consultar la cosecha: {error}. Ninguna cifra de esta pantalla se
        pudo calcular — y ninguna de ellas es cero.
      </Alert>
    );
  }
  if (!data) {
    return (
      <Stack alignItems="center" sx={{ py: 6 }}>
        <CircularProgress />
      </Stack>
    );
  }

  const [weeksRes, curve] = data;
  // The server sends newest first; a curve is drawn oldest first.
  const weeks = [...weeksRes.items].reverse();

  if (!weeks.length) {
    return (
      <Alert severity="info">
        No hay recolección registrada en este periodo. Si la cosecha ya empezó, revise
        que las labores se estén registrando con una actividad pagada a destajo al
        precio de la semana — es lo que las hace parte de la cosecha.
      </Alert>
    );
  }

  const season = foldTotals(weeks);
  const finished = weeks.filter((w) => w.finished);
  const current = weeks.find((w) => !w.finished);
  const lastFinished = finished[finished.length - 1];

  // A week whose kilos could not be established is a GAP in the curve, not a
  // dip to the floor. `weeksWithoutKilos` is the server counting exactly these.
  const kgPoints: CurvePoint[] = weeks.map((w) => ({
    key: w.weekStart,
    label: formatDayShort(w.weekStart),
    value: w.kg,
    partial: !w.finished,
  }));

  const valuePoints: CurvePoint[] = weeks.map((w) => ({
    key: w.weekStart,
    label: formatDayShort(w.weekStart),
    value: w.valueCents,
    partial: !w.finished,
  }));

  const peakIndex = curve.shape.peak
    ? weeks.findIndex((w) => w.weekStart === curve.shape.peak!.weekStart)
    : -1;
  const maxKg = Math.max(...weeks.map(kgForDrawing), 1);

  const pickers = Math.max(...weeks.map((w) => w.pickers), 0);
  const days = weeks.reduce((s, w) => s + w.days, 0);

  return (
    <Stack spacing={3}>
      <Verdict curve={curve} current={current} lastFinished={lastFinished} />

      {curve.weeksWithoutKilos > 0 && (
        <Alert severity="info">
          {curve.weeksWithoutKilos}{" "}
          {curve.weeksWithoutKilos === 1
            ? "semana quedó fuera de la lectura porque sus kilos no se pudieron establecer"
            : "semanas quedaron fuera de la lectura porque sus kilos no se pudieron establecer"}
          . Tratarlas como cero habría fabricado una caída que no ocurrió.
        </Alert>
      )}

      <Box
        sx={{
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: { xs: "1fr 1fr", md: canSeeMoney ? "repeat(4,1fr)" : "repeat(3,1fr)" },
        }}
      >
        <Stat label="Recogido">
          <Kg total={season} align="flex-start" bold scope="el periodo" />
        </Stat>
        {canSeeMoney && (
          <Stat
            label="Valor de la recolección"
            hint="Lo que valió la recogida en el periodo. No es la nómina de la finca: un jornal no tiene kilos y no entra aquí."
          >
            <Value total={season} scope="el periodo" align="flex-start" />
          </Stat>
        )}
        <Stat label={PICKER.Many} hint="El mayor número de personas que trabajó en una misma semana.">
          {pickers}
        </Stat>
        <Stat label="Días con recolección">{days}</Stat>
      </Box>

      <Card>
        <CardContent>
          <Typography variant="h3" gutterBottom>
            Kilos por semana
          </Typography>
          <Curve
            points={kgPoints}
            format={(v) => formatQuantity(v)}
            highlight={peakIndex >= 0 ? peakIndex : undefined}
            highlightLabel="pico"
            summary={`Curva de recolección: ${weeks.length} semanas, máximo ${formatQuantity(maxKg)} kg.`}
            onSelect={(week) => navigate(`/cosecha/semana/${week}`)}
          />

          {canSeeMoney && (
            <>
              <Divider sx={{ my: 2 }} />
              <Typography variant="h3" gutterBottom>
                Valor por semana
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Las mismas semanas, en pesos. Una semana sin línea es una semana cuyo
                valor no se pudo calcular — no una semana sin cosecha.
              </Typography>
              <Curve
                points={valuePoints}
                format={(v) => formatMoney(v)}
                summary={`Valor de la recolección por semana, ${weeks.length} semanas.`}
                onSelect={(week) => navigate(`/cosecha/semana/${week}`)}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent sx={{ p: 0, "&:last-child": { pb: 0 } }}>
          <Box sx={{ p: 2, pb: 1 }}>
            <Typography variant="h3">Semana a semana</Typography>
            <Typography variant="body2" color="text.secondary">
              Pulse una semana para ver quién recogió, qué día y en qué lote.
            </Typography>
          </Box>
          <Box sx={{ overflowX: "auto" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Semana</TableCell>
                  <TableCell sx={{ width: "20%" }}>Recolección</TableCell>
                  <TableCell align="right">Kilos</TableCell>
                  {canSeeMoney && <TableCell align="right">Valor</TableCell>}
                  {canSeeMoney && <TableCell align="right">Precio</TableCell>}
                  <TableCell align="right">Gente</TableCell>
                  <TableCell align="right">Días</TableCell>
                  <TableCell padding="none" />
                </TableRow>
              </TableHead>
              <TableBody>
                {weeksRes.items.map((w) => {
                  const tag = weekTag(w.weekStart, today);
                  const isPeak = curve.shape.peak?.weekStart === w.weekStart;
                  return (
                    <TableRow
                      key={w.weekStart}
                      hover
                      onClick={() => navigate(`/cosecha/semana/${w.weekStart}`)}
                      sx={{ cursor: "pointer" }}
                    >
                      <TableCell>
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap" }}>
                          <Typography sx={{ fontWeight: 600 }}>
                            {formatWeekRange(w.weekStart)}
                          </Typography>
                          {tag && <Chip size="small" variant="outlined" label={tag} />}
                          {isPeak && <Chip size="small" color="success" label="pico" />}
                          {!w.finished && (
                            <Tooltip title="La semana no ha terminado, así que su total no es comparable con el de una semana cerrada.">
                              <Chip size="small" color="warning" variant="outlined" label="en curso" sx={{ cursor: "help" }} />
                            </Tooltip>
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <RowBar fraction={kgForDrawing(w) / maxKg} />
                      </TableCell>
                      <TableCell align="right">
                        <Kg total={w} scope="esa semana" showUnit={false} />
                      </TableCell>
                      {canSeeMoney && (
                        <TableCell align="right">
                          <Value total={w} scope="esa semana" />
                        </TableCell>
                      )}
                      {canSeeMoney && (
                        <TableCell align="right">
                          {w.priceCents === null ? (
                            <Tooltip title="La finca no tiene precio base. Sin él no se puede saber qué vale un kilo de esa semana.">
                              <Box component="span" sx={{ color: "text.disabled", cursor: "help" }}>—</Box>
                            </Tooltip>
                          ) : (
                            formatMoney(w.priceCents)
                          )}
                        </TableCell>
                      )}
                      <TableCell align="right">{w.pickers}</TableCell>
                      <TableCell align="right">{w.days}</TableCell>
                      <TableCell padding="none">
                        <ChevronRightIcon fontSize="small" sx={{ color: "text.disabled" }} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        </CardContent>
      </Card>
    </Stack>
  );
}

/**
 * The sentence at the top: rising, past the peak, or winding down.
 *
 * It refuses to guess. The server sends `reason: "no_finished_weeks"` when
 * there is nothing to read, and this says exactly that instead of drawing an
 * arrow from one data point — an arrow off a single week is the kind of
 * confidence that gets a crew moved to another lot for no reason.
 */
function Verdict({
  curve,
  current,
  lastFinished,
}: {
  curve: Awaited<ReturnType<typeof reportHarvestCurve>>;
  current?: { kg: number | null } | undefined;
  lastFinished?: { kg: number | null } | undefined;
}) {
  const { shape } = curve;

  if (shape.reason === "no_finished_weeks" || !shape.peak) {
    return (
      <Alert severity="info" icon={<TimelineIcon />}>
        {NOT_ENOUGH_SEASON}
      </Alert>
    );
  }

  if (shape.windingDown) {
    return (
      <Alert severity="warning" icon={<TrendingDownIcon />}>
        <strong>La cosecha va de salida.</strong> Lleva {shape.fallingWeeks}{" "}
        {shape.fallingWeeks === 1 ? "semana cayendo" : "semanas cayendo"} fuerte y ya
        pasó su pico ({formatWeekRange(shape.peak.weekStart)}). Es el momento de pensar
        en mover gente a otro lote o a otra labor.
      </Alert>
    );
  }

  // The running week against the last finished one — stated as partial,
  // because it is. Null kilos on either side means no comparison at all.
  const change =
    current?.kg != null && lastFinished?.kg != null && lastFinished.kg > 0
      ? (current.kg - lastFinished.kg) / lastFinished.kg
      : null;
  const up = change !== null && change > 0.05;
  const down = change !== null && change < -0.05;

  return (
    <Alert severity="success" icon={up ? <TrendingUpIcon /> : <TimelineIcon />}>
      <strong>
        El pico hasta ahora fue {formatWeekRange(shape.peak.weekStart)}
        {shape.peak.kg !== null ? ` (${formatQuantity(shape.peak.kg)} kg)` : ""}.
      </strong>{" "}
      {change !== null ? (
        <>
          La semana en curso va {up ? "por encima" : down ? "por debajo" : "parecida a"} de
          la anterior ({change > 0 ? "+" : "−"}
          {Math.round(Math.abs(change) * 100)} %). Todavía no ha terminado, así que la
          comparación es parcial.
        </>
      ) : (
        <>Aún no hay con qué comparar la semana en curso.</>
      )}
    </Alert>
  );
}

/** Kept so a caller can reason about a value without importing the module. */
export { valueState };
