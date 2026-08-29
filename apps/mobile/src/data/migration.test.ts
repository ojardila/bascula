import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { nodeSqlite } from "./nodeSqlite.ts";
import { createSqliteRepository } from "./sqliteRepository.ts";
import { instantOfRow } from "./migrateToV6.ts";
import { SYNCED_TABLES } from "../schema.ts";
import type { SqlDatabase } from "./sqliteRepository.ts";
import type { Repository } from "./repository.ts";
import {
  isUuidV7,
  uuidV7Time,
} from "../../../../packages/shared/src/uuid.ts";

/**
 * `user_version = 6`, tested against what would actually go wrong.
 *
 * This migration runs once, unattended, on a phone in a field, on the only
 * copy of a season's weighings. Nobody will be watching it and nobody can
 * re-enter what it loses. So the tests below are not "does it add a column":
 * they are a season of real volume, a migration killed halfway, a second run,
 * and the question of whether the ids it mints still say when things happened.
 */

// ---- A phone as it shipped at version 5 --------------------------------

/**
 * The v5 schema, written out rather than imported.
 *
 * `schema.ts` is the CURRENT schema and will keep moving; what a migration has
 * to survive is the shape that is actually out there on phones today. Frozen
 * here on purpose, so that editing `schema.ts` cannot quietly change what this
 * suite claims to be upgrading from.
 */
const V5_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, lastName TEXT, documentType TEXT, docId TEXT, tag TEXT,
    createdAt TEXT, image TEXT, deletedAt TEXT);
  CREATE TABLE crops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, type TEXT, variety TEXT, dimension REAL,
    createdAt TEXT, deletedAt TEXT);
  CREATE TABLE pickups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    personId INTEGER, cropId INTEGER, weight REAL NOT NULL, date TEXT,
    createdAt TEXT);
  CREATE TABLE config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cropType TEXT, label TEXT, unit TEXT, yieldUnit TEXT, costPerUnit REAL,
    language TEXT);
  CREATE TABLE cost_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT, week TEXT UNIQUE, costPerUnit REAL);
  CREATE TABLE settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    personId INTEGER NOT NULL REFERENCES people(id),
    periodStart TEXT NOT NULL, periodEnd TEXT NOT NULL,
    grossCents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
    note TEXT, createdAt TEXT NOT NULL, voidedAt TEXT);
  CREATE INDEX ix_settlements_person ON settlements(personId, createdAt DESC);
  CREATE TABLE settlement_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    settlementId INTEGER NOT NULL REFERENCES settlements(id),
    pickupId INTEGER NOT NULL, week TEXT NOT NULL, weight REAL NOT NULL,
    costPerUnitCents INTEGER NOT NULL, amountCents INTEGER NOT NULL,
    voidedAt TEXT);
  CREATE UNIQUE INDEX ux_items_pickup_live
    ON settlement_items(pickupId) WHERE voidedAt IS NULL;
  CREATE INDEX ix_items_settlement ON settlement_items(settlementId);
  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    personId INTEGER NOT NULL REFERENCES people(id),
    kind TEXT NOT NULL CHECK (kind IN
      ('devengo','pago','anticipo','deduccion','ajuste','reverso')),
    amountCents INTEGER NOT NULL CHECK (amountCents <> 0),
    date TEXT NOT NULL, settlementId INTEGER REFERENCES settlements(id),
    method TEXT, note TEXT, reversesId INTEGER REFERENCES ledger(id),
    createdAt TEXT NOT NULL,
    CHECK ( (kind = 'devengo' AND amountCents > 0)
         OR (kind IN ('pago','anticipo','deduccion') AND amountCents < 0)
         OR (kind IN ('ajuste','reverso')) ));
  CREATE INDEX ix_ledger_person ON ledger(personId, date DESC, id DESC);
  CREATE INDEX ix_ledger_sett ON ledger(settlementId);
  CREATE UNIQUE INDEX ux_ledger_reverses
    ON ledger(reversesId) WHERE reversesId IS NOT NULL;
  CREATE INDEX ix_pickups_date ON pickups(date);
  CREATE INDEX ix_pickups_dup ON pickups(personId, cropId, weight, createdAt);
  INSERT INTO config (id, cropType, label, unit, yieldUnit, costPerUnit, language)
    VALUES (1, 'cafe', 'Café', 'kg', 'kg por recolector', 800, 'es');
  PRAGMA user_version = 5;
