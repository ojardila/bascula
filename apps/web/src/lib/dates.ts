/**
 * Business dates live in the farm's timezone, not the browser's.
 *
 * A pickup logged at 19:30 in Bogota is 00:30 UTC the next day. Slicing an
 * instant's first ten characters therefore books half an evening's coffee into
 * tomorrow's week, which is how a settlement ends up short. Every date the
 * user sees or picks goes through here.
 */

const MONTHS_SHORT = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

/** Read a plain YYYY-MM-DD key without letting the local timezone shift it. */
export function parseDay(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(d.getUTCDate() + n);
  return r;
}

/** Today as YYYY-MM-DD in the farm's timezone. */
export function todayInFarm(timezone: string, now: Date = new Date()): string {
  // en-CA gives YYYY-MM-DD, which is the only reason to use it here.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
}

/**
 * Monday of the week a date falls in, as YYYY-MM-DD.
 *
 * Mirrors `WEEK_OF` in the mobile schema. Weekly prices are keyed by this, so
 * it has to agree with the phone to the day.
 */
export function mondayOf(date: string | Date): string {
  const d = typeof date === "string" ? parseDay(date) : parseDay(date.toISOString());
  const dow = d.getUTCDay(); // 0 = Sunday
  return addDays(d, dow === 0 ? -6 : 1 - dow).toISOString().slice(0, 10);
}

/** "27/08/2026" — the format a Colombian farm writes on paper. */
export function formatDate(iso: string): string {
  const d = parseDay(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

/** "27 ago" — for dense lists. */
export function formatDayShort(iso: string): string {
  const d = parseDay(iso);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/**
 * A work record's date span, collapsed for display:
 * one day  -> "27/08/2026"
 * a range  -> "24–25/08/2026"
 */
export function formatDateRange(from: string, to: string): string {
  if (from === to) return formatDate(from);
  const a = parseDay(from);
  const b = parseDay(to);
  if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()) {
    return `${a.getUTCDate()}–${formatDate(to)}`;
  }
  return `${formatDate(from)} – ${formatDate(to)}`;
}

/** "lun 24 ago" — used to name the week a weekly price belongs to. */
export function formatMonday(monday: string): string {
  const d = parseDay(monday);
  return `lun ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}
