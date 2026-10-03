// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { compareAsc } from "./compare";

describe("compareAsc", () => {
  it("orders ISO days oldest first", () => {
    expect(["2026-09-01", "2026-08-29", "2026-08-30"].sort(compareAsc)).toEqual([
      "2026-08-29",
      "2026-08-30",
      "2026-09-01",
    ]);
  });

  it("says 0 for the same value", () => {
    expect(compareAsc("2026-08-29", "2026-08-29")).toBe(0);
    expect(compareAsc("a", "b")).toBe(-1);
    expect(compareAsc("b", "a")).toBe(1);
  });
});
