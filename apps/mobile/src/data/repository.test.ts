import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlite } from "./nodeSqlite.ts";
import {
  ConfirmationRequired,
  createSqliteRepository,
} from "./sqliteRepository.ts";
import type { Repository } from "./repository.ts";

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
  assert.equal(v.user_version, 5);
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
  repo.init();
  repo.init();
  const v = raw.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(v.user_version, 5);
  assert.equal(repo.reports.totals()?.pickups, 1);
  assert.equal(repo.config.get()?.label, "Café");
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
  assert.equal(v.user_version, 5);
  assert.equal(upgraded.reports.totals()?.pickups, 1, "the season survives");
  assert.equal(upgraded.people.all().length, 1, "deletedAt was added, not reset");
  // The payments half now exists and works.
  assert.equal(upgraded.payments.balance(1).balanceCents, 0);
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
  raw
    .prepare(
      "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,1,47,?,?)",
    )
    .run(p, stamp, stamp);
  raw
    .prepare(
      "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,1,47,?,?)",
    )
    .run(p, stamp, stamp);
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
