import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlite } from "./nodeSqlite.ts";
import {
  ConfirmationRequired,
  createSqliteRepository,
} from "./sqliteRepository.ts";
import type { Repository } from "./repository.ts";
import { isUuidV7, uuidV7Time } from "../../../../packages/shared/src/uuid.ts";
import {
  dayInZone,
  weekInZone,
} from "../../../../packages/shared/src/time.ts";

/**
 * The data layer, driven through the real implementation.
 *
 * Until this sprint none of it could be tested at all: `db.ts` opened
 * `bascula.db` at module scope, so the suites had to stop at `schema.ts` and
 * settle, pay, void, undo and every migration shipped unproven
 * (`docs/diagramas/movil.md` §9.2). What runs below is the same code the phone
 * runs, over `node:sqlite`, with the connection handed in.
 */

let raw: DatabaseSync;
let repo: Repository;

const CENT = 100;
const money = (pesos: number) => pesos * CENT;

/** A weighing `daysAgo` back, at a wall-clock hour, in the runner's timezone. */
function at(daysAgo: number, hour = 9, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function aWorker(name = "Ana") {
  return repo.people.add({
    name,
    lastName: "Rodríguez",
    documentType: "CC",
    docId: "1000",
    tag: "T1",
    image: "",
  }).lastInsertRowId;
}

function aPlot(name = "Lote 1") {
  return repo.crops.add({
    name,
    type: "Café",
    variety: "Castillo",
    dimension: 2.5,
  }).lastInsertRowId;
}

/** Settle everything outstanding, the way both pay screens do. */
const settleAll = (personId: number, general = 800) =>
  repo.payments.settle(personId, "1970-01-01", "2099-12-31", general);

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  repo = createSqliteRepository(nodeSqlite(raw));
  repo.init();
});

// ---- Schema and migrations ---------------------------------------------

test("a fresh database comes up at the current schema version", () => {
  const v = raw.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(v.user_version, 8);
  assert.deepEqual({ ...repo.config.get() }, {
    cropType: "cafe",
    label: "Café",
    unit: "kg",
    yieldUnit: "kg por recolector",
    costPerUnit: 800,
  });
});

test("pickups finally has indexes, on the one table that grows for ever", () => {
  const names = (
    raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pickups'",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  assert.ok(names.includes("ix_pickups_date"));
  assert.ok(names.includes("ix_pickups_dup"));
});

test("starting up twice changes nothing — every launch runs this", () => {
  const person = aWorker();
  aPlot();
  repo.pickups.add({ personId: person, cropId: 1, weight: 40, date: at(2) });
  const before = raw.prepare("SELECT uuid FROM pickups WHERE id = 1").get() as {
    uuid: string;
  };
  repo.init();
  repo.init();
  const v = raw.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(v.user_version, 8);
  assert.equal(repo.reports.totals()?.pickups, 1);
  assert.equal(repo.config.get()?.label, "Café");
  // A re-run must not re-mint an identity the server may already know.
  assert.deepEqual(
    raw.prepare("SELECT uuid FROM pickups WHERE id = 1").get(),
    before,
  );
});

test("a database from the first release migrates all the way up", () => {
  // BASE_SCHEMA only, which is what `user_version = 1` means: no payments
  // tables, no soft-delete columns, no index.
  const old = new DatabaseSync(":memory:");
  old.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      lastName TEXT, documentType TEXT, docId TEXT, tag TEXT, createdAt TEXT);
    CREATE TABLE crops (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      type TEXT, variety TEXT, dimension REAL, createdAt TEXT);
    CREATE TABLE pickups (id INTEGER PRIMARY KEY AUTOINCREMENT, personId INTEGER,
      cropId INTEGER, weight REAL NOT NULL, date TEXT, createdAt TEXT);
    CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1), cropType TEXT,
      label TEXT, unit TEXT, yieldUnit TEXT, costPerUnit REAL);
    CREATE TABLE cost_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT,
      week TEXT UNIQUE, costPerUnit REAL);
    INSERT INTO people (id,name,lastName) VALUES (1,'Ana','R');
    INSERT INTO pickups (personId,cropId,weight,date,createdAt)
      VALUES (1,1,42,'2026-08-25T14:00:00Z','2026-08-25T14:00:00Z');
    PRAGMA user_version = 1;
  `);
  const upgraded = createSqliteRepository(nodeSqlite(old));
  upgraded.init();

  const v = old.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(v.user_version, 8);
  assert.equal(upgraded.reports.totals()?.pickups, 1, "the season survives");
  assert.equal(upgraded.people.all().length, 1, "deletedAt was added, not reset");
  // The payments half now exists and works.
  assert.equal(upgraded.payments.balance(1).balanceCents, 0);
  // ...and five versions later the row that was there from the first release
  // has an identity, dated at the weighing rather than at the upgrade.
  const pk = old.prepare("SELECT uuid FROM pickups WHERE id = 1").get() as {
    uuid: string;
  };
  assert.ok(isUuidV7(pk.uuid));
  assert.equal(uuidV7Time(pk.uuid), Date.parse("2026-08-25T14:00:00Z"));
});

test("two legacy labels for the same week collapse instead of crashing the app", () => {
  // A week straddling new year was stored as both "2025-W52" and "2026-W00".
  // `cost_overrides.week` is UNIQUE, so re-keying both onto the same Monday
  // with a blind UPDATE threw, the version never advanced, and the app failed
  // to start on every launch from then on.
  const old = new DatabaseSync(":memory:");
  old.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      lastName TEXT, documentType TEXT, docId TEXT, tag TEXT, createdAt TEXT);
    CREATE TABLE crops (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      type TEXT, variety TEXT, dimension REAL, createdAt TEXT);
    CREATE TABLE pickups (id INTEGER PRIMARY KEY AUTOINCREMENT, personId INTEGER,
      cropId INTEGER, weight REAL NOT NULL, date TEXT, createdAt TEXT);
    CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1), cropType TEXT,
      label TEXT, unit TEXT, yieldUnit TEXT, costPerUnit REAL);
    CREATE TABLE cost_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT,
      week TEXT UNIQUE, costPerUnit REAL);
    INSERT INTO cost_overrides (week,costPerUnit) VALUES ('2025-W52',900);
    INSERT INTO cost_overrides (week,costPerUnit) VALUES ('2026-W00',880);
    INSERT INTO cost_overrides (week,costPerUnit) VALUES ('2026-W34',950);
    PRAGMA user_version = 1;
  `);
  const upgraded = createSqliteRepository(nodeSqlite(old));
  upgraded.init();

  const rows = upgraded.overrides.all();
  assert.deepEqual(
    rows.map((r) => r.week).sort(),
    ["2025-12-29", "2026-08-24"],
    "both halves of the straddling week became one Monday",
  );
  assert.equal(upgraded.costForWeek("2026-08-24", 800), 950);
});

