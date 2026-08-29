/**
 * `user_version = 6` — giving the phone the identity sync needs.
 *
 * A separate file because this is the first migration that touches every table
 * the farm owns, on a database that is in production, mid-harvest, holding a
 * season of weighings nobody can re-enter. The rules it is written to:
 *
 * - **One transaction.** Every statement below runs inside the caller's
 *   `withTransactionSync`, `PRAGMA user_version = 6` included. SQLite journals
 *   DDL and the user_version header field alike, so a failure anywhere rolls
 *   the schema back with the data and the app comes up at 5, exactly as it was
 *   yesterday. A migration to 2 once left a farm unable to start at all
 *   (`sqliteRepository.ts`, the `v < 2` branch); half a schema is worse than
 *   no schema, so there is no half here.
 * - **Nothing is rewritten.** Integer primary keys stay, foreign keys stay,
 *   every screen and every join stay. Rows only grow columns.
 * - **Chronology survives.** Each uuid is seeded from the instant its row
 *   belongs to, and the whole farm is sorted into one stream before a single
 *   id is minted, so `ORDER BY uuid` across any table is the order things
 *   actually happened. Seeding from the migration's own clock would have been
 *   two lines shorter and would have handed the server a season with no order
 *   at all.
 */

import { createUuidV7 } from "../../../../packages/shared/src/uuid.ts";
import {
  OUTBOX_SCHEMA,
  SYNCED_TABLES,
  SYNC_COLUMNS,
  outboxSeedSql,
  outboxTriggersSql,
  uuidIndexesSql,
} from "../schema.ts";
import type { SqlDatabase } from "./sqliteRepository.ts";

/**
 * The instant a row belongs at, from whatever its table stores.
 *
 * Three shapes turn up: a full ISO instant (`createdAt`, `pickups.date`), a
 * bare local day (`cost_overrides.week`, and `ledger.date` on rows the older
 * writers stamped with a day), and nothing at all. A bare day is read as UTC
 * midnight rather than through `new Date(day)`'s local parsing, which would
 * shift the row a day backwards for everyone west of Greenwich and reorder the
 * boundary between two weeks.
 */
export function instantOfRow(raw: string | number | null, fallbackMs: number): number {
  if (raw === null || raw === undefined) return fallbackMs;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : fallbackMs;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (day) return Date.UTC(+day[1]!, +day[2]! - 1, +day[3]!);
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : fallbackMs;
}

/** Add a column only if it is missing. `try { ALTER } catch {}` inside a
 *  transaction leaves SQLite holding an error nobody asked about; asking the
 *  schema is both cheaper and honest about what it found. */
function addMissingColumns(db: SqlDatabase): void {
  for (const [table, columns] of Object.entries(SYNC_COLUMNS)) {
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

interface Pending {
  table: string;
  rank: number;
  id: number;
  ms: number;
}

/**
 * Mint a uuid for every row that has none, in one chronological pass over the
 * whole farm.
 *
 * Sorting all the tables together rather than one table at a time is what
 * makes the ids mean something across tables: a settlement written in the same
 * millisecond as its lines still sorts before them, because ties fall back to
 * the order `SYNCED_TABLES` declares — parents first. Doing it per table would
 * also have needed one generator each, since a monotonic generator fed a
 * February instant after an August one has to lie about February.
 *
 * Returns how many rows it touched, which is what the migration's timing test
 * reports.
 */
function backfillUuids(db: SqlDatabase, at: Date): number {
  const fallbackMs = at.getTime();
  const pending: Pending[] = [];

  SYNCED_TABLES.forEach((t, rank) => {
    const rows = db.getAllSync<{ id: number; bornAt: string | number | null }>(
      `SELECT id, ${t.bornAt} AS bornAt FROM ${t.name} WHERE uuid IS NULL`,
      [],
    );
    for (const r of rows)
      pending.push({
        table: t.name,
        rank,
        id: r.id,
        ms: instantOfRow(r.bornAt, fallbackMs),
      });
  });

  pending.sort((a, b) => a.ms - b.ms || a.rank - b.rank || a.id - b.id);

  // One statement per row, deliberately. Folding them into batched
  // `CASE id WHEN ... END` updates was measured at 93 ms against 58 ms for
  // 25,000 rows — SQLite's linear scan of a 150-branch CASE costs more than
  // preparing a two-parameter update by primary key — and it would have put
  // the migration a parameter-limit away from failing on an older SQLite.
  const next = createUuidV7();
  const sqlFor = new Map(
    SYNCED_TABLES.map((t) => [
      t.name,
      `UPDATE ${t.name} SET uuid = ?, updatedAt = ? WHERE id = ?`,
    ]),
  );
  for (const p of pending)
    db.runSync(sqlFor.get(p.table)!, [
      next(p.ms),
      // The row last changed when it was written; that is all this database
      // knows, and claiming it changed today would make every row on the phone
      // look newer than the server's copy on the very first pull.
      new Date(p.ms).toISOString(),
      p.id,
    ]);

  return pending.length;
}

/**
 * The whole of `user_version = 6`. The caller opens the transaction and stamps
 * the version; this function does the work and nothing else, so a test can run
 * it under a connection that fails on the Nth statement and check what is left.
 */
export function migrateToV6(db: SqlDatabase, at: Date): number {
  addMissingColumns(db);
  db.execSync(OUTBOX_SCHEMA);

  const filled = backfillUuids(db, at);

  // After the backfill, not before: building a unique index over a column that
  // is about to be written 18,000 times costs the same work twice.
  db.execSync(uuidIndexesSql());

  // Also after: the triggers would otherwise fire once per backfilled row and
  // queue them one at a time, where the seed below does the lot in one
  // statement and in uuid order.
  db.execSync(outboxTriggersSql());

  // At version 6 the server has never seen this farm, so every row it holds is
  // owed. One statement, in uuid order, rather than eighteen thousand trigger
  // firings — which is why the triggers above are created only now.
  db.runSync(outboxSeedSql(), [at.toISOString()]);

  return filled;
}
