import * as SQLite from "expo-sqlite";

export interface Person {
  id: number;
  name: string;
  lastName: string;
  documentType: string;
  docId: string;
  tag: string;
  image: string;
  createdAt: string;
  deletedAt?: string | null;
}
export interface Crop {
  id: number;
  name: string;
  type: string;
  variety: string;
  dimension: number;
  createdAt: string;
}
export interface Pickup {
  id: number;
  personId: number;
  cropId: number;
  weight: number;
  date: string;
  createdAt: string;
}

const db = SQLite.openDatabaseSync("bascula.db");

export function initDb() {
  db.execSync(`
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
  `);
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
  );
}

// ---- Schema migrations -------------------------------------------------
//
// The week key used to be a strftime week-of-year label ("2026-W34"), which
// splits a week straddling new year into two labels and can't be rendered as a
// date range. It is now the Monday of the week, as YYYY-MM-DD.

const SCHEMA_VERSION = 2;

const PAYMENTS_SCHEMA = `
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
    amountCents      INTEGER NOT NULL
  );
  -- The anti double-count lock: a pickup can belong to one settlement, ever.
  CREATE UNIQUE INDEX IF NOT EXISTS ux_items_pickup ON settlement_items(pickupId);
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

// Monday of the "%Y-Www" week that strftime('%W') would have produced:
// week 01 starts on the year's first Monday, and earlier days fall in week 00.
function mondayOfLegacyWeek(label: string): string | null {
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

function migrate() {
  const v =
    db.getFirstSync<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;

  if (v < 2) {
    db.execSync(PAYMENTS_SCHEMA);
    db.withTransactionSync(() => {
      // Re-key existing weekly cost overrides onto the Monday-based key.
      // Two legacy labels can map to the same Monday — a week straddling new
      // year was stored as both "2025-W52" and "2026-W00" — and `week` is
      // UNIQUE, so a blind UPDATE throws, the version never advances, and the
      // app fails to start on every launch from then on.
      const legacy = db.getAllSync<{ id: number; week: string }>(
        "SELECT id, week FROM cost_overrides WHERE week LIKE '%-W%'",
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
        if (clash) db.runSync("DELETE FROM cost_overrides WHERE id = ?", [o.id]);
        else db.runSync("UPDATE cost_overrides SET week = ? WHERE id = ?", [monday, o.id]);
      }
      db.execSync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }
}

const now = () => new Date().toISOString();
// Local calendar day, not the UTC one: every query now groups by local day,
// and a payment made on Sunday evening in Bogota would otherwise be stamped
// with tomorrow's date and shown as a movement dated in the future.
const today = () => {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};


export const People = {
  // Active workers only (soft-deleted ones stay in the table for history).
  all: () =>
    db.getAllSync<Person>(
      "SELECT * FROM people WHERE deletedAt IS NULL ORDER BY name, lastName",
    ),
  byId: (id: number) => db.getFirstSync<Person>("SELECT * FROM people WHERE id = ?", [id]),
  byTag: (tag: string) =>
    db.getFirstSync<Person>("SELECT * FROM people WHERE tag = ? AND deletedAt IS NULL", [tag]),
  add: (p: Omit<Person, "id" | "createdAt">) =>
    db.runSync(
      "INSERT INTO people (name,lastName,documentType,docId,tag,image,createdAt) VALUES (?,?,?,?,?,?,?)",
      [p.name, p.lastName, p.documentType, p.docId, p.tag, p.image, now()],
    ),
  // Soft delete: hide the worker but keep their pickups intact.
  remove: (id: number) =>
    db.runSync("UPDATE people SET deletedAt = ? WHERE id = ?", [now(), id]),
};

export const Crops = {
  all: () => db.getAllSync<Crop>("SELECT * FROM crops ORDER BY name"),
  add: (c: Omit<Crop, "id" | "createdAt">) =>
    db.runSync(
      "INSERT INTO crops (name,type,variety,dimension,createdAt) VALUES (?,?,?,?,?)",
      [c.name, c.type, c.variety, c.dimension, now()],
    ),
  remove: (id: number) => db.runSync("DELETE FROM crops WHERE id = ?", [id]),
};

export const Pickups = {
  add: (p: Omit<Pickup, "id" | "createdAt">) =>
    db.runSync(
      "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?)",
      [p.personId, p.cropId, p.weight, p.date, now()],
    ),
  recent: () =>
    db.getAllSync<{
      id: number;
      weight: number;
      date: string;
      person: string;
      crop: string;
    }>(
      `SELECT pk.id, pk.weight, pk.date,
              COALESCE(pe.name || ' ' || pe.lastName, 'Unknown') AS person,
              COALESCE(cr.name, 'Unknown') AS crop
       FROM pickups pk
       LEFT JOIN people pe ON pe.id = pk.personId
       LEFT JOIN crops cr ON cr.id = pk.cropId
       ORDER BY pk.date DESC LIMIT 50`,
    ),
};

export const Reports = {
  totals: () =>
    db.getFirstSync<{ pickups: number; kg: number; people: number; crops: number }>(
      `SELECT
         (SELECT COUNT(*) FROM pickups) AS pickups,
         (SELECT COALESCE(SUM(weight),0) FROM pickups) AS kg,
         (SELECT COUNT(*) FROM people) AS people,
         (SELECT COUNT(*) FROM crops) AS crops`,
    ),
  today: () =>
    db.getFirstSync<{ kg: number; count: number }>(
      `SELECT COALESCE(SUM(weight),0) AS kg, COUNT(*) AS count
       FROM pickups WHERE date(date,'localtime') = date('now','localtime')`,
    ),
  thisWeek: () =>
    db.getFirstSync<{ kg: number; count: number }>(
      `SELECT COALESCE(SUM(weight),0) AS kg, COUNT(*) AS count
       FROM pickups WHERE date(date,'localtime','-6 days','weekday 1') = date('now','localtime','-6 days','weekday 1')`,
    ),
  byWeek: () =>
    db.getAllSync<{ label: string; kg: number }>(
      `SELECT date(date,'localtime','-6 days','weekday 1') AS label, SUM(weight) AS kg
       FROM pickups GROUP BY label ORDER BY label DESC LIMIT 12`,
    ),
  byWorker: () =>
    db.getAllSync<{ label: string; kg: number; id: number }>(
      `SELECT COALESCE(pe.name || ' ' || pe.lastName, 'Unknown') AS label,
              SUM(pk.weight) AS kg, pk.personId AS id
       FROM pickups pk LEFT JOIN people pe ON pe.id = pk.personId
       GROUP BY pk.personId ORDER BY kg DESC`,
    ),
  byCrop: () =>
    db.getAllSync<{ label: string; kg: number }>(
      `SELECT COALESCE(cr.name, 'Unknown') AS label, SUM(pk.weight) AS kg
       FROM pickups pk LEFT JOIN crops cr ON cr.id = pk.cropId
       GROUP BY pk.cropId ORDER BY kg DESC`,
    ),
};

// Which crops (lotes) were harvested each week — powers the weekly breakdown.
export const weekCrops = () =>
  db.getAllSync<{ week: string; crop: string; kg: number }>(
    `SELECT date(pk.date,'localtime','-6 days','weekday 1') AS week,
            COALESCE(cr.name, 'Unknown') AS crop, SUM(pk.weight) AS kg
     FROM pickups pk LEFT JOIN crops cr ON cr.id = pk.cropId
     GROUP BY week, pk.cropId ORDER BY week DESC, kg DESC`,
  );

// ---- Per-worker performance -------------------------------------------

export const WorkerReports = {
  stats: (personId: number) =>
    db.getFirstSync<{ kg: number; pickups: number; firstDate: string; lastDate: string }>(
      `SELECT COALESCE(SUM(weight),0) AS kg, COUNT(*) AS pickups,
              MIN(date) AS firstDate, MAX(date) AS lastDate
       FROM pickups WHERE personId = ?`,
      [personId],
    ),
  byWeek: (personId: number) =>
    db.getAllSync<{ label: string; kg: number }>(
      `SELECT date(date,'localtime','-6 days','weekday 1') AS label, SUM(weight) AS kg
       FROM pickups WHERE personId = ? GROUP BY label ORDER BY label DESC LIMIT 12`,
      [personId],
    ),
  byCrop: (personId: number) =>
    db.getAllSync<{ label: string; kg: number }>(
      `SELECT COALESCE(cr.name, 'Unknown') AS label, SUM(pk.weight) AS kg
       FROM pickups pk LEFT JOIN crops cr ON cr.id = pk.cropId
       WHERE pk.personId = ? GROUP BY pk.cropId ORDER BY kg DESC`,
      [personId],
    ),
  recent: (personId: number) =>
    db.getAllSync<{ id: number; weight: number; date: string; crop: string }>(
      `SELECT pk.id, pk.weight, pk.date, COALESCE(cr.name, 'Unknown') AS crop
       FROM pickups pk LEFT JOIN crops cr ON cr.id = pk.cropId
       WHERE pk.personId = ? ORDER BY pk.date DESC LIMIT 50`,
      [personId],
    ),
  // Payout for this worker applying weekly cost overrides.
  payout: (personId: number, general: number) => {
    const rows = db.getAllSync<{ week: string; kg: number }>(
      `SELECT date(date,'localtime','-6 days','weekday 1') AS week, SUM(weight) AS kg
       FROM pickups WHERE personId = ? GROUP BY week`,
      [personId],
    );
    return rows.reduce((s, r) => s + r.kg * costForWeek(r.week, general), 0);
  },
};

export type Grouping = "week" | "worker" | "crop";
export function reportBy(g: Grouping) {
  return g === "week" ? Reports.byWeek() : g === "worker" ? Reports.byWorker() : Reports.byCrop();
}

// ---- Crop configuration (units + costs) --------------------------------

export interface CropConfig {
  cropType: string;
  label: string;
  unit: string; // "kg", "racimo", ...
  yieldUnit: string; // "kg por recolector"
  costPerUnit: number; // general cost per unit
}

export const Config = {
  get: () =>
    db.getFirstSync<CropConfig>(
      "SELECT cropType, label, unit, yieldUnit, costPerUnit FROM config WHERE id = 1",
    ),
  save: (c: CropConfig) =>
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

export type AppLang = "es" | "en" | "pt";

export const Prefs = {
  getLang: (): AppLang => {
    const r = db.getFirstSync<{ language: string | null }>(
      "SELECT language FROM config WHERE id = 1",
    );
    return r?.language === "en" ? "en" : r?.language === "pt" ? "pt" : "es";
  },
  setLang: (l: AppLang) =>
    db.runSync(
      `INSERT INTO config (id, language) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET language = excluded.language`,
      [l],
    ),
};

export interface CostOverride {
  id: number;
  week: string; // matches the byWeek() label, e.g. "2026-W33"
  costPerUnit: number;
}

export const Overrides = {
  all: () =>
    db.getAllSync<CostOverride>(
      "SELECT id, week, costPerUnit FROM cost_overrides ORDER BY week DESC",
    ),
  set: (week: string, costPerUnit: number) =>
    db.runSync(
      `INSERT INTO cost_overrides (week, costPerUnit) VALUES (?, ?)
       ON CONFLICT(week) DO UPDATE SET costPerUnit = excluded.costPerUnit`,
      [week, costPerUnit],
    ),
  remove: (id: number) => db.runSync("DELETE FROM cost_overrides WHERE id = ?", [id]),
};

// Effective cost per unit for a given week label: the weekly override if one
// exists, otherwise the general cost from the active config.
export function costForWeek(week: string, general: number): number {
  const o = db.getFirstSync<{ costPerUnit: number }>(
    "SELECT costPerUnit FROM cost_overrides WHERE week = ?",
    [week],
  );
  return o ? o.costPerUnit : general;
}

// ---- Demo data ---------------------------------------------------------

export const Demo = {
  clear: () => {
    // Children first: foreign_keys is ON, so deleting people while the ledger
    // still references them fails and takes the screen down with it.
    db.withTransactionSync(() => {
      db.execSync(
        `DELETE FROM ledger; DELETE FROM settlement_items; DELETE FROM settlements;
         DELETE FROM pickups; DELETE FROM crops; DELETE FROM people;
         DELETE FROM cost_overrides;`,
      );
    });
  },
  seed: () => {
    Demo.clear();

    const people: [string, string][] = [
      ["María", "Gómez"],
      ["Juan", "Pérez"],
      ["Ana", "Rodríguez"],
      ["Carlos", "Muñoz"],
      ["Luisa", "Torres"],
      ["Pedro", "Ramírez"],
    ];
    const pids: number[] = [];
    people.forEach(([name, lastName], i) => {
      const r = db.runSync(
        "INSERT INTO people (name,lastName,documentType,docId,tag,image,createdAt) VALUES (?,?,?,?,?,?,?)",
        [name, lastName, "CC", String(1000000000 + i * 137), "T" + (i + 1), "", now()],
      );
      pids.push(r.lastInsertRowId as number);
    });

    const crops: [string, string, string, number][] = [
      ["Café lote 1", "Café", "Castillo", 2.5],
      ["Café lote 2", "Café", "Caturra", 1.8],
      ["Cacao norte", "Cacao", "CCN-51", 1.2],
    ];
    const cids: number[] = [];
    crops.forEach(([name, type, variety, dim]) => {
      const r = db.runSync(
        "INSERT INTO crops (name,type,variety,dimension,createdAt) VALUES (?,?,?,?,?)",
        [name, type, variety, dim, now()],
      );
      cids.push(r.lastInsertRowId as number);
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
      const plots = [cids[d % cids.length], cids[(d + 1) % cids.length]];
      pids.forEach((pid, idx) => {
        if ((d + idx) % 9 === 0) return; // somebody misses a day now and then
        // Every third day the whole crew works one plot together; otherwise it
        // splits in rotating blocks. Assigning by the parity of the index left
        // two halves that never shared a plot, so they never got a common
        // baseline and the index could not rank them against each other.
        const cid = d % 3 === 0 ? plots[0] : plots[Math.floor((idx + d) / 2) % plots.length];
        const base = 90 + ((d * 3 + idx * 5) % 40); // the plot's day, shared by all
        const loads = 2 + (idx % 2); // two or three weighings each
        for (let k = 0; k < loads; k++) {
          const weight = Math.max(
            4,
            Math.round(((base * skill[idx % skill.length]) / loads) * 10) / 10,
          );
          db.runSync(
            "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?)",
            [pid, cid, weight, iso(8 + k * 3, (idx * 7) % 60), iso(8 + k * 3, (idx * 7) % 60)],
          );
        }
      });
    }

    // A couple of weekly cost overrides to showcase the feature.
    const weeks = db.getAllSync<{ week: string }>(
      "SELECT DISTINCT date(date,'localtime','-6 days','weekday 1') AS week FROM pickups ORDER BY week DESC LIMIT 2",
    );
    if (weeks[0]) Overrides.set(weeks[0].week, 950);
    if (weeks[1]) Overrides.set(weeks[1].week, 880);
  },
};

// Total payout across all pickups, applying weekly overrides where present.
export function totalPayout(general: number): number {
  const rows = db.getAllSync<{ week: string; kg: number }>(
    `SELECT date(date,'localtime','-6 days','weekday 1') AS week, SUM(weight) AS kg
     FROM pickups GROUP BY week`,
  );
  return rows.reduce((sum, r) => sum + r.kg * costForWeek(r.week, general), 0);
}

// ---- Payments: settlements, ledger and balances -------------------------
//
// Money is stored as INTEGER cents; REAL would drift on balances that carry
// over for months. Sign convention on the ledger: a positive amount means the
// farm owes the worker, so a positive balance is the worker's savings.

export type LedgerKind = "devengo" | "pago" | "anticipo" | "deduccion" | "ajuste" | "reverso";
export type PayMethod = "efectivo" | "transferencia" | "otro";

export interface LedgerEntry {
  id: number;
  personId: number;
  kind: LedgerKind;
  amountCents: number;
  date: string;
  settlementId: number | null;
  method: PayMethod | null;
  note: string | null;
  reversesId: number | null;
  createdAt: string;
}

export interface Settlement {
  id: number;
  personId: number;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  status: "open" | "void";
  note: string | null;
  createdAt: string;
  voidedAt: string | null;
}

export interface SettlementItem {
  id: number;
  settlementId: number;
  pickupId: number;
  week: string;
  weight: number;
  costPerUnitCents: number;
  amountCents: number;
}

export interface Balance {
  personId: number;
  earnedCents: number;
  paidCents: number;
  deductedCents: number;
  balanceCents: number;
  lastMovementAt: string | null;
}

export type PendingItem = Omit<SettlementItem, "id" | "settlementId">;

export interface SettlementPreview {
  personId: number;
  periodStart: string;
  periodEnd: string;
  items: PendingItem[];
  grossCents: number;
  pickupCount: number;
  kg: number;
}

export const toCents = (amount: number) => Math.round(amount * 100);
export const fromCents = (cents: number) => cents / 100;

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
    `SELECT pk.id, pk.weight, date(pk.date,'localtime','-6 days','weekday 1') AS week
       FROM pickups pk
      WHERE pk.personId = ?
        AND date(pk.date,'localtime') BETWEEN date(?) AND date(?)
        AND pk.id NOT IN (SELECT pickupId FROM settlement_items)
      ORDER BY pk.date`,
    [personId, from, to],
  );
  const priceOf = new Map<string, number>();
  return rows.map((r) => {
    if (!priceOf.has(r.week)) priceOf.set(r.week, toCents(costForWeek(r.week, general)));
    const costPerUnitCents = priceOf.get(r.week)!;
    return {
      pickupId: r.id,
      week: r.week,
      weight: r.weight,
      costPerUnitCents,
      // Round per line so the printed receipt adds up exactly.
      amountCents: Math.round(r.weight * costPerUnitCents),
    };
  });
}

function requirePositive(cents: number) {
  if (!Number.isFinite(cents) || cents <= 0) throw new Error("El monto debe ser mayor que cero");
}

function addEntry(e: Omit<LedgerEntry, "id" | "createdAt">): number {
  const r = db.runSync(
    `INSERT INTO ledger (personId,kind,amountCents,date,settlementId,method,note,reversesId,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [e.personId, e.kind, e.amountCents, e.date, e.settlementId, e.method, e.note, e.reversesId, now()],
  );
  return r.lastInsertRowId as number;
}

