// SPDX-License-Identifier: MIT
/**
 * THE KILO PRICE RULES, KEPT ON THE DEVICE.
 *
 * The value shown next to a weighing before it is settled is only an
 * estimate, but it has to be the estimate the server would give: the server
 * prices a kilo with `kilo_price()` (migration 00034) — persona > lote >
 * semana > finca, each effective from a Monday — and an estimate that used
 * the farm's base price alone told the owner José Arley's 40 kg were worth
 * $32.000 when they are worth $40.000.
 *
 * So the rules travel, not a price: the special prices (per person and per
 * lote, with their dated history), the base price history and the week
 * prices seen so far are copied into IndexedDB whenever the app is online,
 * and resolved here with the shared `resolveKiloPrice` — the same function
 * the mock server uses, tested against every priority level.
 *
 * The server stays authoritative. Once a weighing is on the server, its
 * `estimatedAmountCents` is what every list shows; this copy is only what the
 * phone can say without signal. Settled weeks never come through here at all:
 * their price was frozen when they were settled.
 *
 * Money: only roles that may read prices (owner and administrator) sync the
 * book. A weigher's device never holds a price.
 */
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import { addDays, mondayOf, parseDay } from "../lib/dates";
import {
  resolveKiloPrice,
  type KiloPrice,
  type KiloPriceBook,
} from "../../../../packages/shared/src/kiloPrice";
import { getCache, putCache } from "./store";

export type { KiloPrice, KiloPriceBook };

/** How many Mondays back the week prices are copied, counting this one. */
export const WEEKS_SYNCED = 6;

export const EMPTY_BOOK: KiloPriceBook = {
  employeePrices: [],
  plotPrices: [],
  weekPrices: [],
  basePrices: [],
  farmPriceCents: null,
};

const key = (farmId: string) => `prices:${farmId}`;

/** The request never got an answer from our server. */
function noSignal(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 0 || e.status >= 502);
}

/** The Mondays whose week price the device keeps: this one and the ones before it. */
export function recentMondays(today: string, weeks = WEEKS_SYNCED): string[] {
  const first = parseDay(mondayOf(today));
  return Array.from({ length: weeks }, (_, i) => addDays(first, -7 * i).toISOString().slice(0, 10));
}

/**
 * `GET /v1/prices/weeks/{monday}` answers the week's own price or, when the
 * week has none, the base price in force. Only a week whose price differs
 * from the base in force that Monday is kept as a week override — otherwise
 * the shared resolver would treat every cached Monday as "semana" and a later
 * base-price change would never reach those weeks.
 */
async function fetchWeekOverrides(
  mondays: string[],
  basePrices: KiloPriceBook["basePrices"],
  farmPriceCents: number | null,
): Promise<KiloPriceBook["weekPrices"]> {
  const baseOn = (monday: string): number | null => {
    let best: { validFrom: string; priceCents: number } | undefined;
    for (const e of basePrices) {
      if (e.validFrom > monday) continue;
      if (!best || e.validFrom > best.validFrom) best = e;
    }
    if (best) return best.priceCents;
    return farmPriceCents && farmPriceCents > 0 ? farmPriceCents : null;
  };
  const out = await Promise.all(
    mondays.map((m) =>
      api.weekPrice(m).then(
        (w) => {
          if (w.costPerUnitCents <= 0) return null;
          // Same number as the base: not a week override.
          if (w.costPerUnitCents === baseOn(m)) return null;
          return { weekStart: w.monday, priceCents: w.costPerUnitCents };
        },
        (e: unknown) => {
          if (noSignal(e)) throw e;
          return null;
        },
      ),
    ),
  );
  return out.filter((w): w is { weekStart: string; priceCents: number } => w !== null);
}

/**
 * Replaces the week overrides for the Mondays just asked about. A Monday that
 * no longer has its own price (it was deleted, or it never had one) must leave
 * the book — keeping a stale override would freeze an old number forever.
 */
