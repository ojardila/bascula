/**
 * Arithmetic of the harvest sheet: people × days, kilos in the cells.
 *
 * The scale uses one day; the Saturday planilla uses seven. Same writes.
 */
import { addDays, parseDay } from "../../lib/dates";
import { parseQuantity } from "./validation";
import type { Activity, WorkRecord, Worker } from "../../api/types";

export function pickHarvestActivity(activities: Activity[]): Activity | null {
  const weekly = activities.filter((a) => a.rateSource === "weekly_price");
  if (weekly.length === 0) return null;
  const named = weekly.find((a) => /recolecci[oó]n/i.test(a.name));
  return named ?? weekly[0];
}

export const DAY_LETTERS = ["L", "M", "X", "J", "V", "S", "D"] as const;

export function isIsoDay(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * The week grid is `?lunes=` (and the Cosecha week button). Everything else,
 * including a bare /labores/planilla, is the easy sheet: one day, one lote.
 */
export function planillaMode(params: { modo: string | null; lunes: string | null; dia: string | null }): "dia" | "semana" {
  if (params.modo === "semana") return "semana";
  if (params.modo === "dia") return "dia";
  if (params.lunes && !params.dia) return "semana";
  return "dia";
}

export function daysOfWeek(monday: string): string[] {
  const start = parseDay(monday);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i).toISOString().slice(0, 10));
}

export function workerLabel(w: Worker): string {
  return `${w.name} ${w.lastName}`.trim();
}

export function cellKey(workerId: string, day: string): string {
  return `${workerId}:${day}`;
}

export interface SheetCell {
  text: string;
  recordId: string | null;
  settled: boolean;
  original: string;
  /**
   * How many weighings this cell adds up. A picker can bring coffee to the
   * scale several times a day; the cell shows the sum and is read-only when
   * it is more than one, because one box cannot say which weighing to change.
   */
  records?: number;
}

export function emptyCell(): SheetCell {
  return { text: "", recordId: null, settled: false, original: "" };
}

/** Fill the sheet from records that already belong to this week and lote. */
export function cellsFromRecords(
  workers: Worker[],
  days: string[],
  records: WorkRecord[],
): Record<string, SheetCell> {
  const out: Record<string, SheetCell> = {};
  for (const w of workers) {
    for (const day of days) out[cellKey(w.id, day)] = emptyCell();
  }
  for (const r of records) {
    if (r.status === "inactive") continue;
    const day = r.dateFrom.slice(0, 10);
    const key = cellKey(r.workerId, day);
    const existing = out[key];
    if (!existing) continue;
    if (existing.recordId) {
      // Another weighing the same day on the same lote: add it up.
      const sum = (parseQuantity(existing.text) ?? 0) + r.quantity;
      const text = formatKg(Math.round(sum * 1000) / 1000);
      out[key] = {
        ...existing,
        text,
        original: text,
        settled: existing.settled || r.settled,
        records: (existing.records ?? 1) + 1,
      };
      continue;
    }
    const text = formatKg(r.quantity);
    out[key] = {
      text,
      recordId: r.id,
      settled: r.settled,
      original: text,
      records: 1,
    };
  }
  return out;
}

export function formatKg(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(n).replace(".", ",");
}

export type CellWrite =
  | { kind: "create"; workerId: string; day: string; quantity: number }
  | { kind: "update"; recordId: string; quantity: number }
  | { kind: "remove"; recordId: string };

export function plannedWrites(
  workers: Worker[],
  days: string[],
  cells: Record<string, SheetCell>,
  today: string,
): { writes: CellWrite[]; errors: string[] } {
  const writes: CellWrite[] = [];
  const errors: string[] = [];
  for (const w of workers) {
    for (const day of days) {
      if (day > today) continue;
      const cell = cells[cellKey(w.id, day)] ?? emptyCell();
      if (cell.settled || (cell.records ?? 0) > 1) continue;
      const raw = cell.text.trim();
      if (raw === cell.original) continue;
      if (raw === "") {
        if (cell.recordId) writes.push({ kind: "remove", recordId: cell.recordId });
        continue;
      }
      const qty = parseQuantity(raw);
      if (qty === null || qty <= 0) {
        errors.push(`${workerLabel(w)} el ${day}: la cantidad no es un número`);
        continue;
      }
      if (cell.recordId) writes.push({ kind: "update", recordId: cell.recordId, quantity: qty });
      else writes.push({ kind: "create", workerId: w.id, day, quantity: qty });
    }
  }
  return { writes, errors };
}
