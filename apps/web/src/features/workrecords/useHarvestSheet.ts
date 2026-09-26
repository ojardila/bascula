/**
 * The state and the writes behind a harvest sheet: people × days on one lote.
 *
 * Behind the planilla (`/labores/planilla`): one work record per person, day
 * and lote, with ids minted once so a retried save never counts a weighing
 * twice. The bulk registration (`/cosecha/registro-masivo`) does not use it:
 * there every filled box is a NEW pesada (see `bulk.ts`).
 */
import { useEffect, useState } from "react";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import { useWriteOnce } from "../../lib/writeOnce";
import type { Activity, Plot, Worker } from "../../api/types";
import {
  cellKey, cellsFromRecords, emptyCell, pickHarvestActivity, plannedWrites, type SheetCell,
} from "./planilla";

export interface HarvestSheet {
  workers: Worker[] | null;
  plots: Plot[] | null;
  activity: Activity | null;
  plot: Plot | null;
  cells: Record<string, SheetCell>;
  setCell: (workerId: string, day: string, text: string) => void;
  /** Some cell differs from what the server has. */
  dirty: boolean;
  loadingSheet: boolean;
  loadError: string | null;
  saveError: string | null;
  setSaveError: (e: string | null) => void;
  saved: string | null;
  setSaved: (s: string | null) => void;
  denied: boolean;
  busy: boolean;
  save: () => Promise<boolean>;
}

export function useHarvestSheet({
  days,
  plotId,
  today,
  intentTag,
  onCatalogues,
}: {
  /** Memoised by the caller: a new array reloads the sheet. */
  days: string[];
  plotId: string;
  today: string;
  /** Names the sheet in the write-once intent («dia», «semana»). */
  intentTag: string;
  /** Called once with the lotes, e.g. to pick the only one. */
  onCatalogues?: (plots: Plot[]) => void;
}): HarvestSheet {
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
        onCatalogues?.(p);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.isPermissionDenied) setDenied(true);
        else setLoadError(messageFor(e));
      });
    // catalogues load once; the sheet reloads when the days or the lote change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadCells(ws: Worker[], pid: string, activityId?: string) {
    const records = await api.listWorkRecords({ plotId: pid, activityId, from, to, status: "active" });
    return cellsFromRecords(ws, days, records.filter((r) => r.plotIds.includes(pid)));
  }

  useEffect(() => {
    if (!workers || !plotId) {
      setCells({});
      return;
    }
    let cancelled = false;
    setLoadingSheet(true);
    setSaveError(null);
    setSaved(null);
    loadCells(workers, plotId, activity?.id)
      .then((c) => {
        if (!cancelled) setCells(c);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workers, plotId, from, to, activity?.id, days]);

  function setCell(workerId: string, day: string, text: string) {
    const key = cellKey(workerId, day);
    setCells((prev) => ({ ...prev, [key]: { ...(prev[key] ?? emptyCell()), text } }));
    setSaved(null);
  }

  /** True when something was written. */
  async function save(): Promise<boolean> {
    if (!workers || !activity || !plot) return false;
    setSaveError(null);
    setSaved(null);
    const { writes, errors } = plannedWrites(workers, days, cells, today);
    if (errors.length) {
      setSaveError(errors[0]);
      return false;
    }
    if (!writes.length) {
      setSaved("No hay cambios que guardar.");
      return false;
    }
    const cropIds = plot.crops.map((c) => c.id);
    const intent = ["planilla", intentTag, from, to, plot.id, writes.map((w) => JSON.stringify(w)).join(";")].join("|");
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
    if (!outcome.ran || outcome.value == null) return false;
    const n = outcome.value;
    setSaved(n === 1 ? "Se guardó 1 pesada." : `Se guardaron ${n} pesadas.`);
    setCells(await loadCells(workers, plot.id, activity.id));
    return true;
  }

  const dirty = Object.values(cells).some((c) => c.text !== c.original);

  return {
    workers, plots, activity, plot, cells, setCell, dirty, loadingSheet, loadError,
    saveError, setSaveError, saved, setSaved, denied, busy, save,
  };
}
