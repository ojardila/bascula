// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { formatDateRange, mondayOf, parseTypedDay } from "./dates";

describe("dates, the remaining edges", () => {
  it("finds the Monday of a Date object as well as of a string", () => {
    expect(mondayOf(new Date("2026-09-24T12:00:00Z"))).toBe("2026-09-21");
  });

  it("writes both dates in full when a range crosses a month", () => {
    expect(formatDateRange("2026-08-31", "2026-09-02")).toBe("31/08/2026 – 02/09/2026");
  });

  it("writes both dates in full when a range crosses a year in the same month number", () => {
    expect(formatDateRange("2025-12-29", "2026-12-01")).toBe("29/12/2025 – 01/12/2026");
  });

  it("reads blank input as no date", () => {
    expect(parseTypedDay("   ", 2026)).toBeNull();
  });

  it("refuses a day too large to be a number", () => {
    expect(parseTypedDay(`${"9".repeat(400)}/08/2026`, 2026)).toBeNull();
  });
});
