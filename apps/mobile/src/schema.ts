// Schema and the SQL that decides money, kept apart from expo-sqlite so the
// test suite can run the very same statements under node:sqlite. A test that
// re-typed this SQL would prove nothing about what the app executes.

export const BASE_SCHEMA = `
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, lastName TEXT, documentType TEXT, docId TEXT, tag TEXT,
      createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS crops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT, variety TEXT, dimension REAL,
      createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS pickups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      personId INTEGER, cropId INTEGER, weight REAL NOT NULL, date TEXT,
      createdAt TEXT,
      -- Added at v7 and declared here too, so a database created fresh is
      -- born with them. On the phone that is already in production this whole
      -- statement is a no-op (IF NOT EXISTS) and migrateToV7 does the work
      -- by ALTER; the two paths have to end at the same shape.
      deletedAt TEXT, localDay TEXT, week TEXT
    );
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cropType TEXT, label TEXT, unit TEXT, yieldUnit TEXT, costPerUnit REAL,
      costPerUnitCents INTEGER, timezone TEXT
    );
    CREATE TABLE IF NOT EXISTS cost_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week TEXT UNIQUE, costPerUnit REAL, costPerUnitCents INTEGER
    );
    -- Every read of a weighing goes through here. See PICKUPS_LIVE_VIEW.
    CREATE VIEW IF NOT EXISTS pickups_live AS
      SELECT * FROM pickups WHERE deletedAt IS NULL;
`;

export const PAYMENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS settlements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    personId    INTEGER NOT NULL REFERENCES people(id),
    periodStart TEXT NOT NULL,
    periodEnd   TEXT NOT NULL,
    grossCents  INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
    note        TEXT,
    createdAt   TEXT NOT NULL,
    voidedAt    TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_settlements_person
    ON settlements(personId, createdAt DESC);

  CREATE TABLE IF NOT EXISTS settlement_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    settlementId     INTEGER NOT NULL REFERENCES settlements(id),
    pickupId         INTEGER NOT NULL,
    week             TEXT NOT NULL,
    weight           REAL NOT NULL,
    costPerUnitCents INTEGER NOT NULL,
    amountCents      INTEGER NOT NULL,
    voidedAt         TEXT
  );
  -- The anti double-count lock: a pickup can belong to one live settlement.
  -- Voided lines stay for the record but release their pickup.
  CREATE UNIQUE INDEX IF NOT EXISTS ux_items_pickup_live
    ON settlement_items(pickupId) WHERE voidedAt IS NULL;
  CREATE INDEX IF NOT EXISTS ix_items_settlement ON settlement_items(settlementId);

  CREATE TABLE IF NOT EXISTS ledger (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    personId     INTEGER NOT NULL REFERENCES people(id),
    kind         TEXT NOT NULL CHECK (kind IN
                   ('devengo','pago','anticipo','deduccion','ajuste','reverso')),
    amountCents  INTEGER NOT NULL CHECK (amountCents <> 0),
    date         TEXT NOT NULL,
    settlementId INTEGER REFERENCES settlements(id),
    method       TEXT,
    note         TEXT,
    reversesId   INTEGER REFERENCES ledger(id),
    createdAt    TEXT NOT NULL,
    -- The farm's business day, materialised at v7. A copy of date, which
    -- every writer already stamps with the farm's day.
    localDay     TEXT,
    CHECK ( (kind = 'devengo' AND amountCents > 0)
         OR (kind IN ('pago','anticipo','deduccion') AND amountCents < 0)
         OR (kind IN ('ajuste','reverso')) )
  );
  CREATE INDEX IF NOT EXISTS ix_ledger_person ON ledger(personId, date DESC, id DESC);
  CREATE INDEX IF NOT EXISTS ix_ledger_sett ON ledger(settlementId);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_reverses
    ON ledger(reversesId) WHERE reversesId IS NOT NULL;
