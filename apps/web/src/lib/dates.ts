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
 * ── THE DATE FIELDS, IN SPANISH ──────────────────────────────────────────
 *
 * The fields you type into asked for `mm/dd/yyyy`, which is the US order: a
 * coffee farmer who writes the 3rd of August as 03/08 ends up recording the
 * 8th of March, and the work item lands in a different week — at a different
 * price.
 *
 * LAST SPRINT DID THE HALF THAT FIT: tagging the `<input type="date">` as
 * `es-CO`, which is enough for Firefox and Safari and not for Chrome, because
 * Chrome looks at the language the browser is configured with and ignores it
 * — a fix that depended on which browser the farm happened to have. That note
 * said the real way out was a field of our own with its own calendar. It is
 * `components/DateField.tsx`, and it leans on what follows below.
 *
 * `DATE_FIELD_PROPS` no longer exists because not one `type="date"` is left in
 * the product: the browser stopped deciding the input mask.
 */

const WEEKDAYS_LONG = [
  "domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado",
];

/** "L M X J V S D" — the week starts on Monday, like the rest of the product. */
export const WEEKDAY_INITIALS = ["L", "M", "X", "J", "V", "S", "D"] as const;

export const MONTH_NAMES = MONTHS_LONG;

/**
 * "sábado 29 de agosto de 2026".
 *
 * THIS FUNCTION IS THE FIX, as much as the calendar is. The bug that was
 * reported is not that the input mask is in English: it is that **whoever
 * types 29/08 does not know what got saved**. A field that echoes back in
 * words what it understood settles that doubt without anyone having to trust
 * the mask, the browser, or the machine's settings.
 */
export function formatDayFull(iso: string): string {
  const d = parseDay(iso);
  return (
    `${WEEKDAYS_LONG[d.getUTCDay()]} ${d.getUTCDate()} de ` +
    `${MONTHS_LONG[d.getUTCMonth()]} de ${d.getUTCFullYear()}`
  );
}

/** Is `YYYY-MM-DD` a day that actually exists? The 31st of February is not. */
export function isValidDay(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m - 1);
}

/** How many days that month has, leap years included. */
export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * What the person TYPED, read as a day. Returns `YYYY-MM-DD` or null.
 *
 * The forms accepted are the ones a date really gets written in on a farm, all
 * of them in the order used here —day first, which is the whole point of this
 * sprint—:
 *
 *   "29/8"        the year is assumed: `refYear`
 *   "29/08/26"    two-digit year, in the current century
 *   "29/08/2026"  in full
 *   "29-8-2026"   with dashes or dots, which is what some keypads produce
 *   "29082026"    eight digits in a row, for whoever types without looking up
 *
 * It never guesses the month: "13/08" is not the 13th of August, it is a month
 * that does not exist, and it returns null so the field can say so instead of
 * saving something arbitrary.
 */
export function parseTypedDay(raw: string, refYear: number): string | null {
  const cleaned = raw.trim();
  if (cleaned === "") return null;

  let d: number, m: number, y: number;
  const digits = cleaned.replace(/\D/g, "");
  const parts = cleaned.split(/[/\-.\s]+/).filter(Boolean);

  if (parts.length >= 2 && parts.every((p) => /^\d+$/.test(p))) {
    d = Number(parts[0]);
    m = Number(parts[1]);
    y = parts.length >= 3 ? Number(parts[2]) : refYear;
  } else if (/^\d+$/.test(cleaned) && (digits.length === 8 || digits.length === 6)) {
    d = Number(digits.slice(0, 2));
    m = Number(digits.slice(2, 4));
    y = Number(digits.slice(4));
  } else {
    return null;
  }

  // "26" is 2026 and not the year 26. The century comes from the reference
  // year, so this still works in 2100 without anyone coming back here.
  if (y < 100) y = Math.floor(refYear / 100) * 100 + y;
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return null;
  if (y < 1900 || y > 2200) return null;

  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isValidDay(iso) ? iso : null;
}

/** `YYYY-MM-DD` -> "29/08/2026", which is what gets typed in the field. */
export const toTypedDay = (iso: string): string => (isValidDay(iso) ? formatDate(iso) : "");

/**
 * The days a month grid paints: six weeks running Monday to Sunday.
 *
 * Always six, always complete — with the previous and next month's days in
 * their places — because a grid that changes height when you page to the next
 * month moves the button the person is about to click.
 */
export function monthGrid(year: number, monthIndex: number): string[] {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const dow = first.getUTCDay(); // 0 = Sunday
  const start = addDays(first, dow === 0 ? -6 : 1 - dow);
  return Array.from({ length: 42 }, (_, i) =>
    addDays(start, i).toISOString().slice(0, 10),
  );
}
