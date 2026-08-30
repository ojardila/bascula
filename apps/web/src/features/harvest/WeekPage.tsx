/**
 * One week, in the two grids the owner actually uses.
 *
 * Worker x day answers "who turned up and when". Worker x crop answers "where
 * did the coffee come from". The server folds both from the same cells, so
 * `byDay.total` and `byCrop.total` are equal and each grid's margins agree
 * with its grand total.
 *
 * THE SCREEN CHECKS ANYWAY. Deriving the margins together is a promise, not a
 * proof, and this is a table a farm settles from. If it ever fails to
 * cross-foot, the screen says so at the top rather than showing a tidy table
 * that is wrong.
 *
 * THE UNATTRIBUTED COLUMN IS NEVER HIDDEN. The crop grid can carry a column
 * with a null key: weighings that name no crop, or name several. Splitting
 * them would be a guess and counting them twice would break the grid, so they
 * get a column of their own. Hiding it would make the remaining columns fail
 * to add up to the total — which would read as OUR bug rather than as a
 * property of the data. It is shown, and it is explained.
 *
 * THE EMPTY CELL. A person who did not work on Wednesday gets a placeholder,
 * not a zero. "0 kg" says they came and picked nothing; blank says they were
 * not there. On a table used to settle a week, those are different claims.
 */
import { useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Stack, Table,
  TableBody, TableCell, TableFooter, TableHead, TableRow, ToggleButton,
  ToggleButtonGroup, Tooltip, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import { useAsync } from "../../lib/useAsync";
import { PermissionDenied } from "../../components/Guards";
import { reportWeek } from "../../api/harvest";
import { formatWeekRange, mondayOf, weekTag } from "../../lib/dates";
import { useHarvest } from "./HarvestLayout";
import { Kg, Stat, Value } from "./Figures";
import { unattributedReason } from "./text";
import { kgForDrawing, type Totals } from "./totals";
import type { WireReportGrid } from "../../api/wire";
import { PICKER } from "../../lib/vocab";

const DAY_LETTER = ["D", "L", "M", "X", "J", "V", "S"];

/** "L 24" — a column header narrow enough for seven of them plus a total. */
function dayHeader(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return `${DAY_LETTER[d.getUTCDay()]} ${d.getUTCDate()}`;
}

/** Does this grid actually add up, by rows and by columns? */
function crossFoots(grid: WireReportGrid): boolean {
  const cent = 1e-6;
  const total = kgForDrawing(grid.total);
  const rows = grid.rows.reduce((s, r) => s + kgForDrawing(r.total), 0);
  const cols = grid.columns.reduce((s, c) => s + kgForDrawing(c.total), 0);
  return Math.abs(rows - total) < cent && Math.abs(cols - total) < cent;
}

export function WeekPage() {
  const { monday = "" } = useParams();
  const { today, rangeKey, canSeeMoney } = useHarvest();
  const [axis, setAxis] = useState<"day" | "crop">("day");

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(monday) && mondayOf(monday) === monday;

  const { data, error, denied } = useAsync(
    async () => (valid ? reportWeek(monday) : null),
    [monday, valid],
  );

  const back = (
    <Button
      component={RouterLink}
      to={`/cosecha?rango=${rangeKey}`}
      startIcon={<ArrowBackIcon />}
      size="small"
    >
      Volver a la temporada
    </Button>
  );

  if (denied) return <PermissionDenied moduleName="ver la cosecha" />;

  if (!valid) {
    return (
      <Stack spacing={2} alignItems="flex-start">
        {back}
        <Alert severity="error">
          «{monday}» no nombra una semana. Una semana se nombra por su lunes, en
          formato AAAA-MM-DD.
        </Alert>
      </Stack>
    );
  }

  if (error) {
    return (
      <Stack spacing={2} alignItems="flex-start">
        {back}
        <Alert severity="error">
          No se pudo consultar la semana: {error}. Ninguna cifra se pudo calcular — y
          ninguna de ellas es cero.
        </Alert>
      </Stack>
    );
  }

  if (!data) {
    return (
      <Stack alignItems="center" sx={{ py: 6 }}>
        <CircularProgress />
      </Stack>
    );
  }

  const grid = axis === "day" ? data.byDay : data.byCrop;
  const tag = weekTag(monday, today);
  const balances = crossFoots(grid);

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ flexWrap: "wrap" }}>
        {back}
        <Typography variant="h2">{formatWeekRange(monday)}</Typography>
        {tag && <Chip size="small" variant="outlined" label={tag} />}
        {!data.finished && (
          <Chip size="small" color="warning" variant="outlined" label="semana en curso" />
        )}
      </Stack>

      {/* Emptiness is a property of the WEEK, not of the axis being shown. Read
          off the visible grid, a week whose work is all unattributed would look
          empty in one tab and full in the other. */}
      {data.total.records === 0 ? (
        <Alert severity="info">
          Nadie recogió en la semana del {formatWeekRange(monday)}. Es una respuesta,
          no un error.
        </Alert>
      ) : (
        <>
          {!balances && (
            <Alert severity="error" icon={<WarningAmberIcon />}>
              Los totales de esta tabla no cuadran por filas y columnas. No la use para
              liquidar: avísele a quien mantiene el sistema.
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
              <Kg total={data.total} align="flex-start" bold scope="la semana" />
            </Stat>
            {canSeeMoney && (
              <Stat label="Valor de la semana">
                <Value total={data.total} scope="la semana" align="flex-start" />
              </Stat>
            )}
            <Stat label={PICKER.Many}>{grid.rows.length}</Stat>
            <Stat label={axis === "day" ? "Días trabajados" : "Cultivos"}>
              {grid.columns.length}
            </Stat>
          </Box>

          <Card>
            <CardContent>
              <Stack
                direction={{ xs: "column", sm: "row" }}
                justifyContent="space-between"
                alignItems={{ xs: "stretch", sm: "center" }}
                spacing={2}
                sx={{ mb: 2 }}
              >
                <Box>
                  <Typography variant="h3">Quién recogió, y dónde</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {axis === "day"
                      ? "Kilos por recolector y día. Una celda vacía es un día que no trabajó."
                      : "Kilos por recolector y cultivo. Una celda vacía es un cultivo donde no estuvo."}
                  </Typography>
                </Box>
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={axis}
                  onChange={(_, v) => v && setAxis(v)}
                >
                  <ToggleButton value="day">Por día</ToggleButton>
                  <ToggleButton value="crop">Por cultivo</ToggleButton>
                </ToggleButtonGroup>
              </Stack>

              {axis === "crop" && grid.unattributed && (
                <Alert severity="info" icon={<HelpOutlineIcon />} sx={{ mb: 2 }}>
                  <strong>Sin cultivo asignado.</strong>{" "}
                  {unattributedReason(
                    grid.unattributed.noCropLink,
                    grid.unattributed.sharedAcrossCrops,
                  )}
                </Alert>
              )}

              <Box sx={{ overflowX: "auto" }}>
                <Table size="small" sx={{ minWidth: 520 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell
                        sx={{ position: "sticky", left: 0, bgcolor: "#f2f5f0", zIndex: 1, minWidth: 150 }}
                      >
                        {PICKER.One}
                      </TableCell>
                      {grid.columns.map((c) => (
                        <TableCell
                          key={c.key ?? "__unattributed"}
                          align="right"
                          sx={{ whiteSpace: "nowrap" }}
                        >
                          {c.key === null ? (
                            <Tooltip title="Pesadas que no dicen en qué cultivo se recogieron, o que nombran varios. Van aparte para que los totales cuadren.">
                              <Box component="span" sx={{ cursor: "help" }}>
                                Sin asignar
                              </Box>
                            </Tooltip>
                          ) : axis === "day" ? (
                            dayHeader(c.key)
                          ) : (
                            c.label
                          )}
                        </TableCell>
                      ))}
                      <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                        Total
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {grid.rows.map((r) => {
                      const cells = new Map<string, Totals>(
                        r.cells.map((c) => [c.column ?? "__unattributed", c]),
                      );
                      return (
                        <TableRow key={r.workerId} hover>
                          <TableCell
                            sx={{ position: "sticky", left: 0, bgcolor: "background.paper", zIndex: 1 }}
                          >
                            <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{r.name}</Typography>
                          </TableCell>
                          {grid.columns.map((c) => {
                            const key = c.key ?? "__unattributed";
                            const cell = cells.get(key);
                            return (
                              <TableCell key={key} align="right">
                                {cell === undefined ? (
                                  <Tooltip
                                    title={
                                      axis === "day"
                                        ? `${r.name} no registró recolección ese día.`
                                        : `${r.name} no recogió en ${c.label} esa semana.`
                                    }
                                  >
                                    <Box
                                      component="span"
                                      aria-label={
                                        axis === "day"
                                          ? `${r.name} no registró recolección ese día`
                                          : `${r.name} no recogió en ${c.label} esa semana`
                                      }
                                      sx={{ color: "text.disabled", cursor: "help" }}
                                    >
                                      ·
                                    </Box>
                                  </Tooltip>
                                ) : (
                                  <Kg total={cell} showUnit={false} />
                                )}
                              </TableCell>
                            );
                          })}
                          <TableCell align="right">
                            <Kg total={r.total} showUnit={false} bold />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell
                        sx={{
                          position: "sticky", left: 0, bgcolor: "#f2f5f0", zIndex: 1,
                          fontWeight: 700, color: "text.primary", fontSize: 13,
                        }}
                      >
                        Total
                      </TableCell>
                      {grid.columns.map((c) => (
                        <TableCell
                          key={c.key ?? "__unattributed"}
                          align="right"
                          sx={{ fontWeight: 700, color: "text.primary", fontSize: 13 }}
                        >
                          <Kg total={c.total} showUnit={false} bold />
                        </TableCell>
                      ))}
                      <TableCell align="right" sx={{ fontWeight: 700, color: "text.primary", fontSize: 13 }}>
                        <Kg total={grid.total} bold />
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </Box>

              <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, display: "block" }}>
                Los días sin recolección no aparecen: la finca no trabajó, no recogió cero.
              </Typography>
            </CardContent>
          </Card>

          {canSeeMoney && (
            <Card>
              <CardContent>
                <Typography variant="h3" gutterBottom>
                  Lo que valió cada {axis === "day" ? "día" : "cultivo"}
                </Typography>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>{axis === "day" ? "Día" : "Cultivo"}</TableCell>
                      <TableCell align="right">Kilos</TableCell>
                      <TableCell align="right">Valor</TableCell>
                      <TableCell align="right">Pesadas</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {grid.columns.map((c) => (
                      <TableRow key={c.key ?? "__unattributed"}>
                        <TableCell>{c.key === null ? "Sin asignar" : c.label}</TableCell>
                        <TableCell align="right">
                          <Kg total={c.total} showUnit={false} />
                        </TableCell>
                        <TableCell align="right">
                          <Value total={c.total} scope={c.label} />
                        </TableCell>
                        <TableCell align="right">{c.total.records}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </Stack>
  );
}