`;

/**
 * `pickups` had no index of any kind, on the one table that grows for ever.
 * Added at `user_version = 5`.
 *
 * - `ix_pickups_date` serves every "recent" and windowed scan, and the ORDER BY
 *   the review rules use to show the newest suspects first.
 * - `ix_pickups_dup` serves the duplicate rule, which is a self-join on
 *   (person, plot, weight): without it SQLite scanned the whole table once per
 *   candidate row, which is why that one rule cost more than the other four
 *   together and grew faster than linearly with the season.
 */
export const PICKUP_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS ix_pickups_date ON pickups(date);
  CREATE INDEX IF NOT EXISTS ix_pickups_dup
    ON pickups(personId, cropId, weight, createdAt);
`;

/** Local calendar day of a stored instant. */
export const DAY_OF = (col: string) => `date(${col},'localtime')`;

/** Monday of the week a stored instant falls in. */
export const WEEK_OF = (col: string) => `date(${col},'localtime','-6 days','weekday 1')`;

/**
 * One worker's position, straight from the ledger. Positive means the farm
 * owes them, so a positive balance is their credit. Reversals are told apart
 * by sign: reversing an earning is negative, reversing a payment positive.
 */
export const BALANCE_SQL = `
  SELECT ? AS personId,
         COALESCE(SUM(CASE WHEN kind = 'devengo' THEN amountCents
                           WHEN kind = 'reverso' AND amountCents < 0 THEN amountCents END),0)
           AS earnedCents,
         COALESCE(-SUM(CASE WHEN kind IN ('pago','anticipo') THEN amountCents
                            WHEN kind = 'reverso' AND amountCents > 0 THEN amountCents END),0)
           AS paidCents,
         COALESCE(-SUM(CASE WHEN kind = 'deduccion' THEN amountCents END),0) AS deductedCents,
         COALESCE(SUM(amountCents),0) AS balanceCents,
         MAX(date) AS lastMovementAt
    FROM ledger WHERE personId = ?
`;

/**
 * What was actually handed over against ONE settlement (`movil.md` §9.3).
 *
 * The receipt used to guess, filtering the ledger with
 * `kind = 'pago' AND date >= settlement.periodStart`. `periodStart` is the
 * Monday of the oldest UNSETTLED week, which on a farm running behind is
 * months back, so the receipt swept in money handed over for documents closed
 * long ago and told the worker they had been paid more than they had.
 *
 * Two clauses, and the order matters:
 *
 * 1. `settlementId = s.id` — the payment says which document it is for. Every
 *    payment written from the two settle-and-pay screens now does.
 * 2. The fallback, for the payments already sitting on phones in the field
 *    with a null link. Nothing records what those were for, so a guess is all
 *    there is — but it is narrowed from "after the work started" to "after the
 *    DOCUMENT existed", which is the difference §9.3 is about.
 *
 * A payment carrying another settlement's id is excluded by both clauses,
 * which is the double-count the fix exists to stop.
 */
export const PAID_AGAINST_SQL = `
  SELECT COALESCE(-SUM(l.amountCents), 0) AS cents
    FROM ledger l
    JOIN settlements s ON s.id = ?
   WHERE l.personId = s.personId
     AND l.kind = 'pago'
     AND ( l.settlementId = s.id
        OR ( l.settlementId IS NULL
             AND date(l.date) >= ${DAY_OF("s.createdAt")} ) )
`;

/** Pickups in range that no live settlement has claimed. */
export const PENDING_SQL = `
  SELECT pk.id, pk.weight, pk.week AS week
    FROM pickups_live pk
   WHERE pk.personId = ?
     AND pk.localDay BETWEEN date(?) AND date(?)
     AND pk.id NOT IN (SELECT pickupId FROM settlement_items WHERE voidedAt IS NULL)
   ORDER BY pk.date
`;

/**
 * The comparative index: each worker against the mates who worked the same
 * plot the same day. Three things had to be right and none of them were at
 * first — the window matches the other figures, the person is out of their own
 * benchmark, and it averages daily ratios instead of dividing sums, so a day
 * on a heavy plot does not outweigh several on a light one.
 */
