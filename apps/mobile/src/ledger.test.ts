import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BASE_SCHEMA, PAYMENTS_SCHEMA, BALANCE_SQL, PENDING_SQL } from "./schema.ts";
import {
  dayInZone,
  weekInZone,
} from "../../../packages/shared/src/time.ts";

// Runs the app's own schema and money SQL under node:sqlite. The point is to
// exercise the statements the app actually executes, not a retyped copy.

let db: DatabaseSync;

const CENT = 100;
const money = (pesos: number) => pesos * CENT;

function post(
  personId: number,
  kind: string,
  amountCents: number,
  opts: { date?: string; settlementId?: number; reversesId?: number } = {},
) {
  db.prepare(
    `INSERT INTO ledger (personId,kind,amountCents,date,settlementId,method,note,reversesId,createdAt)
     VALUES (?,?,?,?,?,NULL,NULL,?,?)`,
  ).run(
    personId,
    kind,
    amountCents,
    opts.date ?? "2026-08-27",
    opts.settlementId ?? null,
    opts.reversesId ?? null,
    "2026-08-27T12:00:00Z",
  );
}

function makeSettlement(id: number, personId = 1) {
  db.prepare(
    `INSERT INTO settlements (id,personId,periodStart,periodEnd,grossCents,status,createdAt)
     VALUES (?,?,'2026-08-24','2026-08-30',0,'open','x')`,
  ).run(id, personId);
}

const balanceOf = (personId: number) =>
  db.prepare(BALANCE_SQL).get(personId, personId) as Record<string, number>;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(BASE_SCHEMA.replace("PRAGMA journal_mode = WAL;", ""));
  db.exec(PAYMENTS_SCHEMA);
  db.prepare("INSERT INTO people (id,name,lastName) VALUES (1,'Ana','R')").run();
  db.prepare("INSERT INTO crops (id,name,dimension) VALUES (1,'Lote 1',2.5)").run();
});

test("paying in full leaves nothing owed", () => {
  post(1, "devengo", money(100000));
  post(1, "pago", -money(100000));
  assert.equal(balanceOf(1).balanceCents, 0);
});

test("paying part of it leaves the rest as the worker's credit", () => {
  post(1, "devengo", money(100000));
  post(1, "pago", -money(40000));
  assert.equal(balanceOf(1).balanceCents, money(60000));
});

test("an advance is owed back and comes off the next settlement", () => {
  post(1, "anticipo", -money(50000)); // handed over on Wednesday
  assert.equal(balanceOf(1).balanceCents, -money(50000));
  post(1, "devengo", money(120000)); // Sunday's harvest
  // The whole point: what is handed over is 70.000, not 120.000.
  assert.equal(balanceOf(1).balanceCents, money(70000));
});

test("an advance bigger than the week still amortises", () => {
  post(1, "anticipo", -money(150000));
  post(1, "devengo", money(100000));
  assert.equal(balanceOf(1).balanceCents, -money(50000));
});

test("a deduction reduces what is owed and is reported apart", () => {
  post(1, "devengo", money(100000));
  post(1, "deduccion", -money(25000)); // meals
  const b = balanceOf(1);
  assert.equal(b.balanceCents, money(75000));
  assert.equal(b.deductedCents, money(25000));
});

test("voiding a settlement after paying leaves the worker owing it back", () => {
  makeSettlement(1);
  post(1, "devengo", money(100000), { settlementId: 1 });
  post(1, "pago", -money(100000));
  assert.equal(balanceOf(1).balanceCents, 0);
  // Voiding reverses the earning; the payment already went out.
  post(1, "reverso", -money(100000), { settlementId: 1, reversesId: 1 });
  assert.equal(balanceOf(1).balanceCents, -money(100000));
});

