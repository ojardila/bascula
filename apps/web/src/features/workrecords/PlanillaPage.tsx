/**
 * Two harvest sheets, same writes.
 *
 * The easy one is the scale: one day, one lote, kilos next to each name.
 * The week grid is still here for whoever fills the paper planilla on Saturday.
 */
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, CircularProgress, MenuItem, Stack,
  Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { PermissionDenied } from "../../components/Guards";
import { DateField } from "../../components/DateField";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { useWriteOnce } from "../../lib/writeOnce";
import { formatDate, formatWeekRange, mondayOf, parseDay, todayInFarm } from "../../lib/dates";
import { PLOT } from "../../lib/vocab";
import type { Activity, Plot, Worker } from "../../api/types";
import {
  DAY_LETTERS, cellKey, cellsFromRecords, daysOfWeek, emptyCell, isIsoDay,
  pickHarvestActivity, planillaMode, plannedWrites, workerLabel, type SheetCell,
} from "./planilla";

function dayHeader(day: string, i: number): string {
  const d = parseDay(day);
  return `${DAY_LETTERS[i]} ${d.getUTCDate()}`;
}

export function PlanillaPage({ lockedMode }: { lockedMode?: "dia" | "semana" } = {}) {
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

  const [workers, setWorkers] = useState<Worker[] | null>(null);
  const [plots, setPlots] = useState<Plot[] | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [cells, setCells] = useState<Record<string, SheetCell>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [loadingSheet, setLoadingSheet] = useState(false);
  const { busy, run: runOnce } = useWriteOnce();

  const days = useMemo(
    () => (mode === "dia" ? [day] : daysOfWeek(monday)),
    [mode, day, monday],
  );
  const from = days[0];
  const to = days[days.length - 1];
  const plot = plots?.find((p) => p.id === plotId) ?? null;

  useEffect(() => {
    Promise.all([
      api.listWorkers({ status: "active" }),
      api.listPlots({ status: "active" }),
      api.listActivities({ status: "active" }),
    ])
      .then(([w, p, a]) => {
        setWorkers(w);
        setPlots(p);
        setActivity(pickHarvestActivity(a));
        if (!params.get("lote") && p.length === 1) {
          setParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set("lote", p[0].id);
            if (mode === "semana") next.set("lunes", monday);
            else next.set("dia", day);
            return next;
          }, { replace: true });
        }
      })
      .catch((e) => {
        if (e instanceof ApiError && e.isPermissionDenied) setDenied(true);
        else setLoadError(messageFor(e));
      });
    // catalogues load once; the sheet reloads when monday/lote change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!workers || !plotId) {
      setCells({});
      return;
    }
    let cancelled = false;
    setLoadingSheet(true);
    setSaveError(null);
    setSaved(null);
    api
      .listWorkRecords({
        plotId,
        activityId: activity?.id,
        from,
        to,
        status: "active",
      })
      .then((records) => {
        if (cancelled) return;
        const mine = records.filter((r) => r.plotIds.includes(plotId));
        setCells(cellsFromRecords(workers, days, mine));
      })
      .catch((e) => {
        if (!cancelled) setLoadError(messageFor(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingSheet(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workers, plotId, from, to, activity?.id, days]);

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

  function setCell(workerId: string, day: string, text: string) {
    const key = cellKey(workerId, day);
    setCells((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? emptyCell()), text },
    }));
    setSaved(null);
  }

  async function save() {
    if (!workers || !activity || !plot) return;
    setSaveError(null);
    setSaved(null);
    const { writes, errors } = plannedWrites(workers, days, cells, today);
    if (errors.length) {
      setSaveError(errors[0]);
      return;
    }
    if (!writes.length) {
      setSaved("No hay cambios que guardar.");
      return;
    }
    const cropIds = plot.crops.map((c) => c.id);
    const intent = ["planilla", mode, from, to, plot.id, writes.map((w) => JSON.stringify(w)).join(";")].join("|");
    const outcome = await runOnce(intent, async (mint) => {
      for (const w of writes) {
        if (w.kind === "create") {
          await api.createWorkRecord({
            id: mint(`wr|${w.workerId}|${w.day}`),
            activityId: activity.id,
            workerId: w.workerId,
            quantity: w.quantity,
            dateFrom: w.day,
            dateTo: w.day,
            plotIds: [plot.id],
            plotCropIds: cropIds,
          });
        } else if (w.kind === "update") {
          await api.updateWorkRecord(w.recordId, { quantity: w.quantity });
        } else {
          await api.deactivateWorkRecord(w.recordId);
        }
      }
      return writes.length;
    }).catch((e: unknown) => {
      setSaveError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran || outcome.value == null) return;
    const n = outcome.value;
    setSaved(n === 1 ? "Se guardó 1 pesada." : `Se guardaron ${n} pesadas.`);
    const records = await api.listWorkRecords({
      plotId: plot.id,
      activityId: activity.id,
      from,
      to,
      status: "active",
    });
    setCells(cellsFromRecords(workers, days, records.filter((r) => r.plotIds.includes(plot.id))));
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

  const dirty = Object.values(cells).some((c) => c.text !== c.original);

  return (
    <Box>
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
        {mode === "dia" ? "Registrar recolección" : "Planilla de la semana"}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {mode === "dia"
          ? "Un lote, un día, los kilos de cada persona. En blanco es que no trabajó ahí."
          : "La planilla de la semana: personas abajo, días al lado. Lo ya liquidado no se cambia."}
      </Typography>

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