export const INDEX_SQL = `
  WITH dw AS (
    SELECT pk.personId, pk.cropId, pk.localDay AS d, SUM(pk.weight) AS kg
      FROM pickups_live pk
     WHERE pk.localDay >= ?
     GROUP BY pk.personId, pk.cropId, d
  ),
  base AS (
    SELECT cropId, d, SUM(kg) AS tot, COUNT(*) AS n FROM dw GROUP BY cropId, d
  )
  SELECT dw.personId,
         AVG(dw.kg / NULLIF((base.tot - dw.kg) / (base.n - 1), 0)) AS irl,
         COUNT(DISTINCT dw.d) AS comparableDays
    FROM dw JOIN base ON base.cropId = dw.cropId AND base.d = dw.d
   WHERE base.n >= 3
   GROUP BY dw.personId
`;

// The review rules. Deliberately simple and explainable: accusing a worker
// with a number nobody can justify out loud destroys the trust the app runs
// on. They are here so tests can prove each one actually fires — the
// extra-zero rule spent several versions algebraically unable to.
//
// ---- The window ---------------------------------------------------------
//
// Every rule takes the same first two parameters and ends with a row cap:
//
//     ?1  raw instant bound   — an ISO instant, for the pickups(date) index
//     ?2  local day bound     — YYYY-MM-DD, the predicate that actually decides
//     ?n  LIMIT
//
// They are not redundant. `date(col,'localtime') >= date(?)` is the correct
// test, but no index can serve a call on the column, so on its own every rule
// still read every row the farm had ever weighed. `col >= ?` on the raw stored
// instant is sargable; it is set a day earlier than the local bound so it can
// never exclude a row the exact test would have kept, whatever offset the phone
// is on. See `windowBounds` in `data/sqliteRepository.ts`.
//
// What the window changes: a mis-weighing older than the window stops being
// reported. What it deliberately does NOT change is any reference value — the
// extra-zero rule still measures a load against this person's whole history,
// and the crew rule still compares a whole plot-day. The window decides what is
// worth showing, never what normal looks like.

export const RULE_IMPOSSIBLE_SQL = `SELECT pk.id AS pickupId, pk.personId, pk.weight, pk.date,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS person,
              COALESCE(cr.name,'?') AS crop
         FROM pickups_live pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE pk.date >= ? AND pk.localDay >= date(?)
          AND (pk.weight <= 0 OR pk.weight > ?)
        ORDER BY pk.date DESC LIMIT ?`;

export const RULE_DUPLICATE_SQL = `SELECT a.id AS pickupId, a.personId, a.weight, a.date,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS person,
              COALESCE(cr.name,'?') AS crop
         FROM pickups_live a
         JOIN pickups_live b ON b.personId = a.personId AND b.cropId = a.cropId
                       AND b.weight = a.weight AND b.id < a.id
                       AND (julianday(a.createdAt) - julianday(b.createdAt))
                             BETWEEN 0 AND 3.0 / 1440
         LEFT JOIN people pe ON pe.id = a.personId
         LEFT JOIN crops cr ON cr.id = a.cropId
        WHERE a.date >= ? AND a.localDay >= date(?)
        ORDER BY a.date DESC LIMIT ?`;

// `tot` is the same arithmetic the window functions did — the person's total
// and count minus this row — as a plain GROUP BY. The window-function form had
// to sort the whole table into partitions before a single row could be tested,
// which no window on the outer query could avoid.
export const RULE_DIGIT_SQL = `WITH tot AS (
         SELECT personId, SUM(weight) AS s, COUNT(*) AS n
           FROM pickups_live GROUP BY personId
       )
       SELECT pk.id AS pickupId, pk.personId, pk.weight, pk.date,
              (tot.s - pk.weight) / NULLIF(tot.n - 1, 0) AS reference,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS person,
              COALESCE(cr.name,'?') AS crop
         FROM pickups_live pk JOIN tot ON tot.personId = pk.personId
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE pk.date >= ? AND pk.localDay >= date(?)
          AND (tot.s - pk.weight) / NULLIF(tot.n - 1, 0) > 0
          AND pk.weight >= 4 * ((tot.s - pk.weight) / NULLIF(tot.n - 1, 0))
        ORDER BY pk.date DESC LIMIT ?`;

