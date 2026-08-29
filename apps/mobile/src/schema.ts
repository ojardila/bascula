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
      createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cropType TEXT, label TEXT, unit TEXT, yieldUnit TEXT, costPerUnit REAL
    );
    CREATE TABLE IF NOT EXISTS cost_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week TEXT UNIQUE, costPerUnit REAL
    );
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

/** Pickups in range that no live settlement has claimed. */
export const PENDING_SQL = `
  SELECT pk.id, pk.weight, ${WEEK_OF("pk.date")} AS week
    FROM pickups pk
   WHERE pk.personId = ?
     AND ${DAY_OF("pk.date")} BETWEEN date(?) AND date(?)
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
    SELECT pk.personId, pk.cropId, ${DAY_OF("pk.date")} AS d, SUM(pk.weight) AS kg
      FROM pickups pk
     WHERE ${DAY_OF("pk.date")} >= date('now','localtime',?)
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
         FROM pickups pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE pk.date >= ? AND date(pk.date,'localtime') >= date(?)
          AND (pk.weight <= 0 OR pk.weight > ?)
        ORDER BY pk.date DESC LIMIT ?`;

export const RULE_DUPLICATE_SQL = `SELECT a.id AS pickupId, a.personId, a.weight, a.date,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS person,
              COALESCE(cr.name,'?') AS crop
         FROM pickups a
         JOIN pickups b ON b.personId = a.personId AND b.cropId = a.cropId
                       AND b.weight = a.weight AND b.id < a.id
                       AND (julianday(a.createdAt) - julianday(b.createdAt))
                             BETWEEN 0 AND 3.0 / 1440
         LEFT JOIN people pe ON pe.id = a.personId
         LEFT JOIN crops cr ON cr.id = a.cropId
        WHERE a.date >= ? AND date(a.date,'localtime') >= date(?)
        ORDER BY a.date DESC LIMIT ?`;

// `tot` is the same arithmetic the window functions did — the person's total
// and count minus this row — as a plain GROUP BY. The window-function form had
// to sort the whole table into partitions before a single row could be tested,
// which no window on the outer query could avoid.
export const RULE_DIGIT_SQL = `WITH tot AS (
         SELECT personId, SUM(weight) AS s, COUNT(*) AS n
           FROM pickups GROUP BY personId
       )
       SELECT pk.id AS pickupId, pk.personId, pk.weight, pk.date,
              (tot.s - pk.weight) / NULLIF(tot.n - 1, 0) AS reference,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS person,
              COALESCE(cr.name,'?') AS crop
         FROM pickups pk JOIN tot ON tot.personId = pk.personId
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE pk.date >= ? AND date(pk.date,'localtime') >= date(?)
          AND (tot.s - pk.weight) / NULLIF(tot.n - 1, 0) > 0
          AND pk.weight >= 4 * ((tot.s - pk.weight) / NULLIF(tot.n - 1, 0))
        ORDER BY pk.date DESC LIMIT ?`;

// The window goes on `dayplot`, not on the final SELECT: a plot-day is either
// wholly inside the window or wholly outside it, so `agg` — the mates' total
// and headcount for that day — comes out identical for every day that is kept.
export const RULE_OUTLIER_SQL = `WITH dayplot AS (
         SELECT pk.id, pk.personId, pk.cropId, pk.weight, pk.date,
                date(pk.date,'localtime') AS d
           FROM pickups pk
          WHERE pk.date >= ? AND date(pk.date,'localtime') >= date(?)
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
         FROM pickups pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE pk.date >= ? AND date(pk.date,'localtime') >= date(?)
          AND date(pk.date,'localtime') > date('now','localtime')
        ORDER BY pk.date DESC LIMIT ?`;

// What leaves the phone when the season is exported.

export const EXPORT_PICKUPS_SQL = `SELECT pk.id,
              date(pk.date,'localtime') AS dia,
              date(pk.date,'localtime','-6 days','weekday 1') AS semana,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS recolector,
              pe.docId AS documento,
              COALESCE(cr.name,'?') AS lote,
              pk.weight AS peso
         FROM pickups pk
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

export const WEEK_BY_DAY_SQL = `SELECT date(date,'localtime') AS day, SUM(weight) AS kg,
              COUNT(DISTINCT personId) AS pickers, COUNT(DISTINCT cropId) AS plots
         FROM pickups
        WHERE date(date,'localtime','-6 days','weekday 1') = ?
        GROUP BY day ORDER BY day`;

export const WEEK_BY_WORKER_SQL = `SELECT pk.personId,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS name,
              SUM(pk.weight) AS kg,
              COUNT(DISTINCT date(pk.date,'localtime')) AS days
         FROM pickups pk LEFT JOIN people pe ON pe.id = pk.personId
        WHERE date(pk.date,'localtime','-6 days','weekday 1') = ?
        GROUP BY pk.personId ORDER BY kg DESC`;

export const WEEK_GRID_SQL = `SELECT pk.personId,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS name,
              pk.cropId,
              COALESCE(cr.name,'?') AS crop,
              SUM(pk.weight) AS kg
         FROM pickups pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE date(pk.date,'localtime','-6 days','weekday 1') = ?
        GROUP BY pk.personId, pk.cropId`;

export const WEEK_PLOTS_SQL = `SELECT pk.cropId, COALESCE(cr.name,'?') AS crop, SUM(pk.weight) AS kg
         FROM pickups pk LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE date(pk.date,'localtime','-6 days','weekday 1') = ?
        GROUP BY pk.cropId ORDER BY kg DESC`;

/** Kilos per worker and day of the week: who came which days, and how much. */
export const WEEK_GRID_DAY_SQL = `
  SELECT pk.personId,
         COALESCE(pe.name || ' ' || pe.lastName,'?') AS name,
         date(pk.date,'localtime') AS day,
         SUM(pk.weight) AS kg
    FROM pickups pk
    LEFT JOIN people pe ON pe.id = pk.personId
   WHERE date(pk.date,'localtime','-6 days','weekday 1') = ?
   GROUP BY pk.personId, day
`;
