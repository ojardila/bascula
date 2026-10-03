// SPDX-License-Identifier: MIT
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
 *  2. The lote of the pesadas being added, remembered on this device. Next to
 *     it, «Buscar por nombre»: people don't arrive in list order, so typing
 *     part of a name («pedro», «ramirez») narrows the list right away; Enter
 *     jumps to the kilos of the first match, Enter there asks to save, and
 *     after the save the search is cleared and ready for the next person.
 *  3. One row per employee: what that person ALREADY has on the day (any
 *     lote, e.g. «2 pesadas · 38 kg») and one big empty box to ADD another.
 *     People come to the scale several times a day, so a filled box is always
 *     a new pesada — nothing registered is replaced. Blank writes nothing.
 *     To fix a wrong number, «Corregir» on the row (owners and
 *     administrators) opens that person's pesadas of the day to change or
 *     take out — on today or any earlier day of a week that is not settled.
 *     A settled week («liquidada») is read-only and says so plainly: a
 *     person with a settled pesada in the week cannot be changed there, and
 *     when the whole week is settled nothing on the screen can be written.
 *  4. «Guardar» asks first — the day, the lote, who and how many kilos — and
 *     then lists exactly what was added.
 *
 * Ids are minted once per approved save (`useWriteOnce`), so a retried save
 * never counts a weighing twice.
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ClearIcon from "@mui/icons-material/Clear";
import SearchIcon from "@mui/icons-material/Search";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import type { Activity, Plot, Worker, WorkRecord } from "../../api/types";
import { PermissionDenied } from "../../components/Guards";
import { useAuth } from "../../auth/AuthContext";
import {
  addDays,
  mondayOf,
  parseDay,
  todayInFarm,
} from "../../lib/dates";
import { formatQuantity } from "../../lib/money";
import { PLOT } from "../../lib/vocab";
import { useWriteOnce } from "../../lib/writeOnce";
import { useOffline } from "../../offline/OfflineContext";
import {
  daysOfWeek,
  isIsoDay,
  pickHarvestActivity,
  workerLabel,
} from "./planilla";
import { MAX_PLAUSIBLE_KG } from "./WeighingForm";
import { weighable } from "../teams/team";
import {
  bulkEntries,
  filterWorkers,
  registeredByWorker,
  weekLocks,
} from "./bulk";
import { CorregirPesadasDialog } from "./CorregirPesadasDialog";
import {
  AddedAlert,
  DayPicker,
  RegistroHeader,
  SaveBar,
  WeekNotices,
  WorkerKilosRow,
  WorkerList,
  dayTitle,
  iso,
  pesadas,
  type Added,
} from "./RegistroMasivoParts";

/** Remembered per device, so the next time opens on the same lote. */
const LAST_LOTE = "bascula.registroMasivo.lote";

export { dayTitle };

