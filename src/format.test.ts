import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMoney,
  formatNumber,
  formatDay,
  formatWeekRange,
  mondayOf,
  weekNumber,
} from "./format.ts";

// Every case below is a bug that actually shipped and was caught by hand.

test("formatNumber rounds once, so a float sum never grows a second decimal", () => {
  // 65.3 + 68.1 + 52.6 comes back from SQLite as 185.99999999999997, and
  // taking the integer part before rounding the rest printed "185,10".
  assert.equal(formatNumber(65.3 + 68.1 + 52.6, "es"), "186");
  assert.equal(formatNumber(82.1 + 75.3 + 58.6, "es"), "216");
  assert.equal(formatNumber(47.95, "es"), "48");
  assert.equal(formatNumber(100.99, "es"), "101");
});

test("formatNumber keeps one decimal when there is one", () => {
  assert.equal(formatNumber(1742.5, "es"), "1.742,5");
  assert.equal(formatNumber(1742.5, "en"), "1,742.5");
});

test("separators follow the language, not the device", () => {
  // Hermes resolves the default locale to en-US, so the app in Spanish was
  // printing "$1,471,070".
  assert.equal(formatMoney(1471070, "es"), "$1.471.070");
  assert.equal(formatMoney(1471070, "en"), "$1,471,070");
  assert.equal(formatMoney(1471070, "pt"), "$1.471.070");
});

test("a rounding-away amount does not keep its minus sign", () => {
  assert.equal(formatMoney(-0.4, "es"), "$0");
  assert.equal(formatNumber(-0.02, "es"), "0");
  assert.equal(formatMoney(-1500, "es"), "-$1.500");
});

test("mondayOf lands on the Monday of the local week", () => {
  assert.equal(mondayOf("2026-08-27"), "2026-08-24"); // Thursday
  assert.equal(mondayOf("2026-08-24"), "2026-08-24"); // Monday itself
  assert.equal(mondayOf("2026-08-30"), "2026-08-24"); // Sunday belongs back
});

test("a week straddling new year keeps one identity", () => {
  // The old "%Y-W%W" label split this week into 2026-W52 and 2027-W00.
  assert.equal(mondayOf("2026-12-31"), "2026-12-28");
  assert.equal(mondayOf("2027-01-01"), "2026-12-28");
  assert.equal(mondayOf("2027-01-03"), "2026-12-28");
});

test("week ranges read as dates, with the year only when it differs", () => {
  const now = new Date("2026-08-27T12:00:00Z");
  assert.equal(formatWeekRange("2026-08-24", "es", now), "24–30 ago");
  assert.equal(formatWeekRange("2026-08-31", "es", now), "31 ago – 6 sep");
  assert.equal(formatWeekRange("2026-08-24", "en", now), "Aug 24–30");
  // Crossing new year needs both years, or "29 dic" is ambiguous.
  assert.equal(formatWeekRange("2025-12-29", "es", now), "29 dic 2025 – 4 ene 2026");
  assert.equal(formatWeekRange("2025-12-29", "en", now), "Dec 29 2025 – Jan 4 2026");
  // A past week inside a single year still shows it.
  assert.equal(formatWeekRange("2025-06-02", "es", now), "2–8 jun 2025");
});

test("formatDay converts an instant to its local day", () => {
  // A pickup at 19:30 in Bogota is stored as the next day in UTC; slicing the
  // ISO string showed tomorrow while every total grouped it under today.
  const localEvening = new Date(2026, 7, 26, 19, 30).toISOString();
  assert.equal(formatDay(localEvening, "es"), "26 ago");
});

test("formatDay reads a plain date key as-is", () => {
  assert.equal(formatDay("2026-08-24", "es"), "24 ago");
  assert.equal(formatDay("2026-08-24", "en"), "Aug 24");
});

test("weekNumber names the week after its Thursday", () => {
  assert.equal(weekNumber("2026-08-24"), 35);
  assert.equal(weekNumber("2026-01-05"), 2);
});
