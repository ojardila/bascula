/**
 * The SQLite implementation of `Repository`.
 *
 * It receives its connection instead of opening one. That is the whole point
 * of this file existing: `db.ts` used to run
 * `SQLite.openDatabaseSync("bascula.db")` at module scope, so importing any of
 * this outside a phone was impossible and the entire data layer — settle, pay,
 * void, undo, the migrations — had no tests at all
 * (`docs/diagramas/movil.md` §9.2). Everything below is exactly the code that
 * used to live in `db.ts`; only where `db` comes from has changed.
 *
 * The port is deliberately the five methods expo-sqlite already offers, so the
 * real `SQLiteDatabase` satisfies it as-is and a `node:sqlite` handle needs
 * about fifteen lines of adapter.
 */

import {
  toCents,
  fromCents,
  amountCents,
} from "../../../../packages/shared/src/money.ts";
import {
  localDayOf,
  dayInZone,
  weekInZone,
  DEFAULT_TIMEZONE,
} from "../../../../packages/shared/src/time.ts";
import { createUuidV7 } from "../../../../packages/shared/src/uuid.ts";
import { migrateToV6 } from "./migrateToV6.ts";
import { migrateToV7, restampDays } from "./migrateToV7.ts";
import { createSyncStore, reactivateWorker } from "./syncStore.ts";
import {
  BASE_SCHEMA,
  PAYMENTS_SCHEMA,
  PICKUP_INDEXES_SQL,
  BALANCE_COLUMNS,
  BALANCE_SQL,
  HARVEST_VALUE_EXPR,
  HARVEST_VALUE_SQL,
  PENDING_SQL,
  PAID_AGAINST_SQL,
  PAID_IN_RANGE_SQL,
  INDEX_SQL,
  RULE_IMPOSSIBLE_SQL,
  RULE_DUPLICATE_SQL,
  RULE_DIGIT_SQL,
  RULE_OUTLIER_SQL,
  RULE_FUTURE_SQL,
  EXPORT_PICKUPS_SQL,
  EXPORT_LEDGER_SQL,
  EXPORT_BALANCES_SQL,
  WEEK_BY_DAY_SQL,
  WEEK_BY_WORKER_SQL,
  WEEK_GRID_SQL,
  WEEK_PLOTS_SQL,
  WEEK_GRID_DAY_SQL,
  OUTBOX_PENDING_SQL,
  PICKUPS_LIVE_VIEW,
  IMPORT_RUNS_SCHEMA,
  SERVER_BALANCES_SCHEMA,
} from "../schema.ts";
import { buildSeasonExport } from "../sync/seasonExport.ts";
import type { ImportRun, ImportRunInput } from "../sync/seasonImport.ts";
import { UnpricedWeeks } from "./repository.ts";
import type {
  AnomaliesRepo,
  Anomaly,
  AnomalyWindow,
  AppLang,
  Balance,
  BalanceRow,
  ConfigRepo,
  CostOverride,
  Crop,
  CropConfig,
  CropPickup,
  CropReportsRepo,
  CropStats,
  CropWeek,
  CropWorker,
  CropsRepo,
  DemoRepo,
  ExportRepo,
  FarmTotals,
  Grouping,
  LabelledKg,
  LedgerEntry,
  OverridesRepo,
  PaymentsRepo,
  PendingItem,
  PendingWorker,
  PeopleRepo,
  PerformanceRepo,
  PeriodTotals,
  Person,
  PickupsRepo,
  PlotPerf,
  PrefsRepo,
  PriceResponseRow,
  RealCost,
  RecentPickup,
  TypicalLoad,
  OutboxEntry,
  Repository,
  ReportsRepo,
  PayrollRun,
  FullBalance,
  SettleResult,
  Settlement,
  SettlementItem,
  SettlementPreview,
  SyncIdentity,
  SyncRepo,
  ValuedGroup,
  WeekCropRow,
  WeekDay,
  WeekDayCell,
  WeekGridCell,
  WeekPlot,
  WeekReportsRepo,
  WeekWorker,
  WorkerPerf,
  WorkerPickup,
  WorkerReportsRepo,
  WorkerStats,
  WriteResult,
} from "./repository.ts";

// ---- The port ----------------------------------------------------------

export type SqlValue = string | number | boolean | Uint8Array | null;

/**
 * The slice of `expo-sqlite`'s `SQLiteDatabase` this layer actually uses. A
 * real database satisfies it structurally; so does a thin wrapper over
 * `node:sqlite`, which is how the tests get at everything below.
 */
export interface SqlDatabase {
  getAllSync<T>(sql: string, params: SqlValue[]): T[];
  getFirstSync<T>(sql: string, params: SqlValue[]): T | null;
  runSync(sql: string, params: SqlValue[]): WriteResult;
  execSync(sql: string): void;
  withTransactionSync(task: () => void): void;
}

// ---- Pure helpers ------------------------------------------------------

const SCHEMA_VERSION = 7;