// The window goes on `dayplot`, not on the final SELECT: a plot-day is either
// wholly inside the window or wholly outside it, so `agg` — the mates' total
// and headcount for that day — comes out identical for every day that is kept.
export const RULE_OUTLIER_SQL = `WITH dayplot AS (
         SELECT pk.id, pk.personId, pk.cropId, pk.weight, pk.date,
                pk.localDay AS d
           FROM pickups_live pk
          WHERE pk.date >= ? AND pk.localDay >= date(?)
       ),
       agg AS (
         SELECT cropId, d, SUM(weight) AS tot, COUNT(*) AS n
           FROM dayplot GROUP BY cropId, d
       )
       SELECT dp.id AS pickupId, dp.personId, dp.weight, dp.date,
              (agg.tot - dp.weight) / (agg.n - 1) AS reference,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS person,
              COALESCE(cr.name,'?') AS crop
         FROM dayplot dp
         JOIN agg ON agg.cropId = dp.cropId AND agg.d = dp.d
         LEFT JOIN people pe ON pe.id = dp.personId
         LEFT JOIN crops cr ON cr.id = dp.cropId
        WHERE agg.n >= 5
          AND (agg.tot - dp.weight) / (agg.n - 1) > 0
          AND dp.weight >= 4 * ((agg.tot - dp.weight) / (agg.n - 1))
        ORDER BY dp.date DESC LIMIT ?`;

// A row dated in the future is by definition after the window's start, so the
// bounds cost nothing here and buy the index.
export const RULE_FUTURE_SQL = `SELECT pk.id AS pickupId, pk.personId, pk.weight, pk.date,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS person,
              COALESCE(cr.name,'?') AS crop
         FROM pickups_live pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE pk.date >= ? AND pk.localDay >= date(?)
          AND pk.localDay > ?
        ORDER BY pk.date DESC LIMIT ?`;

// What leaves the phone when the season is exported.

export const EXPORT_PICKUPS_SQL = `SELECT pk.id,
              pk.localDay AS dia,
              pk.week AS semana,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS recolector,
              pe.docId AS documento,
              COALESCE(cr.name,'?') AS lote,
              pk.weight AS peso
         FROM pickups_live pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        ORDER BY pk.date`;

export const EXPORT_LEDGER_SQL = `SELECT l.id, l.date AS fecha,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS recolector,
              l.kind AS tipo,
              l.amountCents / 100.0 AS monto,
              l.method AS forma,
              l.note AS nota,
              l.settlementId AS liquidacion
         FROM ledger l
         LEFT JOIN people pe ON pe.id = l.personId
        ORDER BY l.date, l.id`;

export const EXPORT_BALANCES_SQL = `SELECT pe.id,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS recolector,
              pe.docId AS documento,
              COALESCE(SUM(l.amountCents),0) / 100.0 AS saldo
         FROM people pe LEFT JOIN ledger l ON l.personId = pe.id
        GROUP BY pe.id ORDER BY saldo DESC`;

// The week detail: day by day, who worked, and the person-by-plot grid.

export const WEEK_BY_DAY_SQL = `SELECT localDay AS day, SUM(weight) AS kg,
              COUNT(DISTINCT personId) AS pickers, COUNT(DISTINCT cropId) AS plots
         FROM pickups_live
        WHERE week = ?
        GROUP BY day ORDER BY day`;

export const WEEK_BY_WORKER_SQL = `SELECT pk.personId,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS name,
              SUM(pk.weight) AS kg,
              COUNT(DISTINCT pk.localDay) AS days
         FROM pickups_live pk LEFT JOIN people pe ON pe.id = pk.personId
        WHERE pk.week = ?
        GROUP BY pk.personId ORDER BY kg DESC`;

export const WEEK_GRID_SQL = `SELECT pk.personId,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS name,
              pk.cropId,
              COALESCE(cr.name,'?') AS crop,
              SUM(pk.weight) AS kg
         FROM pickups_live pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE pk.week = ?
        GROUP BY pk.personId, pk.cropId`;

export const WEEK_PLOTS_SQL = `SELECT pk.cropId, COALESCE(cr.name,'?') AS crop, SUM(pk.weight) AS kg
         FROM pickups_live pk LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE pk.week = ?
        GROUP BY pk.cropId ORDER BY kg DESC`;

