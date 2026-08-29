import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BASE_SCHEMA, PAYMENTS_SCHEMA, INDEX_SQL } from "./schema.ts";
import {
  dayInZone,
  weekInZone,
} from "../../../packages/shared/src/time.ts";

// The comparative index shipped with three statistical defects at once, and it
// is the number a farm would use to decide who not to hire again.

let db: DatabaseSync;

function person(id: number) {
  db.prepare("INSERT INTO people (id,name,lastName) VALUES (?,?,'X')").run(id, `P${id}`);
}

function plot(id: number) {
  db.prepare("INSERT INTO crops (id,name,dimension) VALUES (?,?,2.0)").run(id, `Lote ${id}`);
}

/** A day's work, dated `daysAgo` back so it lands inside the window. */
function pickup(personId: number, cropId: number, kg: number, daysAgo: number) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(10, 0, 0, 0);
  const at = d.toISOString();
  db.prepare(
    "INSERT INTO pickups (personId,cropId,weight,date,createdAt,localDay,week) VALUES (?,?,?,?,?,?,?)",
  ).run(personId, cropId, kg, at, at, dayInZone(at), weekInZone(at));
}

const index = () => {
  const rows = db.prepare(INDEX_SQL).all(dayInZone(Date.now() - 28 * 86400000)) as {
    personId: number;
    irl: number | null;
    comparableDays: number;
  }[];
  return new Map(rows.map((r) => [r.personId, r]));
};

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(BASE_SCHEMA.replace("PRAGMA journal_mode = WAL;", ""));
  db.exec(PAYMENTS_SCHEMA);
  [1, 2, 3, 4, 5, 6].forEach(person);
  [1, 2].forEach(plot);
});

test("someone matching their mates scores exactly 1", () => {
  for (const p of [1, 2, 3]) pickup(p, 1, 50, 2);
  assert.equal(index().get(1)!.irl, 1);
});

test("doubling your mates scores 2, not 1.5", () => {
  // The benchmark must exclude the person being measured. Including them drags
  // everyone toward 1: this case used to come out as 1.5.
  pickup(1, 1, 60, 2);
  pickup(2, 1, 30, 2);
  pickup(3, 1, 30, 2);
  assert.equal(index().get(1)!.irl, 2);
});

test("the score does not depend on how big the crew was", () => {
  // Same relative performance in a crew of three and a crew of six. These used
  // to come out as 1.5 and 1.71, which reordered people across groups.
  pickup(1, 1, 60, 2);
  for (const p of [2, 3]) pickup(p, 1, 30, 2);
  pickup(4, 2, 60, 2);
  for (const p of [5, 6]) pickup(p, 2, 30, 2);
  pickup(4, 2, 0.0001, 3); // keep 4 in the same shape, different day
  assert.equal(index().get(1)!.irl, index().get(4)!.irl);
});

test("a heavy day does not outweigh several light ones", () => {
  // One day on a loaded plot at 0.9, then three light days at 1.5 each.
  // Dividing sums gave far less than the honest average of the daily ratios.
  pickup(1, 1, 90, 2);
  for (const p of [2, 3]) pickup(p, 1, 100, 2);
  for (const day of [3, 4, 5]) {
    pickup(1, 2, 15, day);
    for (const p of [2, 3]) pickup(p, 2, 10, day);
  }
  const irl = index().get(1)!.irl!;
  // (0.9 + 1.5 + 1.5 + 1.5) / 4 = 1.35
  assert.ok(Math.abs(irl - 1.35) < 0.0001, `expected ~1.35, got ${irl}`);
});

test("fewer than three on a plot that day is not a comparison", () => {
  pickup(1, 1, 80, 2);
  pickup(2, 1, 40, 2);
  assert.equal(index().get(1), undefined, "two people give no index at all");
});

test("comparable days count days, not rows", () => {
  // Working two plots the same day is still one day of evidence.
  for (const p of [1, 2, 3]) {
    pickup(p, 1, 50, 2);
    pickup(p, 2, 50, 2);
  }
  assert.equal(index().get(1)!.comparableDays, 1);
});

test("work older than the window does not count", () => {
  for (const p of [1, 2, 3]) pickup(p, 1, 50, 40); // beyond 28 days
  assert.equal(index().get(1), undefined);
});
