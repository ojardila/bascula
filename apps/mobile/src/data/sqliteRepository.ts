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
import { localDayOf } from "../../../../packages/shared/src/time.ts";
import {
  BASE_SCHEMA,
  PAYMENTS_SCHEMA,
  PICKUP_INDEXES_SQL,
  BALANCE_SQL,
  PENDING_SQL,
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
} from "../schema.ts";
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
  Repository,
  ReportsRepo,
  SettleResult,
  Settlement,
  SettlementItem,
  SettlementPreview,
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

const SCHEMA_VERSION = 5;

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

  /** The stored instant of a write. */
  const now = () => clock().toISOString();

  // The business date of a movement: the LOCAL calendar day, not the UTC one.
  // Every query here groups by local day, and a payment made on Sunday evening
  // in Bogota would otherwise be stamped with tomorrow's date and shown as a
  // movement dated in the future.
  const today = () => localDayOf(clock());

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
      db.execSync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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

    // Seed a sensible default crop config (Café) on first run.
    db.runSync(
      `INSERT OR IGNORE INTO config (id, cropType, label, unit, yieldUnit, costPerUnit, language)
       VALUES (1, 'cafe', 'Café', 'kg', 'kg por recolector', 800, 'es')`,
      [],
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
        "INSERT INTO people (name,lastName,documentType,docId,tag,image,createdAt) VALUES (?,?,?,?,?,?,?)",
        [p.name, p.lastName, p.documentType, p.docId, p.tag, p.image, now()],
      ),
    // Soft delete: hide the worker but keep their pickups intact.
    remove: (id) =>
      db.runSync("UPDATE people SET deletedAt = ? WHERE id = ?", [now(), id]),
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
        "INSERT INTO crops (name,type,variety,dimension,createdAt) VALUES (?,?,?,?,?)",
        [c.name, c.type, c.variety, c.dimension, now()],
      ),
    // Soft delete: hide the plot but keep every pickup that references it.
    remove: (id) =>
      db.runSync("UPDATE crops SET deletedAt = ? WHERE id = ?", [now(), id]),
  };

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
      if (!Number.isFinite(weight) || weight <= 0) throw new Error("BADWEIGHT");
      const r = db.runSync("UPDATE pickups SET weight = ? WHERE id = ?", [
        weight,
        id,
      ]);
      // Without this an update that matched nothing reported success.
      if (r.changes === 0) throw new Error("NOTFOUND");
    },

    remove: (id) => {
      if (pickups.isSettled(id)) throw new Error("SETTLED");
      db.runSync("DELETE FROM pickups WHERE id = ?", [id]);
    },

    add: (p) =>
      db.runSync(
        "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?)",
        [p.personId, p.cropId, p.weight, p.date, now()],
      ),

    recent: () =>
      db.getAllSync<RecentPickup>(
        `SELECT pk.id, pk.weight, pk.date,
                COALESCE(pe.name || ' ' || pe.lastName, 'Unknown') AS person,
                COALESCE(cr.name, 'Unknown') AS crop
         FROM pickups pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
         ORDER BY pk.date DESC LIMIT 50`,
        [],
      ),
  };

  // ---- Reports ---------------------------------------------------------

  const reports: ReportsRepo = {
    totals: () =>
      db.getFirstSync<FarmTotals>(
        `SELECT
           (SELECT COUNT(*) FROM pickups) AS pickups,
           (SELECT COALESCE(SUM(weight),0) FROM pickups) AS kg,
           (SELECT COUNT(*) FROM people) AS people,
           (SELECT COUNT(*) FROM crops) AS crops`,
        [],
      ),
    today: () =>
      db.getFirstSync<PeriodTotals>(
        `SELECT COALESCE(SUM(weight),0) AS kg, COUNT(*) AS count
         FROM pickups WHERE date(date,'localtime') = date('now','localtime')`,
        [],
      ),
    thisWeek: () =>
      db.getFirstSync<PeriodTotals>(
        `SELECT COALESCE(SUM(weight),0) AS kg, COUNT(*) AS count
         FROM pickups WHERE date(date,'localtime','-6 days','weekday 1') = date('now','localtime','-6 days','weekday 1')`,
        [],
      ),
    byWeek: () =>
      db.getAllSync<LabelledKg>(
        `SELECT date(date,'localtime','-6 days','weekday 1') AS label, SUM(weight) AS kg
         FROM pickups GROUP BY label ORDER BY label DESC LIMIT 12`,
        [],
      ),
    byWorker: (general) =>
      db.getAllSync<ValuedGroup>(
        `SELECT COALESCE(pe.name || ' ' || pe.lastName, 'Unknown') AS label,
                SUM(pk.weight) AS kg, pk.personId AS id,
                SUM(pk.weight * COALESCE(o.costPerUnit, ?)) AS value
         FROM pickups pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN cost_overrides o
           ON o.week = date(pk.date,'localtime','-6 days','weekday 1')
         GROUP BY pk.personId ORDER BY kg DESC`,
        [general],
      ),
    // The value comes out of SQL with each week's price applied. Multiplying
    // the total by the general cost in one screen and by the weekly overrides
    // in another made the same plot worth two different amounts.
    byCrop: (general) =>
      db.getAllSync<ValuedGroup>(
        `SELECT COALESCE(cr.name, 'Unknown') AS label, SUM(pk.weight) AS kg,
                pk.cropId AS id,
                SUM(pk.weight * COALESCE(o.costPerUnit, ?)) AS value
         FROM pickups pk
         LEFT JOIN crops cr ON cr.id = pk.cropId
         LEFT JOIN cost_overrides o
           ON o.week = date(pk.date,'localtime','-6 days','weekday 1')
         WHERE cr.deletedAt IS NULL
         GROUP BY pk.cropId ORDER BY kg DESC`,
        [general],
      ),
  };

  // Which crops (lotes) were harvested each week — powers the weekly breakdown.
  const weekCrops = () =>
    db.getAllSync<WeekCropRow>(
      `SELECT date(pk.date,'localtime','-6 days','weekday 1') AS week,
              COALESCE(cr.name, 'Unknown') AS crop, SUM(pk.weight) AS kg
       FROM pickups pk LEFT JOIN crops cr ON cr.id = pk.cropId
       WHERE cr.deletedAt IS NULL
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
                COUNT(DISTINCT date(date,'localtime')) AS days,
                MIN(date) AS firstDate, MAX(date) AS lastDate
         FROM pickups WHERE personId = ?`,
        [personId],
      ),
    byWeek: (personId) =>
      db.getAllSync<LabelledKg>(
        `SELECT date(date,'localtime','-6 days','weekday 1') AS label, SUM(weight) AS kg
         FROM pickups WHERE personId = ? GROUP BY label ORDER BY label DESC LIMIT 12`,
        [personId],
      ),
    byCrop: (personId) =>
      db.getAllSync<LabelledKg>(
        `SELECT COALESCE(cr.name, 'Unknown') AS label, SUM(pk.weight) AS kg
         FROM pickups pk LEFT JOIN crops cr ON cr.id = pk.cropId
         WHERE pk.personId = ? GROUP BY pk.cropId ORDER BY kg DESC`,
        [personId],
      ),
    recent: (personId) =>
      db.getAllSync<WorkerPickup>(
        `SELECT pk.id, pk.weight, pk.date, COALESCE(cr.name, 'Unknown') AS crop
         FROM pickups pk LEFT JOIN crops cr ON cr.id = pk.cropId
         WHERE pk.personId = ? ORDER BY pk.date DESC LIMIT 50`,
        [personId],
      ),
    // Payout for this worker applying weekly cost overrides.
    payout: (personId, general) => {
      const rows = db.getAllSync<{ week: string; kg: number }>(
        `SELECT date(date,'localtime','-6 days','weekday 1') AS week, SUM(weight) AS kg
         FROM pickups WHERE personId = ? GROUP BY week`,
        [personId],
      );
      return rows.reduce((s, r) => s + r.kg * costForWeek(r.week, general), 0);
    },
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
        `INSERT INTO config (id, cropType, label, unit, yieldUnit, costPerUnit)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cropType = excluded.cropType, label = excluded.label,
           unit = excluded.unit, yieldUnit = excluded.yieldUnit,
           costPerUnit = excluded.costPerUnit`,
        [c.cropType, c.label, c.unit, c.yieldUnit, c.costPerUnit],
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
        `INSERT INTO config (id, language) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET language = excluded.language`,
        [l],
      ),
  };

  const overrides: OverridesRepo = {
    all: () =>
      db.getAllSync<CostOverride>(
        "SELECT id, week, costPerUnit FROM cost_overrides ORDER BY week DESC",
        [],
      ),
    set: (week, costPerUnit) =>
      db.runSync(
        `INSERT INTO cost_overrides (week, costPerUnit) VALUES (?, ?)
         ON CONFLICT(week) DO UPDATE SET costPerUnit = excluded.costPerUnit`,
        [week, costPerUnit],
      ),
    remove: (id) =>
      db.runSync("DELETE FROM cost_overrides WHERE id = ?", [id]),
  };

  // Effective cost per unit for a given week label: the weekly override if one
  // exists, otherwise the general cost from the active config.
  function costForWeek(week: string, general: number): number {
    const o = db.getFirstSync<{ costPerUnit: number }>(
      "SELECT costPerUnit FROM cost_overrides WHERE week = ?",
      [week],
    );
    return o ? o.costPerUnit : general;
  }

  // Total payout across all pickups, applying weekly overrides where present.
  function totalPayout(general: number): number {
    const rows = db.getAllSync<{ week: string; kg: number }>(
      `SELECT date(date,'localtime','-6 days','weekday 1') AS week, SUM(weight) AS kg
       FROM pickups GROUP BY week`,
      [],
    );
    return rows.reduce((sum, r) => sum + r.kg * costForWeek(r.week, general), 0);
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
          "INSERT INTO people (name,lastName,documentType,docId,tag,image,createdAt) VALUES (?,?,?,?,?,?,?)",
          [
            name,
            lastName,
            "CC",
            String(1000000000 + i * 137),
            "T" + (i + 1),
            "",
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
          "INSERT INTO crops (name,type,variety,dimension,createdAt) VALUES (?,?,?,?,?)",
          [name, type, variety, dim, now()],
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
            db.runSync(
              "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?)",
              [
                pid,
                cid,
                weight,
                iso(8 + k * 3, (idx * 7) % 60),
                iso(8 + k * 3, (idx * 7) % 60),
              ],
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
        "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?)",
        [pids[2], cids[0], 520, badIso(9), badIso(9)],
      );
      // The same weighing saved twice by a double tap.
      const dup = badIso(11);
      for (let k = 0; k < 2; k++) {
        db.runSync(
          "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?)",
          [pids[4], cids[1], 47, dup, dup],
        );
      }

      // A couple of weekly cost overrides to showcase the feature.
      const weeks = db.getAllSync<{ week: string }>(
        "SELECT DISTINCT date(date,'localtime','-6 days','weekday 1') AS week FROM pickups ORDER BY week DESC LIMIT 2",
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
    return rows.map((r) => {
      if (!priceOf.has(r.week))
        priceOf.set(r.week, toCents(costForWeek(r.week, general)));
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
      `INSERT INTO ledger (personId,kind,amountCents,date,settlementId,method,note,reversesId,createdAt)
       VALUES (?,?,?,?,?,?,?,?,?)`,
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
      "UPDATE settlement_items SET voidedAt = ? WHERE settlementId = ?",
      [now(), settlementId],
    );
    db.runSync(
      "UPDATE settlements SET status = 'void', voidedAt = ? WHERE id = ?",
      [now(), settlementId],
    );
    const devengo = db.getFirstSync<{ id: number; amountCents: number }>(
      "SELECT id, amountCents FROM ledger WHERE settlementId = ? AND kind = 'devengo'",
      [settlementId],
    );
    if (devengo) {
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
      // A zero gross would violate the ledger's CHECK and crash the payroll for
      // the whole farm; it happens as soon as someone saves a cost of 0.
      if (!items.length || grossCents <= 0) return null;
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
          `INSERT INTO settlements (personId,periodStart,periodEnd,grossCents,status,note,createdAt)
           VALUES (?,?,?,?, 'open', ?, ?)`,
          [personId, periodStart, to, grossCents, note ?? null, now()],
        );
        settlementId = s.lastInsertRowId;
        for (const i of items) {
          db.runSync(
            `INSERT INTO settlement_items (settlementId,pickupId,week,weight,costPerUnitCents,amountCents)
             VALUES (?,?,?,?,?,?)`,
            [
              settlementId,
              i.pickupId,
              i.week,
              i.weight,
              i.costPerUnitCents,
              i.amountCents,
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
                COALESCE(SUM(CASE WHEN l.kind = 'devengo' THEN l.amountCents
                                  WHEN l.kind = 'reverso' AND l.amountCents < 0 THEN l.amountCents END),0)
                  AS earnedCents,
                COALESCE(-SUM(CASE WHEN l.kind IN ('pago','anticipo') THEN l.amountCents
                                   WHEN l.kind = 'reverso' AND l.amountCents > 0 THEN l.amountCents END),0)
                  AS paidCents,
                COALESCE(-SUM(CASE WHEN l.kind = 'deduccion' THEN l.amountCents END),0) AS deductedCents,
                COALESCE(SUM(l.amountCents),0) AS balanceCents,
                MAX(l.date) AS lastMovementAt
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

    settlements: (personId): Settlement[] =>
      db.getAllSync<Settlement>(
        "SELECT * FROM settlements WHERE personId = ? ORDER BY createdAt DESC",
        [personId],
      ),

    // Live lines only: this feeds the receipt, which must not list work that
    // was annulled.
    itemsOf: (settlementId): SettlementItem[] =>
      db.getAllSync<SettlementItem>(
        `SELECT * FROM settlement_items
          WHERE settlementId = ? AND voidedAt IS NULL ORDER BY week DESC, id`,
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
                date(pk.date,'localtime','-6 days','weekday 1') AS week,
                pk.weight AS weight, COUNT(*) AS lines
           FROM pickups pk
           LEFT JOIN people pe ON pe.id = pk.personId
          WHERE pk.id NOT IN (SELECT pickupId FROM settlement_items WHERE voidedAt IS NULL)
            AND (? IS NULL OR date(pk.date,'localtime') <= date(?))
          GROUP BY pk.personId, week, pk.weight`,
        [upTo ?? null, upTo ?? null],
      );
      const acc = new Map<number, PendingWorker>();
      for (const r of rows) {
        const perLine = amountCents(
          r.weight,
          toCents(costForWeek(r.week, general)),
        );
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

  const DAY_KEY = "date(pk.date,'localtime')";
  const WEEK_KEY = "date(pk.date,'localtime','-6 days','weekday 1')";

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
                COUNT(DISTINCT ${DAY_KEY}) AS days
           FROM pickups pk LEFT JOIN people pe ON pe.id = pk.personId
          WHERE ${DAY_KEY} >= date('now','localtime',?)
          GROUP BY pk.personId`,
        [`-${sinceDays} days`],
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
      }>(INDEX_SQL, [`-${sinceDays} days`]);

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
           SELECT pk.personId, pk.cropId, ${DAY_KEY} AS d, SUM(pk.weight) AS kg
             FROM pickups pk
            WHERE ${DAY_KEY} >= date('now','localtime',?)
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
                AVG(CASE WHEN d >= date('now','localtime',?) THEN ratio END) AS recent,
                AVG(CASE WHEN d <  date('now','localtime',?) THEN ratio END) AS earlier,
                COUNT(CASE WHEN d >= date('now','localtime',?) THEN 1 END) AS recentDays,
                COUNT(CASE WHEN d <  date('now','localtime',?) THEN 1 END) AS earlierDays
           FROM j GROUP BY personId`,
        [
          `-${sinceDays} days`,
          `-${half} days`,
          `-${half} days`,
          `-${half} days`,
          `-${half} days`,
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
           FROM pickups pk JOIN crops cr ON cr.id = pk.cropId
          WHERE ${DAY_KEY} >= date('now','localtime',?) AND cr.deletedAt IS NULL
          GROUP BY cr.id ORDER BY kgPerHa DESC`,
        [`-${sinceDays} days`],
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
           SELECT ${WEEK_KEY} AS week, pk.personId, ${DAY_KEY} AS d, SUM(pk.weight) AS kg
             FROM pickups pk
            WHERE ${DAY_KEY} <= date('now','localtime')
            GROUP BY week, pk.personId, d
         )
         SELECT week, AVG(kg) AS kgPerDay, COUNT(DISTINCT personId) AS pickers,
                SUM(kg) AS kg
           FROM perDay GROUP BY week ORDER BY week DESC LIMIT ?`,
        [weeks],
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

      // Dated after today: a wrong clock or a typo.
      for (const r of db.getAllSync<Row>(RULE_FUTURE_SQL, [raw, day, limit]))
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
                COUNT(DISTINCT date(date,'localtime')) AS days,
                MIN(date) AS firstDate, MAX(date) AS lastDate
           FROM pickups WHERE cropId = ?`,
        [cropId],
      ),

    byWeek: (cropId) =>
      db.getAllSync<CropWeek>(
        `SELECT date(date,'localtime','-6 days','weekday 1') AS week,
                SUM(weight) AS kg, COUNT(DISTINCT personId) AS pickers
           FROM pickups
          WHERE cropId = ? AND date(date,'localtime') <= date('now','localtime')
          GROUP BY week ORDER BY week DESC LIMIT 12`,
        [cropId],
      ),

    // Who worked this plot, and how they compared against the others who were
    // on it the same days — the only fair way to rank inside a plot.
    byWorker: (cropId, sinceDays = 28) =>
      db.getAllSync<CropWorker>(
        `WITH dw AS (
           SELECT pk.personId, ${DAY_KEY} AS d, SUM(pk.weight) AS kg
             FROM pickups pk
            WHERE pk.cropId = ? AND ${DAY_KEY} >= date('now','localtime',?)
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
        [cropId, `-${sinceDays} days`],
      ),

    recent: (cropId) =>
      db.getAllSync<CropPickup>(
        `SELECT pk.id, pk.weight, pk.date,
                COALESCE(pe.name || ' ' || pe.lastName,'?') AS person
           FROM pickups pk LEFT JOIN people pe ON pe.id = pk.personId
          WHERE pk.cropId = ? ORDER BY pk.date DESC LIMIT 30`,
        [cropId],
      ),

    // Value produced by this plot, with the price in force each week, resolved
    // in one query instead of one lookup per week from JS.
    value: (cropId, general) =>
      db.getFirstSync<{ value: number }>(
        `SELECT COALESCE(SUM(pk.weight * COALESCE(o.costPerUnit, ?)), 0) AS value
           FROM pickups pk
           LEFT JOIN cost_overrides o
             ON o.week = date(pk.date,'localtime','-6 days','weekday 1')
          WHERE pk.cropId = ?`,
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
    weekCrops,
    reportBy,
    costForWeek,
    totalPayout,
  };
}
