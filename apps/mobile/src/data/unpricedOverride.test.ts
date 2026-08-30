/**
 * An override that names no price is not an override of nothing.
 *
 * `cost_overrides` allows both price columns NULL, and two places treated that
 * row as a deliberate zero:
 *
 *   1. `costCentsForWeek` read it as a price of 0 instead of falling back to
 *      what the farm charges. Measured: one worker, 40 kg, general price 800 →
 *      3_200_000 cents became **0** with that general price sitting unused.
 *   2. `backfillPriceCents` wrote that zero down PERMANENTLY, via
 *      `Number(r.costPerUnit ?? 0)`. The read path can be corrected later; a
 *      migration cannot -- once the cents column says 0 there is no null left
 *      to fall back from, and the row is indistinguishable from a week the
 *      farm really did set to nothing.
 *
 * Deliberately zero and never priced are different weeks. The first is a real
 * decision the migration must preserve -- its own comment says so, and it is
 * right. The second is an absence, and `docs/auditorias.md` is about exactly
 * this: not knowing is not zero.
 *
 * The export is the third place it surfaced. With the migration no longer
 * inventing a zero, a null now reaches `seasonExport`, whose own comment warns
 * the server reads a null price as «free» -- so those rows are left out rather
 * than sent. A week the farm never overrode is a week to say nothing about.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { nodeSqlite } from "./nodeSqlite.ts";
import { createSqliteRepository } from "./sqliteRepository.ts";
import { backfillPriceCents } from "./migrateToV7.ts";
import { buildSeasonExport } from "../sync/seasonExport.ts";
import type { Repository } from "./repository.ts";

let raw: DatabaseSync;
let repo: Repository;

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  repo = createSqliteRepository(nodeSqlite(raw));
  repo.init();
  repo.crops.add({ name: "Lote 1", type: "Café", variety: "Castillo", dimension: 1 });
});

function aPickup(): string {
  const d = new Date();
  d.setDate(d.getDate() - 2);
  const id = repo.people.add({
    name: "Ana", lastName: "R", documentType: "CC", docId: "1", tag: "T", image: "",
  }).lastInsertRowId;
  repo.pickups.add({ personId: id, cropId: 1, weight: 40, date: d.toISOString() });
  return (raw.prepare("SELECT DISTINCT week w FROM pickups_live").get() as { w: string }).w;
}

const owed = () => repo.payments.pendingAll(800)[0]?.amountCents ?? 0;

test("a week with an empty override still charges what the farm charges", () => {
  const week = aPickup();
  const before = owed();
  assert.equal(before, 3_200_000, "baseline moved; the rest of this test is meaningless");

  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents) VALUES (?, NULL, NULL)",
  ).run(week);

  assert.equal(owed(), before, "an override naming no price zeroed the week");
});

test("a week deliberately set to zero stays zero", () => {
  // The other half, and the one the migration's own comment defends. An
  // override of 0 is a decision somebody made and it must survive.
  const week = aPickup();
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents) VALUES (?, 0, 0)",
  ).run(week);

  assert.equal(owed(), 0, "a deliberate zero was overridden by the general price");
});

test("the migration does not write a zero for a row that names no price", () => {
  const week = aPickup();
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents) VALUES (?, NULL, NULL)",
  ).run(week);

  backfillPriceCents(nodeSqlite(raw));

  const row = raw.prepare(
    "SELECT costPerUnitCents c FROM cost_overrides WHERE week = ?",
  ).get(week) as { c: number | null };
  assert.equal(row.c, null, "the migration made an absent price into a permanent zero");
  // And the week still prices at the farm's rate afterwards.
  assert.equal(owed(), 3_200_000);
});

test("the migration still backfills a real price, including a deliberate zero", () => {
  const week = aPickup();
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents) VALUES (?, 0, NULL)",
  ).run(week);
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents) VALUES ('1999-01-04', 500, NULL)",
  ).run();

  // Not an exact count: `backfillPriceCents` walks `config` as well, and
  // `init()` leaves a config row of its own. What matters is that both priced
  // overrides were taken.
  const n = backfillPriceCents(nodeSqlite(raw));
  assert.ok(n >= 2, `the migration stopped backfilling rows that do have a price (${n})`);

  const rows = raw.prepare(
    "SELECT week, costPerUnitCents c FROM cost_overrides ORDER BY week",
  ).all() as { week: string; c: number | null }[];
  assert.equal(rows.find((r) => r.week === week)!.c, 0, "a deliberate zero was skipped");
  assert.equal(rows.find((r) => r.week === "1999-01-04")!.c, 50_000);
});

// ---- The third place it surfaces: what leaves for the server --------------

test("a week that names no price is not exported as a free week", () => {
  const week = aPickup();
  // One real override and one that names nothing.
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents, uuid, updatedAt) VALUES (?, 700, 70000, 'u-real', '2026-01-01')",
  ).run(week);
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents, uuid, updatedAt) VALUES ('1999-01-04', NULL, NULL, 'u-empty', '2026-01-01')",
  ).run();

  const out = buildSeasonExport(nodeSqlite(raw), {
    importId: "i1",
    farmId: null,
    deviceId: "d1",
    schemaVersion: 7,
    timezone: "America/Bogota",
    generatedAt: "2026-01-01T00:00:00.000Z",
  });

  const ids = out.weekPrices.map((w) => w.id);
  assert.ok(ids.includes("u-real"), "the real override stopped being exported");
  assert.ok(
    !ids.includes("u-empty"),
    "a week naming no price was exported; the server reads a null price as free",
  );
  // And nothing that did go carries a null.
  for (const w of out.weekPrices) {
    assert.notEqual(w.priceCents, null, `${w.id} was exported with a null price`);
  }
});
