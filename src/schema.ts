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