test("reversals stop counting as earned and as paid", () => {
  makeSettlement(1);
  post(1, "devengo", money(100000), { settlementId: 1 });
  post(1, "pago", -money(100000));
  post(1, "reverso", -money(100000), { reversesId: 1 }); // undo the earning
  post(1, "reverso", money(100000), { reversesId: 2 }); // undo the payment
  const b = balanceOf(1);
  assert.equal(b.balanceCents, 0);
  assert.equal(b.earnedCents, 0, "a voided earning is not earnings");
  assert.equal(b.paidCents, 0, "a reversed payment is not money paid");
});

test("a pickup can only be claimed by one live settlement", () => {
  db.prepare(
    `INSERT INTO pickups (id,personId,cropId,weight,date,localDay,week)
     VALUES (1,1,1,50,'2026-08-25T14:00:00Z',?,?)`,
  ).run(dayInZone("2026-08-25T14:00:00Z"), weekInZone("2026-08-25T14:00:00Z"));
  db.prepare(
    `INSERT INTO settlements (id,personId,periodStart,periodEnd,grossCents,status,createdAt)
     VALUES (1,1,'2026-08-24','2026-08-30',4000000,'open','x')`,
  ).run();
  const line = db.prepare(
    `INSERT INTO settlement_items (settlementId,pickupId,week,weight,costPerUnitCents,amountCents)
     VALUES (?,1,'2026-08-24',50,80000,4000000)`,
  );
  line.run(1);
  assert.throws(() => line.run(1), /UNIQUE/, "the same pickup cannot be settled twice");
});

test("voiding releases the pickup but keeps the line for the record", () => {
  db.prepare(
    `INSERT INTO pickups (id,personId,cropId,weight,date,localDay,week)
     VALUES (1,1,1,50,'2026-08-25T14:00:00Z',?,?)`,
  ).run(dayInZone("2026-08-25T14:00:00Z"), weekInZone("2026-08-25T14:00:00Z"));
  db.prepare(
    `INSERT INTO settlements (id,personId,periodStart,periodEnd,grossCents,status,createdAt)
     VALUES (1,1,'2026-08-24','2026-08-30',4000000,'open','x')`,
  ).run();
  db.prepare(
    `INSERT INTO settlement_items (settlementId,pickupId,week,weight,costPerUnitCents,amountCents)
     VALUES (1,1,'2026-08-24',50,80000,4000000)`,
  ).run();

  db.prepare("UPDATE settlement_items SET voidedAt = 'now' WHERE settlementId = 1").run();

  const kept = db.prepare("SELECT COUNT(*) AS n FROM settlement_items").get() as { n: number };
  assert.equal(kept.n, 1, "the annulled document keeps its detail");

  const pending = db.prepare(PENDING_SQL).all(1, "1970-01-01", "2026-12-31");
  assert.equal(pending.length, 1, "and its pickup goes back to pending");
});

test("a Sunday-evening pickup belongs to the week that is being paid", () => {
  // Stored in UTC, so 19:30 local in Colombia is already Monday for UTC. It
  // used to fall out of the week the panel was settling.
  const sundayEvening = new Date(2026, 7, 30, 19, 30).toISOString();
  // Stamped through the FARM's zone, which is the whole point of v7: it is
  // this derivation, not the handset's offset, that decides the week.
  db.prepare(
    `INSERT INTO pickups (id,personId,cropId,weight,date,localDay,week)
     VALUES (1,1,1,40,?,?,?)`,
  ).run(sundayEvening, dayInZone(sundayEvening), weekInZone(sundayEvening));
  const pending = db.prepare(PENDING_SQL).all(1, "1970-01-01", "2026-08-30") as {
    week: string;
  }[];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].week, "2026-08-24", "and it is priced at that week's rate");
});

// Undoing a whole payroll run. The real bug this covers was structural: the
// undo opened a transaction and then called helpers that opened their own, and
// SQLite has no nested BEGIN, so the run rolled back the reversals it had just
// written. These tests pin down what the undo has to leave behind.

