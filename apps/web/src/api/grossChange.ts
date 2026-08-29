/**
 * THE RACE BETWEEN LOOKING AT A FIGURE AND APPROVING IT.
 *
 * The payment screen shows a gross, and the person reads it, thinks about it,
 * and presses the button. In between, two things can move it without anybody
 * touching this browser:
 *
 *   - a late weighing is registered, from the phone or by another user, or
 *     somebody else's settlement claims one of the payables first;
 *   - the week's price is changed, and every `weekly_price` payable in that
 *     week is suddenly worth something else — because those are priced at
 *     settlement time and not at registration time.
 *
 * Either way the settlement writes a `devengo` for a number the approver never
 * saw. That is a signature on a figure nobody agreed to, and it is worse than
 * a failed write, because it succeeds silently.
 *
 * THE GUARD IS THE SERVER'S, AND IT IS MANDATORY.
 *
 * `POST /v1/settlements` REQUIRES `expectedGrossCents` — the figure
 * `/v1/settlements/preview` showed. If the settlement would not add up to it,
 * the server writes nothing and answers 409 GROSS_CHANGED. The spec gives the
 * reason for making it required rather than optional, and it is the right one:
 * "a money guard a client may omit is a guard that is off in exactly the
 * moment it matters."
 *
 * WHAT THIS MODULE DOES.
 *
 * It turns that 409 into a sentence. The server sends what moved and is
 * careful not to guess — `details` carries the two figures, the payable ids
 * that came and went, and every week the settlement spans WITH THE PRICE NOW
 * IN FORCE. Note the name: `weeksInSettlement`, not "weeks that changed". It
 * is every week, priced as of now, because the server does not know what the
 * screen was showing. This side does: it is holding the preview it just
 * displayed. So the join happens here.
 *
 *     server            expectedCents, actualCents, addedPayableIds,
 *                       removedPayableIds, payableIdsProvided,
 *                       weeksInSettlement[{weekStart, priceCents}]
 *     this module       + the lines the user approved
 *                       + a fresh preview, to put a name and a date on an id
 *                       = "porque el precio de la semana del 24 de agosto
 *                          pasó de $800 a $850"
 *
 * THE TRAP IN THAT FIELD, WRITTEN DOWN SO NOBODY WALKS INTO IT AGAIN. Reading
 * `weeksInSettlement` as "the weeks that changed" makes the screen announce a
 * reprice every time a late weighing arrives, because the week is always in
 * the list whether its price moved or not. A week is only reported here when
 * its price differs from what the approved lines of that same week were
 * carrying — which is a comparison, not a reading.
 *
 * AND THE OTHER ONE. When `payableIdsProvided` is false the two id lists are
 * empty because the server was not told what the screen saw — NOT because
 * nothing moved. Those two are not the same fact and must not produce the same
 * sentence.
 *
 * NOTHING IS INVENTED. Every branch that cannot establish a cause says the
 * figure changed and stops. A wrong reason on this dialog is worse than no
 * reason: the dialog exists to be believed.
 */
import type { DayISO, PayableLine, Uuid } from "./types";

/** The code the payment screen branches on. */
export const GROSS_CHANGED = "GROSS_CHANGED";

/**
 * `details.weeksInSettlement[]`: a week this settlement spans, priced as of
 * now. NOT a week that changed — see the note at the top of this file.
 */
export interface WeekPriceNow {
  weekStart: DayISO;
  priceCents: number;
}

/**
 * `details` of a 409 GROSS_CHANGED, read off the wire.
 *
 * Read strictly. A figure that is not a whole number of cents is refused
 * rather than coerced, because it is about to be shown to somebody as pesos in
 * a dialog whose entire purpose is to state the right number.
 */
export interface ServerGrossDetails {
  expectedCents: number;
  actualCents: number;
  /**
   * Exact ONLY when `payableIdsProvided` is true. Otherwise both are empty and
   * that means "the server was not told what you saw", never "nothing moved".
   */
  addedPayableIds: Uuid[];
  removedPayableIds: Uuid[];
  payableIdsProvided: boolean;
  weeksInSettlement: WeekPriceNow[];
}