`;

const iso = (ms: number) => new Date(ms).toISOString();
const SEASON_START = Date.UTC(2026, 1, 2, 11, 0, 0); // a Monday
const DAY = 86400000;

interface Season {
  db: DatabaseSync;
  pickups: number;
  rows: number;
}

/**
 * A season on a real farm: forty pickers, six plots, a weighing or three each
 * per working day for five months, every week settled and paid.
 *
 * `pickupCount` is what the brief asks for; everything else is scaled off it,
 * because the tables that grow with the harvest all grow together — a season
 * with 18,000 weighings has 18,000 settlement lines behind it, and a migration
 * timed on the pickups alone would be timing a third of the work.
 */
function aSeason(pickupCount = 18000): Season {
  const db = new DatabaseSync(":memory:");
  db.exec(V5_SCHEMA);
  db.exec("BEGIN");

  const people = 40;
  const plots = 6;
  const person = db.prepare(
    "INSERT INTO people (name,lastName,documentType,docId,tag,createdAt) VALUES (?,?,'CC',?,?,?)",
  );
  for (let i = 1; i <= people; i++)
    person.run(`P${i}`, `Apellido${i}`, String(1000000 + i), `T${i}`, iso(SEASON_START));
  const plot = db.prepare(
    "INSERT INTO crops (name,type,variety,dimension,createdAt) VALUES (?,'Café','Castillo',2.5,?)",
  );
  for (let i = 1; i <= plots; i++) plot.run(`Lote ${i}`, iso(SEASON_START));

  // The weighings, spread over the season in ascending time — which is how a
  // real table looks, since rows are appended as they are weighed.
  const pk = db.prepare(
    "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?)",
  );
  const perDay = Math.ceil(pickupCount / 150);
  let made = 0;
  const dateOfPickup: number[] = [0];
  for (let d = 0; made < pickupCount; d++) {
    if (d % 7 === 6) continue; // Sunday off
    for (let k = 0; k < perDay && made < pickupCount; k++, made++) {
      // Two loads can land in the same second; that is exactly the tie the
      // uuid counter has to break.
      const when = SEASON_START + d * DAY + Math.floor(k / 3) * 1000;
      dateOfPickup.push(when);
      pk.run(
        (made % people) + 1,
        (made % plots) + 1,
        20 + (made % 60),
        iso(when),
        iso(when),
      );
    }
  }

  // Every week settled for every picker, and every settlement paid.
  const st = db.prepare(
    `INSERT INTO settlements (personId,periodStart,periodEnd,grossCents,status,createdAt)
     VALUES (?,?,?,?, 'open', ?)`,
  );
  const li = db.prepare(
    `INSERT INTO settlement_items (settlementId,pickupId,week,weight,costPerUnitCents,amountCents)
     VALUES (?,?,?,?,?,?)`,
  );
  const le = db.prepare(
    `INSERT INTO ledger (personId,kind,amountCents,date,settlementId,method,createdAt)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const weeks = Math.ceil(dateOfPickup.length / (people * 5));
  let nextPickup = 1;
  for (let w = 0; w < weeks; w++) {
    for (let p = 1; p <= people && nextPickup < dateOfPickup.length; p++) {
      const paidAt = SEASON_START + (w * 7 + 6) * DAY;
      const mine: number[] = [];
      for (let k = 0; k < 5 && nextPickup < dateOfPickup.length; k++)
        mine.push(nextPickup++);
      const gross = mine.length * 40000;
      const sid = Number(
        st.run(p, iso(paidAt).slice(0, 10), iso(paidAt).slice(0, 10), gross, iso(paidAt))
          .lastInsertRowid,
      );
      for (const id of mine)
        li.run(sid, id, iso(paidAt).slice(0, 10), 50, 800, 40000);
      le.run(p, "devengo", gross, iso(paidAt).slice(0, 10), sid, null, iso(paidAt));
      le.run(p, "pago", -gross, iso(paidAt).slice(0, 10), null, "efectivo", iso(paidAt + 60000));
    }
  }
  for (let w = 0; w < 20; w++)
    db.prepare("INSERT INTO cost_overrides (week, costPerUnit) VALUES (?, ?)").run(
      iso(SEASON_START + w * 7 * DAY).slice(0, 10),
      800 + w * 5,
    );
  db.exec("COMMIT");

  const rows = SYNCED_TABLES.reduce(
    (n, t) =>
      n + Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get() as { n: number }).n),
    0,
  );
  return { db, pickups: pickupCount, rows };
}

