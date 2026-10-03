// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { type Position, bboxOfPositions, closeRing, niceDistance, parseDegrees, ringsIntersect } from "./geo";

describe("geo, the remaining edges", () => {
  it("closes an empty ring as an empty ring", () => {
    expect(closeRing([])).toEqual([]);
  });

  it("has no bounding box for no positions", () => {
    expect(bboxOfPositions([])).toBeNull();
  });

  it("says a ring with fewer than three corners intersects nothing", () => {
    const square: Position[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(ringsIntersect([[0, 0], [1, 1]], square)).toBe(false);
    expect(ringsIntersect(square, [[0, 0], [1, 1]])).toBe(false);
  });

  it("counts a corner of one lot touching the middle of another's edge (from its start)", () => {
    const a: Position[] = [[0, 0], [2, 0], [2, -2], [0, -2]];
    const b: Position[] = [[1, 0], [1, 1], [3, 1]];
    expect(ringsIntersect(a, b)).toBe(true);
  });

  it("counts a corner of one lot touching the middle of another's edge (from its end)", () => {
    const a: Position[] = [[0, 0], [2, 0], [2, -2], [0, -2]];
    const b: Position[] = [[1, 1], [1, 0], [3, 1]];
    expect(ringsIntersect(a, b)).toBe(true);
  });

  it("does not read a lone point or sign as degrees", () => {
    expect(parseDegrees(".")).toBeNull();
    expect(parseDegrees("-")).toBeNull();
  });

  it("caps the scale at the largest round distance", () => {
    expect(niceDistance(1000, 100)).toBe(10_000);
  });
});