// ---- Pickups ------------------------------------------------------------

test("a weighing inside a live settlement cannot be edited or deleted", () => {
  const p = aWorker();
  aPlot();
  const pk = repo.pickups.add({
    personId: p,
    cropId: 1,
    weight: 50,
    date: at(2),
  }).lastInsertRowId;

  assert.equal(repo.pickups.isSettled(pk), false);
  settleAll(p);
  assert.equal(repo.pickups.isSettled(pk), true);

  assert.throws(() => repo.pickups.setWeight(pk, 45), /SETTLED/);
  assert.throws(() => repo.pickups.remove(pk), /SETTLED/);
});

test("voiding the settlement makes its weighings editable again", () => {
  const p = aWorker();
  aPlot();
  const pk = repo.pickups.add({
    personId: p,
    cropId: 1,
    weight: 50,
    date: at(2),
  }).lastInsertRowId;
  const s = settleAll(p)!;
  repo.payments.voidSettlement(s.settlementId, "mal pesada");

  repo.pickups.setWeight(pk, 45);
  assert.equal(repo.workerReports.stats(p)?.kg, 45);
});

test("a weight that is not a positive number is refused", () => {
  const p = aWorker();
  aPlot();
  const pk = repo.pickups.add({
    personId: p,
    cropId: 1,
    weight: 50,
    date: at(2),
  }).lastInsertRowId;
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => repo.pickups.setWeight(pk, bad), /BADWEIGHT/);
});

test("correcting a weighing that is not there is an error, not a success", () => {
  assert.throws(() => repo.pickups.setWeight(9999, 40), /NOTFOUND/);
});

// ---- The right weight on the wrong person -------------------------------
//
// The commonest mistake at a scale and, until `setPerson`, the only one with
// no path back: the number is plausible, the plot is plausible and the day is
// today, so no review rule ever mentions it. Somebody is paid short and the
// pesador is the one who has to explain it.

test("a weighing moves to the person it belonged to, with its kilos", () => {
  const ana = aWorker("Ana");
  const beto = aWorker("Beto");
  aPlot();
  const pk = repo.pickups.add({
    personId: ana,
    cropId: 1,
    weight: 85,
    date: at(0),
  }).lastInsertRowId;

  repo.pickups.setPerson(pk, beto);

  assert.equal(repo.workerReports.stats(ana)?.kg ?? 0, 0, "it left Ana whole");
  assert.equal(repo.workerReports.stats(beto)?.kg, 85, "and arrived at Beto whole");
  // The farm picked 85 kg either way: a reassignment is not a correction of
  // how much was harvested.
  assert.equal(repo.reports.totals()?.kg, 85);
  assert.equal(repo.reports.totals()?.pickups, 1);
});

test("the server hears about a reassignment like any other correction", () => {
  // Nothing about this needs a new message: `updatedAt` moves, the outbox
  // trigger fires, and the wire projection already sends `personId` as the
  // worker's uuid.
  const ana = aWorker("Ana");
  const beto = aWorker("Beto");
  aPlot();
  const pk = repo.pickups.add({
    personId: ana,
    cropId: 1,
    weight: 85,
    date: at(0),
  }).lastInsertRowId;
  const before = repo.sync.pending().find((e) => e.entity === "pickups")!;

  repo.pickups.setPerson(pk, beto);

  const after = repo.sync.pending().find((e) => e.entity === "pickups")!;
  assert.equal(after.entityUuid, before.entityUuid, "the same weighing, corrected");
  assert.ok(after.revision > before.revision, "and the queue knows it changed again");
});

test("a paid weighing cannot be moved to somebody else either", () => {
  // The same reason `setWeight` refuses: its price is frozen and cash has
  // changed hands against it. Void the settlement first — that is a decision
  // for a person, not a side effect of tapping a name.
  const ana = aWorker("Ana");
  const beto = aWorker("Beto");
  aPlot();
  const pk = repo.pickups.add({
    personId: ana,
    cropId: 1,
    weight: 50,
    date: at(2),
  }).lastInsertRowId;
  settleAll(ana);

  assert.throws(() => repo.pickups.setPerson(pk, beto), /SETTLED/);
  assert.equal(repo.workerReports.stats(ana)?.kg, 50, "and nothing moved");
});

test("a weighing is never handed to somebody who is not on the farm", () => {
  const ana = aWorker("Ana");
  const gone = aWorker("Beto");
  aPlot();
  const pk = repo.pickups.add({
    personId: ana,
    cropId: 1,
    weight: 50,
    date: at(0),
  }).lastInsertRowId;
  repo.people.remove(gone);

  assert.throws(() => repo.pickups.setPerson(pk, gone), /NOPERSON/);
  assert.throws(() => repo.pickups.setPerson(pk, 9999), /NOPERSON/);
  assert.throws(() => repo.pickups.setPerson(9999, ana), /NOTFOUND/);
  assert.equal(repo.workerReports.stats(ana)?.kg, 50);
});

// ---- What this person usually carries -----------------------------------

test("a person's usual load is their own history, and says how much of it there is", () => {
  const ana = aWorker("Ana");
  aPlot();
  assert.deepEqual(repo.pickups.typical(ana), { avgWeight: 0, samples: 0 });

  for (const w of [70, 80, 90])
    repo.pickups.add({ personId: ana, cropId: 1, weight: w, date: at(1) });

  assert.deepEqual(repo.pickups.typical(ana), { avgWeight: 80, samples: 3 });
});

test("a discarded weighing stops counting as what somebody usually carries", () => {
  // Otherwise the 850 that was thrown away goes on inflating the reference
  // that is supposed to catch the next one.
  const ana = aWorker("Ana");
  aPlot();
  for (const w of [70, 80, 90])
    repo.pickups.add({ personId: ana, cropId: 1, weight: w, date: at(1) });
  const bad = repo.pickups.add({
    personId: ana,
    cropId: 1,
    weight: 800,
    date: at(0),
  }).lastInsertRowId;
  assert.equal(repo.pickups.typical(ana).samples, 4);

  repo.pickups.remove(bad);
  assert.deepEqual(repo.pickups.typical(ana), { avgWeight: 80, samples: 3 });
});

