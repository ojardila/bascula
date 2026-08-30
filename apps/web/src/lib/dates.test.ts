/**
 * `formatPeriod`, and the lie it replaced.
 *
 * A settlement's period has two ends and they are not a week apart by
 * definition: `periodStart` is the Monday of the earliest payable it took in,
 * `periodEnd` is the last one. The settlements screen used to render the
 * column with `formatWeekRange(periodStart)` — one argument — which prints the
 * seven days after a Monday and nothing else. Every settlement in the running
 * farm covers 2026-08-24 to 2027-08-29 and every one of them was labelled
 * "24–30 ago". The printed payroll had it right, so the screen and the paper
 * disagreed about the same document.
 */
import { describe, expect, it } from "vitest";
import { formatPeriod, formatWeekRange } from "./dates";

const TODAY = new Date("2026-08-29T12:00:00Z");

describe("formatPeriod", () => {
  it("does not call a year-long period a week", () => {
    // The real figure off the running server.
    expect(formatPeriod("2026-08-24", "2027-08-29", TODAY)).toBe("24 ago 2026 – 29 ago 2027");
    // …which is precisely what the old call produced, and it is wrong.
    expect(formatWeekRange("2026-08-24", TODAY)).toBe("24–30 ago");
  });

  it("does say \"24–30 ago\" when it really is that week", () => {
    expect(formatPeriod("2026-08-24", "2026-08-30", TODAY)).toBe("24–30 ago");
  });

  it("a single day is a day, not a week", () => {
    expect(formatPeriod("2026-08-24", "2026-08-24", TODAY)).toBe("24/08/2026");
  });

  it("within one month, without naming the month twice", () => {
    expect(formatPeriod("2026-08-03", "2026-08-14", TODAY)).toBe("3–14 ago");
  });

  it("crossing a month, it names both", () => {
    expect(formatPeriod("2026-07-27", "2026-08-14", TODAY)).toBe("27 jul – 14 ago");
  });

  it("crossing a year, it prints the years", () => {
    expect(formatPeriod("2026-12-28", "2027-01-10", TODAY)).toBe("28 dic 2026 – 10 ene 2027");
  });
});