/** Kilos per worker and day of the week: who came which days, and how much. */
export const WEEK_GRID_DAY_SQL = `
  SELECT pk.personId,
         COALESCE(pe.name || ' ' || pe.lastName,'?') AS name,
         pk.localDay AS day,
         SUM(pk.weight) AS kg
    FROM pickups_live pk
    LEFT JOIN people pe ON pe.id = pk.personId
   WHERE pk.week = ?
   GROUP BY pk.personId, day
`;

// ---- user_version = 6: the identity sync needs -------------------------
//
// Nothing below sends anything. It gives every row that will one day travel a
// name the server can recognise, and it records which rows are waiting. The
// protocol itself is being written separately; what is here is what any
// reasonable protocol needs and nothing that presumes one.
//
// The integer primary keys STAY. They are in every join, every screen and
// every foreign key in this file, and rewriting them would mean rewriting the
// app during a harvest to buy nothing: a local `id` and a global `uuid` can
// coexist, and the mapping between them is one indexed column.

/** A table whose rows travel, and how the migration dates each row. */
export interface SyncedTable {
  /** Table name, and the entity name the outbox and the server use. */
  name: string;
  /**
   * The SQL expression giving the instant this row belongs at, used to seed
   * its UUIDv7. Chronology is the whole point of a v7, so a row backfilled
   * with the migration's clock would be a row whose id lies about when it
   * happened.
   */
  bornAt: string;
}

/**
 * In the order the server should receive them: a parent before the rows that
 * reference it. Two rows written in the same millisecond are separated by this
 * order, so a settlement can never sort after its own lines.
 */
export const SYNCED_TABLES: SyncedTable[] = [
  // The farm's own singleton: one row, no history, nothing to be chronological
  // about. `NULL` tells the backfill to date it at migration time, which puts
  // it after everything the farm has ever recorded — correct, since that is
  // the moment this row acquired an identity worth sending.
  { name: "config", bornAt: "NULL" },
  { name: "people", bornAt: "createdAt" },
  { name: "crops", bornAt: "createdAt" },
  // No timestamp of its own; a weekly price belongs to the Monday it prices.
  { name: "cost_overrides", bornAt: "week" },
  // `date` is when the load was weighed, `createdAt` when the phone stored it.
  // The weighing is the event the farm and the server care about.
  { name: "pickups", bornAt: "COALESCE(date, createdAt)" },
  { name: "settlements", bornAt: "createdAt" },
  // A line is born with its document.
  {
    name: "settlement_items",
    bornAt:
      "(SELECT s.createdAt FROM settlements s WHERE s.id = settlement_items.settlementId)",
  },
  // Append-only, and `date` can be back-dated by a correction, so the order
  // the rows were written is the order that actually happened.
  { name: "ledger", bornAt: "COALESCE(createdAt, date)" },
];

/** The two columns every travelling row grows, plus the farm's own identity. */
export const SYNC_COLUMNS: Record<string, string[]> = {
  ...Object.fromEntries(
    SYNCED_TABLES.map((t) => [t.name, ["uuid TEXT", "updatedAt TEXT"]]),
  ),
  // `farmId` lives here and only here. See `docs/diagramas/movil.md` and the
  // note on `SyncRepo` in `data/repository.ts`: one phone is one farm, the
  // value is unknown until the farm is registered on the server, and putting
  // it on every row would mean rewriting eighteen thousand of them at exactly
  // the moment the owner is trying to sign up.
  config: [
    "uuid TEXT",
    "updatedAt TEXT",
    "farmId TEXT",
    "deviceId TEXT",
    "syncedAt TEXT",
  ],
};

