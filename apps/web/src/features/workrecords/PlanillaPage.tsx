/**
 * Two harvest sheets, same writes.
 *
 * The easy one is the scale: one day, one lote, kilos next to each name.
 * The week grid is still here for whoever fills the paper planilla on Saturday.
 */
import { useMemo } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, CircularProgress, MenuItem, Stack,
  Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { PermissionDenied } from "../../components/Guards";
import { DateField } from "../../components/DateField";
import { useAuth } from "../../auth/AuthContext";
import { formatDate, formatWeekRange, mondayOf, parseDay, todayInFarm } from "../../lib/dates";
import { PLOT } from "../../lib/vocab";
import {
  DAY_LETTERS, cellKey, daysOfWeek, emptyCell, isIsoDay, planillaMode, workerLabel,
} from "./planilla";
import { useHarvestSheet } from "./useHarvestSheet";

function dayHeader(day: string, i: number): string {
  const d = parseDay(day);
  return `${DAY_LETTERS[i]} ${d.getUTCDate()}`;
}

export function PlanillaPage({
  lockedMode,
  hideChrome,
}: {
  lockedMode?: "dia" | "semana";
  /** Parent already drew the title and back link. */
  hideChrome?: boolean;
} = {}) {
  const { can, user } = useAuth();
  const timezone = user?.farm?.timezone ?? "America/Bogota";
  const today = todayInFarm(timezone);
  const [params, setParams] = useSearchParams();

  const mondayParam = params.get("lunes") ?? "";
  const diaParam = params.get("dia") ?? "";
  const mode = lockedMode ?? planillaMode({
    modo: params.get("modo"),
    lunes: mondayParam,
    dia: diaParam,
  });
  const monday = isIsoDay(mondayParam) && mondayOf(mondayParam) === mondayParam
    ? mondayParam
    : mondayOf(isIsoDay(diaParam) ? diaParam : today);
  const day = isIsoDay(diaParam) && diaParam <= today
    ? diaParam
    : (mode === "dia" ? today : monday);
  const plotId = params.get("lote") ?? "";

  const days = useMemo(
    () => (mode === "dia" ? [day] : daysOfWeek(monday)),
    [mode, day, monday],
  );

  const {
    workers, plots, activity, cells, setCell, dirty, loadingSheet, loadError,
    saveError, setSaveError, saved, setSaved, denied, busy, save,
  } = useHarvestSheet({
    days,
    plotId,
    today,
    intentTag: mode,
    onCatalogues: (p) => {
      if (!params.get("lote") && p.length === 1) {
        setParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set("lote", p[0].id);
          if (mode === "semana") next.set("lunes", monday);
          else next.set("dia", day);
          return next;
        }, { replace: true });
      }
    },
  });

  function patchParams(patch: Record<string, string | null>) {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) p.delete(k);
        else p.set(k, v);
      }
      if (plotId && !("lote" in patch)) p.set("lote", plotId);
      return p;
    });
  }

  function setMode(next: "dia" | "semana") {
    if (next === "semana") {
      patchParams({ modo: "semana", lunes: mondayOf(isIsoDay(diaParam) ? diaParam : today), dia: null });
    } else {
      patchParams({ modo: "dia", dia: today, lunes: null });
    }
  }

  function setMonday(iso: string) {
    if (!iso) return;
    patchParams({ modo: "semana", lunes: mondayOf(iso), dia: null });
  }

  function setDay(iso: string) {
    if (!iso || iso > today) return;
    patchParams({ modo: "dia", dia: iso, lunes: null });
  }

  function setPlot(id: string) {
    patchParams({ lote: id });
  }

  if (denied || !can("workRecords.write")) {
    return <PermissionDenied moduleName="registrar la planilla de recolección" />;
  }

  if (loadError) {
    return <Alert severity="error">{loadError}</Alert>;
  }

  if (!workers || !plots) {
    return (
      <Stack alignItems="center" sx={{ py: 6 }}>
        <CircularProgress />
      </Stack>
    );
  }

  if (!activity) {
    return (
      <Alert severity="error">
        Esta finca no tiene una actividad de recolección pagada al precio de la
        semana. Sin ella la planilla no sabe qué registrar.
      </Alert>
    );
  }

  return (
    <Box>
      {!hideChrome && (
        <>
      <Button
        component={RouterLink}
        to="/cosecha"
        startIcon={<ArrowBackIcon />}
        size="small"
        sx={{ mb: 2 }}
      >
        Volver a la cosecha
      </Button>

      <Typography variant="h1" gutterBottom>
        {mode === "dia" ? "Planilla del día" : "Planilla de la semana"}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {mode === "dia"
          ? "Un lote, un día, los kilos de cada persona. En blanco es que no trabajó ahí."
          : "La planilla de la semana: personas abajo, días al lado. Lo ya liquidado no se cambia."}
      </Typography>
        </>
      )}

      {!lockedMode && (
        <Tabs
          value={mode}
          onChange={(_, v: "dia" | "semana") => setMode(v)}
          sx={{ mb: 2 }}
        >
          <Tab value="dia" label="Por día" />
          <Tab value="semana" label="Semana" />
        </Tabs>
      )}

      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        sx={{ mb: 2 }}
        alignItems={{ xs: "stretch", sm: "flex-end" }}
      >
        {mode === "dia" ? (
          <DateField
            label="Día"
            value={day}
            onChange={setDay}
            max={today}
          />
        ) : (
          <DateField
            label="Semana"
            value={monday}
            onChange={setMonday}
            helperText={`Semana del ${formatWeekRange(monday)}`}
            max={today}
          />
        )}
        <TextField
          select
          label={PLOT.One}
          value={plotId}
          onChange={(e) => setPlot(e.target.value)}
          sx={{ minWidth: 240 }}
        >
          <MenuItem value="" disabled>
            Elija un lote
          </MenuItem>
          {plots.map((p) => (
            <MenuItem key={p.id} value={p.id}>
              {p.name}
            </MenuItem>
          ))}
        </TextField>
        <Button
          variant="contained"
          onClick={() => void save()}
          disabled={busy || !plotId || !dirty}
        >
          Guardar
        </Button>
      </Stack>

      {saveError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setSaveError(null)}>
          {saveError}
        </Alert>
      )}
      {saved && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSaved(null)}>
          {saved}
        </Alert>
      )}

      {!plotId ? (
        <Alert severity="info">Elija el lote de esta planilla.</Alert>
      ) : loadingSheet ? (
        <Stack alignItems="center" sx={{ py: 6 }}>
          <CircularProgress />
        </Stack>
      ) : (
        <Card>
          <CardContent sx={{ overflowX: "auto" }}>
            {mode === "dia" ? (
              <Stack spacing={1.5}>
                {workers.map((w) => {
                  const cell = cells[cellKey(w.id, day)] ?? emptyCell();
                  const future = day > today;
                  return (
                    <Stack
                      key={w.id}
                      direction="row"
                      spacing={2}
                      alignItems="center"
                    >
                      <Typography sx={{ flex: 1, fontWeight: 600, minWidth: 0 }}>
                        {workerLabel(w)}
                      </Typography>
                      <TextField
                        value={cell.text}
                        onChange={(e) => setCell(w.id, day, e.target.value)}
                        disabled={busy || cell.settled || future}
                        placeholder="kg"
                        inputProps={{
                          inputMode: "decimal",
                          "aria-label": `${workerLabel(w)}, kilos`,
                        }}
                        size="medium"
                        sx={{
                          width: 120,
                          "& input": { textAlign: "right", fontSize: 20, py: 1.25 },
                        }}
                      />
                    </Stack>
                  );
                })}
              </Stack>
            ) : (
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, minWidth: 160 }}>
                    Empleado
                  </TableCell>
                  {days.map((d, i) => (
                    <TableCell key={d} align="right" sx={{ fontWeight: 700, minWidth: 88 }}>
                      <div>{dayHeader(d, i)}</div>
                      <Typography variant="caption" color="text.secondary">
                        {formatDate(d).slice(0, 5)}
                      </Typography>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {workers.map((w) => (
                  <TableRow key={w.id} hover>
                    <TableCell sx={{ fontWeight: 600 }}>{workerLabel(w)}</TableCell>
                    {days.map((d) => {
                      const cell = cells[cellKey(w.id, d)] ?? emptyCell();
                      const future = d > today;
                      return (
                        <TableCell key={d} align="right" sx={{ p: 0.5 }}>
                          <TextField
                            value={cell.text}
                            onChange={(e) => setCell(w.id, d, e.target.value)}
                            disabled={busy || cell.settled || future}
                            placeholder={future ? "—" : ""}
                            inputProps={{
                              inputMode: "decimal",
                              "aria-label": `${workerLabel(w)}, ${dayHeader(d, days.indexOf(d))}`,
                            }}
                            size="small"
                            sx={{
                              width: 84,
                              "& input": { textAlign: "right", py: 0.75 },
                            }}
                          />
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            )}
            {workers.length === 0 && (
              <Alert severity="info" sx={{ mt: 2 }}>
                No hay empleados activos. Regístrelos primero para llenar la planilla.
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
    </Box>
  );
}
