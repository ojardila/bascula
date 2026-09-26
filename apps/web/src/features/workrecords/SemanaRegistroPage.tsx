/**
 * «REGISTRAR LA SEMANA»: the kilos of everybody on one lote, day by day.
 *
 * The paper planilla the farm already fills on Saturday, on a screen:
 * people down the side, days across. It saves the same way the old planilla
 * did (`useHarvestSheet`) — one work record per person, day and lote.
 *
 * Built for somebody who does not live in software:
 *  - On a computer it is the grid, with a total per person and per day.
 *  - On a phone a grid of 7 columns is unreadable, so it shows ONE DAY at a
 *    time: seven big day buttons across the top, and under them one big box
 *    per person. The day's total is under the list.
 *  - One button saves, and it asks first, saying how many kilos it is about
 *    to save, then says clearly that it did.
 *  - A day in the future cannot be filled, and a settled weighing cannot be
 *    changed; both are shown greyed out.
 */
import { useMemo, useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, IconButton, MenuItem, Paper, Stack, Table, TableBody,
  TableCell, TableHead, TableRow, TextField, ToggleButton, ToggleButtonGroup, Typography,
  useMediaQuery, useTheme,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import SaveIcon from "@mui/icons-material/Save";
import { PermissionDenied } from "../../components/Guards";
import { useAuth } from "../../auth/AuthContext";
import { addDays, formatWeekRange, mondayOf, parseDay, todayInFarm } from "../../lib/dates";
import { formatQuantity } from "../../lib/money";
import { PLOT } from "../../lib/vocab";
import { useOffline } from "../../offline/OfflineContext";
import { DAY_LETTERS, cellKey, daysOfWeek, emptyCell, isIsoDay, plannedWrites, workerLabel } from "./planilla";
import { parseQuantity } from "./validation";
import { useHarvestSheet } from "./useHarvestSheet";

const DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"] as const;

function dayLabel(day: string, i: number): string {
  return `${DAY_LETTERS[i]} ${parseDay(day).getUTCDate()}`;
}

function kgOf(text: string): number {
  const q = parseQuantity(text);
  return q !== null && q > 0 ? q : 0;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Remembered per device, so the next week opens on the same lote. */
const LAST_LOTE = "bascula.registrarSemana.lote";

export function SemanaRegistroPage() {
  const { can, user } = useAuth();
  const offline = useOffline();
  const today = todayInFarm(user?.farm?.timezone ?? "America/Bogota");
  const phone = useMediaQuery(useTheme().breakpoints.down("md"));
  const [params, setParams] = useSearchParams();

  const lunesParam = params.get("lunes") ?? "";
  const monday = isIsoDay(lunesParam) && lunesParam <= today ? mondayOf(lunesParam) : mondayOf(today);
  const plotId = params.get("lote") ?? "";
  const days = useMemo(() => daysOfWeek(monday), [monday]);
  const prevMonday = iso(addDays(parseDay(monday), -7));
  const nextMonday = iso(addDays(parseDay(monday), 7));

  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const day = pickedDay && days.includes(pickedDay)
    ? pickedDay
    : (days.includes(today) ? today : days[0]);
  const [confirming, setConfirming] = useState(false);

  function patch(next: Record<string, string>) {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(next)) p.set(k, v);
      return p;
    }, { replace: true });
  }

  const sheet = useHarvestSheet({
    days,
    plotId,
    today,
    intentTag: "semana",
    onCatalogues: (p) => {
      if (params.get("lote")) return;
      // The lote used last time on this device, or the only one there is.
      const last = localStorage.getItem(LAST_LOTE);
      const pick = p.find((x) => x.id === last) ?? (p.length === 1 ? p[0] : null);
      if (pick) patch({ lote: pick.id });
    },
  });
  const { workers, plots, activity, cells, setCell, dirty, busy } = sheet;

  if (sheet.denied || !can("workRecords.write")) {
    return <PermissionDenied moduleName="registrar la semana" />;
  }

  const header = (
    <>
      {can("harvest.read") && (
        <Button component={RouterLink} to="/cosecha" startIcon={<ArrowBackIcon />} sx={{ mb: 1, fontSize: "1rem" }}>
          Volver a la cosecha
        </Button>
      )}
      <Typography variant="h1" gutterBottom>
        Registrar la semana
      </Typography>
      <Typography sx={{ mb: 2, fontSize: "1.1rem" }} color="text.secondary">
        Escriba los kilos de cada persona. Si no trabajó, déjelo en blanco.
      </Typography>
    </>
  );

  if (sheet.loadError) return <Box>{header}<Alert severity="error">{sheet.loadError}</Alert></Box>;
  if (!workers || !plots) {
    return (
      <Box>
        {header}
        <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress /></Stack>
      </Box>
    );
  }
  if (!activity) {
    return (
      <Box>
        {header}
        <Alert severity="error">
          Esta finca no tiene una actividad de recolección pagada al precio de la semana.
          Sin ella no se sabe qué registrar.
        </Alert>
      </Box>
    );
  }

  const cellOf = (workerId: string, d: string) => cells[cellKey(workerId, d)] ?? emptyCell();
  const rowTotal = (workerId: string) => days.reduce((s, d) => s + kgOf(cellOf(workerId, d).text), 0);
  const dayTotal = (d: string) => workers.reduce((s, w) => s + kgOf(cellOf(w.id, d).text), 0);
  const weekTotal = days.reduce((s, d) => s + dayTotal(d), 0);
  const planned = plannedWrites(workers, days, cells, today);
  const changes = planned.writes.length;

  function askToSave() {
    sheet.setSaved(null);
    if (planned.errors.length) {
      sheet.setSaveError(planned.errors[0]);
      return;
    }
    sheet.setSaveError(null);
    setConfirming(true);
  }

  async function confirmSave() {
    setConfirming(false);
    await sheet.save();
  }

  const input = (workerId: string, name: string, d: string, i: number, large: boolean) => {
    const cell = cellOf(workerId, d);
    const future = d > today;
    return (
      <TextField
        value={cell.text}
        onChange={(e) => setCell(workerId, d, e.target.value)}
        disabled={busy || cell.settled || future}
        placeholder={future ? "—" : ""}
        inputProps={{ inputMode: "decimal", "aria-label": `${name}, ${dayLabel(d, i)}` }}
        sx={{
          width: large ? 140 : 76,
          "& input": { textAlign: "right", fontSize: large ? 26 : 18, fontWeight: 600, py: large ? 1.5 : 1 },
        }}
        InputProps={large ? { endAdornment: <Typography sx={{ ml: 0.5, color: "text.secondary" }}>kg</Typography> } : undefined}
      />
    );
  };

  return (
    <Box sx={{ pb: 12 }}>
      {header}

      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ xs: "stretch", sm: "center" }} sx={{ mb: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ border: 1, borderColor: "divider", borderRadius: 3, px: 1, py: 0.5, bgcolor: "background.paper" }}>
          <IconButton aria-label="Semana anterior" onClick={() => patch({ lunes: prevMonday })} size="large">
            <ChevronLeftIcon fontSize="large" />
          </IconButton>
          <Box sx={{ flex: 1, textAlign: "center", minWidth: 150 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              {monday === mondayOf(today) ? "Esta semana" : "Semana"}
            </Typography>
            <Typography sx={{ fontWeight: 700, fontSize: "1.2rem" }}>{formatWeekRange(monday)}</Typography>
          </Box>
          <IconButton
            aria-label="Semana siguiente"
            onClick={() => patch({ lunes: nextMonday })}
            disabled={nextMonday > today}
            size="large"
          >
            <ChevronRightIcon fontSize="large" />
          </IconButton>
        </Stack>
        <TextField
          select
          label={PLOT.One}
          value={plotId}
          onChange={(e) => {
            localStorage.setItem(LAST_LOTE, e.target.value);
            patch({ lote: e.target.value });
          }}
          sx={{ minWidth: 240, "& .MuiSelect-select": { fontSize: "1.15rem", py: 1.75 } }}
        >
          <MenuItem value="" disabled>Elija un lote</MenuItem>
          {plots.map((p) => (
            <MenuItem key={p.id} value={p.id} sx={{ fontSize: "1.1rem" }}>{p.name}</MenuItem>
          ))}
        </TextField>
      </Stack>

      {!offline.online && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Sin conexión. Para guardar la semana se necesita señal. Para registrar sin señal use
          «Registrar una recolección».
        </Alert>
      )}
      {sheet.saveError && (
        <Alert severity="error" sx={{ mb: 2, fontSize: "1.05rem" }} onClose={() => sheet.setSaveError(null)}>
          {sheet.saveError}
        </Alert>
      )}
      {sheet.saved && (
        <Alert severity="success" sx={{ mb: 2, fontSize: "1.1rem" }} onClose={() => sheet.setSaved(null)}>
          <strong>Listo.</strong> {sheet.saved}
        </Alert>
      )}

      {!plotId ? (
        <Alert severity="info">Elija el lote.</Alert>
      ) : sheet.loadingSheet ? (
        <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress /></Stack>
      ) : workers.length === 0 ? (
        <Alert severity="info">No hay empleados activos. Regístrelos primero en Empleados.</Alert>
      ) : phone ? (
        <>
          <ToggleButtonGroup
            exclusive
            value={day}
            onChange={(_, v: string | null) => v && setPickedDay(v)}
            aria-label="Día"
            sx={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", mb: 2, bgcolor: "background.paper" }}
          >
            {days.map((d, i) => (
              <ToggleButton
                key={d}
                value={d}
                disabled={d > today}
                aria-label={`${DAY_NAMES[i]} ${parseDay(d).getUTCDate()}`}
                sx={{ flexDirection: "column", py: 1, px: 0, lineHeight: 1.2, "&.Mui-selected": { bgcolor: "primary.main", color: "#fff", "&:hover": { bgcolor: "primary.dark" } } }}
              >
                <Box component="span" sx={{ fontWeight: 700, fontSize: "1rem" }}>{DAY_LETTERS[i]}</Box>
                <Box component="span" sx={{ fontSize: "1.1rem" }}>{parseDay(d).getUTCDate()}</Box>
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Typography variant="h2" sx={{ mb: 1 }}>
            {DAY_NAMES[days.indexOf(day)]} {parseDay(day).getUTCDate()}
          </Typography>
          <Stack spacing={1.25}>
            {workers.map((w) => (
              <Card key={w.id} variant="outlined">
                <CardContent sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 1.25, "&:last-child": { pb: 1.25 } }}>
                  <Typography sx={{ flex: 1, fontWeight: 600, fontSize: "1.1rem", minWidth: 0 }}>
                    {workerLabel(w)}
                  </Typography>
                  {input(w.id, workerLabel(w), day, days.indexOf(day), true)}
                </CardContent>
              </Card>
            ))}
          </Stack>
          <Typography sx={{ mt: 2, fontSize: "1.15rem" }}>
            Total del día: <strong>{formatQuantity(dayTotal(day))} kg</strong> · Semana:{" "}
            <strong>{formatQuantity(weekTotal)} kg</strong>
          </Typography>
        </>
      ) : (
        <Card>
          <CardContent sx={{ overflowX: "auto" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, fontSize: "1rem", minWidth: 180 }}>Empleado</TableCell>
                  {days.map((d, i) => (
                    <TableCell key={d} align="right" sx={{ fontWeight: 700, fontSize: "1rem", color: d > today ? "text.disabled" : undefined }}>
                      {dayLabel(d, i)}
                    </TableCell>
                  ))}
                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: "1rem" }}>Total</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {workers.map((w) => (
                  <TableRow key={w.id} hover>
                    <TableCell sx={{ fontWeight: 600, fontSize: "1rem" }}>{workerLabel(w)}</TableCell>
                    {days.map((d, i) => (
                      <TableCell key={d} align="right" sx={{ p: 0.5 }}>
                        {input(w.id, workerLabel(w), d, i, false)}
                      </TableCell>
                    ))}
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: "1rem", whiteSpace: "nowrap" }}>
                      {formatQuantity(rowTotal(w.id))} kg
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, fontSize: "1rem" }}>Total del día</TableCell>
                  {days.map((d) => (
                    <TableCell key={d} align="right" sx={{ fontWeight: 700, fontSize: "1rem" }}>
                      {d > today ? "—" : formatQuantity(dayTotal(d))}
                    </TableCell>
                  ))}
                  <TableCell align="right" sx={{ fontWeight: 800, fontSize: "1.05rem", whiteSpace: "nowrap" }}>
                    {formatQuantity(weekTotal)} kg
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {plotId && workers.length > 0 && (
        <Paper
          elevation={dirty ? 6 : 0}
          variant={dirty ? "elevation" : "outlined"}
          sx={{
            // Stuck to the bottom only while there is something to save.
            position: dirty ? "sticky" : "static",
            bottom: 12,
            mt: 3,
            p: 1.5,
            borderRadius: 3,
            display: "flex",
            alignItems: "center",
            gap: 2,
            flexWrap: "wrap",
            zIndex: 2,
          }}
        >
          <Typography sx={{ flex: 1, minWidth: 160, fontSize: "1.05rem" }} color={dirty ? "text.primary" : "text.secondary"}>
            {dirty
              ? (changes === 1 ? "1 cambio sin guardar" : `${changes} cambios sin guardar`)
              : "Todo está guardado"}
          </Typography>
          <Button
            variant="contained"
            size="large"
            startIcon={<SaveIcon />}
            onClick={askToSave}
            disabled={busy || !dirty}
            sx={{ minHeight: 56, px: 4, fontSize: "1.15rem", borderRadius: 3, flexGrow: { xs: 1, sm: 0 } }}
          >
            Guardar la semana
          </Button>
        </Paper>
      )}

      <Dialog open={confirming} onClose={() => setConfirming(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: "1.4rem" }}>¿Guardar la semana?</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: "1.1rem" }}>
            {changes === 1 ? "Se va a guardar 1 cambio" : `Se van a guardar ${changes} cambios`} en{" "}
            {plots.find((p) => p.id === plotId)?.name ?? "el lote"}, semana {formatWeekRange(monday)}.
          </Typography>
          <Typography sx={{ fontSize: "1.1rem", mt: 1 }}>
            Total de la semana: <strong>{formatQuantity(weekTotal)} kg</strong>
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1 }}>
          <Button onClick={() => setConfirming(false)} size="large">Revisar</Button>
          <Button onClick={() => void confirmSave()} variant="contained" size="large" sx={{ minHeight: 48, px: 3 }}>
            Sí, guardar
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
