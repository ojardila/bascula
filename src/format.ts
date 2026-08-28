// Pure formatting, kept free of React and of the database so it can be
// exercised by tests directly. Node runs TypeScript natively, so the suite
// needs no build step and no test dependency.

export type Lang = "es" | "en" | "pt";

//
// Formatted by hand rather than with toLocaleString/Intl: Hermes resolves the
// default locale to en-US, so money came out as "$1,471,070" and dates as
// "8/27/2026" even with the app in Spanish. Month names also differ between
// Android and iOS ICU builds, which would make the same week read differently
// on two phones.

const MONTHS_SHORT: Record<Lang, string[]> = {
  es: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  pt: ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"],
};

// English groups thousands with a comma and marks decimals with a dot; Spanish
// and Portuguese do the opposite. Getting this wrong is not cosmetic: "1,500"
// is a thousand and a half in one convention and one and a half in the other.
const SEPARATORS: Record<Lang, { group: string; decimal: string }> = {
  es: { group: ".", decimal: "," },
  en: { group: ",", decimal: "." },
  pt: { group: ".", decimal: "," },
};

function group(digits: string, sep: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += sep;
    out += digits[i];
  }
  return out;
}

/** Money without decimals: 1471070 -> "$1.471.070" (es) / "$1,471,070" (en). */
export function formatMoney(amount: number, lang: Lang = "es"): string {
  const n = Math.round(Math.abs(amount));
  // Sign only when something survives the rounding, so -0.4 is "$0", not "-$0".
  const sign = amount < 0 && n > 0 ? "-" : "";
  return `${sign}$${group(String(n), SEPARATORS[lang].group)}`;
}

/**
 * Weights and counts: 1742.5 -> "1.742,5" (es) / "1,742.5" (en).
 *
 * Rounds once, in tenths. Taking the integer part first and rounding the
 * remainder separately lets the remainder reach 10, which then prints as a
 * second digit: a SUM() of 65.3 + 68.1 + 52.6 comes back as 185.99999999999997
 * and rendered as "185,10" instead of "186". That number ends up on the
 * receipt the worker checks their weight against.
 */
export function formatNumber(value: number, lang: Lang = "es"): string {
  const tenths = Math.round(Math.abs(value) * 10);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  const { group: g, decimal } = SEPARATORS[lang];
  const sign = value < 0 && tenths > 0 ? "-" : "";
  return `${sign}${group(String(whole), g)}${frac ? decimal + frac : ""}`;
}

// Parse a YYYY-MM-DD key without going through the local timezone, which would
// shift the day backwards for anyone west of UTC.
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

/** ISO week number, shown as a secondary hint only. */
export function weekNumber(mondayISO: string): number {
  const d = parseDay(mondayISO);
  const thursday = addDays(d, 3); // ISO weeks are named after their Thursday
  const jan1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.floor((thursday.getTime() - jan1.getTime()) / 86400000 / 7) + 1;
}

/**
 * The date range a week covers: "24–30 ago", "31 ago – 6 sep",
 * "29 dic – 4 ene 2026". The year is appended only when the week ends in a
 * different year than today. The range is always shown — "this week" is a
 * separate tag, so the actual dates never get hidden behind it.
 */
export function formatWeekRange(mondayISO: string, lang: Lang, now = new Date()): string {
  const start = parseDay(mondayISO);
  const end = addDays(start, 6);
  const M = MONTHS_SHORT[lang];
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const sy = start.getUTCFullYear();
  const ey = end.getUTCFullYear();
  // A week that crosses new year needs the year on both ends: judging only by
  // the end date left "29 dic – 4 ene" with no way to tell which December.
  const crossesYear = sy !== ey;
  const startYear = crossesYear ? ` ${sy}` : "";
  const endYear = crossesYear || ey !== now.getFullYear() ? ` ${ey}` : "";
  const sd = start.getUTCDate();
  const ed = end.getUTCDate();
  if (lang === "en") {
    return sameMonth
      ? `${M[start.getUTCMonth()]} ${sd}–${ed}${endYear}`
      : `${M[start.getUTCMonth()]} ${sd}${startYear} – ${M[end.getUTCMonth()]} ${ed}${endYear}`;
  }
  return sameMonth
    ? `${sd}–${ed} ${M[end.getUTCMonth()]}${endYear}`
    : `${sd} ${M[start.getUTCMonth()]}${startYear} – ${ed} ${M[end.getUTCMonth()]}${endYear}`;
}

/**
 * Short day for lists and receipts: "27 ago".
 *
 * A stored pickup is a UTC instant, so slicing its first ten characters shows
 * tomorrow for anything logged after 19:00 in Bogota — while every total in
 * the app groups it by local day. Values that carry a time are converted to
 * the local day; plain YYYY-MM-DD keys (week mondays, ledger dates) are
 * already local and must be read as-is.
 */
export function formatDay(value: string, lang: Lang): string {
  const M = MONTHS_SHORT[lang];
  const hasTime = value.length > 10;
  if (hasTime) {
    const d = new Date(value);
    return lang === "en"
      ? `${M[d.getMonth()]} ${d.getDate()}`
      : `${d.getDate()} ${M[d.getMonth()]}`;
  }
  const d = parseDay(value);
  return lang === "en"
    ? `${M[d.getUTCMonth()]} ${d.getUTCDate()}`
    : `${d.getUTCDate()} ${M[d.getUTCMonth()]}`;
}