// Monday of the "%Y-Www" week that strftime('%W') would have produced:
// week 01 starts on the year's first Monday, and earlier days fall in week 00.
export function mondayOfLegacyWeek(label: string): string | null {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(label);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const firstMonday = new Date(jan1);
  firstMonday.setUTCDate(jan1.getUTCDate() + ((8 - jan1.getUTCDay()) % 7));
  const monday = new Date(firstMonday);
  monday.setUTCDate(firstMonday.getUTCDate() + (week - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

/**
 * The bounds of the review window, as the two predicates the rule SQL wants:
 * a raw instant the `pickups(date)` index can seek on, and the exact local day.
 *
 * They are not redundant. `date(col,'localtime') >= date(?)` is the correct
 * test but no index can serve it, so on its own it still reads every row ever
 * weighed. The raw bound is set a day earlier than the local one so it can
 * never exclude anything the exact test would have kept, whatever the phone's
 * offset; the exact test then does the real filtering on a much smaller set.
 */
export function windowBounds(sinceDays: number): { raw: string; day: string } {
  const start = new Date();
  start.setDate(start.getDate() - sinceDays);
  const slack = new Date(start);
  slack.setDate(slack.getDate() - 1);
  return {
    raw: `${localDayOf(slack)}T00:00:00.000Z`,
    day: localDayOf(start),
  };
}

/** One harvest season back, and no more findings than anyone will read. */
export const DEFAULT_ANOMALY_WINDOW: AnomalyWindow = {
  sinceDays: 120,
  limit: 200,
};

/**
 * Fold accents and case before comparing a typed confirmation with the farm's
 * name. Demanding the exact accent on "Café" from a phone keyboard in the
 * field would only teach people to look for a way around the prompt.
 */
const foldToken = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();

/** Used when the farm has no label yet, so the token is never the empty string. */
export const FALLBACK_CLEAR_TOKEN = "BORRAR";

export class ConfirmationRequired extends Error {
  // Written out rather than a parameter property: the suites run on Node's
  // type stripping, which does not support them.
  expected: string;
  constructor(expected: string) {
    super("CONFIRM_REQUIRED");
    this.name = "ConfirmationRequired";
    this.expected = expected;
  }
}

// ---- The factory -------------------------------------------------------

export interface RepositoryOptions {
  /**
   * The FARM's zone, which is the only one allowed to decide a business date.
   *
   * It arrives from the server (`/v1/me` today, the handshake of §3.1 when
   * there is one) and is stored on the config row, so this option is really
   * only for tests and for the first launch before anything has been
   * registered. Everything a settlement depends on — which week a weighing
   * falls in, which price applies, which day a payment is dated — is derived
   * from this and never from the handset's own offset.
   */
  timezone?: string;

  /**
   * Where "now" comes from. Defaults to the device clock, which is what the
   * phone passes and what every existing behaviour depends on.
   *
   * It is a seam, not a feature: `advance`, `deduct`, `adjust`, `reverse` and
   * `voidSettlement` all stamp their entry with the current day and take no
   * date argument, so without this the money layer cannot be replayed at a
   * business date — which is exactly why the golden corpus had to retype the
   * phone's write sequence instead of running it (`golden/runner.ts`). With
   * the clock injected, `golden/real-repository.test.ts` drives the real code.
   */
  clock?: () => Date;
}

export function createSqliteRepository(
  db: SqlDatabase,
  opts: RepositoryOptions = {},
): Repository {
  const clock = opts.clock ?? (() => new Date());

  /**
   * The farm's zone. Read from the config row on every call rather than
   * captured once, because the handshake can change it while the app is
   * running and a stale copy would keep pricing weighings under the old zone.
   * Cheap: one indexed read of a single-row table.
   */
  const timezone = (): string =>
    opts.timezone ?? storedTimezone() ?? DEFAULT_TIMEZONE;

  /** Today, on the farm's calendar. This is what `date('now','localtime')`
   *  used to be, with the handset's opinion taken out of it. */
  const farmToday = () => dayInZone(clock(), timezone());

  /** The Monday of the farm's current week. */
  const farmWeek = () => weekInZone(clock(), timezone());

  /**
   * The farm-calendar day `n` days back, as the lower bound of a window.
   *
   * Computed here instead of with SQLite's `date(...,'-28 days')` because that
   * modifier applies to a string SQLite built from the HANDSET's clock, which
   * is the input this whole change exists to remove. Subtracting whole days of
   * milliseconds and then asking for the farm's day of the result is correct
   * across a DST boundary too, which the farm does not have but a future one
   * might.
   */
  const daysAgo = (n: number) =>
    dayInZone(new Date(clock().getTime() - n * 86400000), timezone());

  /** The stored instant of a write. */
  const now = () => clock().toISOString();

  /**
   * The name a new row will be known by on the server.
   *
   * One generator for the life of this repository, so two rows written inside
   * the same millisecond — which happens on every `settle`, where the document,
   * its lines and the ledger entry all land at once — still come out in the
   * order they were written. It is deliberately NOT the one the v6 migration
   * uses: that one walks backwards through the farm's whole history, and a
   * shared counter would drag its oldest row up to today.
   */
  const uuid = createUuidV7();
  const newUuid = () => uuid(clock().getTime());

  // The business date of a movement: the FARM's calendar day.
  //
  // It used to be `localDayOf(clock())` — the handset's day — which was right
  // as long as the handset's zone was right. It is the farm's now, for the
  // same reason the week is: the server derives `local_day` from
  // `farms.timezone`, and two sides that disagree about which day a payment
  // falls on disagree about which settlement it belongs to.
  const today = () => farmToday();

  // ---- Schema and migrations ------------------------------------------
  //
  // The week key used to be a strftime week-of-year label ("2026-W34"), which
  // splits a week straddling new year into two labels and can't be rendered as
  // a date range. It is now the Monday of the week, as YYYY-MM-DD.

  function migrate() {
    const v =
      db.getFirstSync<{ user_version: number }>("PRAGMA user_version", [])
        ?.user_version ?? 0;

    if (v < 2) {
      db.execSync(PAYMENTS_SCHEMA);
      db.withTransactionSync(() => {
        // Re-key existing weekly cost overrides onto the Monday-based key.
        // Two legacy labels can map to the same Monday — a week straddling new
        // year was stored as both "2025-W52" and "2026-W00" — and `week` is
        // UNIQUE, so a blind UPDATE throws, the version never advances, and
        // the app fails to start on every launch from then on.
        const legacy = db.getAllSync<{ id: number; week: string }>(
          "SELECT id, week FROM cost_overrides WHERE week LIKE '%-W%'",
          [],
        );
        for (const o of legacy) {
          const monday = mondayOfLegacyWeek(o.week);
          if (!monday) continue;
          const clash = db.getFirstSync<{ id: number }>(
            "SELECT id FROM cost_overrides WHERE week = ? AND id <> ?",
            [monday, o.id],
          );
          // Both halves described the same week; keeping either price is
          // defensible, so keep the one already re-keyed and drop the duplicate.
          if (clash)
            db.runSync("DELETE FROM cost_overrides WHERE id = ?", [o.id]);
          else
            db.runSync("UPDATE cost_overrides SET week = ? WHERE id = ?", [
              monday,
              o.id,
            ]);
        }
        db.execSync("PRAGMA user_version = 2");
      });
    }

    if (v < 3) {
      // Soft-delete marker for plots, so deleting one cannot orphan its pickups.
      try {
        db.execSync("ALTER TABLE crops ADD COLUMN deletedAt TEXT");
      } catch {
        /* column already exists */
      }
      db.execSync("PRAGMA user_version = 3");
    }

    if (v < 4) {
      // Voiding a settlement used to delete its lines, so an annulled document
      // could never be reprinted or audited: it kept its total with nothing
      // underneath. Now the lines are marked instead, and the unique lock that
      // stops a pickup being settled twice only counts the live ones.
      try {
        db.execSync("ALTER TABLE settlement_items ADD COLUMN voidedAt TEXT");
      } catch {
        /* column already exists */
      }
      db.execSync(`
        DROP INDEX IF EXISTS ux_items_pickup;
        CREATE UNIQUE INDEX IF NOT EXISTS ux_items_pickup_live
          ON settlement_items(pickupId) WHERE voidedAt IS NULL;
      `);
      db.execSync("PRAGMA user_version = 4");
    }

    if (v < 5) {
      // `pickups` had no index of any kind. Every screen that scans it paid
      // for that, and the review rules paid the most: the duplicate rule is a
      // self-join on (person, plot, weight) and without an index it was doing
      // a table scan per candidate row.
      db.execSync(PICKUP_INDEXES_SQL);
      db.execSync("PRAGMA user_version = 5");
    }

    if (v < 6) {
      // Identity for sync: a UUIDv7 on every row that will travel, an
      // `updatedAt`, the farm's and device's names on the config row, and the
      // queue of what is still owed. See `migrateToV6.ts` for the how and the
      // why; what matters here is the shape of this branch.
      //
      // All of it inside one transaction, `PRAGMA user_version` included.
      // SQLite journals the version header along with the data, so a failure
      // at any point leaves a database that is still exactly a version-5
      // database and an app that still starts. The `v < 2` branch above is
      // there because that lesson was learned the expensive way: a migration
      // that threw halfway left a farm unable to open the app at all, on every
      // launch, until someone reinstalled it.
      db.withTransactionSync(() => {
        migrateToV6(db, clock());
        db.execSync(`PRAGMA user_version = 6`);
      });
    }

    if (v < 7) {
      // The three the architect blocked on, and the tables sync keeps its own
      // state in. See `migrateToV7.ts`: soft delete on `pickups`, the day and
      // the week materialised in the FARM's zone rather than the handset's,
      // and the price as integer cents.
      //
      // Same one transaction, same reason. This one also creates a view every
      // read in the app now goes through, so a half-applied v7 would leave
      // screens querying a view that does not exist — which is precisely what
      // the rollback prevents.
      db.withTransactionSync(() => {
        migrateToV7(db, opts.timezone ?? storedTimezone() ?? DEFAULT_TIMEZONE);
        db.execSync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
  }

  /** The zone already recorded on the config row, if v7 has run. */
  function storedTimezone(): string | null {
    try {
      return (
        db.getFirstSync<{ timezone: string | null }>(
          "SELECT timezone FROM config WHERE id = 1",
          [],
        )?.timezone ?? null
      );
    } catch {
      // The column does not exist yet, which is the normal state on the way
      // into v7 and not worth an error.
      return null;
    }
  }

  function init() {
    db.execSync(BASE_SCHEMA);
    // Migration: add the worker photo column to pre-existing databases.
    try {
      db.execSync("ALTER TABLE people ADD COLUMN image TEXT");
    } catch {
      /* column already exists */
    }
    // Migration: soft-delete marker for workers (keeps their harvest history).
    try {
      db.execSync("ALTER TABLE people ADD COLUMN deletedAt TEXT");
    } catch {
      /* column already exists */
    }
    // Migration: language preference column on the single config row.
    try {
      db.execSync("ALTER TABLE config ADD COLUMN language TEXT");
    } catch {
      /* column already exists */
    }
    migrate();

    // Rebuilt rather than left alone, because `CREATE VIEW ... SELECT *`
    // freezes the column list at creation time: a column added to `pickups` by
    // a later migration would exist on the table and be invisible through the
    // view every screen reads. One statement per launch against a definition
    // that cannot drift is worth more than the microsecond it costs.
    db.execSync("DROP VIEW IF EXISTS pickups_live;");
    db.execSync(PICKUPS_LIVE_VIEW);

    // The record of every attempt at §8's import. Additive, idempotent, and
    // outside the migration ladder on purpose: it holds no farm data, nothing
    // reads it to decide money, and a `user_version` bump would have made a
    // phone in the field re-run a migration to gain a log table. Same shape of
    // decision as `SECRETS_SCHEMA` in `sync/session.ts`.
    db.execSync(IMPORT_RUNS_SCHEMA);
    db.execSync(SERVER_BALANCES_SCHEMA);

    // Seed a sensible default crop config (Café) on first run. It carries its
    // own identity from birth: on a brand-new phone this row is inserted after
    // the migration has run, so nothing else would ever give it one.
    db.runSync(
      `INSERT OR IGNORE INTO config
         (id, cropType, label, unit, yieldUnit, costPerUnit, language, uuid, updatedAt, deviceId)
       VALUES (1, 'cafe', 'Café', 'kg', 'kg por recolector', 800, 'es', ?, ?, ?)`,
      [newUuid(), now(), newUuid()],
    );

    // And a database that got its config row some other way — an upgrade from
    // before any of this, a restored backup — still needs a device name. Costs
    // one no-op UPDATE per launch once it is set.
    db.runSync(
      "UPDATE config SET deviceId = ? WHERE id = 1 AND deviceId IS NULL",
      [newUuid()],
    );
  }

  // ---- People and plots -----------------------------------------------

  const people: PeopleRepo = {
    // Active workers only (soft-deleted ones stay in the table for history).
    all: () =>
      db.getAllSync<Person>(
        "SELECT * FROM people WHERE deletedAt IS NULL ORDER BY name, lastName",
        [],
      ),
    byId: (id) =>
      db.getFirstSync<Person>("SELECT * FROM people WHERE id = ?", [id]),
    // The card number. Not dead code: `PeopleAdd` warns on a tag somebody else
    // already carries, and that is the only duplicate-card check there is.
    byTag: (tag) =>
      db.getFirstSync<Person>(
        "SELECT * FROM people WHERE tag = ? AND deletedAt IS NULL",
        [tag],
      ),
    add: (p) =>
      db.runSync(
        `INSERT INTO people (name,lastName,documentType,docId,tag,image,createdAt,uuid,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [p.name, p.lastName, p.documentType, p.docId, p.tag, p.image, now(), newUuid(), now()],
      ),
    // Soft delete: hide the worker but keep their pickups intact.
    remove: (id) =>
      db.runSync(
        "UPDATE people SET deletedAt = ?, updatedAt = ? WHERE id = ?",
        [now(), now(), id],
      ),
  };

  const crops: CropsRepo = {
    all: () =>
      db.getAllSync<Crop>(
        "SELECT * FROM crops WHERE deletedAt IS NULL ORDER BY name",
        [],
      ),
    byId: (id) =>
      db.getFirstSync<Crop>("SELECT * FROM crops WHERE id = ?", [id]),
    add: (c) =>
      db.runSync(
        `INSERT INTO crops (name,type,variety,dimension,createdAt,uuid,updatedAt)
         VALUES (?,?,?,?,?,?,?)`,
        [c.name, c.type, c.variety, c.dimension, now(), newUuid(), now()],
      ),
    // Soft delete: hide the plot but keep every pickup that references it.
    remove: (id) =>
      db.runSync(
        "UPDATE crops SET deletedAt = ?, updatedAt = ? WHERE id = ?",
        [now(), now(), id],
      ),
  };

  /**
   * A weight the farm can pay on. Finite, and more than nothing.
   *
   * Deliberately NOT an upper bound: 120 kg is the `impossible` rule's
   * threshold and it is configurable because it is a suspicion, not a law —
   * a bunch of plátano really does weigh more than a day of coffee. Refusing
   * at the door what a review screen is designed to ask a person about would
   * lose real work.
   */
  function requireWeight(weight: number): void {
    if (!Number.isFinite(weight) || weight <= 0) throw new Error("BADWEIGHT");
  }

  const pickups: PickupsRepo = {
    // Whether a pickup can still be touched. Once it is inside a settlement its
    // price is frozen and it has been paid on, so correcting it would silently
    // change money that already changed hands: the settlement has to be voided
    // first, which is a decision for the user, not a side effect of an edit.
    isSettled: (id) =>
      !!db.getFirstSync<{ id: number }>(
        "SELECT id FROM settlement_items WHERE pickupId = ? AND voidedAt IS NULL",
        [id],
      ),

    setWeight: (id, weight) => {
      if (pickups.isSettled(id)) throw new Error("SETTLED");
      requireWeight(weight);
      const r = db.runSync(
        "UPDATE pickups SET weight = ?, updatedAt = ? WHERE id = ?",
        [weight, now(), id],
      );
      // Without this an update that matched nothing reported success.
      if (r.changes === 0) throw new Error("NOTFOUND");
    },

    /**
     * The correction that had no screen. See `PickupsRepo.setPerson`.
     *
     * `updatedAt` moves, so the outbox trigger queues the row and the server
     * hears about the reassignment the same way it hears about a corrected
     * weight — the wire projection sends `personId` as the worker's uuid, so
     * this travels with no protocol change at all.
     */
    setPerson: (id, personId) => {
      if (pickups.isSettled(id)) throw new Error("SETTLED");
      // Checked here rather than trusted from the screen: the chip list only
      // offers active workers, but a stale screen held open across a pull that
      // removed somebody would offer one that is no longer there.
      const person = db.getFirstSync<{ id: number }>(
        "SELECT id FROM people WHERE id = ? AND deletedAt IS NULL",
        [personId],
      );
      if (!person) throw new Error("NOPERSON");
      const r = db.runSync(
        "UPDATE pickups SET personId = ?, updatedAt = ? WHERE id = ?",
        [personId, now(), id],
      );
      if (r.changes === 0) throw new Error("NOTFOUND");
    },

    /**
     * Logical, not physical. A row deleted for real after it had been pushed
     * comes straight back on the next pull: the server still has it and this
     * phone no longer holds anything that says it was cancelled. The tombstone
     * is the only thing that will ever travel (§1.5a).
     *
     * Every read in the app goes through `pickups_live`, so the row disappears
     * from every screen and every total the moment this runs — the behaviour
     * is unchanged, only its mechanism.
     */
    remove: (id) => {
      if (pickups.isSettled(id)) throw new Error("SETTLED");
      const r = db.runSync(
        "UPDATE pickups SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL",
        [now(), now(), id],
      );
      // Silent on a row that was already gone: deleting twice is what a double
      // tap on a slow phone does, and it is not an error.
      if (r.changes === 0 && !db.getFirstSync("SELECT id FROM pickups WHERE id = ?", [id]))
        throw new Error("NOTFOUND");
    },

    add: (p) => {
      // `movil.md` §9.10: the two writers used to validate differently.
      // `setWeight` refused a NaN, an Infinity and a zero; `add` refused
      // nothing at all, and the only barrier on the way in was a `> 0` in
      // `RegisterPickup`. A weight is what a farm pays on — one guard, both
      // doors. The screen already blocks everything this rejects, so nothing a
      // person can type reaches it; what it stops is a caller that is not the
      // screen.
      requireWeight(p.weight);
      // The day and the week are decided here, once, in the FARM's zone, and
      // stored. Every query that used to recompute `date(col,'localtime')` now
      // reads these columns, which means a handset whose zone is wrong can no
      // longer move a weighing into a different week — and therefore into a
      // different price and a different settlement (§1.5b, golden case 04).
      const instant = p.date;
      // The uuid is seeded from the weighing's own instant, not from the
      // moment the row is stored, so a load entered late still sorts where
      // it happened. That is the same rule the v6 backfill follows.
      const rowUuid = uuid(Date.parse(p.date) || clock().getTime());
      const r = db.runSync(
        `INSERT INTO pickups (personId,cropId,weight,date,createdAt,uuid,updatedAt,localDay,week)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          p.personId, p.cropId, p.weight, p.date, now(),
          rowUuid, now(),
          dayInZone(instant, timezone()), weekInZone(instant, timezone()),
        ],
      );

      // Decision 8. Somebody the web took off the books has just been weighed,
      // which means they are on the farm and working. They go back on the
      // books — and the reactivation is RECORDED, with this weighing and this
      // device on it, because that is the condition the owner's decision came
      // with: whoever signed the removal has to be able to see it was undone
      // and by what. §5.6's alternative — rejecting the weighing — loses work
      // that was really done, and that is not on the table.
      reactivateWorker(db, {
        personId: p.personId,
        causeEntity: "pickups",
        causeUuid: rowUuid,
        deviceId: sync.identity().deviceId,
        at: now(),
      });

      return r;
    },

    recent: () =>
      db.getAllSync<RecentPickup>(
        `SELECT pk.id, pk.weight, pk.date, pk.personId, pk.cropId,
                COALESCE(pe.name || ' ' || pe.lastName, 'Unknown') AS person,
                COALESCE(cr.name, 'Unknown') AS crop
         FROM pickups_live pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
         ORDER BY pk.date DESC LIMIT 50`,
        [],
      ),

    // The same aggregate the `digit` rule compares against — this person's
    // whole history, not a window — asked one person at a time and BEFORE the
    // row is written. The rule downstream keeps its own copy of the arithmetic
    // because it has to run over rows nobody is looking at; this one runs
    // while somebody is still standing at the scale and can fix it.
    typical: (personId): TypicalLoad => {
      const r = db.getFirstSync<{ avgWeight: number | null; samples: number }>(
        `SELECT AVG(weight) AS avgWeight, COUNT(*) AS samples
           FROM pickups_live WHERE personId = ?`,
        [personId],
      );
      return { avgWeight: r?.avgWeight ?? 0, samples: r?.samples ?? 0 };
    },
  };

  // ---- Reports ---------------------------------------------------------

  const reports: ReportsRepo = {
    // `movil.md` §9.11: these two counts are the ones Home shows, and they
    // used to include everybody who had been removed. A farm that had let ten
    // people go read "22 recolectores" on the front page and twelve in the
    // list on the next screen, with nothing to explain the gap.
    //
    // Counting is not money. `payments.balances` still MARKS removed workers
    // rather than dropping them, on purpose — a person nobody works with any
    // more can still be owed — but "cuánta gente hay" has one honest answer
    // and it is the same one the list gives.
    totals: () =>
      db.getFirstSync<FarmTotals>(
        `SELECT
           (SELECT COUNT(*) FROM pickups_live) AS pickups,
           (SELECT COALESCE(SUM(weight),0) FROM pickups_live) AS kg,
           (SELECT COUNT(*) FROM people WHERE deletedAt IS NULL) AS people,
           (SELECT COUNT(*) FROM crops  WHERE deletedAt IS NULL) AS crops`,
        [],
      ),
    today: () =>
      db.getFirstSync<PeriodTotals>(
        `SELECT COALESCE(SUM(weight),0) AS kg, COUNT(*) AS count
         FROM pickups_live WHERE localDay = ? AND deletedAt IS NULL`,
        [farmToday()],
      ),
    thisWeek: () =>
      db.getFirstSync<PeriodTotals>(
        `SELECT COALESCE(SUM(weight),0) AS kg, COUNT(*) AS count
         FROM pickups_live WHERE week = ? AND deletedAt IS NULL`,
        [farmWeek()],
      ),
    byWeek: () =>
      db.getAllSync<LabelledKg>(
        `SELECT week AS label, SUM(weight) AS kg
         FROM pickups_live GROUP BY label ORDER BY label DESC LIMIT 12`,
        [],
      ),
    /*
     * `movil.md` §9.11 — and the rule comes from the server, which had the
     * same argument and settled it.
     *
     * Excluding a removed worker was tried and taken back out: the rows stop
     * adding up to the farm total that is printed four centimetres above them
     * on the same screen, and nothing explains the missing kilos. Including
     * them silently was no better — a name in a ranking reads as somebody who
     * is still there.
     *
     * `ListBalances` closed it with «the rule is not "active people" but
     * "people with a position"», and added an `active` column so the caller
     * renders the difference rather than guessing at an absence. That is
     * exactly this list: a picker with kilos HAS a position, whether or not
     * they are still on the payroll, and this query cannot produce a row for
     * anybody without kilos anyway — it groups out of `pickups_live`. So
     * nothing is filtered, the total holds, and `active` carries the truth.
     */
    byWorker: (general) =>
      db.getAllSync<ValuedGroup>(
        `SELECT COALESCE(pe.name || ' ' || pe.lastName, 'Unknown') AS label,
                SUM(pk.weight) AS kg, pk.personId AS id,
                ${HARVEST_VALUE_EXPR} AS value,
                CASE WHEN pe.id IS NULL OR pe.deletedAt IS NULL THEN 1 ELSE 0 END
                  AS active
         FROM pickups_live pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN cost_overrides o
           ON o.week = pk.week
         GROUP BY pk.personId ORDER BY kg DESC`,
        [general],
      ),
    // The value comes out of SQL with each week's price applied. Multiplying
    // the total by the general cost in one screen and by the weekly overrides
    // in another made the same plot worth two different amounts.
    //
    // The same rule as `byWorker` above, and it is a bug fix rather than a
    // symmetry: this one DID filter `cr.deletedAt IS NULL`, so a farm that
    // retired a lote mid-season saw the crop breakdown stop adding up to the
    // farm total while the worker breakdown still did. Two tabs of one card
    // contradicting each other, with the kilos of a real harvest in the gap.
    byCrop: (general) =>
      db.getAllSync<ValuedGroup>(
        `SELECT COALESCE(cr.name, 'Unknown') AS label, SUM(pk.weight) AS kg,
                pk.cropId AS id,
                ${HARVEST_VALUE_EXPR} AS value,
                CASE WHEN cr.id IS NULL OR cr.deletedAt IS NULL THEN 1 ELSE 0 END
                  AS active
         FROM pickups_live pk
         LEFT JOIN crops cr ON cr.id = pk.cropId
         LEFT JOIN cost_overrides o
           ON o.week = pk.week
         GROUP BY pk.cropId ORDER BY kg DESC`,
        [general],
      ),
  };

  // Which crops (lotes) were harvested each week — powers the weekly breakdown.
  // The lots listed under each week, and the same rule as `reports.byCrop`:
  // a retired lote that was harvested that week still has kilos in it, and
  // dropping it left the chips under a week summing to less than the week.
  const weekCrops = () =>
    db.getAllSync<WeekCropRow>(
      `SELECT pk.week AS week,
              COALESCE(cr.name, 'Unknown') AS crop, SUM(pk.weight) AS kg,
              CASE WHEN cr.id IS NULL OR cr.deletedAt IS NULL THEN 1 ELSE 0 END
                AS active
       FROM pickups_live pk LEFT JOIN crops cr ON cr.id = pk.cropId
       GROUP BY week, pk.cropId ORDER BY week DESC, kg DESC`,
      [],
    );

  const workerReports: WorkerReportsRepo = {
    stats: (personId) =>
      db.getFirstSync<WorkerStats>(
        // Days actually worked, not the span between the first and last pickup:
        // the span counts Sundays and whole idle weeks, and the crop screen used
        // the other definition under the very same label.
        `SELECT COALESCE(SUM(weight),0) AS kg, COUNT(*) AS pickups,
                COUNT(DISTINCT localDay) AS days,
                MIN(date) AS firstDate, MAX(date) AS lastDate
         FROM pickups_live WHERE personId = ?`,
        [personId],
      ),
    byWeek: (personId) =>
      db.getAllSync<LabelledKg>(
        `SELECT week AS label, SUM(weight) AS kg
         FROM pickups_live WHERE personId = ? GROUP BY label ORDER BY label DESC LIMIT 12`,
        [personId],
      ),
    byCrop: (personId) =>
      db.getAllSync<LabelledKg>(
        `SELECT COALESCE(cr.name, 'Unknown') AS label, SUM(pk.weight) AS kg
         FROM pickups_live pk LEFT JOIN crops cr ON cr.id = pk.cropId
         WHERE pk.personId = ? GROUP BY pk.cropId ORDER BY kg DESC`,
        [personId],
      ),
    recent: (personId) =>
      db.getAllSync<WorkerPickup>(
        `SELECT pk.id, pk.weight, pk.date, COALESCE(cr.name, 'Unknown') AS crop
         FROM pickups_live pk LEFT JOIN crops cr ON cr.id = pk.cropId
         WHERE pk.personId = ? ORDER BY pk.date DESC LIMIT 50`,
        [personId],
      ),
    // What this worker's harvest is worth, at the price in force each week.
    // The same expression the farm-wide and per-lote figures use — §9.5. It
    // used to be a query per week in a JS loop, which is both the N+1 of §9.6
    // and the second implementation of §9.5.
    payout: (personId, general) =>
      db.getFirstSync<{ value: number }>(
        HARVEST_VALUE_SQL("WHERE pk.personId = ?"),
        [general, personId],
      )?.value ?? 0,
  };

  function reportBy(g: Grouping, general: number) {
    return g === "week"
      ? reports.byWeek()
      : g === "worker"
        ? reports.byWorker(general)
        : reports.byCrop(general);
  }

  // ---- Crop configuration (units + costs) ------------------------------

  const config: ConfigRepo = {
    get: () =>
      db.getFirstSync<CropConfig>(
        "SELECT cropType, label, unit, yieldUnit, costPerUnit FROM config WHERE id = 1",
        [],
      ),
    save: (c) =>
      db.runSync(
        `INSERT INTO config (id, cropType, label, unit, yieldUnit, costPerUnit, costPerUnitCents, uuid, updatedAt)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cropType = excluded.cropType, label = excluded.label,
           unit = excluded.unit, yieldUnit = excluded.yieldUnit,
           costPerUnit = excluded.costPerUnit,
           costPerUnitCents = excluded.costPerUnitCents,
           uuid = COALESCE(config.uuid, excluded.uuid),
           updatedAt = excluded.updatedAt`,
        [c.cropType, c.label, c.unit, c.yieldUnit, c.costPerUnit,
         toCents(c.costPerUnit), newUuid(), now()],
      ),
  };

  const prefs: PrefsRepo = {
    getLang: (): AppLang => {
      const r = db.getFirstSync<{ language: string | null }>(
        "SELECT language FROM config WHERE id = 1",
        [],
      );
      return r?.language === "en" ? "en" : r?.language === "pt" ? "pt" : "es";
    },
    setLang: (l) =>
      db.runSync(
        `INSERT INTO config (id, language, uuid, updatedAt) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET language = excluded.language,
           uuid = COALESCE(config.uuid, excluded.uuid),
           updatedAt = excluded.updatedAt`,
        [l, newUuid(), now()],
      ),
  };

  const overrides: OverridesRepo = {
    all: () =>
      db.getAllSync<CostOverride>(
        "SELECT id, week, costPerUnit FROM cost_overrides ORDER BY week DESC",
        [],
      ),
    // Writes both columns. `costPerUnitCents` is the one every money path
    // reads; the REAL stays for the screens that still display it and for the
    // day somebody reads this database with a spreadsheet (§1.5c).
    set: (week, costPerUnit) =>
      db.runSync(
        `INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents, uuid, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(week) DO UPDATE SET costPerUnit = excluded.costPerUnit,
           costPerUnitCents = excluded.costPerUnitCents,
           uuid = COALESCE(cost_overrides.uuid, excluded.uuid),
           updatedAt = excluded.updatedAt`,
        // Seeded from the Monday it prices, so a price set for a past week
        // sorts with that week and not with today.
        [week, costPerUnit, toCents(costPerUnit),
         uuid(Date.parse(`${week}T00:00:00.000Z`) || clock().getTime()), now()],
      ),
    remove: (id) =>
      db.runSync("DELETE FROM cost_overrides WHERE id = ?", [id]),

    /**
     * The same write, in the units the server speaks.
     *
     * `week_prices.price_minor` is a `bigint`. Coming in through `set` would
     * mean dividing it to pesos and multiplying it back, which is a float in
     * the path of a whole farm's week. This writes the integer straight and
     * derives the display REAL from it, not the other way round.
     */
    setCents: (week, costPerUnitCents) =>
      db.runSync(
        `INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents, uuid, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(week) DO UPDATE SET costPerUnit = excluded.costPerUnit,
           costPerUnitCents = excluded.costPerUnitCents,
           uuid = COALESCE(cost_overrides.uuid, excluded.uuid),
           updatedAt = excluded.updatedAt`,
        [week, fromCents(costPerUnitCents), Math.round(costPerUnitCents),
         uuid(Date.parse(`${week}T00:00:00.000Z`) || clock().getTime()), now()],
      ),
  };

  // Effective cost per unit for a given week label: the weekly override if one
  // exists, otherwise the general cost from the active config.
  //
  // Kept in pesos because a dozen screens display it. It is NOT what decides
  // an amount any more — `costCentsForWeek` is — and the two cannot disagree
  // because this one is derived from that one.
  function costForWeek(week: string, general: number): number {
    return fromCents(costCentsForWeek(week, toCents(general)));
  }

  /**
   * The price of a week, in integer cents. Every amount the farm pays is
   * derived through here.
   *
   * `costPerUnitCents` is read first and the REAL is only the fallback for a
   * row written before v7 that the backfill somehow did not reach — which
   * should be none, and is checked rather than assumed, because reading a
   * float into a price is exactly what this migration removed.
   */
  function costCentsForWeek(week: string, generalCents: number): number {
    const o = db.getFirstSync<{
      costPerUnitCents: number | null;
      costPerUnit: number | null;
    }>(
      "SELECT costPerUnitCents, costPerUnit FROM cost_overrides WHERE week = ?",
      [week],
    );
    if (!o) return Math.round(generalCents);
    if (o.costPerUnitCents !== null && o.costPerUnitCents !== undefined)
      return o.costPerUnitCents;
    return toCents(Number(o.costPerUnit ?? 0));
  }

  // What the whole farm's harvest is worth, at the price in force each week.
  // One query, and the same one every other value on every other screen goes
  // through — §9.5.
  function totalPayout(general: number): number {
    return (
      db.getFirstSync<{ value: number }>(HARVEST_VALUE_SQL(), [general])?.value ?? 0
    );
  }

  // ---- Wiping the farm --------------------------------------------------
  //
  // This is the one button in the app that can end a season. It used to be a
  // single unguarded tap in Ajustes, next to "load demo data", on the phone
  // that holds the only copy of what everyone picked
  // (`docs/diagramas/movil.md` §9.15). Both buttons now demand the farm's own
  // name typed out, because `seed` starts by wiping too and guarding only the
  // scarier-looking one leaves the hole exactly where it was.

  function clearToken(): string {
    const label = config.get()?.label?.trim();
    return label && label.length > 0 ? label : FALLBACK_CLEAR_TOKEN;
  }

  function requireConfirmation(confirmation: string | undefined) {
    const expected = clearToken();
    if (!confirmation || foldToken(confirmation) !== foldToken(expected))
      throw new ConfirmationRequired(expected);
  }

  function wipe() {
    // Children first: foreign_keys is ON, so deleting people while the ledger
    // still references them fails and takes the screen down with it.
    db.withTransactionSync(() => {
      db.execSync(
        `DELETE FROM ledger; DELETE FROM settlement_items; DELETE FROM settlements;
         DELETE FROM pickups; DELETE FROM crops; DELETE FROM people;
         DELETE FROM cost_overrides;`,
      );
    });
  }

  const demo: DemoRepo = {
    clearToken,

    clear: (confirmation) => {
      requireConfirmation(confirmation);
      wipe();
    },

    seed: (confirmation) => {
      requireConfirmation(confirmation);
      wipe();

      const names: [string, string][] = [
        ["María", "Gómez"],
        ["Juan", "Pérez"],
        ["Ana", "Rodríguez"],
        ["Carlos", "Muñoz"],
        ["Luisa", "Torres"],
        ["Pedro", "Ramírez"],
      ];
      const pids: number[] = [];
      names.forEach(([name, lastName], i) => {
        const r = db.runSync(
          `INSERT INTO people (name,lastName,documentType,docId,tag,image,createdAt,uuid,updatedAt)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            name,
            lastName,
            "CC",
            String(1000000000 + i * 137),
            "T" + (i + 1),
            "",
            now(),
            newUuid(),
            now(),
          ],
        );
        pids.push(r.lastInsertRowId);
      });

      const plots: [string, string, string, number][] = [
        ["Café lote 1", "Café", "Castillo", 2.5],
        ["Café lote 2", "Café", "Caturra", 1.8],
        ["Cacao norte", "Cacao", "CCN-51", 1.2],
      ];
      const cids: number[] = [];
      plots.forEach(([name, type, variety, dim]) => {
        const r = db.runSync(
          `INSERT INTO crops (name,type,variety,dimension,createdAt,uuid,updatedAt)
           VALUES (?,?,?,?,?,?,?)`,
          [name, type, variety, dim, now(), newUuid(), now()],
        );
        cids.push(r.lastInsertRowId);
      });

      // A crew works one plot together and moves on — pickers are not scattered
      // one per plot. That is how a farm actually runs, and it is also what makes
      // same-plot-same-day comparison possible at all.
      // Each picker carries a steady skill factor so the index has real spread.
      const skill = [1.25, 1.05, 0.95, 0.7, 1.0, 1.15];

      for (let d = 27; d >= 0; d--) {
        if (d % 7 === 6) continue; // rest day
        const date = new Date();
        date.setDate(date.getDate() - d);
        const iso = (h: number, m: number) => {
          const t = new Date(date);
          t.setHours(h, m, 0, 0);
          return t.toISOString();
        };
        // The crew splits across two plots, rotating who goes where. Without the
        // day in the index, odd and even pickers never share a plot and the two
        // halves end up with separate baselines that cannot be compared.
        const dayPlots = [cids[d % cids.length], cids[(d + 1) % cids.length]];
        pids.forEach((pid, idx) => {
          if ((d + idx) % 9 === 0) return; // somebody misses a day now and then
          // Every third day the whole crew works one plot together; otherwise it
          // splits in rotating blocks. Assigning by the parity of the index left
          // two halves that never shared a plot, so they never got a common
          // baseline and the index could not rank them against each other.
          const cid =
            d % 3 === 0
              ? dayPlots[0]
              : dayPlots[Math.floor((idx + d) / 2) % dayPlots.length];
          // Yield tapers off toward the end of the season on the first plot, so
          // the harvest-curve reading has something real to report.
          const taper = cid === cids[0] ? Math.min(1, 0.35 + d / 20) : 1;
          const base = Math.round((90 + ((d * 3 + idx * 5) % 40)) * taper);
          const loads = 2 + (idx % 2); // two or three weighings each
          for (let k = 0; k < loads; k++) {
            const weight = Math.max(
              4,
              Math.round(((base * skill[idx % skill.length]) / loads) * 10) / 10,
            );
            const when = iso(8 + k * 3, (idx * 7) % 60);
            db.runSync(
              `INSERT INTO pickups (personId,cropId,weight,date,createdAt,uuid,updatedAt,localDay,week)
               VALUES (?,?,?,?,?,?,?,?,?)`,
              [pid, cid, weight, when, when, uuid(Date.parse(when)), when,
               dayInZone(when, timezone()), weekInZone(when, timezone())],
            );
          }
        });
      }

      // Three deliberately bad pickups, so the review rules can actually be seen
      // and tested. With only clean data that half of the module never shows up,
      // and a rule nobody ever watches fire is a rule nobody trusts.
      const bad = new Date();
      bad.setDate(bad.getDate() - 2);
      const badIso = (h: number) => {
        const t = new Date(bad);
        t.setHours(h, 15, 0, 0);
        return t.toISOString();
      };
      // A typed extra zero: 520 kg where this person carries ~50.
      db.runSync(
        `INSERT INTO pickups (personId,cropId,weight,date,createdAt,uuid,updatedAt,localDay,week)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [pids[2], cids[0], 520, badIso(9), badIso(9), uuid(Date.parse(badIso(9))), badIso(9),
         dayInZone(badIso(9), timezone()), weekInZone(badIso(9), timezone())],
      );
      // The same weighing saved twice by a double tap.
      const dup = badIso(11);
      for (let k = 0; k < 2; k++) {
        db.runSync(
          `INSERT INTO pickups (personId,cropId,weight,date,createdAt,uuid,updatedAt,localDay,week)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [pids[4], cids[1], 47, dup, dup, uuid(Date.parse(dup)), dup,
           dayInZone(dup, timezone()), weekInZone(dup, timezone())],
        );
      }

      // A couple of weekly cost overrides to showcase the feature.
      const weeks = db.getAllSync<{ week: string }>(
        "SELECT DISTINCT week AS week FROM pickups_live ORDER BY week DESC LIMIT 2",
        [],
      );
      if (weeks[0]) overrides.set(weeks[0].week, 950);
      if (weeks[1]) overrides.set(weeks[1].week, 880);
    },
  };

  // ---- Payments: settlements, ledger and balances -----------------------
  //
  // Money is stored as INTEGER cents; REAL would drift on balances that carry
  // over for months. Sign convention on the ledger: a positive amount means the
  // farm owes the worker, so a positive balance is the worker's savings.

  // Pickups in range that no settlement has claimed yet. Selecting by pickupId
  // (not by date) is what makes a late pickup on an already-settled week roll
  // into the next settlement instead of being counted twice or lost.
  function pendingItems(
    personId: number,
    from: string,
    to: string,
    general: number,
  ): PendingItem[] {
    const rows = db.getAllSync<{ id: number; weight: number; week: string }>(
      PENDING_SQL,
      [personId, from, to],
    );
    const priceOf = new Map<string, number>();
    const generalCents = toCents(general);
    return rows.map((r) => {
      // Straight to cents. The old form was `toCents(costForWeek(...))`, which
      // took an integer price out of the database, divided it into a float and
      // multiplied it back before every settlement line.
      if (!priceOf.has(r.week))
        priceOf.set(r.week, costCentsForWeek(r.week, generalCents));
      const costPerUnitCents = priceOf.get(r.week)!;
      return {
        pickupId: r.id,
        week: r.week,
        weight: r.weight,
        costPerUnitCents,
        // Round per line so the printed receipt adds up exactly.
        amountCents: amountCents(r.weight, costPerUnitCents),
      };
    });
  }

  function requirePositive(cents: number) {
    if (!Number.isFinite(cents) || cents <= 0)
      throw new Error("El monto debe ser mayor que cero");
  }

  function addEntry(e: Omit<LedgerEntry, "id" | "createdAt">): number {
    const r = db.runSync(
      `INSERT INTO ledger (personId,kind,amountCents,date,settlementId,method,note,reversesId,createdAt,uuid,updatedAt,localDay)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        e.personId,
        e.kind,
        e.amountCents,
        e.date,
        e.settlementId,
        e.method,
        e.note,
        e.reversesId,
        now(),
        // From the write instant, not from `date`: the ledger is append-only
        // and a back-dated correction must still sort after what it corrects.
        newUuid(),
        now(),
        // A copy of `date`, which every writer already stamps with the farm's
        // day. Materialised so the money queries can group on a column instead
        // of on a call, and so the server's `local_day` has something to line
        // up against, one field to one field.
        e.date.slice(0, 10),
      ],
    );
    return r.lastInsertRowId;
  }

  // The bodies of voidSettlement and reverse, without a transaction of their
  // own. The public methods wrap these; undoRun calls them directly. SQLite has
  // no nested BEGIN, so a run that opened a transaction inside another one
  // rolled back the reversals it had just written and left the button doing
  // nothing.
  //
  // Unlike the public methods these are silent about work already undone: a
  // payroll run is undone as a whole, and retrying one that half-succeeded has
  // to be safe.
  function reverseHere(ledgerId: number, note: string): void {
    const e = db.getFirstSync<LedgerEntry>(
      "SELECT * FROM ledger WHERE id = ?",
      [ledgerId],
    );
    if (!e) return;
    const already = db.getFirstSync<{ id: number }>(
      "SELECT id FROM ledger WHERE reversesId = ?",
      [ledgerId],
    );
    if (already) return;
    addEntry({
      personId: e.personId,
      kind: "reverso",
      amountCents: -e.amountCents,
      date: today(),
      settlementId: e.settlementId,
      method: null,
      note,
      reversesId: ledgerId,
    });
  }

  function voidSettlementHere(settlementId: number, note?: string): void {
    const s = db.getFirstSync<Settlement>(
      "SELECT * FROM settlements WHERE id = ?",
      [settlementId],
    );
    if (!s || s.status === "void") return;
    db.runSync(
      "UPDATE settlement_items SET voidedAt = ?, updatedAt = ? WHERE settlementId = ?",
      [now(), now(), settlementId],
    );
    db.runSync(
      "UPDATE settlements SET status = 'void', voidedAt = ?, updatedAt = ? WHERE id = ?",
      [now(), now(), settlementId],
    );
    const devengo = db.getFirstSync<{ id: number; amountCents: number }>(
      "SELECT id, amountCents FROM ledger WHERE settlementId = ? AND kind = 'devengo'",
      [settlementId],
    );
    // A devengo that is ALREADY reversed gets no second reverso.
    //
    // `ux_ledger_reverses` is UNIQUE on `reversesId`, so writing one anyway
    // does not produce a double entry — it throws, and the throw rolls back
    // this whole transaction: the released lines, the `status = 'void'`, and
    // under `undoRun` every other worker in the payroll too. The document
    // stayed open with its payables locked while the money it stood for had
    // already been cancelled, which is the one state nobody can pay out of.
    //
    // Nothing on the phone reverses a devengo by hand. §5.4 does: somebody
    // voids on the web, and the void, the released lines and the reverso all
    // come down the feed together (`syncStore.applyLedgerEntry`). From the
    // moment sync is on, this is reachable from the Deshacer button.
    //
    // Skipping is not "losing" the reversal: the earning is already cancelled,
    // and posting a second one would take the worker into debt for work they
    // really did. The guard matches `reverseHere`'s.
    const alreadyReversed =
      devengo &&
      db.getFirstSync<{ id: number }>("SELECT id FROM ledger WHERE reversesId = ?", [
        devengo.id,
      ]);
    if (devengo && !alreadyReversed) {
      addEntry({
        personId: s.personId,
        kind: "reverso",
        amountCents: -devengo.amountCents,
        date: today(),
        settlementId,
        method: null,
        note: note ?? null,
        reversesId: devengo.id,
      });
    }
  }

  const payments: PaymentsRepo = {
    // What would be settled, without writing anything.
    preview: (personId, from, to, general): SettlementPreview => {
      const items = pendingItems(personId, from, to, general);
      return {
        personId,
        periodStart: from,
        periodEnd: to,
        items,
        grossCents: items.reduce((s, i) => s + i.amountCents, 0),
        pickupCount: items.length,
        kg: items.reduce((s, i) => s + i.weight, 0),
      };
    },

    // Freeze the pending pickups into a settlement document and post the
    // earning. Returns null when there is nothing pending, so we never create
    // a $0 document.
    settle: (personId, from, to, general, note): SettleResult | null => {
      const items = pendingItems(personId, from, to, general);
      const grossCents = items.reduce((s, i) => s + i.amountCents, 0);
      // Nothing pending. Honest silence: there is no week here to settle.
      if (!items.length) return null;
      // Pending weighings that all priced at zero is a DIFFERENT silence, and
      // it used to share this return. A zero gross cannot be written -- the
      // ledger's CHECK refuses it -- but returning null made the caller say
      // «sin saldo por entregar», which everywhere else on this phone means
      // the advance covered the week. It did not. No price reached us for
      // these weeks, and the worker is owed for every kilo of them.
      if (grossCents <= 0) {
        const weeks = [...new Set(items.filter((i) => i.costPerUnitCents <= 0).map((i) => i.week))];
        throw new UnpricedWeeks(weeks.sort());
      }
      let settlementId = 0;
      let ledgerId = 0;
      // The real period is what the items cover, not the open-ended search
      // range, and the earning must not be dated in the future when paying
      // mid-week.
      const weeks = items.map((i) => i.week).sort();
      const periodStart = weeks[0] ?? from;
      const today0 = today();
      const postedAt = to > today0 ? today0 : to;
      db.withTransactionSync(() => {
        const s = db.runSync(
          `INSERT INTO settlements (personId,periodStart,periodEnd,grossCents,status,note,createdAt,uuid,updatedAt)
           VALUES (?,?,?,?, 'open', ?, ?, ?, ?)`,
          [personId, periodStart, to, grossCents, note ?? null, now(), newUuid(), now()],
        );
        settlementId = s.lastInsertRowId;
        for (const i of items) {
          db.runSync(
            `INSERT INTO settlement_items (settlementId,pickupId,week,weight,costPerUnitCents,amountCents,uuid,updatedAt)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
              settlementId,
              i.pickupId,
              i.week,
              i.weight,
              i.costPerUnitCents,
              i.amountCents,
              // Minted after the document's own, so a line can never sort
              // ahead of the settlement it belongs to.
              newUuid(),
              now(),
            ],
          );
        }
        ledgerId = addEntry({
          personId,
          kind: "devengo",
          amountCents: grossCents,
          date: postedAt,
          settlementId,
          method: null,
          note: note ?? null,
          reversesId: null,
        });
      });
      return { settlementId, ledgerId, grossCents };
    },

    // Undo a settlement: release its pickups and reverse the earning.
    voidSettlement: (settlementId, note) => {
      db.withTransactionSync(() => voidSettlementHere(settlementId, note));
    },

    // The crew's payroll, in one call: settle each worker, then hand over what
    // the LEDGER says is owed — never the figure the screen was showing, which
    // does not know about an advance somebody took on Wednesday.
    //
    // The ordering here is the fix for the bug this replaced. `settle` commits
    // on its own, so the moment it returns a document exists whether or not
    // anything is handed over. Recording it only when a payment followed left
    // every zero-balance worker with a committed settlement that «Deshacer»
    // could not see — and a zero balance is not the rare case, it is what an
    // advance produces.
    runPayroll: (personIds, from, to, general, opts = {}): PayrollRun => {
      const run: PayrollRun = {
        paid: 0,
        noCash: 0,
        failed: 0,
        unpriced: 0,
        settlementIds: [],
        paymentIds: [],
        paidCents: 0,
      };

      for (const personId of personIds) {
        try {
          const res = payments.settle(personId, from, to, general, opts.note);
          if (!res) {
            // Nothing pending at all. No document was written, so there is
            // nothing to undo either.
            run.noCash++;
            continue;
          }
          // Recorded FIRST, before anything can throw. The settlement is on
          // the books from here on, and the only question left is whether it
          // was also paid.
          run.settlementIds.push(res.settlementId);

          const owed = payments.balance(personId).balanceCents;
          if (owed <= 0) {
            // Settled, but the advance ate the week. The document stands and
            // is undoable; there is simply no cash to count out.
            run.noCash++;
            continue;
          }

          run.paymentIds.push(
            payments.pay(personId, owed, {
              method: opts.method ?? "efectivo",
              settlementId: res.settlementId,
              note: opts.note,
            }),
          );
          run.paidCents += owed;
          run.paid++;
        } catch (e) {
          // A week nobody priced is not a failure of this worker's payroll --
          // it is the same missing price for the whole crew, and saying so
          // once is worth more than thirty identical errors.
          if (e instanceof UnpricedWeeks) {
            run.unpriced++;
            continue;
          }
          // Skip this worker, keep the rest of the payroll going. Whatever
          // was already recorded for them stays in the run, so a half-done
          // worker is still reachable from Deshacer.
          run.failed++;
        }
      }
      return run;
    },

    // Cash going out to the worker. Amounts come in positive; the sign is ours.
    //
    // `settlementId` is optional but should be passed whenever the payment is
    // being made *against* a settlement: without it the receipt has to guess
    // which payments belong to which document by comparing dates, and with a
    // late week in the mix it guesses wrong (`docs/diagramas/movil.md` §9.3).
    pay: (personId, amount, opts = {}): number => {
      requirePositive(amount);
      return addEntry({
        personId,
        kind: "pago",
        amountCents: -amount,
        date: opts.date ?? today(),
        settlementId: opts.settlementId ?? null,
        method: opts.method ?? "efectivo",
        note: opts.note ?? null,
        reversesId: null,
      });
    },

    advance: (personId, amount, note): number => {
      requirePositive(amount);
      return addEntry({
        personId,
        kind: "anticipo",
        amountCents: -amount,
        date: today(),
        settlementId: null,
        method: "efectivo",
        note: note ?? null,
        reversesId: null,
      });
    },

    deduct: (personId, amount, note): number => {
      requirePositive(amount);
      return addEntry({
        personId,
        kind: "deduccion",
        amountCents: -amount,
        date: today(),
        settlementId: null,
        method: null,
        note,
        reversesId: null,
      });
    },

    // Signed on purpose: an adjustment can go either way. No screen creates one
    // yet, but `ajuste` is in the ledger's CHECK, in the balance breakdown, in
    // `realCost`, and golden case 08 pins its behaviour as part of the contract
    // with the server — this is the writer that case describes.
    adjust: (personId, signedCents, note): number => {
      if (!Number.isFinite(signedCents) || signedCents === 0)
        throw new Error("El ajuste no puede ser cero");
      return addEntry({
        personId,
        kind: "ajuste",
        amountCents: Math.round(signedCents),
        date: today(),
        settlementId: null,
        method: null,
        note,
        reversesId: null,
      });
    },

    // Ledger rows are never edited or deleted; a mistake is cancelled by its
    // opposite. Golden case 08 pins this too.
    reverse: (ledgerId, note): number => {
      const e = db.getFirstSync<LedgerEntry>(
        "SELECT * FROM ledger WHERE id = ?",
        [ledgerId],
      );
      if (!e) throw new Error("El movimiento no existe");
      const already = db.getFirstSync<{ id: number }>(
        "SELECT id FROM ledger WHERE reversesId = ?",
        [ledgerId],
      );
      if (already) throw new Error("Ese movimiento ya fue reversado");
      return addEntry({
        personId: e.personId,
        kind: "reverso",
        amountCents: -e.amountCents,
        date: today(),
        settlementId: e.settlementId,
        method: null,
        note,
        reversesId: ledgerId,
      });
    },

    // Undo a whole payroll run in one transaction. Reversing the payments and
    // voiding the settlements as separate writes meant a failure halfway left
    // some workers reversed and others not, with no way to finish from the UI.
    // Tolerant of anything already undone, so retrying is safe.
    //
    // Both halves call the *Here helpers, never the public methods: those open
    // their own transaction, and SQLite has no nested BEGIN. Calling them from
    // in here rolled back the whole run and left the button doing nothing.
    undoRun: (paymentIds, settlementIds, note) => {
      db.withTransactionSync(() => {
        for (const id of paymentIds) reverseHere(id, note);
        for (const id of settlementIds) voidSettlementHere(id, note);
      });
    },

    /**
     * The balance to SHOW — decision 7 and §2.2.
     *
     * The rule, in the document's own order:
     *
     *  1. While this phone still owes the server movements, the honest figure
     *     is the phone's own, because the server has not seen the payment the
     *     pesador made ten minutes ago. It is marked `provisional` and §7.4
     *     gives the screen the words: «provisional, faltan 4 movimientos por
     *     enviar».
     *  2. Otherwise the figure that came down the feed, which is the full one:
     *     the pull filters out jornales and contracts (§2.2), so the phone's
     *     own sum counts only the weighings. A worker who spent Monday on a
     *     day's wage and Tuesday on the scale has a balance this phone cannot
     *     derive, and showing the half it can derive is the lie decision 7 was
     *     written to stop.
     *
     * The gap between the two is reported separately, because «$500.000, de
     * los cuales $200.000 son jornales que están en la web» is something a
     * person can act on and a bare total is not.
     *
     * NOTHING here decides an amount. `settle`, `pay` and `runPayroll` read
     * `balance` below, which is `BALANCE_SQL` over this phone's own ledger.
     */
    fullBalance: (personId): FullBalance => {
      const itemisedCents = payments.balance(personId).balanceCents;
      const received = syncStore.serverBalanceOf(personId);
      // The whole outbox, not this worker's share of it: a balance is a total,
      // and one unsent weighing for anybody makes every total on this phone a
      // moment behind the server's.
      const provisional =
        (db.getFirstSync<{ n: number }>("SELECT COUNT(*) AS n FROM outbox", [])?.n ?? 0) > 0;

      if (!received)
        return {
          itemisedCents,
          serverCents: null,
          serverAt: null,
          balanceCents: itemisedCents,
          provisional,
          notItemisableCents: 0,
        };

      // What the server counted that this phone could not, as of the instant
      // both figures describe. Held on the row rather than recomputed, so a
      // weighing registered since does not get mistaken for a jornal.
      const notItemisableCents = received.balanceCents - received.derivedCents;

      return {
        itemisedCents,
        serverCents: received.balanceCents,
        serverAt: received.at,
        balanceCents: provisional ? itemisedCents : received.balanceCents,
        provisional,
        notItemisableCents,
      };
    },

    balance: (personId): Balance => {
      const r = db.getFirstSync<Balance>(BALANCE_SQL, [personId, personId]);
      return (
        r ?? {
          personId,
          earnedCents: 0,
          paidCents: 0,
          deductedCents: 0,
          balanceCents: 0,
          lastMovementAt: null,
        }
      );
    },

    // Every worker who has money moving, including soft-deleted ones: money is
    // never hidden just because somebody was removed from the active list.
    balances: () =>
      db.getAllSync<BalanceRow>(
        `SELECT pe.id AS personId,
                COALESCE(pe.name || ' ' || pe.lastName, '?') AS name,
                CASE WHEN pe.deletedAt IS NULL THEN 0 ELSE 1 END AS inactive,
${BALANCE_COLUMNS("l")}
           FROM people pe LEFT JOIN ledger l ON l.personId = pe.id
          GROUP BY pe.id
          HAVING balanceCents <> 0 OR earnedCents <> 0
          ORDER BY balanceCents DESC`,
        [],
      ),

    history: (personId, limit = 200): LedgerEntry[] =>
      db.getAllSync<LedgerEntry>(
        `SELECT * FROM ledger WHERE personId = ? ORDER BY date DESC, id DESC LIMIT ?`,
        [personId, limit],
      ),

    // What the receipt may claim was handed over for this document. See
    // PAID_AGAINST_SQL: it is a lookup where it used to be a guess.
    paidAgainst: (settlementId): number =>
      db.getFirstSync<{ cents: number }>(PAID_AGAINST_SQL, [settlementId])?.cents ??
      0,

    paidInRange: (from, to) =>
      db.getAllSync<{ personId: number; cents: number }>(PAID_IN_RANGE_SQL, [from, to]),

    // Newest first, and `id DESC` is not decoration: a late pickup settled
    // moments after the week it belongs to gives two documents the same
    // `createdAt` to the second, and `Account` takes the FIRST open one as
    // the settlement whose receipt it prints. Without the tiebreak that is
    // whichever SQLite felt like returning.
    settlements: (personId): Settlement[] =>
      db.getAllSync<Settlement>(
        "SELECT * FROM settlements WHERE personId = ? ORDER BY createdAt DESC, id DESC",
        [personId],
      ),

    // Live lines only: this feeds the receipt, which must not list work that
    // was annulled.
    // Joined to the weighing so the receipt can name the DAY. `LEFT`, and the
    // day nullable with it: a settlement that came down the feed can hold
    // lines this phone has no pickup row for, and a receipt that silently
    // dropped those would under-declare what somebody earned.
    itemsOf: (settlementId): SettlementItem[] =>
      db.getAllSync<SettlementItem>(
        `SELECT si.*, pk.localDay AS localDay
           FROM settlement_items si
           LEFT JOIN pickups pk ON pk.id = si.pickupId
          WHERE si.settlementId = ? AND si.voidedAt IS NULL
          ORDER BY si.week DESC, pk.localDay DESC, si.id`,
        [settlementId],
      ),

    // Not yet settled, for the whole farm — this is what drives "pay everyone".
    // `upTo` cuts off at the end of the week being paid; anything still unpaid
    // from earlier weeks is included on purpose, because the worker is still
    // owed it and a settlement covers everything outstanding up to that date.
    pendingAll: (general, upTo): PendingWorker[] => {
      // Grouped by weight as well as by week, so a row is a set of IDENTICAL
      // weighings and `amountCents` is still applied once per weighing.
      //
      // Summing the week's kilos and rounding that instead announced a figure
      // the settlement then contradicted: on the numbers of golden case 06 the
      // panel said 749,97 and `settle` posted 749,99. Rounding per line and
      // summing integers is the rule the corpus exists to pin — the receipt the
      // worker checks has to add up line by line — and the screen a foreman
      // reads before paying the whole farm has to agree with it.
      const rows = db.getAllSync<{
        personId: number;
        name: string;
        week: string;
        weight: number;
        lines: number;
      }>(
        `SELECT pk.personId,
                COALESCE(pe.name || ' ' || pe.lastName, '?') AS name,
                pk.week AS week,
                pk.weight AS weight, COUNT(*) AS lines
           FROM pickups_live pk
           LEFT JOIN people pe ON pe.id = pk.personId
          WHERE pk.id NOT IN (SELECT pickupId FROM settlement_items WHERE voidedAt IS NULL)
            AND (? IS NULL OR pk.localDay <= date(?))
          GROUP BY pk.personId, week, pk.weight`,
        [upTo ?? null, upTo ?? null],
      );
      const acc = new Map<number, PendingWorker>();
      const generalCents = toCents(general);
      for (const r of rows) {
        const perLine = amountCents(r.weight, costCentsForWeek(r.week, generalCents));
        const cur = acc.get(r.personId) ?? {
          personId: r.personId,
          name: r.name,
          kg: 0,
          amountCents: 0,
        };
        cur.kg += r.weight * r.lines;
        cur.amountCents += perLine * r.lines;
        acc.set(r.personId, cur);
      }
      return [...acc.values()].sort((a, b) => b.amountCents - a.amountCents);
    },
  };

  // ---- Performance analysis ---------------------------------------------
  //
  // Ranking pickers by total kg is unfair and actively misleading: whoever
  // worked the ripest plot wins. Every comparison here is against the people
  // who worked the SAME plot on the SAME day, which is the only fair baseline.

  const DAY_KEY = "pk.localDay";
  const WEEK_KEY = "pk.week";

  const performance: PerformanceRepo = {
    // Effective kg per day worked — not per pickup, which only measures how big
    // a sack somebody carries, and not total kg, which just rewards attendance.
    crew: (sinceDays = 28): WorkerPerf[] => {
      const rows = db.getAllSync<{
        personId: number;
        name: string;
        kg: number;
        days: number;
      }>(
        `SELECT pk.personId,
                COALESCE(pe.name || ' ' || pe.lastName, '?') AS name,
                SUM(pk.weight) AS kg,
                COUNT(DISTINCT pk.localDay) AS days
           FROM pickups_live pk LEFT JOIN people pe ON pe.id = pk.personId
          WHERE pk.localDay >= ?
          GROUP BY pk.personId`,
        [daysAgo(sinceDays)],
      );

      // Each person's daily total on a plot, against what their MATES did that
      // same day. Three things matter here and all three were wrong at first:
      //   - the same window as kg/day, or the list shows a lifetime index next
      //     to a 28-day rate and nobody can reconcile them;
      //   - the person is excluded from their own benchmark, otherwise everyone
      //     is dragged toward 1.0 and the pull depends on how big the crew was;
      //   - an average of daily ratios, not a ratio of sums, so a day on a heavy
      //     plot does not outweigh nine days on a light one.
      const irlRows = db.getAllSync<{
        personId: number;
        irl: number;
        comparableDays: number;
      }>(INDEX_SQL, [daysAgo(sinceDays)]);

      const irlOf = new Map(irlRows.map((r) => [r.personId, r]));

      // Same index split into two windows of equal length, to see who is
      // slipping. Raw kg would show everyone dropping at the end of the harvest;
      // the index would not. Both halves need enough days or the arrow would be
      // decided against a single outlying day.
      const half = Math.round(sinceDays / 2);
      const trendRows = db.getAllSync<{
        personId: number;
        recent: number | null;
        earlier: number | null;
        recentDays: number;
        earlierDays: number;
      }>(
        `WITH dw AS (
           SELECT pk.personId, pk.cropId, pk.localDay AS d, SUM(pk.weight) AS kg
             FROM pickups_live pk
            WHERE pk.localDay >= ?
            GROUP BY pk.personId, pk.cropId, d
         ),
         base AS (
           SELECT cropId, d, SUM(kg) AS tot, COUNT(*) AS n FROM dw GROUP BY cropId, d
         ),
         j AS (
           SELECT dw.personId, dw.d,
                  dw.kg / NULLIF((base.tot - dw.kg) / (base.n - 1), 0) AS ratio
             FROM dw JOIN base ON base.cropId = dw.cropId AND base.d = dw.d
            WHERE base.n >= 3
         )
         SELECT personId,
                AVG(CASE WHEN d >= ? THEN ratio END) AS recent,
                AVG(CASE WHEN d <  ? THEN ratio END) AS earlier,
                COUNT(CASE WHEN d >= ? THEN 1 END) AS recentDays,
                COUNT(CASE WHEN d <  ? THEN 1 END) AS earlierDays
           FROM j GROUP BY personId`,
        [
          daysAgo(sinceDays),
          daysAgo(half),
          daysAgo(half),
          daysAgo(half),
          daysAgo(half),
        ],
      );
      const trendOf = new Map(trendRows.map((r) => [r.personId, r]));

      return rows
        .map((r) => {
          const i = irlOf.get(r.personId);
          const t = trendOf.get(r.personId);
          return {
            ...r,
            kgPerDay: r.days ? r.kg / r.days : 0,
            irl: i && i.comparableDays >= 3 ? i.irl : null,
            comparableDays: i?.comparableDays ?? 0,
            trend:
              t &&
              t.recent != null &&
              t.earlier &&
              t.recentDays >= 4 &&
              t.earlierDays >= 4
                ? t.recent / t.earlier
                : null,
          };
        })
        .sort((a, b) => (b.irl ?? -1) - (a.irl ?? -1));
    },

    // Yield per hectare is the one agronomic number the schema already holds
    // and nothing uses: it says whether a plot is giving what it should. Bounded
    // to the same window as the rest of the panel — a lifetime total against a
    // one-season area only ever grows, and means nothing by the third harvest.
    plots: (sinceDays = 28) =>
      db.getAllSync<PlotPerf>(
        `SELECT cr.id AS cropId, cr.name, cr.dimension AS ha,
                SUM(pk.weight) AS kg,
                SUM(pk.weight) / NULLIF(cr.dimension,0) AS kgPerHa,
                COUNT(DISTINCT pk.personId) AS pickers
           FROM pickups_live pk JOIN crops cr ON cr.id = pk.cropId
          WHERE pk.localDay >= ? AND cr.deletedAt IS NULL
          GROUP BY cr.id ORDER BY kgPerHa DESC`,
        [daysAgo(sinceDays)],
      ),

    // Weekly price against what the crew actually produced that week. The price
    // overrides are a log of natural experiments and the pickups are the measured
    // outcome — having both sides is what makes this answerable at all. It tells
    // the owner whether raising the rate bought more harvest or just cost more.
    priceResponse: (general, weeks = 10): PriceResponseRow[] => {
      const rows = db.getAllSync<{
        week: string;
        kgPerDay: number;
        pickers: number;
        kg: number;
      }>(
        `WITH perDay AS (
           SELECT pk.week AS week, pk.personId, pk.localDay AS d, SUM(pk.weight) AS kg
             FROM pickups_live pk
            WHERE pk.localDay <= ? AND pk.deletedAt IS NULL
            GROUP BY week, pk.personId, d
         )
         SELECT week, AVG(kg) AS kgPerDay, COUNT(DISTINCT personId) AS pickers,
                SUM(kg) AS kg
           FROM perDay GROUP BY week ORDER BY week DESC LIMIT ?`,
        [farmToday(), weeks],
      );
      return rows
        .map((r) => ({ ...r, price: costForWeek(r.week, general) }))
        .reverse(); // oldest first, so the reader follows the season forward
    },

    // Real cost per unit from the ledger, not weight * price: it includes the
    // price frozen at settlement plus every deduction and adjustment since.
    realCost: (general): RealCost => {
      const r = db.getFirstSync<{ kg: number; devengoCents: number }>(
        `SELECT COALESCE(SUM(si.weight),0) AS kg, COALESCE(SUM(si.amountCents),0) AS devengoCents
           FROM settlement_items si
           JOIN settlements s ON s.id = si.settlementId AND s.status = 'open'
          WHERE si.voidedAt IS NULL`,
        [],
      );
      const adj = db.getFirstSync<{ c: number }>(
        `SELECT COALESCE(SUM(l.amountCents),0) AS c
           FROM ledger l LEFT JOIN settlements s ON s.id = l.settlementId
          WHERE l.kind IN ('ajuste','deduccion')
            AND (l.settlementId IS NULL OR s.status = 'open')`,
        [],
      );
      const kg = r?.kg ?? 0;
      if (!kg) return { kg: 0, listed: general, real: general, budget: general };
      return {
        kg,
        listed: fromCents((r?.devengoCents ?? 0) / kg),
        real: fromCents(((r?.devengoCents ?? 0) + (adj?.c ?? 0)) / kg),
        budget: general,
      };
    },
  };

  // ---- Review rules ------------------------------------------------------
  //
  // Deliberately simple, explainable rules. Accusing a worker with a number you
  // cannot justify out loud destroys the trust the whole app runs on, so there
  // is no model here — just thresholds anyone can check.
  //
  // All five are bounded to a window and a row cap. They used to be five
  // unbounded scans of `pickups` on the JS thread, every time the panel got
  // focus, and the cost grew with the whole history of the farm rather than
  // with what there is to review.

  const anomalies: AnomaliesRepo = {
    all: (maxWeight = 120, window = {}): Anomaly[] => {
      const { sinceDays, limit } = { ...DEFAULT_ANOMALY_WINDOW, ...window };
      const { raw, day } = windowBounds(sinceDays);
      const out: Anomaly[] = [];
      const push = (
        r: Omit<Anomaly, "rule" | "reference">,
        rule: Anomaly["rule"],
        reference: number,
      ) => out.push({ ...r, rule, reference });

      type Row = Omit<Anomaly, "rule" | "reference"> & { reference?: number };

      // Physically impossible for one person to carry.
      for (const r of db.getAllSync<Row>(RULE_IMPOSSIBLE_SQL, [
        raw,
        day,
        maxWeight,
        limit,
      ]))
        push(r, "impossible", maxWeight);

      // Same person, plot and weight within three minutes: a double tap.
      for (const r of db.getAllSync<Row>(RULE_DUPLICATE_SQL, [raw, day, limit]))
        push(r, "duplicate", r.weight);

      // Far above what this person usually carries. The reference excludes the
      // suspect pickup itself: including it made the rule algebraically unable
      // to fire, because the outlier inflated the very average it was compared
      // against (w >= 10*avg reduces to n+1 >= n+10, false for every n).
      //
      // The reference is still the person's WHOLE history, not just the window:
      // the window decides what is worth showing, never what a normal load for
      // this person is.
      for (const r of db.getAllSync<Row>(RULE_DIGIT_SQL, [raw, day, limit]))
        push(r, "digit", Math.round(r.reference ?? 0));

      // Far above what the rest of the crew did on that plot that day. This is
      // the one that catches a bad weighing on somebody whose own history is
      // short, where the personal reference above has nothing to work with.
      //
      // The mates' average is derived from the group's total minus this row,
      // rather than joining every pickup against every other pickup of its
      // plot-day. That join is quadratic inside each group: with one season of
      // data it took eleven seconds, on the JS thread, every time this screen
      // opened. Same results, ~400x faster.
      for (const r of db.getAllSync<Row>(RULE_OUTLIER_SQL, [raw, day, limit]))
        push(r, "outlier", Math.round(r.reference ?? 0));

      // Dated after today: a wrong clock or a typo. "Today" is the FARM's day
      // now, so a handset one zone out no longer accuses half an afternoon of
      // being in the future — which is the failure that made this rule shout
      // and therefore made it ignored.
      for (const r of db.getAllSync<Row>(RULE_FUTURE_SQL, [
        raw,
        day,
        farmToday(),
        limit,
      ]))
        push(r, "future", 0);

      // One pickup can break more than one rule; report it once, worst first.
      const seen = new Set<number>();
      return out
        .filter((a) => (seen.has(a.pickupId) ? false : seen.add(a.pickupId)))
        .slice(0, limit);
    },
  };

  // ---- Per-crop detail ---------------------------------------------------

  const cropReports: CropReportsRepo = {
    stats: (cropId) =>
      db.getFirstSync<CropStats>(
        `SELECT COALESCE(SUM(weight),0) AS kg, COUNT(*) AS pickups,
                COUNT(DISTINCT personId) AS pickers,
                COUNT(DISTINCT localDay) AS days,
                MIN(date) AS firstDate, MAX(date) AS lastDate
           FROM pickups_live WHERE cropId = ?`,
        [cropId],
      ),

    byWeek: (cropId) =>
      db.getAllSync<CropWeek>(
        `SELECT week AS week,
                SUM(weight) AS kg, COUNT(DISTINCT personId) AS pickers
           FROM pickups_live
          WHERE cropId = ? AND localDay <= ? AND deletedAt IS NULL
          GROUP BY week ORDER BY week DESC LIMIT 12`,
        [cropId, farmToday()],
      ),

    // Who worked this plot, and how they compared against the others who were
    // on it the same days — the only fair way to rank inside a plot.
    byWorker: (cropId, sinceDays = 28) =>
      db.getAllSync<CropWorker>(
        `WITH dw AS (
           SELECT pk.personId, pk.localDay AS d, SUM(pk.weight) AS kg
             FROM pickups_live pk
            WHERE pk.cropId = ? AND pk.localDay >= ?
            GROUP BY pk.personId, d
         ),
         base AS (SELECT d, SUM(kg) AS tot, COUNT(*) AS n FROM dw GROUP BY d)
         SELECT dw.personId,
                COALESCE(pe.name || ' ' || pe.lastName,'?') AS name,
                SUM(dw.kg) AS kg,
                COUNT(DISTINCT dw.d) AS days,
                AVG(CASE WHEN base.n >= 3
                         THEN dw.kg / NULLIF((base.tot - dw.kg) / (base.n - 1), 0) END) AS irl,
                COUNT(CASE WHEN base.n >= 3 THEN 1 END) AS comparableDays
           FROM dw
           JOIN base ON base.d = dw.d
           LEFT JOIN people pe ON pe.id = dw.personId
          GROUP BY dw.personId ORDER BY kg DESC`,
        [cropId, daysAgo(sinceDays)],
      ),

    recent: (cropId) =>
      db.getAllSync<CropPickup>(
        `SELECT pk.id, pk.personId, pk.weight, pk.date,
                COALESCE(pe.name || ' ' || pe.lastName,'?') AS person
           FROM pickups_live pk LEFT JOIN people pe ON pe.id = pk.personId
          WHERE pk.cropId = ? ORDER BY pk.date DESC LIMIT 30`,
        [cropId],
      ),

    // Value produced by this plot, with the price in force each week, resolved
    // in one query instead of one lookup per week from JS.
    value: (cropId, general) =>
      db.getFirstSync<{ value: number }>(
        HARVEST_VALUE_SQL("WHERE pk.cropId = ?"),
        [general, cropId],
      )?.value ?? 0,
  };

  // ---- Export ------------------------------------------------------------
  //
  // The season lives in one phone. These are the rows that let it be rebuilt
  // somewhere else, or checked in a spreadsheet by whoever asks.

  const exportRows: ExportRepo = {
    pickups: () => db.getAllSync<Record<string, unknown>>(EXPORT_PICKUPS_SQL,
        [],),
    ledger: () => db.getAllSync<Record<string, unknown>>(EXPORT_LEDGER_SQL,
        [],),
    balances: () => db.getAllSync<Record<string, unknown>>(EXPORT_BALANCES_SQL,
        [],),
  };

  // ---- Per-week detail ---------------------------------------------------

  const weekReports: WeekReportsRepo = {
    /** Day-by-day totals for the week, with how many people and plots worked. */
    byDay: (monday) => db.getAllSync<WeekDay>(WEEK_BY_DAY_SQL, [monday]),

    /** Who worked that week, and how much. */
    byWorker: (monday) => db.getAllSync<WeekWorker>(WEEK_BY_WORKER_SQL, [monday]),

    /**
     * The grid: how much each person picked on each plot that week. This is the
     * question a foreman actually asks — not "how much did the week give" but
     * "who was where, and did it show".
     */
    grid: (monday) => db.getAllSync<WeekGridCell>(WEEK_GRID_SQL, [monday]),

    /** The same grid, but against the days of the week instead of the plots. */
    gridByDay: (monday) =>
      db.getAllSync<WeekDayCell>(WEEK_GRID_DAY_SQL, [monday]),

    plots: (monday) => db.getAllSync<WeekPlot>(WEEK_PLOTS_SQL, [monday]),
  };

  // ---- Sync: identity now, protocol later -------------------------------
  //
  // Nothing here sends anything. `docs/sync-and-roles.md` puts sync last on
  // purpose — "it is the part that can lose money" — and the protocol is being
  // written in parallel. What a phone needs before any protocol arrives is a
  // name for every row and an honest record of what it still owes, and that is
  // all this is. The queue is filled by the triggers in `schema.ts`, not from
  // here, so a writer added next sprint that nobody remembers to instrument is
  // still queued.

  const syncStore = createSyncStore(db, {
    now,
    timezone,
    newUuid,
    deviceId: () => sync.identity().deviceId,
  });

  const sync: SyncRepo = {
    identity: (): SyncIdentity => {
      const r = db.getFirstSync<{
        farmId: string | null;
        deviceId: string | null;
        syncedAt: string | null;
      }>("SELECT farmId, deviceId, syncedAt FROM config WHERE id = 1", []);
      return {
        farmId: r?.farmId ?? null,
        // Never empty: `init` mints one, and a config row without one gets
        // filled on the next launch. Reported as "" only if init has not run.
        deviceId: r?.deviceId ?? "",
        syncedAt: r?.syncedAt ?? null,
      };
    },

    // Once. A farm id that could be changed on a device already holding a
    // season of rows is a way to hand one farm's payroll to another, and no
    // legitimate flow needs it: a phone that has to move farms is a phone that
    // has to be wiped.
    claimFarm: (farmId) => {
      const current = sync.identity().farmId;
      if (current && current !== farmId) throw new Error("FARM_ALREADY_CLAIMED");
      if (current === farmId) return;
      db.runSync("UPDATE config SET farmId = ?, updatedAt = ? WHERE id = 1", [
        farmId,
        now(),
      ]);
    },

    pending: (limit = 500) =>
      db.getAllSync<OutboxEntry>(OUTBOX_PENDING_SQL, [limit]),

    pendingCount: () =>
      db.getFirstSync<{ n: number }>("SELECT COUNT(*) AS n FROM outbox", [])?.n ??
      0,

    // Dropping by (seq, revision) rather than by seq is the whole safety of
    // this queue. A worker's weight is corrected while the push is in flight;
    // the trigger coalesces onto the same seq and bumps the revision; the
    // server acks the seq it was sent, and the entry stays because the
    // revision moved on. Acking by seq alone would lose that correction for
    // good, and nothing would ever notice.
    ack: (sent) => {
      let dropped = 0;
      db.withTransactionSync(() => {
        for (const e of sent)
          dropped += db.runSync(
            "DELETE FROM outbox WHERE seq = ? AND revision = ?",
            [e.seq, e.revision],
          ).changes;
      });
      return dropped;
    },

    // ---- The protocol's own state, and what came down ------------------

    state: () => syncStore.state(),
    saveState: (patch) => syncStore.saveState(patch),

    /**
     * The farm's zone, adopted once at registration.
     *
     * Writing it and restamping are one operation on purpose. A phone that
     * recorded the zone but kept weighings stamped under the old one would
     * price this week from the farm's calendar and last week from the
     * handset's, and nothing would say which rows were which.
     */
    adoptTimezone: (tz) => {
      let moved = 0;
      db.withTransactionSync(() => {
        // Held, because restamping is not a change the server is owed: the
        // instant did not move, only this phone's reading of which day it
        // falls on, and the server derives its own from the same instant.
        db.runSync("INSERT OR IGNORE INTO sync_apply (id) VALUES (1)", []);
        try {
          db.runSync("UPDATE config SET timezone = ?, updatedAt = ? WHERE id = 1", [
            tz,
            now(),
          ]);
          moved = restampDays(db, tz);
        } finally {
          db.runSync("DELETE FROM sync_apply", []);
        }
      });
      return moved;
    },

    applyPull: (changes) => syncStore.applyPull(changes),
    balanceChecksums: () => syncStore.balanceChecksums(),
    recordServerBalances: (rows, at) => syncStore.recordServerBalances(rows, at),
    wireRow: (entity, uuid) => syncStore.wireRow(entity, uuid),
    personByUuid: (uuid) => syncStore.personByUuid(uuid),

    conflicts: (includeResolved) => syncStore.conflicts(includeResolved),
    openConflictCount: () => syncStore.openConflictCount(),
    raiseConflict: (c) => syncStore.raiseConflict(c),
    resolveConflict: (id, resolution) => syncStore.resolveConflict(id, resolution),

    // ---- The mudanza, §8 fase 3 and 4 --------------------------------

    /**
     * The season, packed. Read-only from top to bottom — see
     * `sync/seasonExport.ts`, which has not one statement that writes.
     *
     * The zone and the schema version come from here rather than from the
     * caller because they are facts about this database, and a screen that had
     * to supply them would be a screen that could supply the wrong ones.
     */
    seasonExport: (importId, generatedAt) => {
      const identity = sync.identity();
      return buildSeasonExport(db, {
        importId,
        farmId: identity.farmId,
        deviceId: identity.deviceId,
        schemaVersion: SCHEMA_VERSION,
        timezone: timezone(),
        generatedAt,
      });
    },

    recordImportRun: (run) => {
      db.runSync(
        `INSERT INTO import_runs
           (importId, startedAt, finishedAt, status, rowsSent, totals, report, error)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          run.importId,
          run.startedAt,
          run.finishedAt,
          run.status,
          run.rows,
          run.totals ? JSON.stringify(run.totals) : null,
          run.report ? JSON.stringify(run.report) : null,
          run.error,
        ],
      );
    },

    importRuns: (limit = 20): ImportRun[] =>
      db
        .getAllSync<
          Omit<ImportRun, "totals" | "report"> & {
            totals: string | null;
            report: string | null;
          }
        >(
          `SELECT id, importId, startedAt, finishedAt, status, rowsSent AS rows,
                  totals, report, error
             FROM import_runs ORDER BY startedAt DESC, id DESC LIMIT ?`,
          [limit],
        )
        .map((r) => ({
          ...r,
          totals: r.totals ? (JSON.parse(r.totals) as ImportRun["totals"]) : null,
          report: r.report ? (JSON.parse(r.report) as ImportRun["report"]) : null,
        })),

    reactivate: (o) =>
      reactivateWorker(db, {
        personId: o.personId,
        causeEntity: o.causeEntity,
        causeUuid: o.causeUuid,
        deviceId: sync.identity().deviceId,
        at: now(),
      }),
    reactivations: (personId) => syncStore.reactivations(personId),
  };

  return {
    init,
    people,
    crops,
    pickups,
    reports,
    workerReports,
    cropReports,
    weekReports,
    config,
    prefs,
    overrides,
    demo,
    payments,
    performance,
    anomalies,
    export: exportRows,
    sync,
    weekCrops,
    reportBy,
    costForWeek,
    costCentsForWeek,
    totalPayout,
  };
}
