// SPDX-License-Identifier: MIT
/**
 * The sentences the «Rendimiento» section says out loud, as pure functions so
 * a test can pin them. Plain Spanish, whole kilos, the arrow AND the words:
 * an arrow alone is a symbol somebody has to decode.
 */
import { formatQuantity } from "../../lib/money";
import { parseDay } from "../../lib/dates";

/** "1.234 kg" — whole kilos. A tenth of a kilo is noise on this screen. */
export function kgText(v: number): string {
  return `${formatQuantity(Math.round(v))} kg`;
}

export const DAY_SHORT = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"] as const;
const DAY_LONG = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

/** 0 = Monday … 6 = Sunday, for a YYYY-MM-DD day. */
export function weekdayIndex(iso: string): number {
  return (parseDay(iso).getUTCDay() + 6) % 7;
}

export interface WeekChange {
  direction: "up" | "down" | "same";
  arrow: "↑" | "↓" | "=";
  /** The difference, positive, in whole kilos. */
  diffKg: number;
  /** The whole sentence: "12 kg más que la semana pasada". */
  sentence: string;
  /** The sentence without the figure, to sit under a big "↑ 12 kg". */
  tail: string;
}

/**
 * This week against last week. A missing figure is a week with no kilos at all,
 * which for a comparison is zero kilos picked — the screen says it that way.
 */
export function weekChange(thisWeek: number | null, lastWeek: number | null): WeekChange {
  const diff = Math.round(thisWeek ?? 0) - Math.round(lastWeek ?? 0);
  if (diff === 0) {
    return {
      direction: "same", arrow: "=", diffKg: 0,
      sentence: "Lo mismo que la semana pasada", tail: "que la semana pasada",
    };
  }
  const n = Math.abs(diff);
  return diff > 0
    ? { direction: "up", arrow: "↑", diffKg: n, sentence: `${kgText(n)} más que la semana pasada`, tail: "más que la semana pasada" }
    : { direction: "down", arrow: "↓", diffKg: n, sentence: `${kgText(n)} menos que la semana pasada`, tail: "menos que la semana pasada" };
}

/**
 * What the comparison covers. On a Sunday the running week is whole; on any
 * other day it is compared against the same days of last week, and says so.
 */
export function comparisonSpan(today: string): string {
  const i = weekdayIndex(today);
  if (i === 6) return "Semana completa contra semana completa.";
  if (i === 0) return "Comparando solo los lunes.";
  return `Comparando de lunes a ${DAY_LONG[i]} en las dos semanas.`;
}

/** "3 días trabajados" / "1 día trabajado". */
export function daysWorkedText(n: number): string {
  return n === 1 ? "1 día trabajado" : `${n} días trabajados`;
}
