/**
 * The pure half of «Registro de recolección masivo»: what a filled form means.
 *
 * Every filled box is a NEW pesada. A person can come to the scale several
 * times a day, so nothing already registered is ever changed or replaced from
 * this screen; a blank box writes nothing.
 */
import type { Worker, WorkRecord } from "../../api/types";
import { workerLabel } from "./planilla";
import { parseQuantity } from "./validation";

export interface BulkEntry {
  workerId: string;
  name: string;
  quantity: number;
}

/** The new pesadas a form asks for, in the order of the list, or why it can't. */
export function bulkEntries(
  workers: Worker[],
  texts: Record<string, string>,
): { entries: BulkEntry[]; errors: string[] } {
  const entries: BulkEntry[] = [];
  const errors: string[] = [];
  for (const w of workers) {
    const raw = (texts[w.id] ?? "").trim();
    if (raw === "") continue;
    const q = parseQuantity(raw);
    if (q === null) errors.push(`Revise los kilos de ${workerLabel(w)}: «${raw}» no es un número.`);
    else if (q <= 0) errors.push(`Revise los kilos de ${workerLabel(w)}: deben ser más de cero.`);
    else entries.push({ workerId: w.id, name: workerLabel(w), quantity: q });
  }
  return { entries, errors };
}

export interface DaySoFar {
  count: number;
  kilos: number;
  records: WorkRecord[];
}

/** What each person already has on the day, on any lote. */
export function registeredByWorker(records: WorkRecord[]): Record<string, DaySoFar> {
  const out: Record<string, DaySoFar> = {};
  for (const r of records) {
    const s = (out[r.workerId] ??= { count: 0, kilos: 0, records: [] });
    s.count += 1;
    s.kilos += r.quantity;
    s.records.push(r);
  }
  return out;
}

/** «1 pesada · 20 kg» · «2 pesadas · 38 kg». */
export function soFarLabel(s: DaySoFar, fmt: (n: number) => string): string {
  return `${s.count} ${s.count === 1 ? "pesada" : "pesadas"} · ${fmt(s.kilos)} kg`;
}
