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
  // Seed a sensible default crop config (Café) on first run.
  db.runSync(
    `INSERT OR IGNORE INTO config (id, cropType, label, unit, yieldUnit, costPerUnit, language)
     VALUES (1, 'cafe', 'Café', 'kg', 'kg por recolector', 800, 'es')`,
  );
}

const now = () => new Date().toISOString();

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
       FROM pickups WHERE date(date) = date('now','localtime')`,
    ),
  thisWeek: () =>
    db.getFirstSync<{ kg: number; count: number }>(
      `SELECT COALESCE(SUM(weight),0) AS kg, COUNT(*) AS count
       FROM pickups WHERE strftime('%Y-W%W', date) = strftime('%Y-W%W','now','localtime')`,
    ),
  byWeek: () =>
    db.getAllSync<{ label: string; kg: number }>(
      `SELECT strftime('%Y-W%W', date) AS label, SUM(weight) AS kg
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
    `SELECT strftime('%Y-W%W', pk.date) AS week,
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
      `SELECT strftime('%Y-W%W', date) AS label, SUM(weight) AS kg
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
      `SELECT strftime('%Y-W%W', date) AS week, SUM(weight) AS kg
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
    db.execSync(
      "DELETE FROM pickups; DELETE FROM crops; DELETE FROM people; DELETE FROM cost_overrides;",
    );
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

    // Spread pickups over the last 28 days (skipping a weekly rest day).
    for (let d = 27; d >= 0; d--) {
      if (d % 7 === 6) continue; // rest day
      const date = new Date();
      date.setDate(date.getDate() - d);
      date.setHours(8 + (d % 6), (d * 7) % 60, 0, 0);
      const iso = date.toISOString();
      const count = 3 + (d % 3); // 3–5 pickups/day
      for (let k = 0; k < count; k++) {
        const pid = pids[(d + k) % pids.length];
        const cid = cids[(d + k) % cids.length];
        const weight = 8 + ((d * 3 + k * 5) % 22); // 8–29 units
        db.runSync(
          "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?)",
          [pid, cid, weight, iso, iso],
        );
      }
    }

    // A couple of weekly cost overrides to showcase the feature.
    const weeks = db.getAllSync<{ week: string }>(
      "SELECT DISTINCT strftime('%Y-W%W', date) AS week FROM pickups ORDER BY week DESC LIMIT 2",
    );
    if (weeks[0]) Overrides.set(weeks[0].week, 950);
    if (weeks[1]) Overrides.set(weeks[1].week, 880);
  },
};

// Total payout across all pickups, applying weekly overrides where present.
export function totalPayout(general: number): number {
  const rows = db.getAllSync<{ week: string; kg: number }>(
    `SELECT strftime('%Y-W%W', date) AS week, SUM(weight) AS kg
     FROM pickups GROUP BY week`,
  );
  return rows.reduce((sum, r) => sum + r.kg * costForWeek(r.week, general), 0);
}
