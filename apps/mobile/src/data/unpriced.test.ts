/**
 * A payroll with no price must not say the advances ate the week.
 *
 * `settle` collapsed two different silences into one `null`: «nothing pending»
 * and «everything pending priced at zero». `runPayroll` reported both as
 * `noCash`, and `noCash` means one specific thing everywhere else on this
 * phone — `pay.settledNoCash` spells it out: «El anticipo cubrió toda la
 * semana». So a farm whose price had not arrived was told that its workers had
 * already drawn their week in advances.
 *
 * The ledger was never wrong. Nothing is written either way, because a zero
 * gross violates the ledger's CHECK. What was wrong was the reason, and a
 * wrong reason on this screen sends somebody out to tell three people they
 * earned nothing.
 *
 * Measured before this fix, three workers at 40 kg each and a price of 0:
 *   {"paid":0,"noCash":3,"failed":0,...}  --  0 settlements, 0 ledger rows
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { nodeSqlite } from "./nodeSqlite.ts";
import { createSqliteRepository } from "./sqliteRepository.ts";
import { UnpricedWeeks } from "./repository.ts";
import type { Repository } from "./repository.ts";

let raw: DatabaseSync;
let repo: Repository;

const ALL = ["1970-01-01", "2099-12-31"] as const;

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  repo = createSqliteRepository(nodeSqlite(raw));
  repo.init();
  repo.crops.add({ name: "Lote 1", type: "Café", variety: "Castillo", dimension: 1 });
});

function crew(names: string[]): number[] {
  const d = new Date();
  d.setDate(d.getDate() - 2);
  return names.map((name) => {
    const id = repo.people.add({
      name, lastName: "Rodríguez", documentType: "CC", docId: name, tag: name, image: "",
    }).lastInsertRowId;
    repo.pickups.add({ personId: id, cropId: 1, weight: 40, date: d.toISOString() });
    return id;
  });
}

test("a crew with no price is counted as unpriced, not as nothing to hand over", () => {
  const ids = crew(["Ana", "Beto", "Caro"]);
  const run = repo.payments.runPayroll(ids, ALL[0], ALL[1], 0);

  assert.equal(run.unpriced, 3, "the missing price is not being reported as such");
  assert.equal(run.noCash, 0, "an unpriced week is being reported as an eaten advance");
  assert.equal(run.paid, 0);
  assert.equal(run.failed, 0, "a missing price is not this worker's payroll failing");

  // And still nothing on the books, which was always true and must stay true.
  assert.equal(raw.prepare("SELECT COUNT(*) c FROM settlements").get()!.c, 0);
  assert.equal(raw.prepare("SELECT COUNT(*) c FROM ledger").get()!.c, 0);
});

test("settle names the weeks it could not price instead of returning null", () => {
  const [ana] = crew(["Ana"]);
  let err: unknown;
  try {
    repo.payments.settle(ana, ALL[0], ALL[1], 0);
    assert.fail("settle returned instead of refusing an unpriced week");
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof UnpricedWeeks, `expected UnpricedWeeks, got ${err}`);
  assert.ok(err.weeks.length > 0, "the error does not say which weeks");
  assert.match(err.weeks[0]!, /^\d{4}-\d{2}-\d{2}$/);
});

test("a worker with genuinely nothing pending is still noCash, not unpriced", () => {
  // No weighings at all -- the honest silence, which must not have moved.
  const id = repo.people.add({
    name: "Zoila", lastName: "R", documentType: "CC", docId: "Z", tag: "Z", image: "",
  }).lastInsertRowId;

  assert.equal(repo.payments.settle(id, ALL[0], ALL[1], 800), null);

  const run = repo.payments.runPayroll([id], ALL[0], ALL[1], 800);
  assert.equal(run.noCash, 1, "an empty week stopped being reported as an empty week");
  assert.equal(run.unpriced, 0);
});

test("a real price still pays, and the counts stay clean", () => {
  const ids = crew(["Ana", "Beto", "Caro"]);
  const run = repo.payments.runPayroll(ids, ALL[0], ALL[1], 800);

  assert.equal(run.paid, 3);
  assert.equal(run.unpriced, 0);
  assert.equal(run.noCash, 0);
  assert.equal(run.paidCents, 9_600_000);
  assert.equal(raw.prepare("SELECT COUNT(*) c FROM settlements").get()!.c, 3);
});

test("one unpriced week does not stop the crew whose weeks are priced", () => {
  // The mixed run is the one worth pinning: unpriced must be per-worker, not a
  // reason to abandon the payroll for everybody else.
  const ids = crew(["Ana", "Beto"]);
  const run = repo.payments.runPayroll(ids, ALL[0], ALL[1], 800);
  assert.equal(run.paid, 2);

  // Now a fresh weighing for Ana only, settled at no price.
  const d = new Date();
  repo.pickups.add({ personId: ids[0]!, cropId: 1, weight: 10, date: d.toISOString() });
  const second = repo.payments.runPayroll(ids, ALL[0], ALL[1], 0);
  assert.equal(second.unpriced, 1, "Ana's unpriced week is not counted");
  assert.equal(second.noCash, 1, "Beto, who has nothing pending, is not noCash");
});
