import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  loadCases,
  instantOf,
  type GoldenCase,
  type GoldenExpectation,
  type ExpectedBalance,
  type ExpectedCheckpoint,
  type ExpectedItem,
  type ExpectedLedgerRow,
  type ExpectedPickup,
  type ExpectedSettlement,
} from "./runner.ts";
import { DAY_OF, WEEK_OF } from "../../../apps/mobile/src/schema.ts";
import { nodeSqlite } from "../../../apps/mobile/src/data/nodeSqlite.ts";
import { createSqliteRepository } from "../../../apps/mobile/src/data/sqliteRepository.ts";
import { fromCents } from "../src/money.ts";

/**
 * The same nine cases, replayed through the phone's REAL data layer.
 *
 * `runner.ts` retypes the sequence of writes a settlement performs, and says
 * why: `apps/mobile/src/db.ts` opened expo-sqlite at module scope and could not
 * be imported outside a phone (`docs/diagramas/movil.md` §9.2). So the corpus
 * that is now the contract with the Go server was pinning a *copy* of the
 * phone's logic, and nothing checked that the copy still matched the original.
 *
 * That hole is closed here. `createSqliteRepository` takes its connection and
 * its clock, so the real `settle`, `pay`, `advance`, `deduct`, `adjust`,
 * `reverse` and `voidSettlement` can be replayed at each event's business date
 * and held to the very same fixtures.
 *
 * If this file and `golden.test.ts` ever disagree, the fixtures are describing
 * something the phone does not do, and Go is being held to the wrong contract.
 */

/** Midday local on a business date: `localDayOf` of it is that date anywhere. */
function noonOf(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function replay(c: GoldenCase): GoldenExpectation {
  const db = new DatabaseSync(":memory:");
  let clock = noonOf("2000-01-01");
  const repo = createSqliteRepository(nodeSqlite(db), { clock: () => clock });
  repo.init();

  // Ids are part of the fixture, and `people.add` / `crops.add` cannot choose
  // one. Everything the case actually asserts about — the money — goes through
  // the repository below.
  db.prepare("DELETE FROM config").run();
  const generalPesos = fromCents(c.generalRateCents);
  db.prepare("INSERT INTO config (id, costPerUnit) VALUES (1, ?)").run(
    generalPesos,
  );
  for (const p of c.people)
    db.prepare("INSERT INTO people (id,name,lastName) VALUES (?,?,?)").run(
      p.id,
      p.name,
      p.lastName,
    );
  for (const cr of c.crops)
    db.prepare("INSERT INTO crops (id,name) VALUES (?,?)").run(cr.id, cr.name);
  for (const [week, cents] of Object.entries(c.weeklyRateCents ?? {}))
    repo.overrides.set(week, fromCents(cents));

  const checkpoints: ExpectedCheckpoint[] = [];
  const balanceOf = (personId: number): ExpectedBalance => ({
    ...repo.payments.balance(personId),
  });

  for (const ev of c.events) {
    if ("on" in ev) clock = noonOf(ev.on);
    switch (ev.op) {
      case "pickup":
        db.prepare(
          "INSERT INTO pickups (id,personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?,?)",
        ).run(
          ev.id,
          ev.personId,
          ev.cropId,
          ev.quantity,
          instantOf(ev.at),
          instantOf(ev.at),
        );
        break;
      case "settle":
        repo.payments.settle(
          ev.personId,
          ev.from,
          ev.to,
          generalPesos,
          ev.note,
        );
        break;
      case "pay":
        repo.payments.pay(ev.personId, ev.amountCents, { method: ev.method });
        break;
      case "advance":
        repo.payments.advance(ev.personId, ev.amountCents, ev.note);
        break;
      case "deduct":
        repo.payments.deduct(ev.personId, ev.amountCents, ev.note);
        break;
      case "adjust":
        repo.payments.adjust(ev.personId, ev.signedCents, ev.note);
        break;
      case "void":
        repo.payments.voidSettlement(ev.settlementId, ev.note);
        break;
      case "reverse":
        repo.payments.reverse(ev.ledgerId, ev.note);
        break;
      case "checkpoint":
        checkpoints.push({
          label: ev.label,
          balances: c.people.map((p) => balanceOf(p.id)),
        });
        break;
    }
  }

  const actual: GoldenExpectation = {};

  if (c.expect.pickups)
    actual.pickups = (
      db
        .prepare(
          `SELECT id, ${DAY_OF("date")} AS localDay, ${WEEK_OF("date")} AS week
             FROM pickups ORDER BY id`,
        )
        .all() as unknown as ExpectedPickup[]
    ).map((r) => ({ ...r }));

  if (c.expect.settlements) {
    const rows = db
      .prepare(
        `SELECT id, personId, periodStart, periodEnd, grossCents, status
           FROM settlements ORDER BY id`,
      )
      .all() as unknown as Omit<ExpectedSettlement, "items">[];
    actual.settlements = rows.map((s) => ({
      ...s,
      items: (
        db
          .prepare(
            `SELECT pickupId, week, weight AS quantity, costPerUnitCents, amountCents, voidedAt
               FROM settlement_items WHERE settlementId = ? ORDER BY id`,
          )
          .all(s.id) as unknown as (Omit<ExpectedItem, "voided"> & {
          voidedAt: string | null;
        })[]
      ).map(({ voidedAt, ...i }) => ({ ...i, voided: voidedAt !== null })),
    }));
  }

  if (c.expect.ledger)
    actual.ledger = (
      db
        .prepare(
          `SELECT id, personId, kind, amountCents, date, settlementId, reversesId
             FROM ledger ORDER BY id`,
        )
        .all() as unknown as ExpectedLedgerRow[]
    ).map((r) => ({ ...r }));

  if (c.expect.balances)
    actual.balances = c.expect.balances.map((b) => balanceOf(b.personId));

  if (c.expect.checkpoints) actual.checkpoints = checkpoints;

  db.close();
  return actual;
}

for (const c of loadCases()) {
  test(`the phone's own code satisfies: ${c.id} — ${c.title}`, () => {
    const actual = replay(c);
    for (const key of Object.keys(c.expect) as (keyof GoldenExpectation)[])
      assert.deepEqual(actual[key], c.expect[key], `${c.id}: ${key}\n${c.why}`);
  });
}
