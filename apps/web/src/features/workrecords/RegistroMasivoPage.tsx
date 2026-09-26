/**
 * «REGISTRO DE RECOLECCIÓN MASIVO»: new pesadas for every employee, for ONE
 * day, in one save.
 *
 * Almost always the whole crew comes back to the scale together, so this is
 * the screen used most. It is the same on a phone and on a computer, and it
 * asks for things in the order they happen:
 *
 *  1. The DAY, big and first. Today by default; seven day buttons for the week
 *     (arrows move a week) so «ayer» or «el martes» is one tap. Future days are
 *     disabled.
 *  2. The lote of the pesadas being added, remembered on this device.
 *  3. One row per employee: what that person ALREADY has on the day (any
 *     lote, e.g. «2 pesadas · 38 kg») and one big empty box to ADD another.
 *     People come to the scale several times a day, so a filled box is always
 *     a new pesada — nothing registered is replaced or blocked. Blank writes
 *     nothing. Corrections are done in Labores.
 *  4. «Guardar» asks first — the day, the lote, who and how many kilos — and
 *     then lists exactly what was added.
 *
 * Ids are minted once per approved save (`useWriteOnce`), so a retried save
 * never counts a weighing twice.
 */
import { useEffect, useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import {
  Alert, Box, Button, Card, CardContent, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, IconButton, MenuItem, Paper, Stack, TextField,
  ToggleButton, ToggleButtonGroup, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import SaveIcon from "@mui/icons-material/Save";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import type { Activity, Plot, Worker, WorkRecord } from "../../api/types";
import { PermissionDenied } from "../../components/Guards";
import { useAuth } from "../../auth/AuthContext";
import { addDays, formatWeekRange, mondayOf, parseDay, todayInFarm } from "../../lib/dates";
import { formatQuantity } from "../../lib/money";
import { PLOT } from "../../lib/vocab";
import { useWriteOnce } from "../../lib/writeOnce";
import { useOffline } from "../../offline/OfflineContext";
import { DAY_LETTERS, daysOfWeek, isIsoDay, pickHarvestActivity, workerLabel } from "./planilla";
import { MAX_PLAUSIBLE_KG } from "./WeighingForm";
import { bulkEntries, registeredByWorker, soFarLabel, type BulkEntry } from "./bulk";

const DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"] as const;
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;

/** Remembered per device, so the next time opens on the same lote. */
const LAST_LOTE = "bascula.registroMasivo.lote";

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** «Hoy, viernes 26 de septiembre» · «Ayer, …» · «Martes 22 de septiembre». */
export function dayTitle(day: string, today: string): string {
  const d = parseDay(day);
  const name = DAY_NAMES[(d.getUTCDay() + 6) % 7];
  const rest = `${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`;
  if (day === today) return `Hoy, ${name.toLowerCase()} ${rest}`;
  if (day === iso(addDays(parseDay(today), -1))) return `Ayer, ${name.toLowerCase()} ${rest}`;
  return `${name} ${rest}`;
}


/** What the last save added, to say it plainly afterwards. */
interface Added {
  day: string;
  plotName: string;
  entries: BulkEntry[];
}

export function RegistroMasivoPage() {
  const { can, user } = useAuth();
  const offline = useOffline();
  const today = todayInFarm(user?.farm?.timezone ?? "America/Bogota");
  const [params, setParams] = useSearchParams();

  // `?dia=` names the day; an old `?lunes=` link opens that week on its Monday.
  const diaParam = params.get("dia") ?? "";
  const lunesParam = params.get("lunes") ?? "";
  const asked = isIsoDay(diaParam) ? diaParam : isIsoDay(lunesParam) ? lunesParam : today;
  const day = asked > today ? today : asked;
  const plotId = params.get("lote") ?? "";
  const week = daysOfWeek(mondayOf(day));

  const [workers, setWorkers] = useState<Worker[] | null>(null);
  const [plots, setPlots] = useState<Plot[] | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [dayRecords, setDayRecords] = useState<WorkRecord[] | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const [denied, setDenied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, run: runOnce } = useWriteOnce();

  function patch(next: Record<string, string>) {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.delete("lunes");
      for (const [k, v] of Object.entries(next)) p.set(k, v);
      return p;
    }, { replace: true });
  }

  const setDay = (d: string) => {
    setAdded(null);
    patch({ dia: d > today ? today : d });
  };

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
        if (!params.get("lote")) {
          const last = localStorage.getItem(LAST_LOTE);
          const pick = p.find((x) => x.id === last) ?? (p.length === 1 ? p[0] : null);
          if (pick) patch({ lote: pick.id });
        }
      })
      .catch((e) => {
        if (e instanceof ApiError && e.isPermissionDenied) setDenied(true);
        else setLoadError(messageFor(e));
      });
    // the catalogues load once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What is already registered on the day, on every lote.
  useEffect(() => {
    if (!activity) return;
    let cancelled = false;
    setDayRecords(null);
    loadDay(activity.id, day)
      .then((r) => {
        if (!cancelled) setDayRecords(r);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(messageFor(e));
      });
    return () => {
      cancelled = true;
    };
  }, [activity, day]);

  if (denied || !can("workRecords.write")) {
    return <PermissionDenied moduleName="el registro de recolección masivo" />;
  }

  const header = (
    <>
      {can("harvest.read") && (
        <Button component={RouterLink} to="/cosecha" startIcon={<ArrowBackIcon />} sx={{ mb: 1, fontSize: "1rem" }}>
          Volver a la cosecha
        </Button>
      )}
      <Typography variant="h1" gutterBottom>
        Registro de recolección masivo
      </Typography>
      <Typography sx={{ mb: 2, fontSize: "1.1rem" }} color="text.secondary">
        Las pesadas de todos los empleados en un día. Elija el día y el lote, y escriba los
        kilos de cada persona. Cada número es una pesada nueva; lo ya registrado no se cambia.
        Si no pesó, déjelo en blanco.
      </Typography>
    </>
  );

  if (loadError) return <Box>{header}<Alert severity="error">{loadError}</Alert></Box>;
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

  const plot = plots.find((p) => p.id === plotId) ?? null;
  const soFar = registeredByWorker(dayRecords ?? []);
  const { entries, errors } = bulkEntries(workers, texts);
  const newKilos = entries.reduce((s, e) => s + e.quantity, 0);
  const dirty = Object.values(texts).some((t) => t.trim() !== "");
  const dayKilos = (dayRecords ?? []).reduce((s, r) => s + r.quantity, 0);
  const prevMonday = iso(addDays(parseDay(week[0]), -7));
  const nextMonday = iso(addDays(parseDay(week[0]), 7));
  const pesadas = (n: number) => (n === 1 ? "1 pesada nueva" : `${n} pesadas nuevas`);

  function askToSave() {
    setAdded(null);
    if (errors.length) {
      setSaveError(errors[0]);
      return;
    }
    if (!entries.length) return;
    setSaveError(null);
    setConfirming(true);
  }

  async function confirmSave() {
    setConfirming(false);
    if (!activity || !plot || !entries.length) return;
    const cropIds = plot.crops.map((c) => c.id);
    const batch = entries;
    const intent = ["masivo", day, plot.id, batch.map((e) => `${e.workerId}:${e.quantity}`).join(";")].join("|");
    const outcome = await runOnce(intent, async (mint) => {
      for (const e of batch) {
        await api.createWorkRecord({
          id: mint(`wr|${e.workerId}`),
          activityId: activity.id,
          workerId: e.workerId,
          quantity: e.quantity,
          dateFrom: day,
          dateTo: day,
          plotIds: [plot.id],
          plotCropIds: cropIds,
        });
      }
      return batch.length;
    }).catch((e: unknown) => {
      setSaveError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    setTexts({});
    setAdded({ day, plotName: plot.name, entries: batch });
    try {
      setDayRecords(await loadDay(activity.id, day));
    } catch {
      // the pesadas are saved; the list refreshes next time
    }
  }

  return (
    <Box sx={{ pb: 12, maxWidth: 760 }}>
      {header}

      {/* 1. The day — first and biggest. */}
      <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 }, mb: 2, borderRadius: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          <Typography sx={{ fontSize: "1rem", fontWeight: 600, color: "text.secondary" }}>Día</Typography>
          <Box sx={{ flex: 1 }} />
          <IconButton aria-label="Semana anterior" onClick={() => setDay(prevMonday)} size="small" disabled={busy}>
            <ChevronLeftIcon />
          </IconButton>
          <Typography sx={{ fontSize: "0.95rem", color: "text.secondary", minWidth: 96, textAlign: "center" }}>
            {formatWeekRange(week[0])}
          </Typography>
          <IconButton
            aria-label="Semana siguiente"
            onClick={() => setDay(nextMonday)}
            disabled={busy || nextMonday > today}
            size="small"
          >
            <ChevronRightIcon />
          </IconButton>
        </Stack>
        <ToggleButtonGroup
          exclusive
          value={day}
          onChange={(_, v: string | null) => v && setDay(v)}
          aria-label="Día"
          disabled={busy}
          sx={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", width: "100%" }}
        >
          {week.map((d, i) => (
            <ToggleButton
              key={d}
              value={d}
              disabled={busy || d > today}
              aria-label={dayTitle(d, today)}
              sx={{
                flexDirection: "column", py: 1, px: 0, lineHeight: 1.2,
                "&.Mui-selected": { bgcolor: "primary.main", color: "#fff", "&:hover": { bgcolor: "primary.dark" } },
              }}
            >
              <Box component="span" sx={{ fontWeight: 700, fontSize: "1rem" }}>{DAY_LETTERS[i]}</Box>
              <Box component="span" sx={{ fontSize: "1.1rem" }}>{parseDay(d).getUTCDate()}</Box>
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mt: 1.5, flexWrap: "wrap" }} useFlexGap>
          <Typography variant="h2" component="p" sx={{ flex: 1, minWidth: 200 }}>
            {dayTitle(day, today)}
          </Typography>
          {day !== today && (
            <Button variant="outlined" onClick={() => setDay(today)} disabled={busy}>Ir a hoy</Button>
          )}
        </Stack>
      </Paper>

      {/* 2. The lote of the new pesadas. */}
      <TextField
        select
        fullWidth
        label={`${PLOT.One} de las pesadas nuevas`}
        value={plotId}
        disabled={busy}
        onChange={(e) => {
          localStorage.setItem(LAST_LOTE, e.target.value);
          patch({ lote: e.target.value });
        }}
        sx={{ mb: 2, maxWidth: 420, "& .MuiSelect-select": { fontSize: "1.15rem", py: 1.75 } }}
      >
        <MenuItem value="" disabled>Elija un lote</MenuItem>
        {plots.map((p) => (
          <MenuItem key={p.id} value={p.id} sx={{ fontSize: "1.1rem" }}>{p.name}</MenuItem>
        ))}
      </TextField>

      {!offline.online && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Sin conexión. Para guardar el registro masivo se necesita señal. Para registrar sin
          señal use «Registrar una recolección».
        </Alert>
      )}
      {saveError && (
        <Alert severity="error" sx={{ mb: 2, fontSize: "1.05rem" }} onClose={() => setSaveError(null)}>
          {saveError}
        </Alert>
      )}
      {added && (
        <Alert severity="success" sx={{ mb: 2, fontSize: "1.1rem" }} onClose={() => setAdded(null)}>
          <strong>Listo.</strong>{" "}
          {added.entries.length === 1 ? "Se agregó 1 pesada nueva" : `Se agregaron ${added.entries.length} pesadas nuevas`}
          {" "}· {dayTitle(added.day, today)} · {added.plotName}:
          <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 3 }}>
            {added.entries.map((e) => (
              <li key={e.workerId}>
                {e.name}: <strong>{formatQuantity(e.quantity)} kg</strong>
              </li>
            ))}
          </Box>
        </Alert>
      )}

      {/* 3. One row per employee: what they have, and a box to add one more. */}
      {!plotId ? (
        <Alert severity="info">Elija el lote.</Alert>
      ) : !dayRecords ? (
        <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress /></Stack>
      ) : workers.length === 0 ? (
        <Alert severity="info">No hay empleados activos. Regístrelos primero en Empleados.</Alert>
      ) : (
        <>
          <Stack spacing={1.25}>
            {workers.map((w) => {
              const name = workerLabel(w);
              const has = soFar[w.id];
              return (
                <Card key={w.id} variant="outlined">
                  <CardContent sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 1.25, "&:last-child": { pb: 1.25 } }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 600, fontSize: "1.1rem" }}>{name}</Typography>
                      <Typography sx={{ fontSize: "0.95rem", color: "text.secondary" }}>
                        {has ? (
                          <>
                            Ya tiene: <strong>{soFarLabel(has, formatQuantity)}</strong>
                            <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>
                              {" "}({has.records.map((r) => `${formatQuantity(r.quantity)} kg ${r.plotNames.join(", ")}`.trim()).join(" · ")})
                            </Box>
                          </>
                        ) : (
                          "Sin pesadas este día"
                        )}
                      </Typography>
                    </Box>
                    <TextField
                      value={texts[w.id] ?? ""}
                      placeholder="+"
                      onChange={(e) => {
                        const v = e.target.value;
                        setTexts((prev) => ({ ...prev, [w.id]: v }));
                        setAdded(null);
                      }}
                      disabled={busy}
                      inputProps={{ inputMode: "decimal", "aria-label": `${name}, kilos` }}
                      InputProps={{ endAdornment: <Typography sx={{ ml: 0.5, color: "text.secondary" }}>kg</Typography> }}
                      sx={{ width: { xs: 128, sm: 150 }, flexShrink: 0, "& input": { textAlign: "right", fontSize: 26, fontWeight: 600, py: 1.5 } }}
                    />
                  </CardContent>
                </Card>
              );
            })}
          </Stack>
          <Typography sx={{ mt: 2, fontSize: "1.15rem" }}>
            Registrado este día: <strong>{formatQuantity(dayKilos)} kg</strong>
            {entries.length > 0 && <> · por agregar: <strong>{formatQuantity(newKilos)} kg</strong></>}
          </Typography>
        </>
      )}

      {/* 4. Save. Stuck to the bottom only while there is something to save. */}
      {plotId && workers.length > 0 && (
        <Paper
          elevation={dirty ? 6 : 0}
          variant={dirty ? "elevation" : "outlined"}
          sx={{
            position: dirty ? "sticky" : "static",
            bottom: 12, mt: 3, p: 1.5, borderRadius: 3,
            display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap", zIndex: 2,
          }}
        >
          <Typography sx={{ flex: 1, minWidth: 160, fontSize: "1.05rem" }} color={dirty ? "text.primary" : "text.secondary"}>
            {dirty ? `${pesadas(entries.length)} sin guardar` : "Escriba los kilos para agregar pesadas"}
          </Typography>
          <Button
            variant="contained"
            size="large"
            startIcon={<SaveIcon />}
            onClick={askToSave}
            disabled={busy || !dirty}
            sx={{ minHeight: 56, px: 4, fontSize: "1.15rem", borderRadius: 3, flexGrow: { xs: 1, sm: 0 } }}
          >
            Guardar
          </Button>
        </Paper>
      )}

      <Dialog open={confirming} onClose={() => setConfirming(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: "1.4rem" }}>¿Guardar el registro del día?</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: "1.1rem" }}>
            {dayTitle(day, today)} · {plot?.name ?? "el lote"}
          </Typography>
          <Typography sx={{ fontSize: "1.1rem", mt: 1 }}>
            {pesadas(entries.length)} · <strong>{formatQuantity(newKilos)} kg</strong>
          </Typography>
          <Box component="ul" sx={{ m: 0, mt: 1, pl: 3, maxHeight: 220, overflowY: "auto", fontSize: "1.05rem" }}>
            {entries.map((e) => (
              <li key={e.workerId}>
                {e.name}: {formatQuantity(e.quantity)} kg
                {e.quantity > MAX_PLAUSIBLE_KG && <strong> ⚠</strong>}
              </li>
            ))}
          </Box>
          {entries.some((e) => e.quantity > MAX_PLAUSIBLE_KG) && (
            <Alert severity="warning" sx={{ mt: 1, fontSize: "1rem" }}>
              ⚠ Es más de lo que carga una persona ({MAX_PLAUSIBLE_KG} kg) en una pesada. Revise
              que no sobre un cero.
            </Alert>
          )}
          <Typography sx={{ fontSize: "1rem", mt: 1 }} color="text.secondary">
            Se suman a lo ya registrado; no se cambia nada de antes.
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

/** Every harvest pesada of the day, on any lote. */
async function loadDay(activityId: string, day: string): Promise<WorkRecord[]> {
  const records = await api.listWorkRecords({ activityId, from: day, to: day, status: "active" });
  return records.filter((r) => r.dateFrom <= day && r.dateTo >= day);
}
