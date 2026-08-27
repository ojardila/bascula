import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  BASE_SCHEMA,
  PAYMENTS_SCHEMA,
  RULE_IMPOSSIBLE_SQL,
  RULE_DUPLICATE_SQL,
  RULE_DIGIT_SQL,
  RULE_OUTLIER_SQL,
  RULE_FUTURE_SQL,
} from "./schema.ts";

// These rules accuse people of mis-weighing, so each one has to be shown
// actually firing. The extra-zero rule spent several versions unable to.

let db: DatabaseSync;

function pickup(personId: number, cropId: number, kg: number, daysAgo: number, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(10, minute, 0, 0);
  db.prepare(
    "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?)",
  ).run(personId, cropId, kg, d.toISOString(), d.toISOString());
}

const run = (sql: string, ...params: unknown[]) =>
  db.prepare(sql).all(...(params as never[])) as { pickupId: number; weight: number }[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(BASE_SCHEMA.replace("PRAGMA journal_mode = WAL;", ""));
  db.exec(PAYMENTS_SCHEMA);
  for (const id of [1, 2, 3, 4, 5, 6]) {
    db.prepare("INSERT INTO people (id,name,lastName) VALUES (?,?,'X')").run(id, `P${id}`);
  }
  db.prepare("INSERT INTO crops (id,name,dimension) VALUES (1,'Lote 1',2.0)").run();
});

test("a load nobody could carry is flagged", () => {
  pickup(1, 1, 55, 2); // a normal sack
  pickup(1, 1, 340, 2);
  const found = run(RULE_IMPOSSIBLE_SQL, 120);
  assert.equal(found.length, 1);
  assert.equal(found[0].weight, 340);
});

test("a zero or negative weight is flagged too", () => {
  pickup(1, 1, 0, 2);
  assert.equal(run(RULE_IMPOSSIBLE_SQL, 120).length, 1);
});

test("the same weighing saved twice within three minutes is flagged", () => {
  const d = new Date();
  d.setDate(d.getDate() - 2);
  const iso = d.toISOString();
  for (let i = 0; i < 2; i++) {
    db.prepare(
      "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (1,1,47,?,?)",
    ).run(iso, iso);
  }
  assert.equal(run(RULE_DUPLICATE_SQL).length, 1, "the second one is the suspect");
});

test("two equal weights hours apart are not a duplicate", () => {
  pickup(1, 1, 47, 2, 0);
  pickup(1, 1, 47, 2, 40); // same day, same weight, forty minutes later
  assert.equal(run(RULE_DUPLICATE_SQL).length, 0);
});

test("an extra typed zero is caught — the rule used to be unable to fire", () => {
  // Twenty sacks of 30 kg and one of 300. Comparing against an average that
  // included the suspect reduced the condition to n+1 >= n+10: false always.
  for (let i = 0; i < 20; i++) pickup(1, 1, 30, 3, i);
  pickup(1, 1, 300, 2);
  const found = run(RULE_DIGIT_SQL);
  assert.equal(found.length, 1);
  assert.equal(found[0].weight, 300);
});

test("a good day is not mistaken for a typo", () => {
  for (let i = 0; i < 20; i++) pickup(1, 1, 30, 3, i);
  pickup(1, 1, 45, 2); // a strong day, not a typo
  assert.equal(run(RULE_DIGIT_SQL).length, 0);
});

test("a weight far above the rest of the crew that day is flagged", () => {
  // Five mates around 30 kg and one at 400 on the same plot and day.
  for (const p of [2, 3, 4, 5, 6]) pickup(p, 1, 30, 2);
  pickup(1, 1, 400, 2);
  const found = run(RULE_OUTLIER_SQL);
  assert.equal(found.length, 1);
  assert.equal(found[0].weight, 400);
});

test("with too few mates that day the outlier rule stays quiet", () => {
  pickup(2, 1, 30, 2);
  pickup(1, 1, 400, 2);
  assert.equal(run(RULE_OUTLIER_SQL).length, 0, "no crew, no comparison");
});

test("a pickup dated in the future is flagged", () => {
  pickup(1, 1, 50, -3); // three days ahead
  assert.equal(run(RULE_FUTURE_SQL).length, 1);
});

test("today's work is not in the future", () => {
  pickup(1, 1, 50, 0);
  assert.equal(run(RULE_FUTURE_SQL).length, 0);
});
