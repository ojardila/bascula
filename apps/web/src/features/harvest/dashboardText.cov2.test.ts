// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { plotTrend } from "./dashboardText";

describe("plotTrend", () => {
  it("says a lote with no kilos in either week has none", () => {
    expect(plotTrend({ kg: null, lastWeekToDateKg: null, lastWeekKg: null })).toBe("sin kilos");
    expect(plotTrend({ kg: 0, lastWeekToDateKg: 0, lastWeekKg: 0 })).toBe("sin kilos");
  });
});