test("a settlement's lines carry the day each load was weighed", () => {
  // Without it the receipt can only say «this week: 155 kg», which is a
  // figure a picker has to take on trust. With it the paper says «Tuesday,
  // 85 and 70», which is two loads somebody watched go on the scale.
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 85, date: at(2) });
  repo.pickups.add({ personId: p, cropId: 1, weight: 70, date: at(2) });
  const s = settleAll(p)!;

  const items = repo.payments.itemsOf(s.settlementId);
  assert.equal(items.length, 2);
  for (const i of items)
    assert.equal(i.localDay, dayInZone(at(2), "America/Bogota"), "each line knows its day");
});

test("recent weighings carry who and where, so a row can be corrected from the list", () => {
  // «Actividad reciente» is the only screen that ever shows the right weight
  // on the wrong person again. A row that cannot say whose it is cannot open
  // a dialog that reassigns it.
  const ana = aWorker("Ana");
  const cropId = aPlot();
  repo.pickups.add({ personId: ana, cropId, weight: 85, date: at(0) });

  const [row] = repo.pickups.recent();
  assert.equal(row.personId, ana);
  assert.equal(row.cropId, cropId);
  assert.equal(row.person, "Ana Rodríguez");
});

// ---- Settle, pay, void, undo -------------------------------------------

test("settling freezes the price, so a later override cannot move paid money", () => {
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });
  const week = repo.reports.byWeek()[0].label;
  repo.overrides.set(week, 900);

  const s = settleAll(p)!;
  assert.equal(s.grossCents, money(50 * 900));

  repo.overrides.set(week, 1200); // the owner changes their mind afterwards
  const items = repo.payments.itemsOf(s.settlementId);
  assert.equal(items[0].costPerUnitCents, money(900));
  assert.equal(repo.payments.balance(p).balanceCents, money(50 * 900));
});

test("settling with nothing pending writes no document at all", () => {
  const p = aWorker();
  aPlot();
  assert.equal(settleAll(p), null);
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });
  assert.ok(settleAll(p));
  assert.equal(settleAll(p), null, "the second run has nothing left to claim");
  assert.equal(repo.payments.settlements(p).length, 1);
});

test("a weighing that arrives late rolls into the next settlement, once", () => {
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(9) });
  const first = settleAll(p)!;
  // Somebody enters Tuesday's sack on Friday, for a week already paid.
  repo.pickups.add({ personId: p, cropId: 1, weight: 20, date: at(8) });
  const second = settleAll(p)!;

  assert.equal(first.grossCents, money(50 * 800));
  assert.equal(second.grossCents, money(20 * 800));
  assert.equal(
    repo.payments.balance(p).earnedCents,
    money(70 * 800),
    "the late sack is earned once, not twice and not never",
  );
});

test("voiding releases the weighings and reverses the earning", () => {
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });
  const s = settleAll(p)!;
  repo.payments.voidSettlement(s.settlementId, "anulada");

  assert.equal(repo.payments.balance(p).balanceCents, 0);
  assert.equal(
    repo.payments.preview(p, "1970-01-01", "2099-12-31", 800).grossCents,
    money(50 * 800),
    "the work is pending again",
  );
  assert.equal(repo.payments.itemsOf(s.settlementId).length, 0, "lines voided");
  assert.equal(
    (raw.prepare("SELECT COUNT(*) AS n FROM settlement_items").get() as {
      n: number;
    }).n,
    1,
    "but kept for the record, so the annulled document can still be read",
  );
});

test("undoing a payroll run reverses the payment and voids the settlement together", () => {
  // The whole run is one transaction. Voiding used to open a second BEGIN
  // inside the first, and SQLite has no nested BEGIN: the inner rollback threw
  // away the reversals just written and the Deshacer button did nothing
  // (`movil.md` §9.1).
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });
  const s = settleAll(p)!;
  const owed = repo.payments.balance(p).balanceCents;
  const payId = repo.payments.pay(p, owed, { settlementId: s.settlementId });

  repo.payments.undoRun([payId], [s.settlementId], "deshacer");

  assert.equal(repo.payments.balance(p).balanceCents, 0);
  const status = raw
    .prepare("SELECT status FROM settlements WHERE id = ?")
    .get(s.settlementId) as { status: string };
  assert.equal(status.status, "void");
  assert.equal(
    repo.payments.preview(p, "1970-01-01", "2099-12-31", 800).grossCents,
    money(50 * 800),
    "the work goes back on the pending list",
  );
});

test("voiding a settlement whose devengo was already reversed does not leave the document half-done", () => {
  // `movil.md` §9: `voidSettlement` posts a `reverso` of the `devengo`, and
  // `ux_ledger_reverses` is UNIQUE on `reversesId`. If something already
  // reversed that devengo, the INSERT collides, the whole transaction rolls
  // back, and the settlement stays `open` with its payables still locked —
  // the worst possible outcome, because the money was already cancelled and
  // the work is now unpayable.
  //
  // Nothing on the phone calls `reverse` on a devengo today. The feed does:
  // §5.4 is somebody voiding on the web, and what comes down is the void, the
  // released lines AND the reverso (`syncStore.applyLedgerEntry`). The moment
  // that lands, a Deshacer on this phone hits exactly this.
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });
  const s = settleAll(p)!;
  assert.equal(repo.payments.balance(p).balanceCents, money(40000));

  // The reverso that arrived from somewhere else.
  repo.payments.reverse(s.ledgerId, "reversado en la web");
  assert.equal(repo.payments.balance(p).balanceCents, 0);

  repo.payments.voidSettlement(s.settlementId, "anulada");

  const row = raw
    .prepare("SELECT status, voidedAt FROM settlements WHERE id = ?")
    .get(s.settlementId) as { status: string; voidedAt: string | null };
  assert.equal(row.status, "void", "the document ended up voided, not half-done");
  assert.ok(row.voidedAt);
  assert.equal(repo.payments.itemsOf(s.settlementId).length, 0, "the lines were released");

  // The earning was cancelled ONCE. A second reverso would have taken the
  // worker 40.000 into debt for work they really did.
  assert.equal(repo.payments.balance(p).balanceCents, 0);
  assert.equal(
    repo.payments.history(p).filter((e) => e.kind === "reverso").length,
    1,
    "a single reverso per devengo, which is what the index says",
  );

  // And the work is payable again, which is the whole reason to void.
  assert.equal(
    repo.payments.preview(p, "1970-01-01", "2099-12-31", 800).grossCents,
    money(40000),
  );
});

