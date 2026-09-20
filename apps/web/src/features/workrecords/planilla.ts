/**
 * One week's harvest sheet: people down the side, calendar days across.
 *
 * The screen that uses this is a matrix of kilos. This file is the arithmetic
 * of that matrix — which days, which cells changed, what to write — so a
 * double-click cannot invent a second weighing and a test can walk the cases
 * without rendering a table.
 */
import { addDays, parseDay } from "../../lib/dates";
import { parseQuantity } from "./validation";
import type { WorkRecord, Worker } from "../../api/types";

export const DAY_LETTERS = ["L", "M", "X", "J", "V", "S", "D"] as const;

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
    if (!existing || existing.recordId) continue;
    const text = formatKg(r.quantity);
    out[key] = {
      text,
      recordId: r.id,
      settled: r.settled,
      original: text,
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
      if (cell.settled) continue;
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
