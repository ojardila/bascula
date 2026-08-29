/**
 * The six report routes the harvest module reads, and nothing else.
 *
 * WHAT CHANGED, AND WHY THE WEB NOW COMPUTES NOTHING.
 *
 * This module shipped its first draft deriving the whole season in the
 * browser, because `/v1/reports/*` did not exist. It exists now — six
 * endpoints, a port of the SQL that has been running on the phone for a season
 * — so the derivation is gone rather than kept as a fallback. Two
 * implementations of "what is a picker's index" is precisely the arrangement
 * that lets the phone and the web quote different numbers for the same person,
 * and a fallback is a second implementation that nobody looks at until it is
 * wrong. The server is the one place this arithmetic lives.
 *
 * WHAT THE WEB STILL OWNS: the wording and the presentation. The server sends
 * `rule: "digit"` and `reference: 9.4`; the sentence a farm reads — "38 kg es
 * más de cuatro veces lo que Beto pesa normalmente" — is written in
 * `features/harvest/text.ts`, because that is a product decision and not a
 * query.
 *
 * THE ONE RULE EVERY CALLER HERE HAS TO KEEP. `kg`, `valueCents`, `index`,
 * `kgPerDay`, `kgPerHa`, `trend` and `peak` are ALL nullable, and each null
 * arrives with a count or a `reason` beside it. None of them may be rendered
 * as a zero. `features/harvest/totals.ts` is where that rule is enforced once,
 * so no screen has to remember it.
 */
import { http } from "./client";
import type { paths } from "./schema";
import type { DayISO, Uuid } from "./types";
import type {
  WireHarvestCurve,
  WireReportAnomaliesResult,
  WireReportCrop,
  WireReportPerformanceResult,
  WireReportWeekDetail,
  WireReportWeeksResult,
} from "./wire";

/**
 * THE ROUTES, ASSERTED AGAINST THE CONTRACT AT COMPILE TIME.
 *
 * Each of these resolves to `true` only while that path is in
 * `services/api/openapi.yaml`, and `Route<>` accepts nothing else. So the day
 * a route is renamed or dropped, `npm run build` fails HERE, naming the path,
 * instead of the module going quietly empty in a farm's browser three weeks
 * later. It is the same discipline `contract.assert.ts` applies to the bodies,
 * applied to the URLs.
 *
 * The earlier draft of this file had the same idea pointed at
 * `"/v1/reports/harvest"` — a path that was never in the design. It would have
 * sat there being `false` forever, which is the failure mode a tripwire is
 * supposed to prevent: it can only work if it is aimed at the real thing.
 */
type Route<T extends true> = T;
type Has<P extends string> = P extends keyof paths ? true : false;

export type ReportRoutes = [
  Route<Has<"/v1/reports/weeks">>,
  Route<Has<"/v1/reports/weeks/{monday}">>,
  Route<Has<"/v1/reports/crops/{plotCropId}">>,
  Route<Has<"/v1/reports/performance">>,
  Route<Has<"/v1/reports/anomalies">>,
  Route<Has<"/v1/reports/harvest-curve">>,
];

const q = (params: Record<string, string | number | undefined>): string => {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) out.set(k, String(v));
  const s = out.toString();
  return s ? `?${s}` : "";
};

/** The weeks with their kilos and their value. Newest first. */
export const reportWeeks = (params: { from?: DayISO; to?: DayISO; limit?: number } = {}) =>
  http.get<WireReportWeeksResult>(`/v1/reports/weeks${q(params)}`);

/**
 * One week, as two grids over the same weighings.
 *
 * `byDay.total` and `byCrop.total` are equal by construction, and inside each
 * grid the margins agree with the grand total. The screen still checks, and
 * says so if they ever do not: a table a farm settles from is worth one
 * addition.
 */
export const reportWeek = (monday: DayISO) =>
  http.get<WireReportWeekDetail>(`/v1/reports/weeks/${monday}`);

/** One crop: kilos, value, people, days, area and its weekly evolution. */
export const reportCrop = (plotCropId: Uuid, weeks?: number) =>
  http.get<WireReportCrop>(`/v1/reports/crops/${plotCropId}${q({ weeks })}`);

/** The comparative index, over a window of `days` in the farm's own calendar. */
export const reportPerformance = (days?: number) =>
  http.get<WireReportPerformanceResult>(`/v1/reports/performance${q({ days })}`);

/** Weighings worth a second look, worst first. */
export const reportAnomalies = (params: { days?: number; maxKg?: number; limit?: number } = {}) =>
  http.get<WireReportAnomaliesResult>(`/v1/reports/anomalies${q(params)}`);

/** The weekly series and the reading of it: peak, decline, end of season. */
export const reportHarvestCurve = (params: { plotCropId?: Uuid; weeks?: number } = {}) =>
  http.get<WireHarvestCurve>(`/v1/reports/harvest-curve${q(params)}`);