test("undoing a payroll whose devengo was already reversed does not take the rest of the payroll down", () => {
  // The same collision, reached the way the field reaches it: the Deshacer
  // button. `undoRun` is one transaction for the whole crew, so one worker
  // whose devengo came back reversed from the web used to roll back every
  // other worker's reversal too.
  const ana = aWorker("Ana");
  const juan = aWorker("Juan");
  aPlot();
  repo.pickups.add({ personId: ana, cropId: 1, weight: 50, date: at(2) });
  repo.pickups.add({ personId: juan, cropId: 1, weight: 30, date: at(2) });
  const sa = settleAll(ana)!;
  const sj = settleAll(juan)!;
  const payA = repo.payments.pay(ana, repo.payments.balance(ana).balanceCents);
  const payJ = repo.payments.pay(juan, repo.payments.balance(juan).balanceCents);

  repo.payments.reverse(sa.ledgerId, "reversado en la web");

  repo.payments.undoRun([payA, payJ], [sa.settlementId, sj.settlementId], "deshacer");

  for (const id of [sa.settlementId, sj.settlementId]) {
    const row = raw.prepare("SELECT status FROM settlements WHERE id = ?").get(id) as {
      status: string;
    };
    assert.equal(row.status, "void", `settlement ${id} ended up voided`);
  }
  // Ana: devengo + reverso (web) + pago + reverso of the pago = 0.
  assert.equal(repo.payments.balance(ana).balanceCents, 0);
  assert.equal(repo.payments.balance(juan).balanceCents, 0);
});

// ---- The sheet the crew signs -------------------------------------------

test("the payroll sheet does not fall short when somebody has half a season of movements", () => {
  // `movil.md` §9.6: the sheet asked for each worker's last FIFTY movements
  // and filtered them by date afterwards. A recolector past their fiftieth
  // movement of the season had this week's payment fall off the end of the
  // window and printed as if they had been handed nothing — on the document
  // they sign.
  const p = aWorker();
  aPlot();

  // The crew was paid on Monday. Sixty movements have been recorded since —
  // a real season reaches that in an afternoon of advances.
  const monday = at(5).slice(0, 10);
  repo.payments.pay(p, money(25000), { date: monday });
  for (let i = 0; i < 60; i++) repo.payments.advance(p, money(1000), `anticipo ${i}`);

  const today0 = at(0).slice(0, 10);
  const sheet = new Map(
    repo.payments.paidInRange(monday, today0).map((r) => [r.personId, r.cents]),
  );
  assert.equal(sheet.get(p), money(25000), "the week's payment shows up on the sheet");

  // And what the old loop found, for the record: nothing. Sixty movements are
  // newer than the payment, and the window was fifty rows deep.
  const truncated = repo.payments
    .history(p, 50)
    .filter((h) => h.kind === "pago" && h.date >= monday);
  assert.equal(truncated.length, 0, "which is exactly the bug");
});

test("a week's payroll sheet does not count what was paid afterwards", () => {
  // The other half: the sheet is titled with a week's dates, and the old
  // filter had no upper bound, so printing an old week's sheet swept in
  // everything paid since under that heading.
  const p = aWorker();
  aPlot();
  repo.payments.pay(p, money(10000), { date: "2026-08-24" });
  repo.payments.pay(p, money(99000), { date: "2026-09-02" });

  const week = new Map(
    repo.payments.paidInRange("2026-08-24", "2026-08-30").map((r) => [r.personId, r.cents]),
  );
  assert.equal(week.get(p), money(10000));
});

test("whoever was not paid this week is off the sheet, and whoever was appears exactly once", () => {
  const ana = aWorker("Ana");
  const juan = aWorker("Juan");
  aPlot();
  repo.payments.pay(ana, money(10000), { date: "2026-08-25" });
  repo.payments.pay(ana, money(5000), { date: "2026-08-27" });

  const rows = repo.payments.paidInRange("2026-08-24", "2026-08-30");
  assert.equal(rows.length, 1, "one row per person");
  assert.equal(rows[0].personId, ana);
  assert.equal(rows[0].cents, money(15000), "added up, not the last one");
  assert.ok(!rows.some((r) => r.personId === juan));
});

// ---- What comes in over the scale ---------------------------------------

test("an absurd weighing is refused on the way in, not only on the way to fixing it", () => {
  // `movil.md` §9.10: `setWeight` refused a zero, a NaN and an Infinity;
  // `add` refused nothing. The asymmetry meant a bad weight could only be
  // caught on the way OUT, by the review screen, after it had already counted
  // towards somebody's pay.
  const p = aWorker();
  aPlot();
  for (const bad of [0, -5, NaN, Infinity]) {
    assert.throws(
      () => repo.pickups.add({ personId: p, cropId: 1, weight: bad, date: at(1) }),
      /BADWEIGHT/,
      `${bad} entró`,
    );
  }
  assert.equal(repo.reports.totals()!.pickups, 0);

  // And a weight that is merely SUSPICIOUS still goes in: 200 kg is over the
  // `impossible` threshold, and that is a question for a person, not a
  // rejection at the door — refusing it would lose work that was really done.
  repo.pickups.add({ personId: p, cropId: 1, weight: 200, date: at(1) });
  assert.equal(repo.reports.totals()!.pickups, 1);
  assert.ok(repo.anomalies.all().some((a) => a.rule === "impossible"));
});

test("the front page counts the people there are, not the people there were", () => {
  // `movil.md` §9.11: Home read `SELECT COUNT(*) FROM people`, so a farm that
  // had let people go showed one number on the front page and another in the
  // list on the next screen.
  const stays = aWorker("Ana");
  const goes = aWorker("Juan");
  const plot = aPlot();
  aPlot("Lote 2");
  repo.pickups.add({ personId: stays, cropId: plot, weight: 10, date: at(1) });
  repo.pickups.add({ personId: goes, cropId: plot, weight: 10, date: at(1) });

  // A movement, so the balances list has a reason to hold him.
  repo.payments.advance(goes, money(5000), "adelanto del martes");

  repo.people.remove(goes);
  repo.crops.remove(2);

  const t = repo.reports.totals()!;
  assert.equal(t.people, repo.people.all().length, "the front page and the list, the same number");
  assert.equal(t.people, 1);
  assert.equal(t.crops, repo.crops.all().length);
  assert.equal(t.crops, 1);

  // The kilos do NOT drop: the work happened and somebody was paid for it.
  assert.equal(t.kg, 20);
  assert.equal(t.pickups, 2);

  // And money is still never hidden, only marked — that exception stands.
  const row = repo.payments.balances().find((b) => b.personId === goes);
  assert.ok(row, "the balance of whoever left is still there");
  assert.equal(row.inactive, 1, "marked, not hidden");
  assert.equal(row.balanceCents, -money(5000));
});

// ---- The crew's payroll, and the Deshacer button ------------------------