// The statements the undo runs, flat, exactly as db.ts does them now.
function undoRun(paymentIds: number[], settlementIds: number[]) {
  db.exec("BEGIN");
  for (const id of paymentIds) {
    const e = db.prepare("SELECT * FROM ledger WHERE id = ?").get(id) as
      | Record<string, number>
      | undefined;
    if (!e) continue;
    if (db.prepare("SELECT id FROM ledger WHERE reversesId = ?").get(id)) continue;
    post(e.personId, "reverso", -e.amountCents, {
      settlementId: (e.settlementId as number) ?? undefined,
      reversesId: id,
    });
  }
  for (const id of settlementIds) {
    const s = db.prepare("SELECT * FROM settlements WHERE id = ?").get(id) as
      | Record<string, string | number>
      | undefined;
    if (!s || s.status === "void") continue;
    db.prepare("UPDATE settlement_items SET voidedAt = 'x' WHERE settlementId = ?").run(id);
    db.prepare("UPDATE settlements SET status = 'void', voidedAt = 'x' WHERE id = ?").run(id);
    const devengo = db
      .prepare("SELECT id, amountCents FROM ledger WHERE settlementId = ? AND kind = 'devengo'")
      .get(id) as Record<string, number> | undefined;
    if (devengo)
      post(s.personId as number, "reverso", -devengo.amountCents, {
        settlementId: id,
        reversesId: devengo.id,
      });
  }
  db.exec("COMMIT");
}

test("undoing a payroll run puts the worker back where they started", () => {
  makeSettlement(7);
  post(1, "devengo", money(100000), { settlementId: 7 });
  post(1, "pago", -money(100000));
  const payment = db.prepare("SELECT id FROM ledger WHERE kind = 'pago'").get() as {
    id: number;
  };
  assert.equal(balanceOf(1).balanceCents, 0);

  undoRun([payment.id], [7]);

  const after = balanceOf(1);
  assert.equal(after.balanceCents, 0);
  assert.equal(after.earnedCents, 0, "the earning was reversed");
  assert.equal(after.paidCents, 0, "the payment was reversed");
  assert.equal(
    (db.prepare("SELECT status FROM settlements WHERE id = 7").get() as { status: string })
      .status,
    "void",
  );
});

test("running the undo twice changes nothing the second time", () => {
  makeSettlement(7);
  post(1, "devengo", money(100000), { settlementId: 7 });
  post(1, "pago", -money(100000));
  const payment = db.prepare("SELECT id FROM ledger WHERE kind = 'pago'").get() as {
    id: number;
  };

  undoRun([payment.id], [7]);
  const rows = db.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number };
  undoRun([payment.id], [7]);

  assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM ledger").get(), rows);
  assert.equal(balanceOf(1).balanceCents, 0);
});

test("undoing a run releases the pickups so the week can be settled again", () => {
  db.prepare(
    `INSERT INTO pickups (id,personId,cropId,weight,date,localDay,week)
     VALUES (1,1,1,100,'2026-08-25T14:00:00Z',?,?)`,
  ).run(dayInZone("2026-08-25T14:00:00Z"), weekInZone("2026-08-25T14:00:00Z"));
  makeSettlement(7);
  db.prepare(
    `INSERT INTO settlement_items (settlementId,pickupId,week,weight,costPerUnitCents,amountCents)
     VALUES (7,1,'2026-08-24',100,1000,?)`,
  ).run(money(1000));
  post(1, "devengo", money(1000), { settlementId: 7 });
  post(1, "pago", -money(1000));
  const payment = db.prepare("SELECT id FROM ledger WHERE kind = 'pago'").get() as {
    id: number;
  };

  undoRun([payment.id], [7]);

  const live = db
    .prepare("SELECT COUNT(*) AS n FROM settlement_items WHERE pickupId = 1 AND voidedAt IS NULL")
    .get() as { n: number };
  assert.equal(live.n, 0, "no live claim on the pickup");
  assert.doesNotThrow(() =>
    db
      .prepare(
        `INSERT INTO settlement_items (settlementId,pickupId,week,weight,costPerUnitCents,amountCents)
         VALUES (7,1,'2026-08-24',100,1000,?)`,
      )
      .run(money(1000)),
  );
});
