/**
 * `user_version = 7` — the three things that had to be true before the phone
 * could talk to a server, plus the tables sync needs to keep its own state.
 *
 * Same rules as v6, for the same reason: this runs unattended, once, on a
 * handset in a field holding the only copy of a season.
 *
 *  - **One transaction**, `PRAGMA user_version` included. A failure anywhere
 *    leaves a database that is still exactly a version-6 database and an app
 *    that still starts.
 *  - **Nothing is rewritten.** Rows only grow columns. The integer primary
 *    keys, the foreign keys and `ux_items_pickup_live` are untouched — that
 *    last one is the only thing stopping this farm paying twice, and it is not
 *    something to be clever near.
 *  - **The backfill is deterministic and resumable.** Every value written
 *    below is a pure function of the row it is written to, so running it twice
 *    produces the same database and a migration that dies halfway resumes.
 */

import {
  dayInZone,
  weekInZone,
  DEFAULT_TIMEZONE,
} from "../../../../packages/shared/src/time.ts";
import { toCents } from "../../../../packages/shared/src/money.ts";
import {
  CONFLICTS_SCHEMA,
  PICKUPS_LIVE_VIEW,
  REACTIVATIONS_SCHEMA,
  SYNC_APPLY_SCHEMA,
  SYNC_STATE_SCHEMA,
  V7_COLUMNS,
  V7_INDEXES_SQL,
  outboxTriggersSql,
} from "../schema.ts";
import type { SqlDatabase } from "./sqliteRepository.ts";

/** Add a column only if it is missing, asking the schema rather than
 *  swallowing an error — same helper as v6, same reason. */