/**
 * The outbox: what this phone still owes the server.
 *
 * Why a queue and not a `WHERE updatedAt > lastSync` watermark:
 *
 * 1. `pickups.remove` is a hard DELETE. Once the row is gone there is no
 *    `updatedAt` left to compare, so a watermark can never tell the server
 *    about it — and the server would keep charging the farm for a weighing
 *    that was cancelled. The `delete` row below is the only surviving trace.
 * 2. A watermark trusts the device clock, and `docs/sync-and-roles.md` says
 *    plainly that these clocks drift and are set by hand. One backwards jump
 *    and a watermark skips every row written in the gap, permanently and
 *    silently. `seq` is an integer this device controls.
 * 3. Retry. A push that dies halfway has to be safe to repeat: a queued row is
 *    dropped only once the server has said it has it, which no watermark can
 *    do atomically across a network.
 *
 * One row per changed entity, not one per change: `UNIQUE(entity, entityUuid)`
 * coalesces, so correcting the same weighing forty times still owes the server
 * one row. The seq of the FIRST change is kept, which is what keeps a pickup
 * ahead of the settlement that claims it; `revision` counts the coalesces so
 * an ack cannot drop a change made after the push was assembled.
 *
 * There is no payload column. Push reads the row live by uuid, so the queue
 * carries "this changed", not a snapshot that could be stale before it is sent.
 */
export const OUTBOX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS outbox (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    entity     TEXT    NOT NULL,
    entityUuid TEXT    NOT NULL,
    op         TEXT    NOT NULL CHECK (op IN ('upsert','delete')),
    localId    INTEGER,
    revision   INTEGER NOT NULL DEFAULT 1,
    queuedAt   TEXT    NOT NULL,
    UNIQUE (entity, entityUuid)
  );
  CREATE INDEX IF NOT EXISTS ix_outbox_seq ON outbox(seq);
`;

/**
 * The triggers that fill it.
 *
 * Deliberately in SQL rather than in the eighteen writers of
 * `sqliteRepository.ts`. A writer that forgets to queue its row is a row that
 * never reaches the server and that nothing ever complains about; a trigger
 * cannot be forgotten, and it also covers `demo.seed`, `wipe` and whatever the
 * next sprint adds. The uuid still has to be minted in TypeScript — SQLite has
 * no way to generate a v7, and a BEFORE trigger cannot write to NEW.
 *
 * `queuedAt` copies the row's own `updatedAt` instead of calling `now`, so the
 * queue obeys the repository's injected clock and the tests stay deterministic.
 * The COALESCE is there only so a row that somehow arrived without one still
 * gets queued rather than taking the write down with it.
 */
export function outboxTriggersSql(tables: SyncedTable[] = SYNCED_TABLES): string {
  const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const enqueue = (entity: string, row: "NEW" | "OLD", op: "upsert" | "delete") => `
    INSERT INTO outbox (entity, entityUuid, op, localId, queuedAt)
    VALUES ('${entity}', ${row}.uuid, '${op}',
            ${op === "delete" ? "NULL" : `${row}.id`},
            COALESCE(${row}.updatedAt, ${stamp}))
    ON CONFLICT(entity, entityUuid) DO UPDATE SET
      op = excluded.op, localId = excluded.localId,
      queuedAt = excluded.queuedAt, revision = outbox.revision + 1;`;

  // A row the phone is WRITING BECAUSE THE SERVER SENT IT is not a row the
  // phone owes the server. Without this guard every pull re-queues everything
  // it just applied, the next push sends it all straight back, that push
  // changes rows on the server, and the farm has a loop that never empties an
  // outbox and never stops using data. The engine holds `sync_apply` open for
  // exactly the length of one apply transaction.
  const notApplying = "NOT EXISTS (SELECT 1 FROM sync_apply)";

  return tables
    .map(
      (t) => `
  DROP TRIGGER IF EXISTS tg_${t.name}_out_ins;
  CREATE TRIGGER tg_${t.name}_out_ins AFTER INSERT ON ${t.name}
  FOR EACH ROW WHEN NEW.uuid IS NOT NULL AND ${notApplying}
  BEGIN${enqueue(t.name, "NEW", "upsert")}
  END;

  DROP TRIGGER IF EXISTS tg_${t.name}_out_upd;
  CREATE TRIGGER tg_${t.name}_out_upd AFTER UPDATE ON ${t.name}
  FOR EACH ROW WHEN NEW.uuid IS NOT NULL AND ${notApplying}
  BEGIN${enqueue(t.name, "NEW", "upsert")}
  END;

  DROP TRIGGER IF EXISTS tg_${t.name}_out_del;
  CREATE TRIGGER tg_${t.name}_out_del AFTER DELETE ON ${t.name}
  FOR EACH ROW WHEN OLD.uuid IS NOT NULL AND ${notApplying}
  BEGIN${enqueue(t.name, "OLD", "delete")}
  END;`,
    )
    .join("\n");
}

/**
 * The flag the triggers above read.
 *
 * A table rather than a PRAGMA or a connection variable because a SQLite
 * trigger can only see the database. One row means "the write happening right
 * now came down the wire"; no rows means it came from a person, and a person's
 * write is owed to the server.
 *
 * It is emptied in the same transaction that fills it, so a crash mid-apply
 * cannot leave the phone permanently unable to queue anything — the rollback
 * takes the flag with it.
 */
export const SYNC_APPLY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sync_apply (id INTEGER PRIMARY KEY CHECK (id = 1));
  DELETE FROM sync_apply;
`;