export function RegistroMasivoPage() {
  const { can, user } = useAuth();
  const offline = useOffline();
  const today = todayInFarm(user?.farm?.timezone ?? "America/Bogota");
  const [params, setParams] = useSearchParams();

  // `?dia=` names the day; an old `?lunes=` link opens that week on its Monday.
  const diaParam = params.get("dia") ?? "";
  const lunesParam = params.get("lunes") ?? "";
  let asked = today;
  if (isIsoDay(diaParam)) asked = diaParam;
  else if (isIsoDay(lunesParam)) asked = lunesParam;
  const day = asked > today ? today : asked;
  const plotId = params.get("lote") ?? "";
  const week = daysOfWeek(mondayOf(day));

  const [workers, setWorkers] = useState<Worker[] | null>(null);
  const [plots, setPlots] = useState<Plot[] | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  // Every harvest pesada of the week around the day: the day's own are shown,
  // and the week's say whether it is already settled.
  const [weekRecords, setWeekRecords] = useState<{
    monday: string;
    records: WorkRecord[];
  } | null>(null);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [corrected, setCorrected] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const [denied, setDenied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, run: runOnce } = useWriteOnce();
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const kilosRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const lastKilos = useRef<string | null>(null);
  const searching = search.trim() !== "";

  const focusKilos = (workerId: string | null | undefined) => {
    if (workerId) kilosRefs.current[workerId]?.focus();
  };
  const clearSearch = () => {
    setSearch("");
    searchRef.current?.focus();
  };

  function patch(next: Record<string, string>) {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete("lunes");
        for (const [k, v] of Object.entries(next)) p.set(k, v);
        return p;
      },
      { replace: true },
    );
  }

  const setDay = (d: string) => {
    const next = d > today ? today : d;
    if (next === day) return;
    // Kilos typed for one day must never be saved on another.
    if (Object.values(texts).some((t) => t.trim() !== "")) {
      if (
        !window.confirm(
          "Hay kilos escritos sin guardar. Si cambia de día se borran. ¿Cambiar de día?",
        )
      )
        return;
      setTexts({});
    }
    setAdded(null);
    setCorrected(null);
    setSaveError(null);
    patch({ dia: next });
  };

  useEffect(() => {
    Promise.all([
      api.listWorkers({ status: "active" }),
      api.listPlots({ status: "active" }),
      api.listActivities({ status: "active" }),
    ])
      .then(([w, p, a]) => {
        // People in a team are weighed with it: one row, the team's.
        setWorkers(weighable(w));
        setPlots(p);
        setActivity(pickHarvestActivity(a));
        if (!params.get("lote")) {
          const last = localStorage.getItem(LAST_LOTE);
          const pick =
            p.find((x) => x.id === last) ?? (p.length === 1 ? p[0] : null);
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

  // What is already registered in the week of the day, on every lote.
  const monday = week[0];
  useEffect(() => {
    if (!activity) return;
    let cancelled = false;
    loadWeek(activity.id, monday)
      .then((r) => {
        if (!cancelled) setWeekRecords({ monday, records: r });
      })
      .catch((e) => {
        if (!cancelled) setLoadError(messageFor(e));
      });
    return () => {
      cancelled = true;
    };
  }, [activity, monday]);

  if (denied || !can("workRecords.write")) {
    return <PermissionDenied moduleName="el registro de recolección masivo" />;
  }

  const header = (
    <RegistroHeader
      canGoBack={can("harvest.read")}
      canCorrect={can("workRecords.correct")}
    />
  );

  if (loadError)
    return (
      <Box>
        {header}
        <Alert severity="error">{loadError}</Alert>
      </Box>
    );
  if (!workers || !plots) {
    return (
      <Box>
        {header}
        <Stack
          sx={{
            alignItems: "center",
            py: 6,
          }}
        >
          <CircularProgress />
        </Stack>
      </Box>
    );
  }
  if (!activity) {
    return (
      <Box>
        {header}
        <Alert severity="error">
          Esta finca no tiene una actividad de recolección pagada al precio de
          la semana. Sin ella no se sabe qué registrar.
        </Alert>
      </Box>
    );
  }

  const plot = plots.find((p) => p.id === plotId) ?? null;
  const loadedWeek =
    weekRecords?.monday === monday ? weekRecords.records : null;
  const dayRecords = loadedWeek ? recordsOn(loadedWeek, day) : null;
  const { settledWorkers, weekSettled } = weekLocks(loadedWeek ?? []);
  const locked = (workerId: string) =>
    weekSettled || settledWorkers.has(workerId);
  const canCorrect = can("workRecords.correct");
  const soFar = registeredByWorker(dayRecords ?? []);
  const { entries, errors } = bulkEntries(
    workers.filter((w) => !locked(w.id)),
    texts,
  );
  const shown = filterWorkers(workers, search);
  const newKilos = entries.reduce((s, e) => s + e.quantity, 0);
  const dirty = Object.entries(texts).some(
    ([id, t]) => t.trim() !== "" && !locked(id),
  );
  const dayKilos = (dayRecords ?? []).reduce((s, r) => s + r.quantity, 0);
  const correctingWorker = correcting
    ? workers.find((w) => w.id === correcting)
    : null;

  function askToSave() {
    setAdded(null);
    if (errors.length) {
      setSaveError(errors[0]);
      return;
    }
    setSaveError(null);
    setConfirming(true);
  }

  function closeConfirm() {
    setConfirming(false);
    if (searching) setTimeout(() => focusKilos(lastKilos.current), 0);
  }

  async function confirmSave() {
    setConfirming(false);
    if (!activity || !plot || !entries.length) return;
    const cropIds = plot.crops.map((c) => c.id);
    const batch = entries;
    const intent = [
      "masivo",
      day,
      plot.id,
      batch.map((e) => `${e.workerId}:${e.quantity}`).join(";"),
    ].join("|");
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
    if (searching) {
      // Next person: the search is empty and ready to type again.
      setSearch("");
      searchRef.current?.focus();
    }
    setAdded({ day, plotName: plot.name, entries: batch });
    try {
      setWeekRecords({ monday, records: await loadWeek(activity.id, monday) });
    } catch {
      // the pesadas are saved; the list refreshes next time
    }
  }

  const renderRow = (w: Worker) => (
    <WorkerKilosRow
      key={w.id}
      w={w}
      name={workerLabel(w)}
      has={soFar[w.id]}
      isLocked={locked(w.id)}
      weekSettled={weekSettled}
      canCorrect={canCorrect}
      busy={busy}
      online={offline.online}
      text={texts[w.id] ?? ""}
      onTextChange={(v) => {
        setTexts((prev) => ({ ...prev, [w.id]: v }));
        setAdded(null);
      }}
      onKilosFocus={() => {
        lastKilos.current = w.id;
      }}
      onEnterSave={askToSave}
      onNameClick={() => focusKilos(w.id)}
      onCorrect={() => {
        setCorrected(null);
        setCorrecting(w.id);
      }}
      inputRef={(el: HTMLInputElement | null) => {
        kilosRefs.current[w.id] = el;
      }}
    />
  );

  return (
    <Box sx={{ pb: 12, maxWidth: 760 }}>
      {header}

      <DayPicker
        week={week}
        day={day}
        today={today}
        busy={busy}
        setDay={setDay}
      />

      {/* 2. The lote of the new pesadas, and next to it the search by name. */}
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={{ xs: 1.5, sm: 2 }}
        sx={{ mb: 2 }}
      >
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
          sx={{
            flex: 1,
            "& .MuiSelect-select": { fontSize: "1.15rem", py: 1.75 },
          }}
        >
          <MenuItem value="" disabled>
            Elija un lote
          </MenuItem>
          {plots.map((p) => (
            <MenuItem key={p.id} value={p.id} sx={{ fontSize: "1.1rem" }}>
              {p.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          fullWidth
          value={search}
          placeholder="Buscar por nombre o canasto"
          disabled={!plotId || workers.length === 0}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={(e) => {
            // On a phone the keyboard takes half the screen: bring the search
            // to the top so the people it finds show right under it.
            if (window.matchMedia?.("(max-width: 599px)").matches) {
              e.target.scrollIntoView?.({ block: "start", behavior: "smooth" });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              focusKilos(shown[0]?.id);
            } else if (e.key === "Escape" && search) {
              e.preventDefault();
              setSearch("");
            }
          }}
          inputRef={searchRef}
          sx={{
            flex: 1,
            scrollMarginTop: 72,
            "& input": { fontSize: "1.15rem", py: 1.75 },
          }}
          slotProps={{
            input: {
              startAdornment: (
                <SearchIcon
                  sx={{ mr: 1, color: "text.secondary", fontSize: 28 }}
                />
              ),
              endAdornment: search ? (
                <IconButton
                  aria-label="Borrar la búsqueda"
                  onClick={clearSearch}
                  edge="end"
                  sx={{ width: 48, height: 48 }}
                >
                  <ClearIcon sx={{ fontSize: 28 }} />
                </IconButton>
              ) : null,
            },

            htmlInput: {
              "aria-label": "Buscar por nombre",
              autoComplete: "off",
              autoCorrect: "off",
              autoCapitalize: "none",
              spellCheck: false,
              enterKeyHint: "search",
            },
          }}
        />
      </Stack>

      {loadedWeek && (
        <WeekNotices
          weekSettled={weekSettled}
          settledCount={settledWorkers.size}
        />
      )}
      {corrected && (
        <Alert
          severity="success"
          sx={{ mb: 2, fontSize: "1.1rem" }}
          onClose={() => setCorrected(null)}
        >
          <strong>Listo.</strong> {corrected}
        </Alert>
      )}
      {!offline.online && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Sin conexión. Para guardar el registro masivo se necesita señal. Para
          registrar sin señal use «Registrar una recolección».
        </Alert>
      )}
      {saveError && (
        <Alert
          severity="error"
          sx={{ mb: 2, fontSize: "1.05rem" }}
          onClose={() => setSaveError(null)}
        >
          {saveError}
        </Alert>
      )}
      {added && (
        <AddedAlert
          added={added}
          today={today}
          onClose={() => setAdded(null)}
        />
      )}

      {/* 3. One row per employee: what they have, and a box to add one more. */}
      <WorkerList
        plotId={plotId}
        loaded={dayRecords !== null}
        workers={workers}
        shown={shown}
        searching={searching}
        clearSearch={clearSearch}
        renderRow={renderRow}
        dayKilos={dayKilos}
        entriesCount={entries.length}
        newKilos={newKilos}
      />

      {/* 4. Save. Stuck to the bottom only while there is something to save. */}
      {plotId && workers.length > 0 && !(loadedWeek && weekSettled) && (
        <SaveBar
          dirty={dirty}
          count={entries.length}
          busy={busy}
          onSave={askToSave}
        />
      )}

      <Dialog
        open={confirming}
        onClose={closeConfirm}
        maxWidth="xs"
        fullWidth
        // While searching, focus is placed by hand: back on the search after a
        // save, back on the kilos after «Revisar».
        disableRestoreFocus={searching}
      >
        <DialogTitle sx={{ fontSize: "1.4rem" }}>
          ¿Guardar el registro del día?
        </DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: "1.1rem" }}>
            {dayTitle(day, today)} · {plot?.name ?? "el lote"}
          </Typography>
          <Typography sx={{ fontSize: "1.1rem", mt: 1 }}>
            {pesadas(entries.length)} ·{" "}
            <strong>{formatQuantity(newKilos)} kg</strong>
          </Typography>
          <Box
            component="ul"
            sx={{
              m: 0,
              mt: 1,
              pl: 3,
              maxHeight: 220,
              overflowY: "auto",
              fontSize: "1.05rem",
            }}
          >
            {entries.map((e) => (
              <li key={e.workerId}>
                {e.name}: {formatQuantity(e.quantity)} kg
                {e.quantity > MAX_PLAUSIBLE_KG && <strong> ⚠</strong>}
              </li>
            ))}
          </Box>
          {entries.some((e) => e.quantity > MAX_PLAUSIBLE_KG) && (
            <Alert severity="warning" sx={{ mt: 1, fontSize: "1rem" }}>
              ⚠ Es más de lo que carga una persona ({MAX_PLAUSIBLE_KG} kg) en
              una pesada. Revise que no sobre un cero.
            </Alert>
          )}
          <Typography
            sx={{
              color: "text.secondary",
              fontSize: "1rem",
              mt: 1,
            }}
          >
            Se suman a lo ya registrado; no se cambia nada de antes.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1 }}>
          <Button onClick={closeConfirm} size="large">
            Revisar
          </Button>
          <Button
            onClick={() => void confirmSave()}
            variant="contained"
            size="large"
            autoFocus
            sx={{ minHeight: 48, px: 3 }}
          >
            Sí, guardar
          </Button>
        </DialogActions>
      </Dialog>

      {correctingWorker && (
        <CorregirPesadasDialog
          key={correctingWorker.id}
          open
          name={workerLabel(correctingWorker)}
          dayLabel={dayTitle(day, today)}
          records={soFar[correctingWorker.id]?.records ?? []}
          onClose={() => setCorrecting(null)}
          onSaved={(n) => {
            setCorrecting(null);
            const what = n === 1 ? "Se corrigió 1 pesada" : `Se corrigieron ${n} pesadas`;
            setCorrected(
              `${what} de ${workerLabel(correctingWorker)} · ${dayTitle(day, today)}.`,
            );
            void loadWeek(activity.id, monday)
              .then((r) => setWeekRecords({ monday, records: r }))
              .catch(() => undefined);
          }}
        />
      )}
    </Box>
  );
}

/** Every harvest pesada of the week that starts on `monday`, on any lote. */
async function loadWeek(
  activityId: string,
  monday: string,
): Promise<WorkRecord[]> {
  const sunday = iso(addDays(parseDay(monday), 6));
  const records = await api.listWorkRecords({
    activityId,
    from: monday,
    to: sunday,
    status: "active",
  });
  return records.filter((r) => r.dateFrom <= sunday && r.dateTo >= monday);
}

/** The pesadas of one day, oldest first so «Pesada 1» is the first weighing. */
function recordsOn(records: WorkRecord[], day: string): WorkRecord[] {
  return records
    .filter((r) => r.dateFrom <= day && r.dateTo >= day)
    .slice()
    .reverse();
}
