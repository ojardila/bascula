// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { formatArea, moneyInputValue, parseMoneyInput, parseQuantityInput } from "./money";

describe("money, the remaining edges", () => {
  it("writes a negative area with its sign", () => {
    expect(formatArea(-1.5)).toBe("-1,50");
  });

  it("refuses a peso amount too large to be a number", () => {
    expect(parseMoneyInput("9".repeat(400))).toBeNull();
  });

  it("puts a negative amount back in the box with its sign", () => {
    expect(moneyInputValue(-1250)).toBe("-12,50");
  });

  it("refuses a quantity too large to be a number", () => {
    expect(parseQuantityInput("9".repeat(400))).toBeNull();
  });
});