/** Every row's identity and the instant its table says it belongs at. */
function identities(db: DatabaseSync) {
  const out: { table: string; id: number; uuid: string | null; bornAt: string | null }[] = [];
  for (const t of SYNCED_TABLES)
    for (const r of db
      .prepare(`SELECT id, uuid, ${t.bornAt} AS bornAt FROM ${t.name}`)
      .all() as unknown as { id: number; uuid: string | null; bornAt: string | null }[])
      out.push({ table: t.name, id: Number(r.id), uuid: r.uuid, bornAt: r.bornAt });
  return out;
}

const version = (db: DatabaseSync) =>
  Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);

const counts = (db: DatabaseSync) =>
  Object.fromEntries(
    SYNCED_TABLES.map((t) => [
      t.name,
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get() as { n: number }).n),
    ]),
  );

const kilos = (db: DatabaseSync) =>
  (db.prepare("SELECT ROUND(SUM(weight),3) AS kg FROM pickups").get() as { kg: number }).kg;

// ---- A season migrates, and nothing goes missing ------------------------

test("a season of 18,000 weighings migrates without losing a row", () => {
  const season = aSeason(18000);
  const before = counts(season.db);
  const beforeKg = kilos(season.db);
  const beforeMoney = (
    season.db.prepare("SELECT SUM(amountCents) AS c FROM ledger").get() as { c: number }
  ).c;

  const repo = createSqliteRepository(nodeSqlite(season.db));
  const t0 = performance.now();
  repo.init();
  const ms = performance.now() - t0;

  assert.equal(version(season.db), 6);
  assert.deepEqual(counts(season.db), before, "not one row lost or invented");
  assert.equal(kilos(season.db), beforeKg, "not a kilo moved");
  assert.equal(
    (season.db.prepare("SELECT SUM(amountCents) AS c FROM ledger").get() as { c: number }).c,
    beforeMoney,
    "not a cent moved",
  );

  // Every row that will travel now has a name, and every name is unique.
  const rows = identities(season.db);
  assert.equal(rows.length, season.rows);
  assert.equal(
    rows.filter((r) => r.uuid === null).length,
    0,
    "a row with no uuid is a row the server can never be told about",
  );
  assert.equal(new Set(rows.map((r) => r.uuid)).size, rows.length, "no id repeats");
  assert.ok(rows.every((r) => isUuidV7(r.uuid!)));

  // And the phone still works: the screens' own queries, over the migrated db.
  assert.equal(repo.reports.totals()?.pickups, season.pickups);
  assert.ok(repo.payments.balances().length > 0);
  assert.ok(repo.people.all().length === 40);

  // The number the brief asks for, reported rather than merely bounded.
  console.log(
    `      migration: ${season.rows} rows (${season.pickups} pickups) in ${ms.toFixed(0)} ms`,
  );
  // Generous, because a loaded CI box is not a phone; it is here to catch a
  // regression into per-row round trips, not to measure hardware.
  assert.ok(ms < 15000, `migration took ${ms.toFixed(0)} ms`);
});

test("everything the farm owns is queued for the server, exactly once", () => {
  const season = aSeason(2000);
  const repo = createSqliteRepository(nodeSqlite(season.db));
  repo.init();

  // At version 6 the server has never heard of this farm, so every row is owed
  // — the config row that names the farm included.
  assert.equal(repo.sync.pendingCount(), season.rows);
  const queued = repo.sync.pending(1e6);
  assert.equal(new Set(queued.map((q) => q.entityUuid)).size, queued.length);
  assert.ok(queued.every((q) => q.op === "upsert"));
  // Push order is queue order, and queue order is chronological order.
  assert.deepEqual(
    queued.map((q) => q.seq),
    [...queued.map((q) => q.seq)].sort((a, b) => a - b),
  );
  assert.deepEqual(
    queued.map((q) => q.entityUuid),
    [...queued.map((q) => q.entityUuid)].sort(),
  );
});

