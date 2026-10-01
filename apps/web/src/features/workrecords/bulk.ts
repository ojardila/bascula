/**
 * The pure half of «Registro de recolección masivo»: what a filled form means.
 *
 * Every filled box is a NEW pesada. A person can come to the scale several
 * times a day, so nothing already registered is ever changed or replaced from
 * this screen; a blank box writes nothing.
 */
import { teamSearchText } from "../teams/team";
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

/** Lower case, no accents, single spaces: «  RAMÍREZ » → «ramirez». */
export function foldName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a person answers to what was typed in «Buscar por nombre o
 * canasto». Accents and case don't matter, any part of the first or last
 * names matches, and each word typed must appear: «pedro ram» finds Pedro
 * Ramírez. The basket number counts too — the worker's own and, for a team,
 * its members' — so «46» finds Yorman's team. Blank matches all.
 */
export function matchesName(w: Worker, query: string): boolean {
  const words = foldName(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const name = foldName(`${workerLabel(w)} ${w.tag ?? ""} ${teamSearchText(w)}`);
  return words.every((word) => name.includes(word));
}

/**
 * How well a worker's basket number answers a query: 0 exact («46» → 46),
 * 1 one of the numbers of a team («46» → 46-63), 2 starts with it, 3 the rest.
 */
function basketRank(w: Worker, query: string): number {
  const q = foldName(query);
  const tag = foldName(w.tag ?? "");
  if (!q || !tag) return 3;
  if (tag === q) return 0;
  if (tag.split(/[^a-z0-9]+/).includes(q)) return 1;
  if (tag.startsWith(q)) return 2;
  return 3;
}

/**
 * The people that answer to the search. Typing a basket number puts its owner
 * first («4» would also match 45 and 46); otherwise the list keeps its order.
 */
export function filterWorkers<T extends Worker>(workers: T[], query: string): T[] {
  const hits = workers.filter((w) => matchesName(w, query));
  if (!/\d/.test(query)) return hits;
  return hits
    .map((w, i) => ({ w, i, r: basketRank(w, query) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.w);
}

/**
 * Which people's week is already settled (liquidada).
 *
 * A settled week never changes (a new price does not move it, and neither may
 * a weighing typed afterwards), so on this screen a person with ANY settled
 * pesada in the week of the day is read-only for that day. The whole week is
 * «ya se liquidó» when somebody has pesadas in it and every such person is
 * settled — then nothing on the screen can be written.
 *
 * `weekRecords` is every harvest pesada of the Monday–Sunday around the day.
 */
export function weekLocks(weekRecords: WorkRecord[]): { settledWorkers: Set<string>; weekSettled: boolean } {
  const settledWorkers = new Set<string>();
  const withRecords = new Set<string>();
  for (const r of weekRecords) {
    withRecords.add(r.workerId);
    if (r.settled) settledWorkers.add(r.workerId);
  }
  const weekSettled = withRecords.size > 0 && [...withRecords].every((w) => settledWorkers.has(w));
  return { settledWorkers, weekSettled };
}

export type Correction =
  | { kind: "update"; recordId: string; quantity: number }
  | { kind: "remove"; recordId: string };

/**
 * What «Corregir» asks for: the pesadas whose kilos were changed, and the ones
 * marked to be taken out. An unchanged box writes nothing; a settled pesada is
 * never touched.
 */
export function plannedCorrections(
  records: WorkRecord[],
  texts: Record<string, string>,
  removed: Record<string, boolean>,
): { corrections: Correction[]; errors: string[] } {
  const corrections: Correction[] = [];
  const errors: string[] = [];
  records.forEach((r, i) => {
    if (r.settled) return;
    if (removed[r.id]) {
      corrections.push({ kind: "remove", recordId: r.id });
      return;
    }
    const raw = (texts[r.id] ?? "").trim();
    if (raw === "") {
      errors.push(`Escriba los kilos de la pesada ${i + 1}, o toque «Quitar».`);
      return;
    }
    const q = parseQuantity(raw);
    if (q === null) errors.push(`Revise la pesada ${i + 1}: «${raw}» no es un número.`);
    else if (q <= 0) errors.push(`Revise la pesada ${i + 1}: deben ser más de cero.`);
    else if (q !== r.quantity) corrections.push({ kind: "update", recordId: r.id, quantity: q });
  });
  return { corrections, errors };
}
