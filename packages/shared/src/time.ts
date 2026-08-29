/**
 * Weeks and days. Moved out of the phone's `format.ts` unchanged, because the
 * server has to derive the same week for the same weighing — the week key is
 * what decides which price applies and which settlement a pickup falls into.
 *
 * The week is the ISO date of its MONDAY (`2026-08-24`), never a `%Y-W%W`
 * label: that label split the week of 29 December into `2026-W52` and
 * `2027-W00` and priced the two halves differently.
 *
 * Business dates are LOCAL dates — the farm's calendar day, not UTC. A pickup
 * weighed at 19:30 on a Sunday in Colombia is stored as Monday 00:30 UTC; it
 * belongs to the week that is being paid, and every rule here is written so
 * that it does.
 */

/**
 * Parse a YYYY-MM-DD key without going through the local timezone, which would
 * shift the day backwards for anyone west of UTC.
 */
export function parseDay(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

export const addDays = (d: Date, n: number) => {
  const r = new Date(d);
  r.setUTCDate(d.getUTCDate() + n);
  return r;
};

/** Monday of the week a date falls in, as YYYY-MM-DD. Mirrors the SQL key. */
export function mondayOf(date: Date | string): string {
  const d = typeof date === "string" ? parseDay(date) : new Date(Date.UTC(
    date.getFullYear(), date.getMonth(), date.getDate(),
  ));
  const dow = d.getUTCDay(); // 0 = Sunday
  return addDays(d, dow === 0 ? -6 : 1 - dow).toISOString().slice(0, 10);
}

/**
 * Sunday of the week that starts on `monday`. A week ends on day six, not on
 * the following Monday — a settlement dated the next Monday would sweep in the
 * first day of the week after it.
 *
 * Was defined twice, character for character, in `PayWorker` and in
 * `PaymentsPanel` (`docs/diagramas/movil.md` §9.12) — the two screens that
 * decide how far a settlement reaches.
 */
export const endOfWeek = (monday: string): string =>
  addDays(parseDay(monday), 6).toISOString().slice(0, 10);

/**
 * "Since the beginning of the record", as the `from` of a settlement range.
 *
 * Both pay screens passed the bare string `"1970-01-01"`. Only `to` really
 * matters: `PENDING_SQL` selects by pickup id, so anything not yet claimed is
 * swept in however old it is, and the `BETWEEN` on the lower bound never
 * excludes anything. Named here so the two screens cannot drift apart, and so
 * the next reader is told that is the intent rather than left to infer it.
 */
export const EPOCH_START = "1970-01-01";

/** ISO week number, shown as a secondary hint only. */
export function weekNumber(mondayISO: string): number {
  const d = parseDay(mondayISO);
  const thursday = addDays(d, 3); // ISO weeks are named after their Thursday
  const jan1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.floor((thursday.getTime() - jan1.getTime()) / 86400000 / 7) + 1;
}

/**
 * The local calendar day of an instant, as YYYY-MM-DD.
 *
 * Composed by hand rather than by slicing an ISO string: a payment made on
 * Sunday evening in Bogota came out stamped with tomorrow's date and showed as
 * a movement dated in the future, while every total in the app grouped it under
 * today. This is the SQL `date(col,'localtime')` written in TypeScript.
 */
export function localDayOf(instant: Date = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${instant.getFullYear()}-${p2(instant.getMonth() + 1)}-${p2(instant.getDate())}`;
}

/**
 * Week of an instant: its local day first, then that day's Monday. Going
 * straight from the instant would put a Sunday evening into the next week for
 * anyone west of UTC.
 */
export const weekOf = (instant: Date = new Date()): string =>
  mondayOf(localDayOf(instant));
