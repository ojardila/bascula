/**
 * ONE WEIGHING AT A TIME, ON A PHONE, NEXT TO THE SCALE.
 *
 * It replaced the retired phone app's «Registrar recolección».
 * It is used standing up, with one hand, by somebody who does not live in
 * software, so everything on it is big and in the order the weighing happens:
 * who, which lote, which day, how many kilos, save. After saving, the kilos
 * and the person clear and the lote and the day stay: the next person in the
 * line is on the same lote on the same day.
 *
 *  - The lote weighed last on this device is picked again on the next visit.
 *  - The same person can be weighed several times a day (one trip per lote,
 *    or several trips): each weighing is its own record.
 *  - Lotes are big buttons when there are few of them. A dropdown is two taps
 *    and a scroll; a button is one tap.
 *  - The day is «Hoy» / «Ayer» / «Otro día». Nearly every weighing is one of
 *    the first two.
 *  - A weight above what one person carries asks before saving, like the
 *    phone did (120 kg, `MAX_PLAUSIBLE_WEIGHT`). The typed extra zero is the
 *    most common mistake at the scale.
 *  - «Deshacer» on what was just saved, and the list of what was saved on
 *    this screen, so the person at the scale can read back the last few.
 *  - NO SIGNAL IS NORMAL AT THE SCALE. The lists of people and lotes are kept
 *    on the device from the last load; a weighing that cannot reach the server
 *    is kept on the device with the id it was minted with, and uploaded later
 *    by `OfflineProvider`. Re-sending that id is a no-op on the server, so a
 *    weighing that did arrive but whose answer was lost is never counted twice.
 */
import { useEffect, useRef, useState } from "react";
import {
  Alert, Autocomplete, Box, Button, Card, CardContent, Dialog, DialogActions, DialogContent,
  DialogTitle, InputAdornment, List, ListItem, ListItemText, MenuItem, Stack, TextField,
  ToggleButton, ToggleButtonGroup, Typography,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import { DateField } from "../../components/DateField";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { useAuth } from "../../auth/AuthContext";
import { useWriteOnce } from "../../lib/writeOnce";
import { addDays, formatDate, parseDay, todayInFarm } from "../../lib/dates";
import { formatQuantity } from "../../lib/money";
import { PLOT } from "../../lib/vocab";
import type { Activity, Plot, Worker } from "../../api/types";
import { parseQuantity } from "./validation";
import { useOffline } from "../../offline/OfflineContext";
import { getCache, putCache } from "../../offline/store";
import { pickHarvestActivity, workerLabel } from "./planilla";

/** Above this, one load is almost certainly a typing mistake. */
export const MAX_PLAUSIBLE_KG = 120;
/** With this many lotes or fewer, they are buttons instead of a list. */
const LOTE_BUTTONS = 6;

export interface SavedWeighing {
  id: string;
  who: string;
  plot: string;
  day: string;
  kg: number;
  /** Kept on this device, not yet on the server. */
  local?: boolean;
}

interface Refs {
  workers: Worker[];
  plots: Plot[];
  activities: Activity[];
}

/** The request never got an answer from our server: keep it for later. */
function noSignal(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 0 || e.status >= 502);
}

type DayChoice = "hoy" | "ayer" | "otro";

const big = { fontSize: "1.2rem" } as const;
/** A chosen button has to look chosen from arm's length, not a shade of grey. */
const chosen = {
  "& .MuiToggleButton-root.Mui-selected": {
    bgcolor: "primary.main",
    color: "#fff",
    fontWeight: 700,
    "&:hover": { bgcolor: "primary.dark" },
  },
} as const;