// ---- The ids have to mean when things happened -------------------------

test("the uuids come out in the same order as the dates", () => {
  const season = aSeason(3000);
  const repo = createSqliteRepository(nodeSqlite(season.db));
  const migratedAt = Date.now();
  repo.init();

  const rows = identities(season.db).map((r) => ({
    ...r,
    ms: instantOfRow(r.bornAt, migratedAt),
  }));

  // Each id carries its own row's instant, to the millisecond.
  for (const r of rows)
    if (r.table !== "config")
      assert.equal(
        uuidV7Time(r.uuid!),
        r.ms,
        `${r.table}#${r.id} is dated ${r.bornAt} but its id says ${new Date(uuidV7Time(r.uuid!)).toISOString()}`,
      );

  // And sorting the whole farm by id sorts the whole farm by date. This is the
  // property the server's `ORDER BY uuid` pagination rests on; lose it and the
  // history arrives shuffled with nothing to say so.
  const sorted = [...rows].sort((a, b) => (a.uuid! < b.uuid! ? -1 : 1));
  for (let i = 1; i < sorted.length; i++)
    assert.ok(
      sorted[i]!.ms >= sorted[i - 1]!.ms,
      `${sorted[i - 1]!.table} (${sorted[i - 1]!.ms}) sorts before ${sorted[i]!.table} (${sorted[i]!.ms})`,
    );
});

test("rows sharing a millisecond keep the order they were written", () => {
  // The season deliberately puts three weighings in the same second, and a
  // settlement, its lines and its ledger entry always share one. Random tails
  // would order these by chance.
  const season = aSeason(600);
  createSqliteRepository(nodeSqlite(season.db)).init();

  const first = season.db
    .prepare("SELECT id, uuid FROM pickups ORDER BY date, id")
    .all() as unknown as { id: number; uuid: string }[];
  assert.deepEqual(
    [...first].sort((a, b) => (a.uuid < b.uuid ? -1 : 1)).map((r) => r.id),
    first.map((r) => r.id),
  );

  // A settlement is written in the same millisecond as its lines; the parent
  // must still sort first, or the server sees a line for a document it has
  // not been given.
  const s = season.db
    .prepare("SELECT uuid, createdAt FROM settlements ORDER BY id LIMIT 1")
    .get() as { uuid: string; createdAt: string };
  const lines = season.db
    .prepare(
      `SELECT i.uuid FROM settlement_items i
        JOIN settlements st ON st.id = i.settlementId
       WHERE st.uuid = ?`,
    )
    .all(s.uuid) as unknown as { uuid: string }[];
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => l.uuid > s.uuid), "a line sorted before its document");
});

// ---- Killed halfway ----------------------------------------------------

/**
 * A connection that dies on the Nth write, with the transaction left to the
 * real one so the rollback is SQLite's own and not the test's idea of it.
 */
function failsAfter(inner: SqlDatabase, n: number): SqlDatabase {
  let left = n;
  const spend = () => {
    if (left-- <= 0) throw new Error("BATERÍA AGOTADA");
  };
  return {
    getAllSync: (sql, params) => inner.getAllSync(sql, params),
    getFirstSync: (sql, params) => inner.getFirstSync(sql, params),
    runSync: (sql, params) => (spend(), inner.runSync(sql, params)),
    execSync: (sql) => (spend(), inner.execSync(sql)),
    withTransactionSync: (task) => inner.withTransactionSync(task),
  };
}

