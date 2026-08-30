/**
 * `user_version = 8` — undoing a zero the phone invented and wrote down.
 *
 * v7's `backfillPriceCents` filled the integer-cents column from the old float
 * one with `toCents(Number(r.costPerUnit ?? 0))`. For a row that named a price
 * that is right. For a row that named NO price — both columns NULL, which the
 * schema allows — it wrote a **0**, and a zero in that column is a claim: it
 * says this week was deliberately worth nothing.
 *
 * v7 was fixed so it no longer invents that zero. This is the other half, and
 * the half that matters, because a migration does not get a second chance:
 * every handset that already ran v7 is carrying the invented zeros right now
 * and nothing in the app will ever revisit them.
 *
 * What makes the repair exact is that the old backfill never touched
 * `costPerUnit`. It is still there, and it is the witness:
 *
 *   costPerUnitCents = 0 AND costPerUnit IS NULL  → invented. Repairable.
 *   costPerUnitCents = 0 AND costPerUnit = 0      → a real decision. Untouched.
 *
 * Measured on a database in the pre-fix state: one of each, and this repair
 * takes exactly the first.
 *
 * ## Why this is not cosmetic
 *
 * The season import is the gate for the whole move to the server, and it is
 * all-or-nothing. Measured against the real API, a season carrying one such
 * week is refused outright:
 *
 *   POST /v1/import/season  →  400
 *   {"code":"BAD_REQUEST","message":"a week price must be positive: 2026-08-24"}
 *
 * The same payload with a real price returns 200. So without this repair, a
 * farm whose phone ever held an empty override row cannot migrate at all —
 * and the error names a week, not a cause, so nobody would know why.
 */

import type { SqlDatabase } from "./sqliteRepository.ts";

/**
 * Nulls out the zeros v7 invented, in both tables v7's backfill wrote to.
 *
 * Returns how many rows were repaired. A phone that never had an empty
 * override row repairs nothing, which is the ordinary case.
 */
export function repairInventedZeroPrices(db: SqlDatabase): number {
  let n = 0;
  for (const t of ["config", "cost_overrides"]) {
    n += db.runSync(
      `UPDATE ${t} SET costPerUnitCents = NULL
        WHERE costPerUnitCents = 0 AND costPerUnit IS NULL`,
      [],
    ).changes;
  }
  return n;
}

export interface V8Report {
  pricesRepaired: number;
}

/**
 * The whole of `user_version = 8`. The caller opens the transaction and stamps
 * the version, exactly as it does for v6 and v7.
 */
export function migrateToV8(db: SqlDatabase): V8Report {
  return { pricesRepaired: repairInventedZeroPrices(db) };
}