export function WeighingForm() {
  const { user } = useAuth();
  const today = todayInFarm(user?.farm?.timezone ?? "America/Bogota");
  const yesterday = addDays(parseDay(today), -1).toISOString().slice(0, 10);
  const { busy, run } = useWriteOnce();
  const [workers, setWorkers] = useState<Worker[] | null>(null);
  const [plots, setPlots] = useState<Plot[] | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [worker, setWorker] = useState<Worker | null>(null);
  const [plotId, setPlotId] = useState("");
  const [dayChoice, setDayChoice] = useState<DayChoice>("hoy");
  const [otherDay, setOtherDay] = useState(today);
  const [kg, setKg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [doubt, setDoubt] = useState<number | null>(null);
  const [saved, setSaved] = useState<SavedWeighing[]>([]);
  const [undone, setUndone] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState<string | null>(null);
  const personRef = useRef<HTMLInputElement>(null);
  const offline = useOffline();
  const farmId = user?.farm?.id ?? "";
  const refsKey = `refs:${farmId}`;
  const lastLoteKey = `bascula.pesada.lote:${farmId}`;

  const day = dayChoice === "hoy" ? today : dayChoice === "ayer" ? yesterday : otherDay;

  useEffect(() => {
    let cancelled = false;
    const show = (r: Refs) => {
      if (cancelled) return;
      setWorkers(r.workers);
      setPlots(r.plots);
      setActivity(pickHarvestActivity(r.activities));
      // The lote weighed last on this device: the next person in line has
      // most likely come back from the same one.
      const last = localStorage.getItem(lastLoteKey);
      if (last && r.plots.some((p) => p.id === last)) setPlotId(last);
      else if (r.plots.length === 1) setPlotId(r.plots[0].id);
    };
    Promise.all([
      api.listWorkers({ status: "active" }),
      api.listPlots({ status: "active" }),
      api.listActivities({ status: "active" }),
    ])
      .then(([workers, plots, activities]) => {
        const r = { workers, plots, activities };
        show(r);
        void putCache(refsKey, r).catch(() => undefined);
      })
      .catch(async (e: unknown) => {
        if (!noSignal(e)) {
          if (!cancelled) setError(messageFor(e));
          return;
        }
        const cached = await getCache<Refs>(refsKey).catch(() => null);
        if (cancelled) return;
        if (!cached) {
          setError(
            "Sin señal y sin lista guardada. Abra esta pantalla una vez con internet para que el celular guarde las personas y los lotes.",
          );
          setWorkers([]);
          setPlots([]);
          return;
        }
        show(cached.value);
        setFromCache(formatDate(cached.savedAt.slice(0, 10)));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refsKey]);

  function check(): number | null {
    setError(null);
    setUndone(null);
    if (!worker) {
      setError("Elija a la persona.");
      return null;
    }
    if (!plotId) {
      setError("Elija el lote.");
      return null;
    }
    const qty = parseQuantity(kg);
    if (qty === null || qty <= 0) {
      setError("Escriba los kilos.");
      return null;
    }
    if (!activity) {
      setError("La finca no tiene una actividad de recolección. Pídale al administrador que la cree.");
      return null;
    }
    return qty;
  }

  function onSave() {
    const qty = check();
    if (qty === null) return;
    if (qty > MAX_PLAUSIBLE_KG) {
      setDoubt(qty);
      return;
    }
    void save(qty);
  }

  async function save(qty: number) {
    setDoubt(null);
    if (!worker || !activity) return;
    const plot = plots?.find((p) => p.id === plotId);
    const who = workerLabel(worker);
    const outcome = await run(`uno|${worker.id}|${plotId}|${day}|${qty}`, async (mint) => {
      const id = mint();
      const input = {
        id,
        activityId: activity.id,
        workerId: worker.id,
        quantity: qty,
        dateFrom: day,
        dateTo: day,
        plotIds: [plotId],
        plotCropIds: plot?.crops.map((c) => c.id) ?? [],
      };
      const keep = async () => {
        await offline.enqueue({ id, input, who, plot: plot?.name ?? "", kg: qty, day });
        return { id, local: true };
      };
      if (!offline.online && offline.canQueue) return keep();
      try {
        await api.createWorkRecord(input);
        return { id, local: false };
      } catch (e) {
        if (noSignal(e) && offline.canQueue) return keep();
        throw e;
      }
    }).catch((e: unknown) => {
      setError(messageFor(e));
      return { ran: false } as const;
    });
    if (!outcome.ran) return;
    setSaved((prev) => [
      { id: outcome.value.id, who, plot: plot?.name ?? "", day, kg: qty, local: outcome.value.local },
      ...prev,
    ]);
    localStorage.setItem(lastLoteKey, plotId);
    setKg("");
    setWorker(null);
    setTimeout(() => personRef.current?.focus(), 50);
  }

  async function undo(w: SavedWeighing) {
    setError(null);
    try {
      if (offline.pending.some((p) => p.id === w.id)) await offline.remove(w.id);
      else await api.deactivateWorkRecord(w.id);
      setSaved((prev) => prev.filter((s) => s.id !== w.id));
      setUndone(`Se borró la pesada de ${w.who}: ${formatQuantity(w.kg)} kg.`);
    } catch (e) {
      setError(messageFor(e));
    }
  }

  const last = saved[0];
  const lastStillLocal = !!last && offline.pending.some((p) => p.id === last.id);
  const fewLotes = (plots?.length ?? 0) > 0 && (plots?.length ?? 0) <= LOTE_BUTTONS;

  return (
    <Stack spacing={2.5} sx={{ maxWidth: { xs: "100%", sm: 560 } }}>
      <Card>
        <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack spacing={3}>
            {error && <Alert severity="error" onClose={() => setError(null)} sx={big}>{error}</Alert>}
            {fromCache && (
              <Alert severity="warning" onClose={() => setFromCache(null)} sx={big}>
                Sin señal: usando la lista de personas y lotes guardada en este celular ({fromCache}).
              </Alert>
            )}
            {undone && <Alert severity="info" onClose={() => setUndone(null)} sx={big}>{undone}</Alert>}
            {last && !error && !undone && (
              <Alert
                severity="success"
                icon={<CheckCircleIcon fontSize="inherit" />}
                sx={{ ...big, alignItems: "center" }}
                action={<Button color="inherit" onClick={() => void undo(last)}>Deshacer</Button>}
              >
                {lastStillLocal
                  ? `Guardado en este celular: ${last.who}, ${formatQuantity(last.kg)} kg. Se sube cuando vuelva la señal.`
                  : `Guardado: ${last.who}, ${formatQuantity(last.kg)} kg`}
              </Alert>
            )}

            <Autocomplete
              options={workers ?? []}
              getOptionLabel={(w) => workerLabel(w)}
              value={worker}
              onChange={(_, v) => setWorker(v)}
              loading={!workers}
              noOptionsText="No hay nadie con ese nombre"
              ListboxProps={{ style: { fontSize: "1.15rem" } }}
              renderInput={(p) => (
                <TextField {...p} inputRef={personRef} label="Persona" required sx={{ "& input": big }} />
              )}
            />

            {fewLotes ? (
              <Box>
                <Typography id="lote-label" sx={{ fontWeight: 700, mb: 1 }}>{PLOT.One}</Typography>
                <ToggleButtonGroup
                  exclusive
                  value={plotId}
                  onChange={(_, v: string | null) => v && setPlotId(v)}
                  aria-labelledby="lote-label"
                  sx={{ ...chosen, flexWrap: "wrap", gap: 1, "& .MuiToggleButton-root": { border: "1px solid", borderRadius: "12px !important", ml: "0 !important" } }}
                >
                  {(plots ?? []).map((p) => (
                    <ToggleButton key={p.id} value={p.id} sx={{ ...big, minHeight: 56, px: 2.5, textTransform: "none" }}>
                      {p.name}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              </Box>
            ) : (
              <TextField select label={PLOT.One} value={plotId} onChange={(e) => setPlotId(e.target.value)} required sx={{ "& .MuiSelect-select": big }}>
                <MenuItem value="" disabled>Elija un lote</MenuItem>
                {(plots ?? []).map((p) => (
                  <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>
                ))}
              </TextField>
            )}

            <Box>
              <Typography id="dia-label" sx={{ fontWeight: 700, mb: 1 }}>Día</Typography>
              <ToggleButtonGroup
                exclusive
                fullWidth
                value={dayChoice}
                onChange={(_, v: DayChoice | null) => v && setDayChoice(v)}
                aria-labelledby="dia-label"
                sx={chosen}
              >
                <ToggleButton value="hoy" sx={{ ...big, minHeight: 56, textTransform: "none" }}>Hoy</ToggleButton>
                <ToggleButton value="ayer" sx={{ ...big, minHeight: 56, textTransform: "none" }}>Ayer</ToggleButton>
                <ToggleButton value="otro" sx={{ ...big, minHeight: 56, textTransform: "none" }}>Otro día</ToggleButton>
              </ToggleButtonGroup>
              {dayChoice === "otro" && (
                <Box sx={{ mt: 2 }}>
                  <DateField label="Fecha" value={otherDay} onChange={setOtherDay} max={today} />
                </Box>
              )}
            </Box>

            <TextField
              label="Kilos"
              value={kg}
              onChange={(e) => setKg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSave();
              }}
              inputProps={{ inputMode: "decimal", "aria-label": "Kilos", enterKeyHint: "done" }}
              InputProps={{ endAdornment: <InputAdornment position="end"><Typography sx={{ fontSize: 24 }}>kg</Typography></InputAdornment> }}
              sx={{ "& input": { fontSize: 40, fontWeight: 700, py: 1.5 } }}
              required
            />

            <Button
              variant="contained"
              size="large"
              onClick={onSave}
              disabled={busy}
              sx={{ minHeight: 64, fontSize: "1.3rem", borderRadius: 3 }}
            >
              {busy ? "Guardando…" : "Guardar pesada"}
            </Button>
          </Stack>
        </CardContent>
      </Card>

      {offline.pending.length > 0 && (
        <Card sx={{ borderLeft: 6, borderColor: "info.main" }}>
          <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 1 }}>
              <Typography variant="h3">Pesadas por subir ({offline.pending.length})</Typography>
              {offline.online && (
                <Button variant="outlined" disabled={offline.syncing} onClick={() => void offline.flush()}>
                  {offline.syncing ? "Subiendo…" : "Subir ahora"}
                </Button>
              )}
            </Stack>
            <Typography color="text.secondary" sx={{ mb: 1 }}>
              Están guardadas en este celular. Se suben solas cuando hay señal.
            </Typography>
            <List dense disablePadding>
              {offline.pending.map((p) => (
                <ListItem
                  key={p.id}
                  disableGutters
                  divider
                  secondaryAction={
                    p.error ? (
                      <Button color="error" onClick={() => void offline.remove(p.id)}>Borrar</Button>
                    ) : undefined
                  }
                >
                  <ListItemText
                    primary={`${p.who} · ${formatQuantity(p.kg)} kg`}
                    secondary={p.error ? `No se pudo subir: ${p.error}` : `${p.plot} · ${p.day === today ? "hoy" : formatDate(p.day)}`}
                    primaryTypographyProps={{ fontSize: "1.1rem", fontWeight: 600 }}
                    secondaryTypographyProps={p.error ? { color: "error" } : undefined}
                  />
                </ListItem>
              ))}
            </List>
          </CardContent>
        </Card>
      )}

      {saved.length > 0 && (
        <Card>
          <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h3" gutterBottom>
              Guardadas en esta pantalla
            </Typography>
            <List dense disablePadding>
              {saved.slice(0, 20).map((s) => (
                <ListItem key={s.id} disableGutters divider>
                  <ListItemText
                    primary={`${s.who} · ${formatQuantity(s.kg)} kg`}
                    secondary={`${s.plot} · ${s.day === today ? "hoy" : formatDate(s.day)}`}
                    primaryTypographyProps={{ fontSize: "1.1rem", fontWeight: 600 }}
                  />
                </ListItem>
              ))}
            </List>
          </CardContent>
        </Card>
      )}

      <Dialog open={doubt !== null} onClose={() => setDoubt(null)} maxWidth="xs" fullWidth>
        <DialogTitle>¿{doubt !== null ? formatQuantity(doubt) : ""} kg en una sola pesada?</DialogTitle>
        <DialogContent>
          <Typography sx={big}>
            Es más de lo que carga una persona ({MAX_PLAUSIBLE_KG} kg). Revise que no sobre un cero.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDoubt(null)} variant="contained" size="large">Corregir</Button>
          <Button onClick={() => doubt !== null && void save(doubt)} color="inherit" size="large">Sí, guardar</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