test("a migration killed halfway leaves a version-5 database that still works", () => {
  // Which write stamps the new version, so the kill points below are real
  // positions inside the migration rather than numbers that fall off the end
  // and test nothing. `init` keeps working after the migration — it seeds the
  // config row — so "the last write" is not "the last write of the migration".
  let stampedAt = 0;
  {
    const s = aSeason(400);
    const inner = nodeSqlite(s.db);
    let seen = 0;
    const counted: SqlDatabase = {
      ...inner,
      runSync: (sql, params) => (seen++, inner.runSync(sql, params)),
      execSync: (sql) => {
        seen++;
        if (sql.includes("PRAGMA user_version = 6")) stampedAt = seen;
        return inner.execSync(sql);
      },
    };
    createSqliteRepository(counted).init();
    assert.ok(stampedAt > 400, `only ${stampedAt} writes — is the backfill still running?`);
    s.db.close();
  }

  // "Halfway" is not one place. The last depth is the cruellest and the one
  // that matters most: everything done, every uuid minted, every trigger
  // created — and the battery dies on the statement that would have written
  // the new version number. That database has to come up at 5.
  const depths = [1, 2, 3, 5, 9, 40, Math.floor(stampedAt / 2), stampedAt - 1];
  for (const depth of depths) {
    const season = aSeason(400);
    const before = counts(season.db);
    const beforeKg = kilos(season.db);

    const repo = createSqliteRepository(failsAfter(nodeSqlite(season.db), depth));
    assert.throws(() => repo.init(), /BATERÍA AGOTADA/, `depth ${depth}`);

    assert.equal(version(season.db), 5, `depth ${depth}: the version must not advance`);
    assert.deepEqual(counts(season.db), before, `depth ${depth}: rows`);
    assert.equal(kilos(season.db), beforeKg, `depth ${depth}: kilos`);
    // The schema is back to what it was: no half-added columns, no outbox
    // holding a queue for ids that no longer exist.
    const cols = (season.db.prepare("PRAGMA table_info(pickups)").all() as unknown as {
      name: string;
    }[]).map((c) => c.name);
    assert.ok(!cols.includes("uuid"), `depth ${depth}: uuid column survived a rollback`);
    assert.equal(
      (season.db.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'outbox'",
      ).get() as { n: number }).n,
      0,
      `depth ${depth}: outbox survived a rollback`,
    );

    // And the app comes up. This is the whole point: yesterday's phone,
    // working, rather than a farm that cannot open its app during a harvest.
    const still = createSqliteRepository(nodeSqlite(season.db));
    assert.equal(still.reports.totals()?.pickups, 400, `depth ${depth}`);
    assert.ok(still.payments.balances().length > 0, `depth ${depth}`);

    // Then the next launch, with a working connection, finishes the job.
    still.init();
    assert.equal(version(season.db), 6, `depth ${depth}: the retry`);
    assert.deepEqual(counts(season.db), before, `depth ${depth}: the retry kept every row`);
    assert.equal(
      identities(season.db).filter((r) => r.uuid === null).length,
      0,
      `depth ${depth}: the retry named every row`,
    );
    season.db.close();
  }
});

// ---- Idempotence -------------------------------------------------------

test("migrating twice does nothing the second time", () => {
  const season = aSeason(500);
  const repo = createSqliteRepository(nodeSqlite(season.db));
  repo.init();

  const first = identities(season.db);
  const firstQueue = repo.sync.pending(1e6);
  const firstStamps = season.db
    .prepare("SELECT id, updatedAt FROM pickups ORDER BY id")
    .all();

  // Three more launches for good measure — this runs on every single one.
  repo.init();
  repo.init();
  repo.init();

  assert.equal(version(season.db), 6);
  assert.deepEqual(identities(season.db), first, "an id was re-minted");
  assert.deepEqual(
    season.db.prepare("SELECT id, updatedAt FROM pickups ORDER BY id").all(),
    firstStamps,
    "a row was marked as changed when nothing changed",
  );
  assert.deepEqual(repo.sync.pending(1e6), firstQueue, "the queue grew on a no-op launch");
});

// ---- The outbox --------------------------------------------------------

function freshRepo(): { db: DatabaseSync; repo: Repository } {
  const db = new DatabaseSync(":memory:");
  const repo = createSqliteRepository(nodeSqlite(db));
  repo.init();
  return { db, repo };
}