test("a settlement with no cash to hand over is still within reach of «Deshacer»", () => {
  // `movil.md` §9: the payroll button settled the worker, then read the
  // balance, and only recorded the settlement if a payment followed. An
  // advance bigger than the week means the balance comes out at zero — the
  // document is committed, the payables are locked, and «Deshacer» never
  // heard about it. Undoing it meant editing the ledger by hand.
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });
  repo.payments.advance(p, money(40000), "el miércoles");

  const run = repo.payments.runPayroll([p], "1970-01-01", "2099-12-31", 800);

  assert.equal(run.paid, 0, "there was no cash to hand over");
  assert.equal(run.noCash, 1);
  assert.equal(run.failed, 0);
  assert.equal(run.paymentIds.length, 0);
  assert.equal(run.settlementIds.length, 1, "but the settlement exists and has to be reachable");
  assert.equal(repo.payments.balance(p).balanceCents, 0);

  // And the button reaches it.
  repo.payments.undoRun(run.paymentIds, run.settlementIds, "deshacer");
  const row = raw
    .prepare("SELECT status FROM settlements WHERE id = ?")
    .get(run.settlementIds[0]) as { status: string };
  assert.equal(row.status, "void");
  // Back to where the crew started: the advance still owed, the work pending.
  assert.equal(repo.payments.balance(p).balanceCents, -money(40000));
  assert.equal(
    repo.payments.preview(p, "1970-01-01", "2099-12-31", 800).grossCents,
    money(40000),
    "the weighing goes back on the pending list",
  );
});

test("a negative balance does not hide its settlement either", () => {
  // The other half of "zero or negative": the advance is bigger than the week,
  // so the worker still owes after settling. Same trap, same fix.
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 10, date: at(2) });
  repo.payments.advance(p, money(50000), "adelanto grande");

  const run = repo.payments.runPayroll([p], "1970-01-01", "2099-12-31", 800);
  assert.equal(run.noCash, 1);
  assert.equal(run.settlementIds.length, 1);
  assert.ok(repo.payments.balance(p).balanceCents < 0);

  repo.payments.undoRun(run.paymentIds, run.settlementIds, "deshacer");
  assert.equal(repo.payments.balance(p).balanceCents, -money(50000));
});

test("a worker with nothing pending creates no document at all", () => {
  // The other branch of noCash, and the one that must NOT record anything:
  // `settle` returns null and no row was written, so there is nothing to undo.
  const p = aWorker();
  const run = repo.payments.runPayroll([p], "1970-01-01", "2099-12-31", 800);
  assert.equal(run.noCash, 1);
  assert.equal(run.settlementIds.length, 0);
  assert.equal(
    (raw.prepare("SELECT COUNT(*) AS n FROM settlements").get() as { n: number }).n,
    0,
  );
});

test("the payroll pays what the ledger says, not the week's gross", () => {
  // Three workers, one of them with an advance. The one with the advance takes
  // home the difference, not the gross — paying the gross would hand the
  // advance over a second time, for the whole crew at once.
  const ana = aWorker("Ana");
  const juan = aWorker("Juan");
  const luz = aWorker("Luz");
  aPlot();
  for (const p of [ana, juan, luz])
    repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });
  repo.payments.advance(juan, money(10000), "el martes");

  const run = repo.payments.runPayroll([ana, juan, luz], "1970-01-01", "2099-12-31", 800);

  assert.equal(run.paid, 3);
  assert.equal(run.noCash, 0);
  assert.equal(run.failed, 0);
  assert.equal(run.settlementIds.length, 3);
  assert.equal(run.paymentIds.length, 3);
  assert.equal(run.paidCents, money(40000) + money(30000) + money(40000));
  for (const p of [ana, juan, luz])
    assert.equal(repo.payments.balance(p).balanceCents, 0);

  // Every payment points at the document it settles, so the receipt is a
  // lookup and not a guess over dates (§9.3).
  for (const id of run.settlementIds)
    assert.ok(repo.payments.paidAgainst(id) > 0);
});

test("one worker failing does not take the rest of the crew down with them", () => {
  const ana = aWorker("Ana");
  const ghost = 9999; // nobody: the FK on settlements.personId refuses it
  const luz = aWorker("Luz");
  aPlot();
  repo.pickups.add({ personId: ana, cropId: 1, weight: 50, date: at(2) });
  repo.pickups.add({ personId: ghost, cropId: 1, weight: 50, date: at(2) });
  repo.pickups.add({ personId: luz, cropId: 1, weight: 50, date: at(2) });

  const run = repo.payments.runPayroll([ana, ghost, luz], "1970-01-01", "2099-12-31", 800);

  assert.equal(run.failed, 1);
  assert.equal(run.paid, 2, "Ana and Luz got paid all the same");
  assert.equal(repo.payments.balance(ana).balanceCents, 0);
  assert.equal(repo.payments.balance(luz).balanceCents, 0);
});

test("undoing the same run twice is safe — the button can be tapped again", () => {
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });
  const s = settleAll(p)!;
  const payId = repo.payments.pay(p, repo.payments.balance(p).balanceCents);

  repo.payments.undoRun([payId], [s.settlementId], "deshacer");
  const after = repo.payments.history(p).length;
  repo.payments.undoRun([payId], [s.settlementId], "deshacer otra vez");

  assert.equal(repo.payments.balance(p).balanceCents, 0);
  assert.equal(repo.payments.history(p).length, after, "nothing double-undone");
});

test("an advance is netted out of the week, not handed over twice", () => {
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });
  repo.payments.advance(p, money(10000), "miércoles");
  settleAll(p);

  const b = repo.payments.balance(p);
  assert.equal(b.earnedCents, money(40000), "50 kg at 800");
  assert.equal(b.balanceCents, money(30000), "40.000 earned less the 10.000 advanced");
  assert.equal(b.paidCents, money(10000), "the advance already counts as handed over");
});

test("the earning is dated today, never in the future, when paying mid-week", () => {
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(1) });
  repo.payments.settle(p, "1970-01-01", "2099-12-31", 800);
  const devengo = repo.payments.history(p)[0];
  assert.ok(
    devengo.date <= new Date().toISOString().slice(0, 10),
    `devengo dated ${devengo.date}`,
  );
});

test("cash out has to be a positive amount; the sign belongs to the ledger", () => {
  const p = aWorker();
  for (const bad of [0, -1, Number.NaN])
    assert.throws(() => repo.payments.pay(p, bad));
  const id = repo.payments.pay(p, money(1000));
  const row = raw
    .prepare("SELECT amountCents FROM ledger WHERE id = ?")
    .get(id) as { amountCents: number };
  assert.equal(row.amountCents, -money(1000));
});

