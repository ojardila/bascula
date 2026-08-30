/**
 * What the phone lets across that the server refuses.
 *
 * The season import is the gate for the whole move to the server, and it is
 * all-or-nothing: one bad row refuses the farm's entire migration. So every
 * rejection the server can make is a rejection the handset should make first,
 * where the row can be named in terms somebody recognises.
 *
 * Three that got through, each confirmed against the real API before it was
 * fixed here:
 *
 *   POST /v1/import/season → 400
 *   "weighing 77777777-… is dated 2029-08-30, outside the window an import
 *    may cover (2015-01-01 to 2027-08-30)"
 *   "every imported worker needs an id and a name"
 *   "a week price is named by its Monday: 2026-08-26"
 *
 * Look at the first one from where the farmer stands: a hex string they have
 * never seen and cannot look up, arriving from a server after they have
 * committed to migrating. The failure is real either way. What changes is
 * whether it reads «Ana Rodríguez: 1 pesada fechada el 2029-08-30 — revisa la
 * fecha del teléfono», on the phone, before anything is sent.
 *
 * A handset with a wrong clock is not a hypothetical. The server's own comment
 * says it is ordinary, which is why its ceiling is a year rather than a day,
 * and the console already names the phone's date as a common cause of a bad
 * weighing.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { nodeSqlite } from "../data/nodeSqlite.ts";
import { createSqliteRepository } from "../data/sqliteRepository.ts";
import { buildSeasonExport, SeasonExportError } from "./seasonExport.ts";
import type { Repository } from "../data/repository.ts";

let raw: DatabaseSync;
let repo: Repository;

const INPUT = {
  importId: "i1",
  farmId: null,
  deviceId: "d1",
  schemaVersion: 8,
  timezone: "America/Bogota",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const build = () => buildSeasonExport(nodeSqlite(raw), INPUT);

function refusal(): SeasonExportError {
  try {
    build();
    assert.fail("the export let the row through");
  } catch (e) {
    assert.ok(e instanceof SeasonExportError, `expected SeasonExportError, got ${e}`);
    return e;
  }
}

function aWorker(name = "Ana") {
  return repo.people.add({
    name, lastName: "Rodríguez", documentType: "CC", docId: name, tag: name, image: "",
  }).lastInsertRowId;
}

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  repo = createSqliteRepository(nodeSqlite(raw));
  repo.init();
  repo.crops.add({ name: "Lote 1", type: "Café", variety: "Castillo", dimension: 1 });
});

test("a weighing dated years out is named with the worker and the date", () => {
  const id = aWorker();
  const far = new Date();
  far.setFullYear(far.getFullYear() + 3);
  repo.pickups.add({ personId: id, cropId: 1, weight: 40, date: far.toISOString() });

  const err = refusal();
  assert.equal(err.code, "NOT_IMPORTABLE");
  const said = err.problems.join(" | ");
  assert.match(said, /Ana Rodríguez/, "the failure does not name the worker");
  assert.match(said, new RegExp(far.toISOString().slice(0, 10)), "it does not name the date");
  assert.match(said, /fecha del teléfono/, "it does not say what to check");
});

test("a weighing from before the app existed is refused too", () => {
  const id = aWorker("Beto");
  repo.pickups.add({ personId: id, cropId: 1, weight: 40, date: "2009-05-05T09:00:00.000Z" });

  assert.match(refusal().problems.join(" "), /2009-05-05/);
});

test("a worker with no name is counted", () => {
  repo.people.add({
    name: "  ", lastName: "", documentType: "CC", docId: "x", tag: "x", image: "",
  });

  const err = refusal();
  assert.match(err.problems.join(" "), /sin nombre/);
});

test("a week not named by its Monday is refused, naming the week", () => {
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents, uuid, updatedAt) VALUES ('2026-08-26', 700, 70000, 'u', '2026-01-01')",
  ).run();

  assert.match(refusal().problems.join(" "), /2026-08-26.*lunes/);
});

test("a Monday is fine, and so is an ordinary season", () => {
  const id = aWorker();
  const d = new Date();
  d.setDate(d.getDate() - 2);
  repo.pickups.add({ personId: id, cropId: 1, weight: 40, date: d.toISOString() });
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents, uuid, updatedAt) VALUES ('2026-08-24', 700, 70000, 'u', '2026-01-01')",
  ).run();

  const out = build();
  assert.equal(out.workRecords.length, 1);
  assert.equal(out.weekPrices.length, 1);
});

test("every problem is reported at once, not one per attempt", () => {
  // A farm migrating wants the whole list. Failing on the first row means a
  // person fixes one thing, tries again, and finds the next -- which for a
  // season of weighings is a very long afternoon.
  const a = aWorker("Ana");
  const far = new Date();
  far.setFullYear(far.getFullYear() + 3);
  repo.pickups.add({ personId: a, cropId: 1, weight: 40, date: far.toISOString() });
  repo.people.add({
    name: "", lastName: "", documentType: "CC", docId: "y", tag: "y", image: "",
  });
  raw.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents, uuid, updatedAt) VALUES ('2026-08-26', 700, 70000, 'u', '2026-01-01')",
  ).run();

  const said = refusal().problems;
  assert.ok(said.length >= 3, `only ${said.length} problem(s) reported: ${said.join(" | ")}`);
});