test("a new weighing queues itself, and so does correcting it", () => {
  const { repo } = freshRepo();
  const person = repo.people.add({
    name: "Ana", lastName: "R", documentType: "CC", docId: "1", tag: "T1", image: "",
  }).lastInsertRowId;
  const plot = repo.crops.add({
    name: "Lote 1", type: "Café", variety: "Castillo", dimension: 2,
  }).lastInsertRowId;

  const before = repo.sync.pendingCount();
  const pickup = repo.pickups.add({
    personId: person, cropId: plot, weight: 40, date: new Date().toISOString(),
  }).lastInsertRowId;
  assert.equal(repo.sync.pendingCount(), before + 1);

  const entry = repo.sync.pending().find((q) => q.entity === "pickups")!;
  assert.equal(entry.op, "upsert");
  assert.equal(entry.localId, pickup);
  assert.equal(entry.revision, 1);

  // Forty corrections still owe the server one row — but the revision counts
  // them, which is what stops an in-flight push acking away a change it never
  // carried.
  for (let i = 1; i <= 40; i++) repo.pickups.setWeight(pickup, 40 + i);
  const after = repo.sync.pending().filter((q) => q.entity === "pickups");
  assert.equal(after.length, 1, "one row owed, not forty");
  assert.equal(after[0]!.seq, entry.seq, "the first change keeps its place in the queue");
  assert.equal(after[0]!.revision, 41);
});

test("a deleted weighing leaves the only trace the server will ever get", () => {
  const { db, repo } = freshRepo();
  const person = repo.people.add({
    name: "Ana", lastName: "R", documentType: "CC", docId: "1", tag: "T1", image: "",
  }).lastInsertRowId;
  const plot = repo.crops.add({
    name: "Lote 1", type: "Café", variety: "Castillo", dimension: 2,
  }).lastInsertRowId;
  const pickup = repo.pickups.add({
    personId: person, cropId: plot, weight: 40, date: new Date().toISOString(),
  }).lastInsertRowId;
  const uuid = (db.prepare("SELECT uuid FROM pickups WHERE id = ?").get(pickup) as {
    uuid: string;
  }).uuid;

  repo.pickups.remove(pickup);

  // The row is gone. A `WHERE updatedAt > lastSync` watermark would have
  // nothing left to report and the server would keep charging the farm for a
  // weighing that was cancelled.
  assert.equal(counts(db).pickups, 0);
  const q = repo.sync.pending().filter((e) => e.entity === "pickups");
  assert.equal(q.length, 1);
  assert.equal(q[0]!.op, "delete");
  assert.equal(q[0]!.entityUuid, uuid);
  assert.equal(q[0]!.localId, null, "there is nothing left to read the row from");
});

test("an ack drops what the server confirmed, and only that", () => {
  const { repo } = freshRepo();
  const person = repo.people.add({
    name: "Ana", lastName: "R", documentType: "CC", docId: "1", tag: "T1", image: "",
  }).lastInsertRowId;
  const plot = repo.crops.add({
    name: "Lote 1", type: "Café", variety: "Castillo", dimension: 2,
  }).lastInsertRowId;
  const pickup = repo.pickups.add({
    personId: person, cropId: plot, weight: 40, date: new Date().toISOString(),
  }).lastInsertRowId;

  const sent = repo.sync.pending();
  assert.equal(sent.length, repo.sync.pendingCount());

  // The push is in flight, and the weigher notices the load was wrong.
  repo.pickups.setWeight(pickup, 55);

  const dropped = repo.sync.ack(sent);
  assert.equal(dropped, sent.length - 1, "the corrected row was not acked away");
  const left = repo.sync.pending();
  assert.equal(left.length, 1);
  assert.equal(left[0]!.entity, "pickups");
  assert.equal(left[0]!.revision, 2);

  // Acking the same batch again is a no-op, because the network will make us
  // do exactly that.
  assert.equal(repo.sync.ack(sent), 0);
});

test("settling queues the document, its lines and the earning, in that order", () => {
  const { repo } = freshRepo();
  const person = repo.people.add({
    name: "Ana", lastName: "R", documentType: "CC", docId: "1", tag: "T1", image: "",
  }).lastInsertRowId;
  const plot = repo.crops.add({
    name: "Lote 1", type: "Café", variety: "Castillo", dimension: 2,
  }).lastInsertRowId;
  const day = new Date();
  day.setDate(day.getDate() - 2);
  repo.pickups.add({
    personId: person, cropId: plot, weight: 40, date: day.toISOString(),
  });
  repo.sync.ack(repo.sync.pending());

  assert.ok(repo.payments.settle(person, "1970-01-01", "2099-12-31", 800));

  const q = repo.sync.pending();
  assert.deepEqual(
    q.map((e) => e.entity),
    ["settlements", "settlement_items", "ledger"],
    "the server must not meet a line before its document",
  );
});

