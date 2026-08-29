/**
 * Every crop of every lot: kilos, value, people, days, area and its own curve.
 *
 * Keyed on the plot-crop rather than the crop TYPE, which is why the schema
 * puts labors on a `plotCropId` at all: a farm with coffee in three lots wants
 * three rows, because "how did the coffee in La Cuchilla do" is the question
 * and a merged "Café" row cannot answer it.
 *
 * `/v1/reports/crops/{plotCropId}` answers one crop, so this asks for the
 * farm's crops first and then reads each. That is N+1 requests and it is the
 * right trade here: a farm has a handful of crops, and the alternative is a
 * list endpoint that would have to invent an ordering and a page size for a
 * list nobody scrolls.
 *
 * TWO FIGURES THAT MUST NOT BE READ AS ZERO, both nullable on purpose:
 *
 *   areaHa   the crop's OWN declared hectares, never the plot's as a
 *            fallback — a plot with two crops would hand the whole area to
 *            each, and half of a real number is worse than a null.
 *   kgPerHa  null when the area was never declared OR the kilos are unknown.
 */
import {
  Alert, Box, Card, CardContent, Chip, CircularProgress, Divider, Stack, Table,
  TableBody, TableCell, TableHead, TableRow, Tooltip, Typography,
} from "@mui/material";
import { useAsync } from "../../lib/useAsync";
import { PermissionDenied } from "../../components/Guards";
import { api } from "../../api/endpoints";
import { reportCrop } from "../../api/harvest";
import { formatDate, formatWeekRange } from "../../lib/dates";
import { formatQuantity } from "../../lib/money";
import { useHarvest } from "./HarvestLayout";
import { Kg, Value } from "./Figures";
import { RowBar, Sparkline } from "./charts";
import { kgForDrawing } from "./totals";