test("a payment can name the settlement it belongs to", () => {
  // Without this the receipt has to guess by date, and with a late week in the
  // mix it counts payments that belonged to an earlier document
  // (`movil.md` §9.3). The column and its index already existed.
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });
  const s = settleAll(p)!;
  const payId = repo.payments.pay(p, money(10000), {
    settlementId: s.settlementId,
  });
  const row = raw
    .prepare("SELECT settlementId FROM ledger WHERE id = ?")
    .get(payId) as { settlementId: number | null };
  assert.equal(row.settlementId, s.settlementId);

  // Still optional: a loose advance payment names nothing, as before.
  const loose = repo.payments.pay(p, money(1000));
  const row2 = raw
    .prepare("SELECT settlementId FROM ledger WHERE id = ?")
    .get(loose) as { settlementId: number | null };
  assert.equal(row2.settlementId, null);
});

// ---- Wiping the farm ----------------------------------------------------

test("wiping the farm needs the farm's name typed out", () => {
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });

  assert.throws(() => repo.demo.clear(), ConfirmationRequired);
  assert.throws(() => repo.demo.clear(""), ConfirmationRequired);
  assert.throws(() => repo.demo.clear("borrar todo"), ConfirmationRequired);
  assert.equal(repo.reports.totals()?.pickups, 1, "nothing was touched");

  repo.demo.clear(repo.demo.clearToken());
  assert.equal(repo.reports.totals()?.pickups, 0);
});

test("loading demo data is guarded too — it begins by wiping", () => {
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });

  assert.throws(() => repo.demo.seed(), ConfirmationRequired);
  assert.equal(repo.reports.totals()?.pickups, 1, "the real season is still there");

  repo.demo.seed("Café");
  assert.ok((repo.reports.totals()?.pickups ?? 0) > 100);
});

test("the token is the farm's own name, and typing it is not a spelling test", () => {
  assert.equal(repo.demo.clearToken(), "Café");
  repo.demo.clear(" cafe "); // no accent, wrong case, stray spaces
  assert.equal(repo.reports.totals()?.people, 0);
});

test("the error says which word is expected, so the screen can ask for it", () => {
  repo.config.save({
    cropType: "cacao",
    label: "Finca La Esperanza",
    unit: "kg",
    yieldUnit: "kg",
    costPerUnit: 800,
  });
  try {
    repo.demo.clear("Café");
    assert.fail("should have refused");
  } catch (e) {
    assert.ok(e instanceof ConfirmationRequired);
    assert.equal(e.expected, "Finca La Esperanza");
  }
});

test("wiping keeps the configuration, so the farm still has a name afterwards", () => {
  aWorker();
  repo.demo.clear("Café");
  assert.equal(repo.config.get()?.label, "Café");
  assert.equal(repo.demo.clearToken(), "Café");
});

// ---- Review rules -------------------------------------------------------

/** Six mates on one plot, one of them carrying an absurd load. */
function aBadDay(daysAgo: number, weight: number) {
  for (let i = 2; i <= 6; i++)
    repo.pickups.add({ personId: i, cropId: 1, weight: 30, date: at(daysAgo) });
  return repo.pickups.add({
    personId: 1,
    cropId: 1,
    weight,
    date: at(daysAgo),
  }).lastInsertRowId;
}

test("the review rules still fire, one line per weighing, worst rule first", () => {
  for (let i = 1; i <= 6; i++) aWorker(`P${i}`);
  aPlot();
  const pk = aBadDay(3, 900); // impossible AND an outlier AND an extra zero

  const found = repo.anomalies.all();
  assert.equal(found.length, 1, "one weighing, one finding");
  assert.equal(found[0].pickupId, pk);
  assert.equal(found[0].rule, "impossible", "the worst rule wins");
});

test("a weighing older than the window is no longer reported", () => {
  for (let i = 1; i <= 6; i++) aWorker(`P${i}`);
  aPlot();
  aBadDay(400, 900); // more than a year ago

  assert.equal(repo.anomalies.all().length, 0, "outside the default window");
  assert.equal(
    repo.anomalies.all(120, { sinceDays: 500 }).length,
    1,
    "and still findable if you widen it",
  );
});

test("the window decides what is shown, never what normal looks like", () => {
  // The extra-zero rule measures a load against this person's WHOLE history.
  // Twenty ordinary sacks two years back still set the reference for a bad one
  // weighed yesterday; narrowing the reference to the window would leave the
  // suspect comparing itself against almost nothing.
  const p = aWorker();
  aPlot();
  for (let i = 0; i < 20; i++)
    repo.pickups.add({ personId: p, cropId: 1, weight: 10, date: at(700, 8, i) });
  // Under the impossible threshold on purpose, so it is the extra-zero rule
  // and not the weight cap that has to catch it.
  repo.pickups.add({ personId: p, cropId: 1, weight: 100, date: at(1) });

  const found = repo.anomalies.all();
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, "digit");
  assert.equal(found[0].reference, 10, "the reference is the lifetime average");
});

test("the list is capped, so a broken scale cannot hang the screen", () => {
  const p = aWorker();
  aPlot();
  for (let i = 0; i < 30; i++)
    repo.pickups.add({ personId: p, cropId: 1, weight: 500, date: at(3, 8, i) });

  assert.equal(repo.anomalies.all(120, { limit: 10 }).length, 10);
  assert.equal(repo.anomalies.all().length, 30, "the default cap is generous");
});

test("the newest suspects come first, which is what a review list is for", () => {
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 500, date: at(30) });
  repo.pickups.add({ personId: p, cropId: 1, weight: 500, date: at(1) });

  const found = repo.anomalies.all();
  assert.equal(found.length, 2);
  assert.ok(found[0].date > found[1].date);
});

test("a double tap and a weighing dated tomorrow are both caught", () => {
  const p = aWorker();
  aPlot();
  const stamp = at(2);
  // Raw, so both rows share a createdAt to the millisecond — which is what a
  // double tap is. The farm's day and week are stamped by hand for the same
  // reason `pickups.add` stamps them: a weighing with none is invisible to
  // every query that groups by a week.
  const stampDay = dayInZone(stamp);
  const stampWeek = weekInZone(stamp);
  for (let i = 0; i < 2; i++)
    raw
      .prepare(
        `INSERT INTO pickups (personId,cropId,weight,date,createdAt,localDay,week)
         VALUES (?,1,47,?,?,?,?)`,
      )
      .run(p, stamp, stamp, stampDay, stampWeek);
  repo.pickups.add({ personId: p, cropId: 1, weight: 40, date: at(-3) });

  const rules = repo.anomalies.all().map((a) => a.rule);
  assert.ok(rules.includes("duplicate"), `got ${rules.join(",")}`);
  assert.ok(rules.includes("future"), `got ${rules.join(",")}`);
});