export function withWeeks(
  book: KiloPriceBook,
  asked: readonly string[],
  weeks: KiloPriceBook["weekPrices"],
): KiloPriceBook {
  const askedSet = new Set(asked);
  const kept = book.weekPrices.filter((w) => !askedSet.has(w.weekStart));
  const next = [...kept, ...weeks];
  // Same Mondays, same prices: keep the book so a React effect that depends
  // on it does not loop forever when ensureWeek finds nothing new.
  if (
    next.length === book.weekPrices.length &&
    next.every((w) => book.weekPrices.some((o) => o.weekStart === w.weekStart && o.priceCents === w.priceCents))
  ) {
    return book;
  }
  return { ...book, weekPrices: next };
}

/** Everything the server knows about kilo prices, flattened into a book. */
export async function fetchPriceBook(mondays: string[]): Promise<KiloPriceBook> {
  const [special, base] = await Promise.all([api.listSpecialPrices(), api.getBasePrice()]);
  const basePrices = base.history.map((h) => ({ validFrom: h.validFrom, priceCents: h.priceCents }));
  const farmPriceCents = base.currentCents > 0 ? base.currentCents : null;
  const weeks = await fetchWeekOverrides(mondays, basePrices, farmPriceCents);
  return {
    employeePrices: special
      .filter((s) => s.kind === "persona")
      .flatMap((s) => s.history.map((h) => ({ employeeId: s.targetId, validFrom: h.validFrom, priceCents: h.priceCents }))),
    plotPrices: special
      .filter((s) => s.kind === "lote")
      .flatMap((s) => s.history.map((h) => ({ plotId: s.targetId, validFrom: h.validFrom, priceCents: h.priceCents }))),
    weekPrices: weeks,
    basePrices,
    farmPriceCents,
  };
}

export async function savePriceBook(farmId: string, book: KiloPriceBook): Promise<void> {
  await putCache(key(farmId), book);
}

export async function loadPriceBook(farmId: string): Promise<KiloPriceBook | null> {
  const row = await getCache<KiloPriceBook>(key(farmId)).catch(() => null);
  return row?.value ?? null;
}

/**
 * The book for this farm: fresh from the server when there is signal (and
 * saved on the device for later), the device's copy when there is not.
 * Null when there is neither — the estimate then says nothing rather than
 * guess.
 */
export async function syncPriceBook(farmId: string, mondays: string[]): Promise<KiloPriceBook | null> {
  try {
    const book = await fetchPriceBook(mondays);
    // Weeks fetched earlier for other Mondays (an «otro día» weighing) stay.
    const saved = await loadPriceBook(farmId);
    // Keep week overrides outside the Mondays we just asked about; replace
    // those Mondays with what the server said (or with nothing).
    const merged = saved
      ? withWeeks({ ...book, weekPrices: saved.weekPrices }, mondays, book.weekPrices)
      : book;
    await savePriceBook(farmId, merged).catch(() => undefined);
    return merged;
  } catch (e) {
    if (!noSignal(e)) return null;
    return loadPriceBook(farmId);
  }
}

/**
 * One more Monday for a book already in hand (a weighing dated outside the
 * weeks synced). Offline, or if the server refuses, the book is returned
 * unchanged and the resolver falls back to the base price history — which is
 * right for every week the owner did not give its own price.
 */
export async function ensureWeek(farmId: string, book: KiloPriceBook, monday: string): Promise<KiloPriceBook> {
  if (book.weekPrices.some((w) => w.weekStart === monday)) return book;
  try {
    const weeks = await fetchWeekOverrides([monday], book.basePrices, book.farmPriceCents ?? null);
    const next = withWeeks(book, [monday], weeks);
    await savePriceBook(farmId, next).catch(() => undefined);
    return next;
  } catch {
    return book;
  }
}

/**
 * The kilo price of one weighing, dated by its day. Null when nothing applies.
 * With no person picked yet (`workerId` empty) it is the price any person
 * without their own would get: lote, then week, then base.
 */
export function kiloPriceFor(
  book: KiloPriceBook,
  weighing: { workerId: string; plotIds?: readonly string[] | null; day: string },
): KiloPrice | null {
  if (!weighing.day) return null;
  return resolveKiloPrice(book, {
    employeeId: weighing.workerId,
    plotIds: weighing.plotIds ?? [],
    weekStart: mondayOf(weighing.day),
  });
}