export function CropsPage() {
  const { weeks, canSeeMoney } = useHarvest();

  const { data, error, denied } = useAsync(async () => {
    const plots = await api.listPlots({ status: "active" });
    const ids = plots.flatMap((p) => p.crops.map((c) => c.id));
    // One failing crop must not blank the whole screen: a farm with six crops
    // and one broken row is better served by five rows and a notice.
    const settled = await Promise.allSettled(ids.map((id) => reportCrop(id, weeks)));
    return {
      crops: settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
      failed: settled.filter((r) => r.status === "rejected").length,
    };
  }, [weeks]);

  if (denied) return <PermissionDenied moduleName="ver la cosecha" />;
  if (error) {
    return (
      <Alert severity="error">
        No se pudieron consultar los cultivos: {error}. Ninguna cifra se pudo calcular
        — y ninguna de ellas es cero.
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

  // Heaviest first. A crop with unknown kilos sorts last rather than as a zero.
  const crops = [...data.crops].sort((a, b) => kgForDrawing(b) - kgForDrawing(a));
  const withHarvest = crops.filter((c) => c.records > 0);
  const max = Math.max(...crops.map(kgForDrawing), 1);

  if (!withHarvest.length) {
    return (
      <Alert severity="info">
        Ninguno de los cultivos de la finca tiene recolección registrada en este
        periodo.
      </Alert>
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Cada cultivo de cada lote, del que más produjo al que menos. La curva de la
        derecha es su evolución semanal dentro del periodo elegido.
      </Typography>

      {data.failed > 0 && (
        <Alert severity="warning">
          {data.failed}{" "}
          {data.failed === 1 ? "cultivo no se pudo consultar" : "cultivos no se pudieron consultar"}{" "}
          y no aparecen abajo. Los totales de esta pantalla no los incluyen.
        </Alert>
      )}

      {withHarvest.map((c) => (
        <Card key={c.plotCropId}>
          <CardContent>
            <Stack
              direction={{ xs: "column", md: "row" }}
              spacing={2}
              alignItems={{ md: "center" }}
              justifyContent="space-between"
            >
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Stack direction="row" spacing={1} alignItems="baseline" sx={{ flexWrap: "wrap" }}>
                  <Typography variant="h3">{c.label}</Typography>
                  {c.sharedRecords > 0 && (
                    <Tooltip
                      title={`${c.sharedRecords} ${
                        c.sharedRecords === 1 ? "pesada nombra" : "pesadas nombran"
                      } este cultivo y otro más. Sus kilos se cuentan enteros aquí y también allá, así que sumar los cultivos entre sí da de más.`}
                    >
                      <Chip
                        size="small"
                        color="warning"
                        variant="outlined"
                        label={`${c.sharedRecords} compartidas`}
                        sx={{ cursor: "help" }}
                      />
                    </Tooltip>
                  )}
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {c.firstOn && c.lastOn
                    ? `Recogido entre el ${formatDate(c.firstOn)} y el ${formatDate(c.lastOn)}`
                    : "Sin fechas de recolección"}
                </Typography>
                <Box sx={{ mt: 1.5, maxWidth: 460 }}>
                  <RowBar fraction={kgForDrawing(c) / max} />
                </Box>
              </Box>

              <Stack direction="row" spacing={3} alignItems="center" sx={{ flexWrap: "wrap", rowGap: 1.5 }}>
                <Cell label="Kilos">
                  <Kg total={c} align="flex-start" bold scope={c.label} />
                </Cell>
                {canSeeMoney && (
                  <Cell label="Valor">
                    <Value total={c} scope={c.label} align="flex-start" />
                  </Cell>
                )}
                <Cell label="kg/ha">
                  {c.kgPerHa === null ? (
                    <Tooltip
                      title={
                        c.areaHa === null
                          ? "Este cultivo no tiene hectáreas declaradas. Sin área no hay rendimiento por hectárea — y no es cero."
                          : "Los kilos de este cultivo no se pudieron establecer, así que no hay rendimiento por hectárea."
                      }
                    >
                      <Box component="span" sx={{ color: "text.disabled", cursor: "help", fontWeight: 600 }}>
                        —
                      </Box>
                    </Tooltip>
                  ) : (
                    formatQuantity(c.kgPerHa)
                  )}
                </Cell>
                <Cell label="Personas">{c.pickers}</Cell>
                <Cell label="Días">{c.days}</Cell>
                <Box>
                  <Typography variant="overline" sx={{ fontSize: 10, color: "text.secondary" }}>
                    Por semana
                  </Typography>
                  <Sparkline
                    values={[...c.byWeek].reverse().map((w) => w.kg)}
                    label={`Evolución semanal de ${c.label}`}
                  />
                </Box>
              </Stack>
            </Stack>

            {c.byWeek.length > 1 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Box sx={{ overflowX: "auto" }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Semana</TableCell>
                        <TableCell align="right">Kilos</TableCell>
                        {canSeeMoney && <TableCell align="right">Valor</TableCell>}
                        <TableCell align="right">Personas</TableCell>
                        <TableCell align="right">Días</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {c.byWeek.map((w) => (
                        <TableRow key={w.weekStart}>
                          <TableCell>
                            <Stack direction="row" spacing={1} alignItems="center">
                              {formatWeekRange(w.weekStart)}
                              {!w.finished && (
                                <Chip size="small" variant="outlined" label="en curso" />
                              )}
                            </Stack>
                          </TableCell>
                          <TableCell align="right">
                            <Kg total={w} showUnit={false} scope="esa semana" />
                          </TableCell>
                          {canSeeMoney && (
                            <TableCell align="right">
                              <Value total={w} scope="esa semana" />
                            </TableCell>
                          )}
                          <TableCell align="right">{w.pickers}</TableCell>
                          <TableCell align="right">{w.days}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              </>
            )}
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ minWidth: 74 }}>
      <Typography variant="overline" sx={{ fontSize: 10, color: "text.secondary", display: "block" }}>
        {label}
      </Typography>
      <Box sx={{ fontWeight: 700, fontSize: "1.05rem" }}>{children}</Box>
    </Box>
  );
}