// ---- Everything else the screens call ----------------------------------

test("a card already carried by somebody else can be found — PeopleAdd warns on it", () => {
  aWorker("Ana");
  assert.ok(repo.people.byTag("T1"));
  assert.equal(repo.people.byTag("T9"), null);
});

test("removing a worker hides them but keeps their harvest and their money", () => {
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });
  settleAll(p);
  repo.people.remove(p);

  assert.equal(repo.people.all().length, 0, "off the active list");
  assert.equal(repo.workerReports.stats(p)?.kg, 50, "the harvest stays");
  const row = repo.payments.balances().find((b) => b.personId === p);
  assert.equal(row?.inactive, 1, "shown as inactive, not hidden");
  assert.equal(row?.balanceCents, money(40000), "money is never hidden");
});

test("the payroll list nets each worker's week at the price of that week", () => {
  const a = aWorker("Ana");
  const b = aWorker("Beto");
  aPlot();
  repo.pickups.add({ personId: a, cropId: 1, weight: 50, date: at(2) });
  repo.pickups.add({ personId: b, cropId: 1, weight: 20, date: at(2) });
  const week = repo.reports.byWeek()[0].label;
  repo.overrides.set(week, 900);

  const pending = repo.payments.pendingAll(800);
  assert.deepEqual(
    pending.map((r) => [r.personId, r.kg, r.amountCents]),
    [
      [a, 50, money(45000)],
      [b, 20, money(18000)],
    ],
    "sorted by what is owed, priced by the week's override",
  );
});

test("the payroll list rounds per weighing, like the settlement it precedes", () => {
  // The numbers of golden case 06, asked the way the payroll panel asks.
  //
  // `settle` rounds each weighing and sums integers, which is the rule the
  // corpus exists to pin: the receipt the worker checks has to add up line by
  // line. `pendingAll` used to SUM the week's kilos first and round once, so
  // the figure the foreman read before tapping "pay everyone" was two cents
  // away from the figure the settlement then posted. The corpus never caught
  // it because it only ever pinned `settle`, and `pendingAll` lived in the
  // half of `db.ts` that could not be imported into a test.
  const p = aWorker("Pedro");
  aPlot();
  for (const q of [2.5, 4.5, 1.5, 0.5])
    repo.pickups.add({ personId: p, cropId: 1, weight: q, date: at(2) });

  const rate = 83.33; // 8.333 cents per kilo
  const shown = repo.payments.pendingAll(rate).find((r) => r.personId === p)!;
  const posted = repo.payments.settle(p, "1970-01-01", "2099-12-31", rate)!;

  assert.equal(posted.grossCents, 74999, "per line, as golden case 06 says");
  assert.equal(
    shown.amountCents,
    posted.grossCents,
    "the panel must announce what the settlement will post",
  );
  assert.equal(shown.kg, 9);
});

test("the payroll list still prices each week with its own rate", () => {
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 10, date: at(3) });
  repo.pickups.add({ personId: p, cropId: 1, weight: 20, date: at(10) });
  const [thisWeek, lastWeek] = repo.reports.byWeek().map((r) => r.label);
  repo.overrides.set(thisWeek, 900);
  repo.overrides.set(lastWeek, 700);

  const shown = repo.payments.pendingAll(800).find((r) => r.personId === p)!;
  assert.equal(shown.kg, 30);
  assert.equal(shown.amountCents, money(10 * 900 + 20 * 700));
});

test("the CSV export is the season, and it survives being asked for", () => {
  const p = aWorker();
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(2) });
  settleAll(p);
  repo.payments.pay(p, money(10000));

  assert.equal(repo.export.pickups().length, 1);
  assert.equal(repo.export.ledger().length, 2);
  assert.equal(repo.export.balances().length, 1);
});

// ---- What a receipt says was handed over (movil.md §9.3) ----------------

test("a receipt counts the payments made against ITS settlement, not the ones before", () => {
  // The shape `movil.md` §9.3 describes, and it is not exotic: weeks run
  // behind, so a settlement's `periodStart` is the Monday of the oldest
  // UNSETTLED week, which can be months back. The receipt then filtered
  // payments by `date >= periodStart` and swept in money handed over for
  // documents that were closed long before.
  const person = aWorker();
  const plot = aPlot();
  const weeksBack = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n * 7);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  };

  repo.pickups.add({ personId: person, cropId: plot, weight: 100, date: weeksBack(8) });
  repo.pickups.add({ personId: person, cropId: plot, weight: 50, date: weeksBack(0) });

  const first = settleAll(person)!;
  repo.payments.pay(person, 40000, { method: "efectivo", settlementId: first.settlementId });

  // A load from that same old week turns up late — golden case 09's shape. It
  // rolls into a NEW settlement whose period still starts eight weeks back.
  repo.pickups.add({ personId: person, cropId: plot, weight: 10, date: weeksBack(8) });
  const second = settleAll(person)!;
  repo.payments.pay(person, 10000, { method: "efectivo", settlementId: second.settlementId });

  const s2 = repo.payments.settlements(person)[0]!;
  assert.equal(s2.id, second.settlementId);
  // The old rule, spelled out, so the test says what it is protecting against.
  const byTheOldGuess = repo.payments
    .history(person)
    .filter((r) => r.kind === "pago" && r.date >= s2.periodStart)
    .reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
  assert.equal(byTheOldGuess, 50000, "the guess still overstates, as it always did");

  assert.equal(repo.payments.paidAgainst(second.settlementId), 10000);
  assert.equal(repo.payments.paidAgainst(first.settlementId), 40000);
});

test("a payment written before the link existed is still attributed by date", () => {
  // Phones in the field are carrying payments with `settlementId` null. They
  // cannot be re-linked — nothing records what they were for — so the date
  // guess stays as the fallback, and only as the fallback.
  const person = aWorker();
  const plot = aPlot();
  const day = new Date();
  day.setDate(day.getDate() - 2);
  repo.pickups.add({ personId: person, cropId: plot, weight: 100, date: day.toISOString() });
  const s = settleAll(person)!;
  // Exactly what the old screens wrote.
  repo.payments.pay(person, 30000, { method: "efectivo" });

  assert.equal(repo.payments.paidAgainst(s.settlementId), 30000);
});

