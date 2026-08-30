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

const MONTHS_LONG = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
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

/**
 * "24 de agosto" — a day written out, for a sentence rather than a table.
 *
 * The short forms above are for columns, where space is the constraint and the
 * reader is scanning. This one goes inside prose — "el precio de la semana del
 * 24 de agosto pasó de $800 a $850" — where "24 ago" reads as an abbreviation
 * somebody has to decode mid-sentence.
 */
export function formatDayLong(iso: string): string {
  const d = parseDay(iso);
  return `${d.getUTCDate()} de ${MONTHS_LONG[d.getUTCMonth()]}`;
}

/** "lun 24 ago" — used to name the week a weekly price belongs to. */
export function formatMonday(monday: string): string {
  const d = parseDay(monday);
  return `lun ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/**
 * "24–30 ago" — the week a harvest report groups by, named by its own days.
 *
 * A week is keyed by its Monday everywhere in this product, and "2026-08-24"
 * is not something a person reads as a week. The year is appended only when
 * the week crosses a new year or ends outside the current one, which is the
 * same rule the phone uses (`formatWeekRange` in `packages/shared`), so the
 * two halves of the product name the same week the same way.
 */
export function formatWeekRange(monday: string, today: Date = new Date()): string {
  const a = parseDay(monday);
  const b = addDays(a, 6);
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const currentYear = today.getUTCFullYear();
  const showYear = !sameYear || b.getUTCFullYear() !== currentYear;

  const aM = MONTHS_SHORT[a.getUTCMonth()];
  const bM = MONTHS_SHORT[b.getUTCMonth()];
  const aY = showYear ? ` ${a.getUTCFullYear()}` : "";
  const bY = showYear ? ` ${b.getUTCFullYear()}` : "";

  if (a.getUTCMonth() === b.getUTCMonth() && sameYear) {
    return `${a.getUTCDate()}–${b.getUTCDate()} ${bM}${bY}`;
  }
  return `${a.getUTCDate()} ${aM}${aY} – ${b.getUTCDate()} ${bM}${bY}`;
}

/**
 * THE PERIOD A DOCUMENT ACTUALLY COVERS, from both of its ends.
 *
 * `formatWeekRange` takes ONE day and prints the seven days that follow it,
 * because a harvest week is keyed by its Monday and its end is arithmetic. A
 * settlement's period is not: `periodStart` is the Monday of the earliest
 * payable taken in and `periodEnd` is the last, and those can be a year apart
 * — the running farm has settlements from 2026-08-24 to 2027-08-29.
 *
 * Passing only the start to `formatWeekRange` therefore labelled every one of
 * them "24–30 ago", which is not a rounding: it is a different period. The
 * printed payroll got it right, so the screen and the paper contradicted each
 * other about the same document.
 *
 * The week form is kept for the case where it is TRUE — exactly seven days —
 * because "24–30 ago" is how people say that week, and only then.
 */
export function formatPeriod(from: string, to: string, today: Date = new Date()): string {
  const a = parseDay(from);
  const b = parseDay(to);
  if (from === to) return formatDate(from);
  if (addDays(a, 6).toISOString().slice(0, 10) === to) return formatWeekRange(from, today);

  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const showYear = !sameYear || b.getUTCFullYear() !== today.getUTCFullYear();
  const aY = showYear ? ` ${a.getUTCFullYear()}` : "";
  const bY = showYear ? ` ${b.getUTCFullYear()}` : "";
  if (a.getUTCMonth() === b.getUTCMonth() && sameYear) {
    return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS_SHORT[b.getUTCMonth()]}${bY}`;
  }
  return (
    `${a.getUTCDate()} ${MONTHS_SHORT[a.getUTCMonth()]}${aY} – ` +
    `${b.getUTCDate()} ${MONTHS_SHORT[b.getUTCMonth()]}${bY}`
  );
}

/** "Esta semana" / "Semana pasada", or null when it is neither. */
export function weekTag(monday: string, today: string): string | null {
  const current = mondayOf(today);
  if (monday === current) return "Esta semana";
  if (monday === addDays(parseDay(current), -7).toISOString().slice(0, 10)) return "Semana pasada";
  return null;
}

/**
 * ── LOS CAMPOS DE FECHA, EN CASTELLANO ───────────────────────────────────
 *
 * Los campos para escribir pedían `mm/dd/aaaa`, que es el orden
 * estadounidense: un caficultor que escribe el 3 de agosto como 03/08 acaba
 * registrando el 8 de marzo, y la labor se va a otra semana — a otro precio.
 *
 * SER HONESTOS CON LO QUE ESTO ARREGLA Y LO QUE NO. El formato de un
 * `<input type="date">` no lo decide la página: lo decide el navegador.
 * Firefox y Safari miran el idioma del elemento, y con esto pasan a
 * `dd/mm/aaaa`. Chrome mira el idioma con el que está configurado el
 * navegador y no hace caso, así que ahí sigue dependiendo del equipo. La
 * alternativa real es un campo propio con su calendario, que es trabajo de
 * verdad y no cabía en este sprint; esto es la mitad que sí cabía, en un solo
 * sitio para que ese día haya un solo sitio que cambiar.
 */
export const DATE_FIELD_PROPS = {
  inputLabel: { shrink: true },
  htmlInput: { lang: "es-CO" },
} as const;
