// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIMEZONE, dayInZone, localDayOf, mondayOf, weekInZone } from "./time.ts";

test("mondayOf takes a Date by its local calendar day", () => {
  // Thursday 10 Sep 2026, local wall clock.
  assert.equal(mondayOf(new Date(2026, 8, 10, 15, 0)), "2026-09-07");
  // A Sunday belongs to the week that started six days before.
  assert.equal(mondayOf(new Date(2026, 8, 13, 9, 0)), "2026-09-07");
});

test("dayInZone reads the farm's day from a Date, an ISO string or a timestamp", () => {
  // 03:30 UTC on the 1st is still the 31st in Bogotá.
  const iso = "2026-09-01T03:30:00Z";
  assert.equal(dayInZone(iso), "2026-08-31");
  assert.equal(dayInZone(new Date(iso), "America/Bogota"), "2026-08-31");
  assert.equal(dayInZone(Date.parse(iso), "UTC"), "2026-09-01");
  assert.equal(dayInZone(iso, "Asia/Tokyo"), "2026-09-01");
  assert.equal(DEFAULT_TIMEZONE, "America/Bogota");
});

test("dayInZone falls back to the device day for an unknown zone or a bad instant", () => {
  const d = new Date(2026, 8, 10, 12, 0);
  assert.equal(dayInZone(d, "Not/AZone"), localDayOf(d));
  assert.equal(dayInZone("not a date"), localDayOf());
  assert.equal(dayInZone(Number.NaN), localDayOf());
});

test("weekInZone is the Monday of the farm's day", () => {
  // Sunday 19:30 in Bogotá is Monday in UTC; the week is still the Sunday's.
  assert.equal(weekInZone("2026-08-31T00:30:00Z"), "2026-08-24");
  assert.equal(weekInZone("2026-08-31T00:30:00Z", "UTC"), "2026-08-31");
});