test("an unlinked payment predating the settlement is not counted into it", () => {
  // The narrowing the fix buys even for old rows: a payment can only be
  // against a document that already existed when it was made. The old rule
  // compared against `periodStart`, which is the start of the WORK, not of the
  // document, and that is the whole of §9.3.
  const person = aWorker();
  const plot = aPlot();
  const old = new Date();
  old.setDate(old.getDate() - 40);
  repo.pickups.add({ personId: person, cropId: plot, weight: 100, date: old.toISOString() });

  // An advance handed over 40 days ago, recorded as a payment by an old build.
  repo.payments.pay(person, 5000, { method: "efectivo", date: "2000-01-01" });

  const s = settleAll(person)!;
  assert.equal(
    repo.payments.paidAgainst(s.settlementId),
    0,
    "money handed over before the document existed was not paid against it",
  );
});

test("paidAgainst does not reach across workers", () => {
  const ana = aWorker("Ana");
  const juan = aWorker("Juan");
  const plot = aPlot();
  const day = new Date();
  day.setDate(day.getDate() - 2);
  repo.pickups.add({ personId: ana, cropId: plot, weight: 100, date: day.toISOString() });
  repo.pickups.add({ personId: juan, cropId: plot, weight: 100, date: day.toISOString() });
  const sa = settleAll(ana)!;
  settleAll(juan);
  repo.payments.pay(juan, 70000, { method: "efectivo" });

  assert.equal(repo.payments.paidAgainst(sa.settlementId), 0);
});

// ---- «People with a standing, not active people» — §9.11 ----------------

test("the ranking still adds up to the farm when somebody leaves, and it says so", () => {
  // The dilemma `movil.md` §9.11 left open: excluding removed workers made
  // the ranking stop adding up to the farm total printed above it, and
  // including them silently made a name in a list read as somebody still
  // here.
  //
  // The server had the same argument on `ListBalances` and settled it: «the
  // rule is not "active people" but "people with a position"», plus an
  // `active` column so the caller renders the difference. A picker with kilos
  // has a position. So nothing is filtered and the row carries the mark.
  const stays = aWorker("Ana");
  const goes = aWorker("Juan");
  const plot = aPlot();
  const retired = aPlot("Lote viejo");

  repo.pickups.add({ personId: stays, cropId: plot, weight: 30, date: at(2) });
  repo.pickups.add({ personId: goes, cropId: retired, weight: 20, date: at(2) });

  repo.people.remove(goes);
  repo.crops.remove(retired);

  const farmKg = repo.reports.totals()!.kg;
  assert.equal(farmKg, 50);

  const byWorker = repo.reports.byWorker(800);
  assert.equal(
    byWorker.reduce((s, r) => s + r.kg, 0),
    farmKg,
    "the per-picker ranking adds up to the whole farm",
  );
  assert.equal(byWorker.find((r) => r.id === stays)!.active, 1);
  assert.equal(byWorker.find((r) => r.id === goes)!.active, 0, "marcado, no escondido");

  // And the crop tab of the same card, which used to filter and therefore did
  // NOT add up — two tabs of one card contradicting each other, with the
  // kilos of a real harvest in the gap.
  const byCrop = repo.reports.byCrop(800);
  assert.equal(
    byCrop.reduce((s, r) => s + r.kg, 0),
    farmKg,
    "and the per-crop one does too",
  );
  assert.equal(byCrop.find((r) => r.id === retired)!.active, 0);

  // The lots listed under each week are the same list, so they add up to the
  // week they sit under.
  const lots = repo.weekCrops();
  assert.equal(lots.reduce((s, l) => s + l.kg, 0), farmKg);
  assert.ok(lots.some((l) => l.active === 0));

  // What does NOT change: the counts on the front page are still the active
  // list, because "how many people there are" has one honest answer.
  assert.equal(repo.reports.totals()!.people, 1);
  assert.equal(repo.reports.totals()!.crops, 1);
});

// ---- §9.4 and §9.5: written once, checked as once ----------------------

test("the balance breakdown is the same through either door", () => {
  // §9.4. `BALANCE_SQL` and the payroll screen's own list carried the sign
  // table twice, and only one of the two was covered. The copies are gone;
  // this is what would notice if one came back.
  const p = aWorker("Ana");
  aPlot();
  repo.pickups.add({ personId: p, cropId: 1, weight: 50, date: at(3) });
  settleAll(p);
  repo.payments.advance(p, money(3000), "adelanto");
  repo.payments.deduct(p, money(1000), "herramienta");
  repo.payments.pay(p, money(5000), { method: "efectivo" });

  const one = repo.payments.balance(p);
  const inList = repo.payments.balances().find((b) => b.personId === p)!;

  assert.equal(inList.earnedCents, one.earnedCents);
  assert.equal(inList.paidCents, one.paidCents);
  assert.equal(inList.deductedCents, one.deductedCents);
  assert.equal(inList.balanceCents, one.balanceCents);
  assert.equal(inList.lastMovementAt, one.lastMovementAt);
});

test("the harvest's value is a single figure, whichever way you look at it", () => {
  // §9.5. The value was derived two ways — row by row in SQL, and week by
  // week in a JS loop that cost a query per week — and the comment on
  // `byCrop` records what a divergence cost the last time: «the same lote was
  // worth two different amounts». The loop is gone.
  const ana = aWorker("Ana");
  const beto = aWorker("Beto");
  const uno = aPlot("Lote 1");
  const dos = aPlot("Lote 2");

  repo.pickups.add({ personId: ana, cropId: uno, weight: 50, date: at(9) });
  repo.pickups.add({ personId: beto, cropId: dos, weight: 30, date: at(9) });
  repo.pickups.add({ personId: ana, cropId: dos, weight: 20, date: at(2) });

  // Two weeks at two different prices, so a general-price shortcut cannot
  // pass by accident.
  const weeks = repo.reports.byWeek().map((w) => w.label);
  repo.overrides.set(weeks[0]!, 900);
  repo.overrides.set(weeks[1]!, 700);

  const total = repo.totalPayout(800);
  const sumWorkers = repo.reports.byWorker(800).reduce((s, r) => s + r.value, 0);
  const sumCrops = repo.reports.byCrop(800).reduce((s, r) => s + r.value, 0);
  const perWorker =
    repo.workerReports.payout(ana, 800) + repo.workerReports.payout(beto, 800);
  const perCrop = repo.cropReports.value(uno, 800) + repo.cropReports.value(dos, 800);

  for (const [what, v] of [
    ["by picker", sumWorkers],
    ["by plot", sumCrops],
    ["picker by picker", perWorker],
    ["plot by plot", perCrop],
  ] as const)
    assert.equal(v, total, `${what} gives a different figure from the farm total`);

  // And it is the real arithmetic, not zero on both sides.
  assert.ok(total > 0);
});
