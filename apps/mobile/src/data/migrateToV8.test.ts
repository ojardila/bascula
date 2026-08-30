/**
 * Undoing a zero the phone invented and wrote down.
 *
 * v7's `backfillPriceCents` turned an override row that named NO price into a
 * permanent `costPerUnitCents = 0`. v7 no longer does that. This is the other
 * half — the handsets that already ran it, which nothing in the app would ever
 * revisit.
 *
 * The repair is exact because the old backfill never touched `costPerUnit`:
 *
 *   cents = 0 AND costPerUnit IS NULL  → invented. Repairable.
 *   cents = 0 AND costPerUnit = 0      → a decision somebody made. Untouched.
 *
 * And it is not cosmetic. Measured against the real API, a season import
 * carrying one such week is refused outright, and the import is
 * all-or-nothing:
 *
 *   POST /v1/import/season → 400
 *   {"code":"BAD_REQUEST","message":"a week price must be positive: 2026-08-24"}
 *
 * The same payload with a real price returns 200. A farm whose phone ever held
 * an empty override row could not migrate at all, and the error names a week
 * rather than a cause.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { nodeSqlite } from "./nodeSqlite.ts";
import { createSqliteRepository } from "./sqliteRepository.ts";
import { repairInventedZeroPrices } from "./migrateToV8.ts";
import { buildSeasonExport, SeasonExportError } from "../sync/seasonExport.ts";
import type { Repository } from "./repository.ts";

let raw: DatabaseSync;
let repo: Repository;

/** Exactly what a handset that ran the old v7 is carrying. */
function asPreFixV7() {
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents, uuid, updatedAt) VALUES ('2026-01-05', NULL, 0, 'u-invented', '2026-01-01')",
  ).run();
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents, uuid, updatedAt) VALUES ('2026-01-12', 0, 0, 'u-deliberate', '2026-01-01')",
  ).run();
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents, uuid, updatedAt) VALUES ('2026-01-19', 700, 70000, 'u-real', '2026-01-01')",
  ).run();
}

const centsFor = (week: string) =>
  (raw.prepare("SELECT costPerUnitCents c FROM cost_overrides WHERE week = ?").get(week) as {
    c: number | null;
  }).c;

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  repo = createSqliteRepository(nodeSqlite(raw));
  repo.init();
});

test("the invented zero is undone", () => {
  asPreFixV7();
  assert.equal(centsFor("2026-01-05"), 0, "fixture is wrong; nothing to repair");

  const n = repairInventedZeroPrices(nodeSqlite(raw));

  assert.equal(centsFor("2026-01-05"), null, "the invented zero survived the repair");
  assert.ok(n >= 1, "the repair reported no rows");
});

test("a zero somebody meant is left exactly where it is", () => {
  asPreFixV7();
  repairInventedZeroPrices(nodeSqlite(raw));

  assert.equal(centsFor("2026-01-12"), 0, "a deliberate zero was thrown away");
  assert.equal(centsFor("2026-01-19"), 70_000, "a real price was touched");
});

test("running it twice changes nothing the second time", () => {
  asPreFixV7();
  const first = repairInventedZeroPrices(nodeSqlite(raw));
  const second = repairInventedZeroPrices(nodeSqlite(raw));

  assert.ok(first >= 1);
  assert.equal(second, 0, "the repair is not idempotent");
});

test("a phone that never held an empty row repairs nothing", () => {
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents, uuid, updatedAt) VALUES ('2026-01-19', 700, 70000, 'u', '2026-01-01')",
  ).run();

  assert.equal(repairInventedZeroPrices(nodeSqlite(raw)), 0);
  assert.equal(centsFor("2026-01-19"), 70_000);
});

test("after the repair the season carries no week the server would refuse", () => {
  // The point of the whole migration: /v1/import/season rejects a
  // non-positive week price and takes the entire farm down with it.
  asPreFixV7();
  repairInventedZeroPrices(nodeSqlite(raw));

  const build = () =>
    buildSeasonExport(nodeSqlite(raw), {
      importId: "i1",
      farmId: null,
      deviceId: "d1",
      schemaVersion: 8,
      timezone: "America/Bogota",
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

  // The DELIBERATE zero is still there, and it still cannot cross: the server
  // refuses a non-positive week price and takes the farm's whole season with
  // it. The export now says so first, naming the week -- rather than letting
  // the server answer 400 with a date and no cause.
  let err: unknown;
  try {
    build();
    assert.fail("the export let a zero week price through");
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof SeasonExportError, `expected SeasonExportError, got ${err}`);
  assert.equal(err.code, "NON_POSITIVE_WEEK_PRICE");
  assert.match(err.problems.join(" "), /2026-01-12/, "the failure does not name the week");
  assert.doesNotMatch(
    err.problems.join(" "),
    /2026-01-05/,
    "the invented zero was NOT repaired; it is still blocking the export",
  );

  // With that one week corrected by a person, the season crosses.
  raw.prepare("UPDATE cost_overrides SET costPerUnit = 700, costPerUnitCents = 70000 WHERE uuid = 'u-deliberate'").run();
  const out = build();
  const ids = out.weekPrices.map((w) => w.id);
  assert.ok(ids.includes("u-real"));
  assert.ok(!ids.includes("u-invented"), "the invented week is still being exported");
  for (const w of out.weekPrices) {
    assert.ok(w.priceCents !== null && w.priceCents > 0, `${w.id}: priceCents=${w.priceCents}`);
  }
});

test("a database migrated from scratch lands on the current version", () => {
  const v = (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert.equal(v, 8, `a fresh database stamped ${v}; the dispatcher did not reach v8`);
});