function addMissingColumns(db: SqlDatabase): void {
  for (const [table, columns] of Object.entries(V7_COLUMNS)) {
    const have = new Set(
      db
        .getAllSync<{ name: string }>(`PRAGMA table_info(${table})`, [])
        .map((c) => c.name),
    );
    for (const decl of columns) {
      const name = decl.split(/\s+/)[0]!;
      if (!have.has(name)) db.execSync(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
    }
  }
}

/**
 * Materialise the farm's day and week onto every weighing that has none.
 *
 * In batches, and `WHERE localDay IS NULL` so a rerun costs nothing. The zone
 * is the farm's, not the handset's; before the first handshake that is
 * `America/Bogota`, which is what the one phone in production is set to
 * (§1.5b). If the handshake later brings a different zone, `restampDays`
 * below is what fixes the rows — deliberately a separate, explicit call, not
 * something a migration does behind anybody's back.
 *
 * Returns how many weighings were stamped.
 */
export function backfillLocalDays(
  db: SqlDatabase,
  timeZone: string,
  batch = 500,
): number {
  let total = 0;
  for (;;) {
    const rows = db.getAllSync<{ id: number; date: string | null; createdAt: string | null }>(
      `SELECT id, date, createdAt FROM pickups
        WHERE localDay IS NULL OR week IS NULL
        LIMIT ?`,
      [batch],
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      // `date` is the weighing; `createdAt` is only the fallback for a row
      // some older writer left without one. A weighing with neither is dated
      // at the epoch rather than at today: putting it in this week would sweep
      // a row of unknown age into the settlement about to be paid.
      const instant = r.date ?? r.createdAt ?? "1970-01-01T00:00:00.000Z";
      db.runSync("UPDATE pickups SET localDay = ?, week = ? WHERE id = ?", [
        dayInZone(instant, timeZone),
        weekInZone(instant, timeZone),
        r.id,
      ]);
    }
    total += rows.length;
    if (rows.length < batch) break;
  }
  return total;
}

/**
 * The ledger's business day.
 *
 * `ledger.date` is ALREADY a local day — every writer stamps it with
 * `localDayOf(clock())` — so this is a copy, not a re-derivation. Deriving it
 * from `createdAt` instead would move every back-dated correction onto the day
 * somebody typed it, which is the opposite of what a correction is for.
 */
export function backfillLedgerDays(db: SqlDatabase): number {
  return db.runSync(
    `UPDATE ledger SET localDay = substr(date, 1, 10) WHERE localDay IS NULL`,
    [],
  ).changes;
}

/**
 * Prices as integer cents.
 *
 * `toCents` is the shared one, so the phone rounds a price exactly the way the
 * server and the web do. A price of 0 is written as 0 rather than skipped: the
 * NULL would otherwise be read as "no override" and quietly restore the
 * general price on a week somebody deliberately set to nothing.
 *
 * A row with NO price is a different row, and it used to share that fate.
 * `Number(null ?? 0)` made an override that names nothing into a permanent,
 * deliberate-looking zero -- and unlike the read path, a migration writes it
 * down once and there is nothing left to fall back from. Deliberately zero and
 * never priced are not the same week, so only the first is backfilled; the
 * second keeps its NULL and goes on reading as "no override".
 */
export function backfillPriceCents(db: SqlDatabase): number {
  let n = 0;
  for (const t of ["config", "cost_overrides"]) {
    const rows = db.getAllSync<{ id: number; costPerUnit: number }>(
      `SELECT id, costPerUnit FROM ${t}
        WHERE costPerUnitCents IS NULL AND costPerUnit IS NOT NULL`,
      [],
    );
    for (const r of rows) {
      db.runSync(`UPDATE ${t} SET costPerUnitCents = ? WHERE id = ?`, [
        toCents(Number(r.costPerUnit)),
        r.id,
      ]);
      n++;
    }
  }
  return n;
}

/**
 * Re-derive every weighing's day and week under a different zone.
 *
 * Called when the handshake brings a `timezone` that is not the one the rows
 * were stamped with. It is a real rewrite of a business date, so it is loud
 * and it is not automatic anywhere except right after the farm is registered,
 * when the phone has not yet sent or settled anything under the wrong zone.
 *
 * Returns how many rows actually changed, which is the number worth logging:
 * on a farm whose zone was right all along it is zero.
 */
export function restampDays(db: SqlDatabase, timeZone: string): number {
  const rows = db.getAllSync<{
    id: number;
    date: string | null;
    createdAt: string | null;
    localDay: string | null;
    week: string | null;
  }>("SELECT id, date, createdAt, localDay, week FROM pickups", []);
  let changed = 0;
  for (const r of rows) {
    const instant = r.date ?? r.createdAt ?? "1970-01-01T00:00:00.000Z";
    const day = dayInZone(instant, timeZone);
    const week = weekInZone(instant, timeZone);
    if (day === r.localDay && week === r.week) continue;
    db.runSync("UPDATE pickups SET localDay = ?, week = ? WHERE id = ?", [
      day,
      week,
      r.id,
    ]);
    changed++;
  }
  return changed;
}

/** What v7 did, for the log and for the migration's own tests. */
export interface V7Report {
  pickupsStamped: number;
  ledgerStamped: number;
  pricesConverted: number;
}

/**
 * The whole of `user_version = 7`. The caller opens the transaction and stamps
 * the version, exactly as it does for v6.
 */
export function migrateToV7(
  db: SqlDatabase,
  timeZone: string = DEFAULT_TIMEZONE,
): V7Report {
  addMissingColumns(db);

  // First, because every UPDATE below fires the v6 outbox triggers, and those
  // triggers read this table. A phone upgrading from a build whose triggers
  // predate the guard gets it here; one upgrading from v6 already has it and
  // this is a no-op.
  db.execSync(SYNC_APPLY_SCHEMA);

  const pickupsStamped = backfillLocalDays(db, timeZone);
  const ledgerStamped = backfillLedgerDays(db);
  const pricesConverted = backfillPriceCents(db);

  // After the backfill, for the same reason v6 indexes after its own: building
  // an index over a column that is about to be written 18,000 times costs the
  // same work twice.
  db.execSync(V7_INDEXES_SQL);

  // The view is created last, because it cannot be created before the column
  // it filters on exists. Every read in the app goes through it from here on.
  db.execSync(PICKUPS_LIVE_VIEW);

  db.execSync(SYNC_STATE_SCHEMA);
  db.execSync(CONFLICTS_SCHEMA);
  db.execSync(REACTIVATIONS_SCHEMA);

  // Rebuilt so a phone whose triggers predate the guard gets the guarded
  // versions. `DROP TRIGGER IF EXISTS` inside makes it idempotent.
  db.execSync(outboxTriggersSql());

  // The zone the rows above were stamped with, recorded so the handshake can
  // tell whether it needs to restamp. Without it the phone cannot know which
  // zone produced the numbers it is already using to pay people.
  db.runSync(
    "UPDATE config SET timezone = COALESCE(timezone, ?) WHERE id = 1",
    [timeZone],
  );

  return { pickupsStamped, ledgerStamped, pricesConverted };
}
