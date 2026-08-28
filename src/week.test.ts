import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  BASE_SCHEMA,
  PAYMENTS_SCHEMA,
  WEEK_BY_DAY_SQL,
  WEEK_BY_WORKER_SQL,
  WEEK_GRID_SQL,
  WEEK_PLOTS_SQL,
  WEEK_GRID_DAY_SQL,
} from "./schema.ts";

// The week detail answers "who was where, and did it show". Its numbers have
// to add up across the table, or the grid is worse than useless.

let db: DatabaseSync;
const MONDAY = "2026-08-17";

/** A weighing at midday local time, so no timezone edge is involved. */
function pickup(personId: number, cropId: number, kg: number, day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const at = new Date(y, m - 1, d, 12, 0, 0).toISOString();
  db.prepare(
    "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?)",
  ).run(personId, cropId, kg, at, at);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(BASE_SCHEMA.replace("PRAGMA journal_mode = WAL;", ""));
  db.exec(PAYMENTS_SCHEMA);
  db.prepare("INSERT INTO people (id,name,lastName) VALUES (1,'Ana','R'),(2,'Beto','S')").run();
  db.prepare("INSERT INTO crops (id,name,dimension) VALUES (1,'Lote A',2),(2,'Lote B',3)").run();
});

test("the days of the week are totalled with who and where", () => {
  pickup(1, 1, 50, "2026-08-17");
  pickup(2, 1, 30, "2026-08-17");
  pickup(1, 2, 20, "2026-08-19");
  const rows = db.prepare(WEEK_BY_DAY_SQL).all(MONDAY) as Record<string, number>[];
  assert.equal(rows.length, 2, "only the days actually worked");
  assert.equal(rows[0].kg, 80);
  assert.equal(rows[0].pickers, 2);
  assert.equal(rows[0].plots, 1);
  assert.equal(rows[1].plots, 1);
});

test("work from another week is not counted", () => {
  pickup(1, 1, 50, "2026-08-17"); // inside
  pickup(1, 1, 99, "2026-08-24"); // the following Monday
  const rows = db.prepare(WEEK_BY_DAY_SQL).all(MONDAY) as Record<string, number>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kg, 50);
});

test("the Sunday belongs to its own week, not the next", () => {
  pickup(1, 1, 40, "2026-08-23"); // Sunday
  const rows = db.prepare(WEEK_BY_DAY_SQL).all(MONDAY) as Record<string, number>[];
  assert.equal(rows.length, 1, "Sunday closes the week that began on the 17th");
  assert.equal(rows[0].kg, 40);
});

test("each worker's days count days, not weighings", () => {
  pickup(1, 1, 20, "2026-08-17");
  pickup(1, 2, 25, "2026-08-17"); // same day, second plot
  pickup(1, 1, 30, "2026-08-18");
  const rows = db.prepare(WEEK_BY_WORKER_SQL).all(MONDAY) as Record<string, number>[];
  assert.equal(rows[0].kg, 75);
  assert.equal(rows[0].days, 2);
});

test("the grid adds up to the same total across rows and columns", () => {
  pickup(1, 1, 50, "2026-08-17");
  pickup(1, 2, 30, "2026-08-18");
  pickup(2, 1, 20, "2026-08-17");
  const grid = db.prepare(WEEK_GRID_SQL).all(MONDAY) as Record<string, number>[];
  const plots = db.prepare(WEEK_PLOTS_SQL).all(MONDAY) as Record<string, number>[];
  const workers = db.prepare(WEEK_BY_WORKER_SQL).all(MONDAY) as Record<string, number>[];

  const gridTotal = grid.reduce((s, g) => s + g.kg, 0);
  const plotTotal = plots.reduce((s, p) => s + p.kg, 0);
  const workerTotal = workers.reduce((s, w) => s + w.kg, 0);

  assert.equal(gridTotal, 100);
  assert.equal(plotTotal, 100, "the column totals must match the grid");
  assert.equal(workerTotal, 100, "and so must the row totals");
});

test("a person who did not touch a plot has no cell for it", () => {
  pickup(1, 1, 50, "2026-08-17");
  pickup(2, 2, 20, "2026-08-17");
  const grid = db.prepare(WEEK_GRID_SQL).all(MONDAY) as Record<string, number>[];
  assert.equal(grid.length, 2, "two cells, not four: the empties are absent");
  assert.ok(!grid.some((g) => g.personId === 1 && g.cropId === 2));
});

test("the day grid adds up to the same total as the plot grid", () => {
  pickup(1, 1, 50, "2026-08-17");
  pickup(1, 2, 30, "2026-08-18");
  pickup(2, 1, 20, "2026-08-17");
  const byPlot = db.prepare(WEEK_GRID_SQL).all(MONDAY) as Record<string, number>[];
  const byDay = db.prepare(WEEK_GRID_DAY_SQL).all(MONDAY) as Record<string, number>[];
  const sum = (rows: Record<string, number>[]) => rows.reduce((s, r) => s + r.kg, 0);
  // Same work seen from two angles: the totals cannot disagree.
  assert.equal(sum(byDay), sum(byPlot));
  assert.equal(sum(byDay), 100);
});

test("a person's day cell merges their plots that day", () => {
  pickup(1, 1, 20, "2026-08-17");
  pickup(1, 2, 25, "2026-08-17"); // two plots, one day
  const rows = db.prepare(WEEK_GRID_DAY_SQL).all(MONDAY) as Record<string, number>[];
  assert.equal(rows.length, 1, "one cell for that day");
  assert.equal(rows[0].kg, 45);
});

test("a day nobody worked has no cells", () => {
  pickup(1, 1, 50, "2026-08-17");
  const rows = db.prepare(WEEK_GRID_DAY_SQL).all(MONDAY) as Record<string, number>[];
  assert.equal(rows.length, 1);
});