export function readGrossDetails(details: Record<string, unknown>): ServerGrossDetails | null {
  const expectedCents = details.expectedCents;
  const actualCents = details.actualCents;
  if (!Number.isInteger(expectedCents) || !Number.isInteger(actualCents)) return null;
  return {
    expectedCents: expectedCents as number,
    actualCents: actualCents as number,
    addedPayableIds: idList(details.addedPayableIds),
    removedPayableIds: idList(details.removedPayableIds),
    // Absent is read as FALSE, which is the safe direction: it makes the
    // screen say "we could not tell what moved" rather than assert that
    // nothing was added on the strength of two empty lists.
    payableIdsProvided: details.payableIdsProvided === true,
    weeksInSettlement: weekList(details.weeksInSettlement),
  };
}

function idList(v: unknown): Uuid[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function weekList(v: unknown): WeekPriceNow[] {
  if (!Array.isArray(v)) return [];
  const out: WeekPriceNow[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown>;
    if (typeof w.weekStart !== "string" || !Number.isInteger(w.priceCents)) continue;
    out.push({ weekStart: w.weekStart, priceCents: w.priceCents as number });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The explanation                                                     */
/* ------------------------------------------------------------------ */

export interface RepricedWeek {
  weekStart: DayISO;
  /** What the screen was showing when the person approved it. */
  fromRateCents: number;
  /** What the week is worth now. */
  toRateCents: number;
  /** How many of the approved lines that week covers. */
  lineCount: number;
}

export interface GrossChange {
  /** The figure that was approved. */
  beforeCents: number;
  /** The figure the settlement would write now. */
  afterCents: number;
  /** `after - before`. Positive means the farm owes more than it approved. */
  deltaCents: number;
  /**
   * AUTHORITATIVE COUNTS, straight from the server. `added` and `removed`
   * below are the same rows with a name and a date on them, resolved from a
   * fresh preview — and there can be fewer of those, because a payable that
   * was deleted outright resolves to nothing. The sentence counts ids; the
   * table shows lines. Counting the table would under-report.
   */
  addedIds: Uuid[];
  removedIds: Uuid[];
  added: PayableLine[];
  removed: PayableLine[];
  repriced: RepricedWeek[];
  /**
   * False when the server could not say what came and went. The dialog then
   * shows the two figures and says so — it does not report an empty `added`
   * as "nothing arrived".
   */
  causeIsKnown: boolean;
}

/**
 * Join the server's `details` with what this browser knows.
 *
 * `approved` is what the screen was showing — the source of the OLD price per
 * week. `fresh` is a preview taken after the refusal, which is what puts an
 * activity and a date on an id the user has never seen.
 *
 * The reprice arithmetic is the subtle part. `weeksInSettlement` carries EVERY
 * week the settlement spans, priced as of now — not only the ones that moved —
 * so a week is only reported here when the price in it differs from the rate
 * the approved lines of that same week were actually carrying. A week with no
 * approved line behind it is skipped rather than guessed at, and a line whose
 * price was frozen at registration (`rateSource !== "weekly_price"`) is
 * ignored, because a weekly price cannot have moved it.
 */
export function explainGrossChange(
  d: ServerGrossDetails,
  approved: PayableLine[],
  fresh: PayableLine[],
): GrossChange {
  const freshById = new Map(fresh.map((l) => [l.id, l]));
  const approvedById = new Map(approved.map((l) => [l.id, l]));

  const added = d.addedPayableIds
    .map((id) => freshById.get(id))
    .filter((l): l is PayableLine => l !== undefined);
  const removed = d.removedPayableIds
    .map((id) => approvedById.get(id))
    .filter((l): l is PayableLine => l !== undefined);

  const repriced: RepricedWeek[] = [];
  for (const week of d.weeksInSettlement) {
    const lines = approved.filter(
      (l) => l.weekStart === week.weekStart && l.rateSource === "weekly_price",
    );
    if (lines.length === 0) continue;
    const was = lines[0].rateCents;
    // Every line of one week carries the same weekly price; if they somehow do
    // not, this side cannot say which one the person read, so it says nothing.
    if (lines.some((l) => l.rateCents !== was)) continue;
    if (was === week.priceCents) continue;
    repriced.push({
      weekStart: week.weekStart,
      fromRateCents: was,
      toRateCents: week.priceCents,
      lineCount: lines.length,
    });
  }

  return {
    beforeCents: d.expectedCents,
    afterCents: d.actualCents,
    deltaCents: d.actualCents - d.expectedCents,
    addedIds: d.addedPayableIds,
    removedIds: d.removedPayableIds,
    added,
    removed,
    repriced,
    causeIsKnown: d.payableIdsProvided,
  };
}

/* ------------------------------------------------------------------ */
/* The sentence                                                        */
/* ------------------------------------------------------------------ */

/**
 * The nouns. A payable priced by weighed quantity is a *pesada* to everybody
 * on the farm; a day of pruning is a *labor*. Using one word for both makes
 * the sentence wrong half the time, and the distinction costs one field.
 *
 * When the rows could not be resolved there is nothing to look at, so the
 * neutral word is used — never a guess at what kind of work arrived.
 */
function nounFor(lines: PayableLine[], n: number): string {
  const allWeighed = lines.length > 0 && lines.every((l) => l.unitLabel !== null);
  if (allWeighed) return n === 1 ? "pesada" : "pesadas";
  return n === 1 ? "labor" : "labores";
}

/** "una", "dos", "tres"… up to a point, then digits. Reads better in a sentence. */
const WORDS = ["cero", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"];
const count = (n: number): string => (n < WORDS.length ? WORDS[n] : String(n));

export interface Formatters {
  money: (cents: number) => string;
  /** A Monday -> "24 de agosto". Injected so this module stays formatter-free. */
  week: (monday: DayISO) => string;
}

/**
 * Why the figure moved, as phrases that finish the sentence "…ahora son
 * $151.200 porque ___".
 *
 * One phrase per KIND of change, never one per row: a week whose price changed
 * moved forty payables at once, and forty phrases saying so is not an
 * explanation. The rows themselves are shown in the table underneath.
 */
export function reasonsFor(change: GrossChange, fmt: Formatters): string[] {
  const out: string[] = [];

  if (change.addedIds.length > 0) {
    const n = change.addedIds.length;
    out.push(`entr${n === 1 ? "ó" : "aron"} ${count(n)} ${nounFor(change.added, n)} más`);
  }
  if (change.removedIds.length > 0) {
    const n = change.removedIds.length;
    out.push(
      `${n === 1 ? "salió" : "salieron"} ${count(n)} ${nounFor(change.removed, n)} ` +
        `de la liquidación`,
    );
  }
  for (const w of change.repriced) {
    out.push(
      `el precio de la semana del ${fmt.week(w.weekStart)} pasó de ` +
        `${fmt.money(w.fromRateCents)} a ${fmt.money(w.toRateCents)}`,
    );
  }

  // Something moved and none of the three explains it. Two quite different
  // situations, and they must not share a sentence: either the server was
  // never told what the screen saw, or it was and the cause is outside
  // anything it can establish.
  if (out.length === 0) {
    out.push(
      change.causeIsKnown
        ? "las labores pendientes cambiaron"
        : "las labores pendientes cambiaron y no se pudo establecer qué se movió",
    );
  }
  return out;
}

/**
 * The whole sentence, the way the owner asked for it:
 *
 *   «Cuando abrió esta pantalla eran $148.400; ahora son $151.200 porque
 *    entraron dos pesadas más.»
 *   «…porque el precio de la semana del 24 de agosto pasó de $800 a $850.»
 */
export function sentenceFor(change: GrossChange, fmt: Formatters): string {
  const reasons = reasonsFor(change, fmt);
  const because =
    reasons.length === 1
      ? reasons[0]
      : `${reasons.slice(0, -1).join(", ")} y ${reasons[reasons.length - 1]}`;
  return (
    `Cuando abrió esta pantalla eran ${fmt.money(change.beforeCents)}; ` +
    `ahora son ${fmt.money(change.afterCents)} porque ${because}.`
  );
}

/** Only used by the tests, to build a line without importing half the app. */
export function line(
  id: Uuid,
  amountCents: number,
  over: Partial<PayableLine> = {},
): PayableLine {
  return {
    id,
    activityName: "Recolección",
    dateFrom: "2026-08-24" as DayISO,
    dateTo: "2026-08-24" as DayISO,
    weekStart: "2026-08-24" as DayISO,
    plotNames: [],
    quantity: 1,
    unitLabel: "kg",
    rateCents: amountCents,
    rateSource: "fixed",
    amountCents,
    ...over,
  };
}