/**
 * One unique index per table, so a uuid cannot be duplicated locally, plus the
 * seek the server's `WHERE uuid > ?` pagination will want. Partial, because
 * during the backfill and for any row an old writer misses the column is NULL,
 * and SQLite lets NULLs repeat in a unique index.
 */
export function uuidIndexesSql(tables: SyncedTable[] = SYNCED_TABLES): string {
  return tables
    .map(
      (t) => `CREATE UNIQUE INDEX IF NOT EXISTS ux_${t.name}_uuid
                ON ${t.name}(uuid) WHERE uuid IS NOT NULL;`,
    )
    .join("\n");
}

/**
 * Everything still owed, oldest change first. `localId` is how push reads the
 * row back; for a delete there is nothing left to read, which is the point.
 */
export const OUTBOX_PENDING_SQL = `
  SELECT seq, entity, entityUuid, op, localId, revision, queuedAt
    FROM outbox ORDER BY seq LIMIT ?
`;

/**
 * The initial fill: at `user_version = 6` the server has none of this farm's
 * history, so every existing row is owed. One statement rather than eighteen
 * thousand trigger firings, ordered by uuid so `seq` comes out in the same
 * chronological order the ids do.
 */
export function outboxSeedSql(tables: SyncedTable[] = SYNCED_TABLES): string {
  const union = tables
    .map((t) => `SELECT '${t.name}' AS entity, uuid, id FROM ${t.name} WHERE uuid IS NOT NULL`)
    .join("\n      UNION ALL ");
  // OR IGNORE, not because the seed is expected to meet an existing queue —
  // it runs once, inside the migration — but because `UNIQUE(entity,uuid)` is
  // the only thing standing between a retry and a duplicate push, and a seed
  // that would rather throw than notice it is a seed that turns a recoverable
  // rerun into an app that will not start.
  return `
    INSERT OR IGNORE INTO outbox (entity, entityUuid, op, localId, queuedAt)
    SELECT entity, uuid, 'upsert', id, ?
      FROM (${union})
     ORDER BY uuid`;
}

// ---- user_version = 7: the three things the architect blocked on ---------
//
// (a) `pickups.remove` was a physical DELETE. A row deleted after being pushed
//     comes straight back on the next pull, because the server still has it
//     and the phone no longer knows it killed it. `deletedAt` plus the view
//     below is the same discipline `people` and `crops` already had.
// (b) The day and the week came from `date(col,'localtime')` — the HANDSET's
//     zone. The server derives them from `farms.timezone`. One notch out and a
//     Sunday-evening weighing lands in the week after the one being paid, at a
//     different price, in a different settlement. Golden case 04.
// (c) The price was `REAL`. Pulling `price_minor bigint` from the server into
//     a float puts a float in the path of money.

/** Columns `user_version = 7` adds, by table. Nothing is rewritten. */
export const V7_COLUMNS: Record<string, string[]> = {
  // The tombstone, and the two business dates the farm's zone decides.
  pickups: ["deletedAt TEXT", "localDay TEXT", "week TEXT"],
  // The ledger's business day, materialised for the same reason.
  ledger: ["localDay TEXT"],
  // Money as integers. The REAL column stays for the screens that still read
  // it for display; no path that decides an amount touches it any more.
  config: ["costPerUnitCents INTEGER", "timezone TEXT"],
  cost_overrides: ["costPerUnitCents INTEGER"],
  // Decision 8: a worker who was off the books and turns up with new work is
  // reactivated automatically — and the reactivation is recorded, because
  // undoing somebody's decision in silence is the one thing that cannot happen.
  people: ["reactivatedAt TEXT"],
};