export const Payments = {
  // What would be settled, without writing anything.
  preview: (personId: number, from: string, to: string, general: number): SettlementPreview => {
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

  // Freeze the pending pickups into a settlement document and post the earning.
  // Returns null when there is nothing pending, so we never create a $0 document.
  settle: (
    personId: number,
    from: string,
    to: string,
    general: number,
    note?: string,
  ): { settlementId: number; ledgerId: number; grossCents: number } | null => {
    const items = pendingItems(personId, from, to, general);
    const grossCents = items.reduce((s, i) => s + i.amountCents, 0);
    // A zero gross would violate the ledger's CHECK and crash the payroll for
    // the whole farm; it happens as soon as someone saves a cost of 0.
    if (!items.length || grossCents <= 0) return null;
    let settlementId = 0;
    let ledgerId = 0;
    // The real period is what the items cover, not the open-ended search range,
    // and the earning must not be dated in the future when paying mid-week.
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
      settlementId = s.lastInsertRowId as number;
      for (const i of items) {
        db.runSync(
          `INSERT INTO settlement_items (settlementId,pickupId,week,weight,costPerUnitCents,amountCents)
           VALUES (?,?,?,?,?,?)`,
          [settlementId, i.pickupId, i.week, i.weight, i.costPerUnitCents, i.amountCents],
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
  voidSettlement: (settlementId: number, note?: string): void => {
    const s = db.getFirstSync<Settlement>("SELECT * FROM settlements WHERE id = ?", [settlementId]);
    if (!s || s.status === "void") return;
    db.withTransactionSync(() => {
      db.runSync("DELETE FROM settlement_items WHERE settlementId = ?", [settlementId]);
      db.runSync("UPDATE settlements SET status = 'void', voidedAt = ? WHERE id = ?", [
        now(),
        settlementId,
      ]);
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
    });
  },

  // Cash going out to the worker. Amounts come in positive; the sign is ours.
  pay: (
    personId: number,
    amountCents: number,
    opts: { method?: PayMethod; date?: string; note?: string } = {},
  ): number => {
    requirePositive(amountCents);
    return addEntry({
      personId,
      kind: "pago",
      amountCents: -amountCents,
      date: opts.date ?? today(),
      settlementId: null,
      method: opts.method ?? "efectivo",
      note: opts.note ?? null,
      reversesId: null,
    });
  },

  advance: (personId: number, amountCents: number, note?: string): number => {
    requirePositive(amountCents);
    return addEntry({
      personId,
      kind: "anticipo",
      amountCents: -amountCents,
      date: today(),
      settlementId: null,
      method: "efectivo",
      note: note ?? null,
      reversesId: null,
    });
  },

  deduct: (personId: number, amountCents: number, note: string): number => {
    requirePositive(amountCents);
    return addEntry({
      personId,
      kind: "deduccion",
      amountCents: -amountCents,
      date: today(),
      settlementId: null,
      method: null,
      note,
      reversesId: null,
    });
  },

  // Signed on purpose: an adjustment can go either way.
  adjust: (personId: number, signedCents: number, note: string): number => {
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

  // Ledger rows are never edited or deleted; a mistake is cancelled by its opposite.
  reverse: (ledgerId: number, note: string): number => {
    const e = db.getFirstSync<LedgerEntry>("SELECT * FROM ledger WHERE id = ?", [ledgerId]);
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

  balance: (personId: number): Balance => {
    const r = db.getFirstSync<Balance>(
      `SELECT ? AS personId,
              COALESCE(SUM(CASE WHEN kind = 'devengo' THEN amountCents END),0) AS earnedCents,
              COALESCE(-SUM(CASE WHEN kind IN ('pago','anticipo') THEN amountCents END),0) AS paidCents,
              COALESCE(-SUM(CASE WHEN kind = 'deduccion' THEN amountCents END),0) AS deductedCents,
              COALESCE(SUM(amountCents),0) AS balanceCents,
              MAX(date) AS lastMovementAt
         FROM ledger WHERE personId = ?`,
      [personId, personId],
    );
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
    db.getAllSync<Balance & { name: string; inactive: number }>(
      `SELECT pe.id AS personId,
              COALESCE(pe.name || ' ' || pe.lastName, '?') AS name,
              CASE WHEN pe.deletedAt IS NULL THEN 0 ELSE 1 END AS inactive,
              COALESCE(SUM(CASE WHEN l.kind = 'devengo' THEN l.amountCents END),0) AS earnedCents,
              COALESCE(-SUM(CASE WHEN l.kind IN ('pago','anticipo') THEN l.amountCents END),0) AS paidCents,
              COALESCE(-SUM(CASE WHEN l.kind = 'deduccion' THEN l.amountCents END),0) AS deductedCents,
              COALESCE(SUM(l.amountCents),0) AS balanceCents,
              MAX(l.date) AS lastMovementAt
         FROM people pe LEFT JOIN ledger l ON l.personId = pe.id
        GROUP BY pe.id
        HAVING balanceCents <> 0 OR earnedCents <> 0
        ORDER BY balanceCents DESC`,
    ),

  history: (personId: number, limit = 200): LedgerEntry[] =>
    db.getAllSync<LedgerEntry>(
      `SELECT * FROM ledger WHERE personId = ? ORDER BY date DESC, id DESC LIMIT ?`,
      [personId, limit],
    ),

  settlements: (personId: number): Settlement[] =>
    db.getAllSync<Settlement>(
      "SELECT * FROM settlements WHERE personId = ? ORDER BY createdAt DESC",
      [personId],
    ),

  itemsOf: (settlementId: number): SettlementItem[] =>
    db.getAllSync<SettlementItem>(
      "SELECT * FROM settlement_items WHERE settlementId = ? ORDER BY week DESC, id",
      [settlementId],
    ),

  // Not yet settled, for the whole farm — this is what drives "pay everyone".
  // `upTo` cuts off at the end of the week being paid; anything still unpaid
  // from earlier weeks is included on purpose, because the worker is still owed
  // it and a settlement covers everything outstanding up to that date.
  pendingAll: (general: number, upTo?: string) => {
    const rows = db.getAllSync<{ personId: number; name: string; week: string; weight: number }>(
      `SELECT pk.personId,
              COALESCE(pe.name || ' ' || pe.lastName, '?') AS name,
              date(pk.date,'localtime','-6 days','weekday 1') AS week, SUM(pk.weight) AS weight
         FROM pickups pk
         LEFT JOIN people pe ON pe.id = pk.personId
        WHERE pk.id NOT IN (SELECT pickupId FROM settlement_items)
          AND (? IS NULL OR date(pk.date,'localtime') <= date(?))
        GROUP BY pk.personId, week`,
      [upTo ?? null, upTo ?? null],
    );
    const acc = new Map<number, { personId: number; name: string; kg: number; amountCents: number }>();
    for (const r of rows) {
      const cents = Math.round(r.weight * toCents(costForWeek(r.week, general)));
      const cur = acc.get(r.personId) ?? { personId: r.personId, name: r.name, kg: 0, amountCents: 0 };
      cur.kg += r.weight;
      cur.amountCents += cents;
      acc.set(r.personId, cur);
    }
    return [...acc.values()].sort((a, b) => b.amountCents - a.amountCents);
  },

  farmTotals: () =>
    db.getFirstSync<{ owedCents: number; overpaidCents: number; savedCount: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN b > 0 THEN b END),0) AS owedCents,
         COALESCE(-SUM(CASE WHEN b < 0 THEN b END),0) AS overpaidCents,
         COUNT(CASE WHEN b > 0 THEN 1 END) AS savedCount
       FROM (SELECT SUM(amountCents) AS b FROM ledger GROUP BY personId)`,
    ),
};

// ---- Performance analysis ----------------------------------------------
//
// Ranking pickers by total kg is unfair and actively misleading: whoever
// worked the ripest plot wins. Every comparison here is against the people
// who worked the SAME plot on the SAME day, which is the only fair baseline.

export interface WorkerPerf {
  personId: number;
  name: string;
  kg: number;
  days: number;
  kgPerDay: number;
  /** 1.00 = exactly the crew average on the same plot and day. */
  irl: number | null;
  comparableDays: number;
  /** Ratio of recent IRL to earlier IRL; below 0.85 means they are slipping. */
  trend: number | null;
}

const DAY_KEY = "date(pk.date,'localtime')";
const WEEK_KEY = "date(pk.date,'localtime','-6 days','weekday 1')";

export const Performance = {
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
    }>(
      `WITH dw AS (
         SELECT pk.personId, pk.cropId, ${DAY_KEY} AS d, SUM(pk.weight) AS kg
           FROM pickups pk
          WHERE ${DAY_KEY} >= date('now','localtime',?)
          GROUP BY pk.personId, pk.cropId, d
       ),
       base AS (
         SELECT cropId, d, SUM(kg) AS tot, COUNT(*) AS n FROM dw GROUP BY cropId, d
       )
       SELECT dw.personId,
              AVG(dw.kg / NULLIF((base.tot - dw.kg) / (base.n - 1), 0)) AS irl,
              COUNT(DISTINCT dw.d) AS comparableDays
         FROM dw JOIN base ON base.cropId = dw.cropId AND base.d = dw.d
        WHERE base.n >= 3          -- fewer than three mates is not a comparison
        GROUP BY dw.personId`,
      [`-${sinceDays} days`],
    );
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
            t && t.recent != null && t.earlier && t.recentDays >= 4 && t.earlierDays >= 4
              ? t.recent / t.earlier
              : null,
        };
      })
      .sort((a, b) => (b.irl ?? -1) - (a.irl ?? -1));
  },

  // Yield per hectare is the one agronomic number the schema already holds
  // and nothing uses: it says whether a plot is giving what it should.
  plots: () =>
    db.getAllSync<{
      cropId: number;
      name: string;
      ha: number;
      kg: number;
      kgPerHa: number | null;
      pickers: number;
    }>(
      `SELECT cr.id AS cropId, cr.name, cr.dimension AS ha,
              SUM(pk.weight) AS kg,
              SUM(pk.weight) / NULLIF(cr.dimension,0) AS kgPerHa,
              COUNT(DISTINCT pk.personId) AS pickers
         FROM pickups pk JOIN crops cr ON cr.id = pk.cropId
        GROUP BY cr.id ORDER BY kgPerHa DESC`,
    ),

  // Real cost per unit from the ledger, not weight * price: it includes the
  // price frozen at settlement plus every deduction and adjustment since.
  realCost: (general: number) => {
    const r = db.getFirstSync<{ kg: number; devengoCents: number }>(
      `SELECT COALESCE(SUM(si.weight),0) AS kg, COALESCE(SUM(si.amountCents),0) AS devengoCents
         FROM settlement_items si
         JOIN settlements s ON s.id = si.settlementId AND s.status = 'open'`,
    );
    const adj = db.getFirstSync<{ c: number }>(
      `SELECT COALESCE(SUM(l.amountCents),0) AS c
         FROM ledger l LEFT JOIN settlements s ON s.id = l.settlementId
        WHERE l.kind IN ('ajuste','deduccion')
          AND (l.settlementId IS NULL OR s.status = 'open')`,
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

export interface Anomaly {
  pickupId: number;
  personId: number;
  person: string;
  crop: string;
  date: string;
  weight: number;
  rule: "impossible" | "duplicate" | "digit" | "outlier" | "future";
  reference: number;
}

// Deliberately simple, explainable rules. Accusing a worker with a number you
// cannot justify out loud destroys the trust the whole app runs on, so there
// is no model here — just thresholds anyone can check.
export const Anomalies = {
  all: (maxWeight = 120): Anomaly[] => {
    const out: Anomaly[] = [];
    const push = (r: any, rule: Anomaly["rule"], reference: number) =>
      out.push({ ...r, rule, reference });

    // Physically impossible for one person to carry.
    for (const r of db.getAllSync<any>(
      `SELECT pk.id AS pickupId, pk.personId, pk.weight, pk.date,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS person,
              COALESCE(cr.name,'?') AS crop
         FROM pickups pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE pk.weight <= 0 OR pk.weight > ?`,
      [maxWeight],
    ))
      push(r, "impossible", maxWeight);

    // Same person, plot and weight within three minutes: a double tap.
    for (const r of db.getAllSync<any>(
      `SELECT a.id AS pickupId, a.personId, a.weight, a.date,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS person,
              COALESCE(cr.name,'?') AS crop
         FROM pickups a
         JOIN pickups b ON b.personId = a.personId AND b.cropId = a.cropId
                       AND b.weight = a.weight AND b.id < a.id
                       AND (julianday(a.createdAt) - julianday(b.createdAt))
                             BETWEEN 0 AND 3.0 / 1440
         LEFT JOIN people pe ON pe.id = a.personId
         LEFT JOIN crops cr ON cr.id = a.cropId`,
    ))
      push(r, "duplicate", r.weight);

    // Far above what this person usually carries. The reference excludes the
    // suspect pickup itself: including it made the rule algebraically unable
    // to fire, because the outlier inflated the very average it was compared
    // against (w >= 10*avg reduces to n+1 >= n+10, false for every n).
    for (const r of db.getAllSync<any>(
      `WITH stats AS (
         SELECT id, personId, weight,
                (SUM(weight) OVER (PARTITION BY personId) - weight)
                  / NULLIF(COUNT(*) OVER (PARTITION BY personId) - 1, 0) AS others
           FROM pickups
       )
       SELECT pk.id AS pickupId, pk.personId, pk.weight, pk.date, st.others AS reference,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS person,
              COALESCE(cr.name,'?') AS crop
         FROM pickups pk JOIN stats st ON st.id = pk.id
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE st.others > 0 AND pk.weight >= 4 * st.others`,
    ))
      push(r, "digit", Math.round(r.reference));

    // Far above what the rest of the crew did on that plot that day. This is
    // the one that catches a bad weighing on somebody whose own history is
    // short, where the personal reference above has nothing to work with.
    for (const r of db.getAllSync<any>(
      `WITH dayplot AS (
         SELECT pk.id, pk.personId, pk.cropId, pk.weight, pk.date,
                date(pk.date,'localtime') AS d
           FROM pickups pk
       ),
       others AS (
         SELECT a.id,
                AVG(b.weight) AS ref,
                COUNT(b.id) AS n
           FROM dayplot a JOIN dayplot b
             ON b.cropId = a.cropId AND b.d = a.d AND b.id <> a.id
          GROUP BY a.id
       )
       SELECT pk.id AS pickupId, pk.personId, pk.weight, pk.date, o.ref AS reference,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS person,
              COALESCE(cr.name,'?') AS crop
         FROM pickups pk JOIN others o ON o.id = pk.id
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE o.n >= 4 AND o.ref > 0 AND pk.weight >= 4 * o.ref`,
    ))
      push(r, "outlier", Math.round(r.reference));

    // Dated after today: a wrong clock or a typo.
    for (const r of db.getAllSync<any>(
      `SELECT pk.id AS pickupId, pk.personId, pk.weight, pk.date,
              COALESCE(pe.name || ' ' || pe.lastName,'?') AS person,
              COALESCE(cr.name,'?') AS crop
         FROM pickups pk
         LEFT JOIN people pe ON pe.id = pk.personId
         LEFT JOIN crops cr ON cr.id = pk.cropId
        WHERE date(pk.date,'localtime') > date('now','localtime')`,
    ))
      push(r, "future", 0);

    // One pickup can break more than one rule; report it once, worst first.
    const seen = new Set<number>();
    return out.filter((a) => (seen.has(a.pickupId) ? false : seen.add(a.pickupId)));
  },
};
