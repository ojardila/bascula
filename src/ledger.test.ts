import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BASE_SCHEMA, PAYMENTS_SCHEMA, BALANCE_SQL, PENDING_SQL } from "./schema.ts";

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
    "INSERT INTO pickups (id,personId,cropId,weight,date) VALUES (1,1,1,50,'2026-08-25T14:00:00Z')",
  ).run();
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
    "INSERT INTO pickups (id,personId,cropId,weight,date) VALUES (1,1,1,50,'2026-08-25T14:00:00Z')",
  ).run();
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
  db.prepare(
    "INSERT INTO pickups (id,personId,cropId,weight,date) VALUES (1,1,1,40,?)",
  ).run(new Date(2026, 7, 30, 19, 30).toISOString());
  const pending = db.prepare(PENDING_SQL).all(1, "1970-01-01", "2026-08-30") as {
    week: string;
  }[];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].week, "2026-08-24", "and it is priced at that week's rate");
});