/**
 * Every read of `pickups` goes through this view, and every write goes to the
 * table. That is the point: `AND deletedAt IS NULL` on forty queries is forty
 * chances to forget, and the query somebody adds next sprint would silently
 * pay for a cancelled weighing. Here the predicate is written once.
 *
 * SQLite flattens a view like this into the outer query, so the indexes below
 * are used exactly as they were before.
 */
export const PICKUPS_LIVE_VIEW = `
  CREATE VIEW IF NOT EXISTS pickups_live AS
    SELECT * FROM pickups WHERE deletedAt IS NULL;
`;

/**
 * The indexes the materialised columns earn. Grouping by a stored column
 * instead of calling `date()` on every row makes the week screens sargable for
 * the first time — they used to scan the whole table to answer "this week".
 */
export const V7_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS ix_pickups_week ON pickups(week);
  CREATE INDEX IF NOT EXISTS ix_pickups_localday ON pickups(localDay);
  CREATE INDEX IF NOT EXISTS ix_ledger_localday ON ledger(localDay);
`;

/**
 * What the phone knows about syncing, as one row.
 *
 * `cursor` is the single number of §3: everything the server holds with a
 * higher sequence is what this phone still has to receive. It is TEXT rather
 * than INTEGER because the transport that exists today has no server-assigned
 * sequence to give (see `sync/restTransport.ts`), and a cursor that is an
 * opaque token the client never interprets is the one shape that survives both
 * that transport and the feed it will be replaced by.
 *
 * `pulledAt` is when a pull last COMPLETED — `more:false`, everything applied.
 * §6.1 makes it a precondition of settling, so it must mean "up to date", not
 * "we tried".
 */
export const SYNC_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sync_state (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    cursor    TEXT,
    pulledAt  TEXT,
    pushedAt  TEXT,
    -- The last thing that went wrong, kept so the status screen can say what
    -- is happening instead of showing a spinner that never resolves.
    lastError TEXT,
    -- When the backoff allows the next attempt. §4.3: 2s, 4s, 8s … 15 min.
    retryAt   TEXT,
    attempts  INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO sync_state (id, attempts) VALUES (1, 0);
`;

/**
 * The conflicts of §5 that a person has to close.
 *
 * Nothing here auto-resolves and nothing disappears on its own: a row leaves
 * this table because somebody pressed something, and `resolution` records what
 * they pressed. `payload` carries the three things §7.3 demands every card
 * shows — a person, a date, and an amount or a quantity — composed at the
 * moment the conflict was detected, because by the time anybody reads the card
 * the rows behind it may have moved on.
 *
 * `UNIQUE(kind, entity, entityUuid)` so a push retried nine times raises one
 * card, not nine.
 */
export const CONFLICTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS conflicts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    entity      TEXT NOT NULL,
    entityUuid  TEXT NOT NULL,
    personId    INTEGER,
    payload     TEXT NOT NULL,
    detectedAt  TEXT NOT NULL,
    resolvedAt  TEXT,
    resolution  TEXT,
    UNIQUE (kind, entity, entityUuid)
  );
  CREATE INDEX IF NOT EXISTS ix_conflicts_open
    ON conflicts(detectedAt) WHERE resolvedAt IS NULL;
`;

/**
 * Decision 8, and the condition the owner attached to it.
 *
 * The owner overruled the team: a worker who was taken off the books and shows
 * up with new work is put back on automatically. The team's objection was that
 * somebody decided that removal. So the reactivation is a row here, with the
 * labour that caused it and the device that recorded it, and the person who
 * signed the removal can see it was undone and by what.
 */
export const REACTIVATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS reactivations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    personId   INTEGER NOT NULL,
    personUuid TEXT,
    -- The weighing whose arrival did it. This is the "qué labor la provocó".
    causeEntity TEXT NOT NULL,
    causeUuid   TEXT NOT NULL,
    deviceId   TEXT,
    deletedAt  TEXT,
    at         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_reactivations_person ON reactivations(personId, at DESC);
`;