test("voiding a settlement queues what it changed, not what it did not", () => {
  const { repo } = freshRepo();
  const person = repo.people.add({
    name: "Ana", lastName: "R", documentType: "CC", docId: "1", tag: "T1", image: "",
  }).lastInsertRowId;
  const plot = repo.crops.add({
    name: "Lote 1", type: "Café", variety: "Castillo", dimension: 2,
  }).lastInsertRowId;
  const day = new Date();
  day.setDate(day.getDate() - 2);
  repo.pickups.add({ personId: person, cropId: plot, weight: 40, date: day.toISOString() });
  const s = repo.payments.settle(person, "1970-01-01", "2099-12-31", 800)!;
  repo.sync.ack(repo.sync.pending());

  repo.payments.voidSettlement(s.settlementId, "error");

  const entities = repo.sync.pending().map((e) => e.entity);
  assert.deepEqual([...new Set(entities)].sort(), [
    "ledger", // the reversal
    "settlement_items",
    "settlements",
  ]);
  assert.ok(!entities.includes("pickups"), "the weighing itself did not change");
});

// ---- farmId and deviceId -----------------------------------------------

test("the farm has no id until the server gives it one; the device always has", () => {
  const { db, repo } = freshRepo();
  const id = repo.sync.identity();
  assert.equal(id.farmId, null, "there is no farm id to invent before registering");
  assert.equal(id.syncedAt, null);
  assert.ok(isUuidV7(id.deviceId), "a device with no name has no per-device counter");

  // It survives relaunches, which is what makes it a device identity at all.
  repo.init();
  repo.init();
  assert.equal(repo.sync.identity().deviceId, id.deviceId);

  repo.sync.claimFarm("finca-la-esperanza");
  assert.equal(repo.sync.identity().farmId, "finca-la-esperanza");
  // Idempotent, because registering will be retried over a bad connection.
  repo.sync.claimFarm("finca-la-esperanza");
  assert.equal(repo.sync.identity().farmId, "finca-la-esperanza");
  // But never reassigned: that is how one farm's payroll reaches another.
  assert.throws(() => repo.sync.claimFarm("otra-finca"), /FARM_ALREADY_CLAIMED/);

  // And it is stored once, on the config row, not copied onto every weighing.
  const carriers = (db
    .prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table'")
    .all() as unknown as { name: string }[])
    .filter((t) =>
      (db.prepare(`PRAGMA table_info(${t.name})`).all() as unknown as { name: string }[]).some(
        (c) => c.name === "farmId",
      ),
    )
    .map((t) => t.name);
  assert.deepEqual(carriers, ["config"]);
});

test("a wiped farm keeps its own identity and tells the server about the loss", () => {
  const { repo } = freshRepo();
  const person = repo.people.add({
    name: "Ana", lastName: "R", documentType: "CC", docId: "1", tag: "T1", image: "",
  }).lastInsertRowId;
  repo.crops.add({ name: "Lote 1", type: "Café", variety: "Castillo", dimension: 2 });
  repo.pickups.add({
    personId: person, cropId: 1, weight: 40, date: new Date().toISOString(),
  });
  repo.sync.claimFarm("finca-la-esperanza");
  const device = repo.sync.identity().deviceId;
  repo.sync.ack(repo.sync.pending());

  repo.demo.clear(repo.demo.clearToken());

  // The wipe is a fact the server has to learn, not an absence of facts.
  const q = repo.sync.pending();
  assert.ok(q.length >= 3);
  assert.ok(q.every((e) => e.op === "delete"));
  // And the phone is still this phone, on still this farm.
  assert.equal(repo.sync.identity().deviceId, device);
  assert.equal(repo.sync.identity().farmId, "finca-la-esperanza");
});
