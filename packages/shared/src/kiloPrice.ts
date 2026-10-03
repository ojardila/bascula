// SPDX-License-Identifier: MIT
/**
 * What a kilo of one weighing is worth, and where that number came from.
 *
 * Mirrors `kilo_price()` in migration 00034 (persona > lote > semana > finca).
 * Phase 3 will put a corrected settlement-line price above all of these; until
 * then this is the whole rule. Settled lines never ask the question — their
 * price was frozen when they were settled — so callers only use this for
 * provisional estimates.
 *
 * Shared so the web offline estimate, the MSW mock and any future client all
 * resolve the same way the server does. Effective dating is by Monday: every
 * `validFrom` / week key is an ISO Monday (YYYY-MM-DD).
 */

/** One dated exception (employee or lote). A null price ends it from that Monday. */
export interface KiloPriceEntry {
  validFrom: string;
  /** Null means "no special price from this Monday on". */
  priceCents: number | null;
}

export interface KiloPriceBook {
  /** Flat history of persona exceptions (any order). */
  employeePrices: ReadonlyArray<KiloPriceEntry & { employeeId: string }>;
  /** Flat history of lote exceptions (any order). */
  plotPrices: ReadonlyArray<KiloPriceEntry & { plotId: string }>;
  /** Weeks with their own override (week_prices rows only). */
  weekPrices: ReadonlyArray<{ weekStart: string; priceCents: number }>;
  /** Farm base price history, any order. */
  basePrices: ReadonlyArray<{ validFrom: string; priceCents: number }>;
  /** Last-resort farm standing price when history is empty. */
  farmPriceCents?: number | null;
}

export type KiloPriceSource = "persona" | "lote" | "semana" | "finca";

export interface KiloPrice {
  priceCents: number;
  source: KiloPriceSource;
}

export interface KiloPriceQuery {
  employeeId: string;
  /** Lotes named on the weighing. Empty / missing skips the lote rule. */
  plotIds?: ReadonlyArray<string> | null;
  /** Monday of the weighing's week (YYYY-MM-DD). */
  weekStart: string;
}

/** The entry in force on a Monday, or undefined when none covers it. */
export function entryOn(
  entries: ReadonlyArray<KiloPriceEntry>,
  monday: string,
): KiloPriceEntry | undefined {
  let best: KiloPriceEntry | undefined;
  for (const e of entries) {
    if (e.validFrom > monday) continue;
    if (!best || e.validFrom > best.validFrom) best = e;
  }
  return best;
}

function baseOn(book: KiloPriceBook, monday: string): number | null {
  const row = entryOn(book.basePrices, monday);
  if (row && row.priceCents !== null) return row.priceCents;
  const farm = book.farmPriceCents;
  return farm !== undefined && farm !== null && farm > 0 ? farm : null;
}

function weekOrFarm(book: KiloPriceBook, monday: string): KiloPrice | null {
  const override = book.weekPrices.find((w) => w.weekStart === monday);
  if (override) return { priceCents: override.priceCents, source: "semana" };
  const base = baseOn(book, monday);
  if (base !== null) return { priceCents: base, source: "finca" };
  return null;
}

/**
 * Resolve the kilo price of one weighing.
 *
 * First match wins: persona (latest valid_from ≤ week with a non-null price) >
 * lote (every named lote has the same non-null price) > week override > farm
 * base. Returns null when nothing applies (no base price yet).
 */
export function resolveKiloPrice(book: KiloPriceBook, q: KiloPriceQuery): KiloPrice | null {
  const personRows = book.employeePrices.filter((e) => e.employeeId === q.employeeId);
  const person = entryOn(personRows, q.weekStart);
  if (person && person.priceCents !== null) {
    return { priceCents: person.priceCents, source: "persona" };
  }

  const plots = q.plotIds ?? [];
  if (plots.length > 0) {
    const prices: number[] = [];
    let allPriced = true;
    for (const plotId of plots) {
      const row = entryOn(
        book.plotPrices.filter((p) => p.plotId === plotId),
        q.weekStart,
      );
      if (row?.priceCents == null) {
        allPriced = false;
        break;
      }
      prices.push(row.priceCents);
    }
    if (allPriced && prices.length > 0 && prices.every((p) => p === prices[0])) {
      return { priceCents: prices[0]!, source: "lote" };
    }
  }

  return weekOrFarm(book, q.weekStart);
}
