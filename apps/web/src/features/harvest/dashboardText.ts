/**
 * The sentences of the «Modo cosecha» dashboard, as pure functions so a test
 * can pin them. Plain Spanish, whole kilos, the arrow AND the words.
 */
import type { WireHarvestDashboardPlot } from "../../api/wire";
import { kgText } from "../workers/performance";
import { parseDay } from "../../lib/dates";

/** The lote against the same weekdays of last week, in words. */
export function plotTrend(p: Pick<WireHarvestDashboardPlot, "kg" | "lastWeekToDateKg" | "lastWeekKg">): string {
  const now = p.kg ?? 0;
  const before = p.lastWeekToDateKg ?? 0;
  if (now === 0 && before === 0) {
    return p.lastWeekKg ? `la semana pasada: ${kgText(p.lastWeekKg)}` : "sin kilos";
  }
  if (before === 0) return "nuevo esta semana";
  if (now === 0) return `↓ nada todavía (la semana pasada a esta altura: ${kgText(before)})`;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return "= igual que la semana pasada";
  return pct > 0 ? `↑ ${pct}% más que la semana pasada` : `↓ ${-pct}% menos que la semana pasada`;
}


const WEEKDAY = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** When somebody last picked, said the way a person says it: "ayer", "el lunes 28". */
export function lastSeenText(lastRecordOn: string, today: string): string {
  const days = Math.round((parseDay(today).getTime() - parseDay(lastRecordOn).getTime()) / 86_400_000);
  if (days === 1) return "ayer";
  if (days === 2) return "anteayer";
  const d = parseDay(lastRecordOn);
  return `el ${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()}`;
}

/** "Muy por debajo del promedio: Ana y Beto." — the names behind the flag. */
export function belowAverageText(names: string[]): string | null {
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
  return `Muy por debajo del promedio: ${list}.`;
}
