import { test } from "node:test";
import assert from "node:assert/strict";
import { localDayOf, weekOf, mondayOf, endOfWeek, EPOCH_START } from "./time.ts";

// mondayOf and weekNumber are covered in format.test.ts, where they have been
// since the phone shipped. What is new here is the instant -> local day -> week
// chain, which is where the timezone bug lived.

test("the local day of an instant is the farm's day, not UTC's", () => {
  // 19:30 on a Sunday in Bogota is already Monday 00:30 in UTC. Slicing the
  // ISO string showed tomorrow while every total grouped it under today.
  // Built from wall-clock parts on purpose, so the test states the same thing
  // in every timezone: 19:30 local on the 30th is the 30th, whatever UTC says.
  const sundayEvening = new Date(2026, 7, 30, 19, 30);
  assert.equal(localDayOf(sundayEvening), "2026-08-30");
});

test("a Sunday-evening instant belongs to the week that is being paid", () => {
  assert.equal(weekOf(new Date(2026, 7, 30, 19, 30)), "2026-08-24");
  // ...and Monday morning starts the next one.
  assert.equal(weekOf(new Date(2026, 7, 31, 6, 0)), "2026-08-31");
});

test("months and days keep their leading zero", () => {
  assert.equal(localDayOf(new Date(2026, 0, 5, 8, 0)), "2026-01-05");
  assert.equal(localDayOf(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
});

test("the week of new year's eve is the week that started in December", () => {
  assert.equal(weekOf(new Date(2026, 11, 31, 10, 0)), "2026-12-28");
  assert.equal(mondayOf("2027-01-03"), "2026-12-28");
});

test("a week ends on Sunday, not on the following Monday", () => {
  // Both pay screens carried their own copy of this; a settlement that reached
  // the next Monday would sweep in the first day of the week after it.
  assert.equal(endOfWeek("2026-08-24"), "2026-08-30");
  assert.equal(endOfWeek("2025-12-29"), "2026-01-04", "across new year");
  assert.equal(mondayOf(endOfWeek("2026-08-24")), "2026-08-24", "still its own week");
});

test("the settlement range starts before any farm did", () => {
  assert.ok(EPOCH_START < "1971-01-01");
  assert.equal(mondayOf(EPOCH_START), "1969-12-29");
});
