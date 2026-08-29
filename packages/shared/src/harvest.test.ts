import { test } from "node:test";
import assert from "node:assert/strict";
import { readHarvest, type WeekTotal } from "./harvest.ts";

// Weeks arrive newest-first, the way the queries return them.
const weeks = (...kg: number[]): WeekTotal[] =>
  kg.map((k, i) => {
    const d = new Date(Date.UTC(2026, 7, 24 - i * 7));
    return { week: d.toISOString().slice(0, 10), kg: k };
  });

const CURRENT = "2026-08-24";

test("a rising harvest is not winding down", () => {
  const r = readHarvest(weeks(900, 800, 600, 300), "2026-08-31");
  assert.equal(r.fallingWeeks, 0);
  assert.equal(r.windingDown, false);
  assert.equal(r.peak!.kg, 900);
});

test("two steep falls after the peak means the season is ending", () => {
  // 1000 -> 700 (-30%) -> 450 (-36%), newest first.
  const r = readHarvest(weeks(450, 700, 1000, 900), "2026-08-31");
  assert.equal(r.fallingWeeks, 2);
  assert.equal(r.windingDown, true);
});

test("a single bad week is not a trend", () => {
  const r = readHarvest(weeks(600, 1000, 950, 900), "2026-08-31");
  assert.equal(r.fallingWeeks, 1);
  assert.equal(r.windingDown, false, "one week could just be rain");
});

test("a mild decline does not trigger it", () => {
  // -10% each week: the harvest is easing off, not collapsing.
  const r = readHarvest(weeks(729, 810, 900, 1000), "2026-08-31");
  assert.equal(r.fallingWeeks, 0);
  assert.equal(r.windingDown, false);
});

test("the running week never counts as a fall", () => {
  // The newest week is the current one and looks tiny because it is partial.
  const r = readHarvest(weeks(120, 1000, 950, 900), CURRENT);
  assert.equal(r.fallingWeeks, 0, "a week in progress proves nothing");
  assert.equal(r.peak!.kg, 1000, "and cannot be the peak either");
});

test("a harvest that peaked early and kept falling is winding down", () => {
  // 1000 -> 400 (-60%) -> 200 (-50%) -> 100 (-50%), newest first.
  const r = readHarvest(weeks(100, 200, 400, 1000), "2026-08-31");
  assert.equal(r.peak!.kg, 1000);
  assert.equal(r.fallingWeeks, 3);
  assert.equal(r.windingDown, true);
});

test("a season with only the current week says nothing yet", () => {
  const r = readHarvest(weeks(500), CURRENT);
  assert.equal(r.peak, null);
  assert.equal(r.windingDown, false);
});
