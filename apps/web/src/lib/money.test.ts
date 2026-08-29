/**
 * Money is the only thing in this app that cannot be a little bit wrong.
 *
 * These tests are pinned to the mobile app's behaviour (`apps/mobile/src/
 * format.ts`, `db.ts`) rather than to a general idea of correct formatting.
 * When `packages/shared` lands, this file should keep passing unchanged — if
 * it does not, the shared package changed the phone's behaviour, which is
 * exactly the thing the golden cases exist to catch.
 */
import { describe, expect, it } from "vitest";
import {
  amountCents, formatArea, formatMoney, formatMoneySigned, formatQuantity,
  fromCents, parseMoneyInput, parseQuantityInput, toCents,
} from "./money";

describe("cents", () => {
  it("converts pesos to integer cents", () => {
    expect(toCents(800)).toBe(80000);
    expect(toCents(45000)).toBe(4500000);
    // 0.1 + 0.2 territory: the rounding has to happen, not be hoped for.
    expect(toCents(1234.565)).toBe(123457);
    expect(Number.isInteger(toCents(19.99))).toBe(true);
  });

  it("round-trips", () => {
    expect(fromCents(toCents(45000))).toBe(45000);
  });
});

describe("amountCents", () => {
  it("is quantity x rate, rounded once", () => {
    // The wireframe case: 38,5 kg at $800/kg is $30.800.
    expect(amountCents(38.5, 80000)).toBe(3080000);
    expect(formatMoney(amountCents(38.5, 80000))).toBe("$30.800");
  });

  it("agrees with the phone on the three pay modes", () => {
    expect(amountCents(41, 80000)).toBe(3280000); // work_unit
    expect(amountCents(2, 4500000)).toBe(9000000); // time_unit, 2 jornales
    expect(amountCents(1, 120000000)).toBe(120000000); // contract
  });

  it("rounds rather than truncating, so cents are never quietly lost", () => {
    // 33.333 kg x $801 = 26.699,733 pesos -> 2.669.973,3 cents -> 2.669.973
    expect(amountCents(33.333, 80100)).toBe(2669973);
    // Halfway rounds up, as Math.round does on the phone.
    expect(amountCents(0.5, 1)).toBe(1);
  });

  it("never produces a float", () => {
    for (const q of [0.1, 1.7, 38.5, 52.3, 1742.5]) {
      expect(Number.isInteger(amountCents(q, 80000))).toBe(true);
    }
  });

  it("sums a pending week to the figure in the wireframe", () => {
    const pending =
      amountCents(38.5, 80000) + amountCents(41, 80000) + amountCents(2, 4500000);
    expect(pending).toBe(15360000);
    expect(formatMoney(pending)).toBe("$153.600");
  });
});

describe("formatMoney", () => {
  it("groups thousands the Colombian way", () => {
    expect(formatMoney(3080000)).toBe("$30.800");
    expect(formatMoney(147107000)).toBe("$1.471.070");
    expect(formatMoney(100)).toBe("$1");
    expect(formatMoney(0)).toBe("$0");
  });

  it("shows a sign only when something survives the rounding", () => {
    expect(formatMoney(-20000000)).toBe("-$200.000");
    // -40 cents is less than a peso: "-$0" is a lie about the direction.
    expect(formatMoney(-40)).toBe("$0");
  });

  it("signs ledger rows explicitly", () => {
    expect(formatMoneySigned(21450000)).toBe("+ $214.500");
    expect(formatMoneySigned(-20000000)).toBe("− $200.000");
    expect(formatMoneySigned(0)).toBe("$0");
  });

  it("renders the seeded balance", () => {
    const ledger = [25300000, 1200000, -5000000, -4500000, 21450000, -20000000];
    expect(formatMoney(ledger.reduce((a, b) => a + b, 0))).toBe("$184.500");
  });
});

describe("formatQuantity", () => {
  it("uses a comma for decimals and a dot for thousands", () => {
    expect(formatQuantity(38.5)).toBe("38,5");
    expect(formatQuantity(1742.5)).toBe("1.742,5");
    expect(formatQuantity(41)).toBe("41");
  });

  it("rounds a floating-point sum to the number a person expects", () => {
    // 65.3 + 68.1 + 52.6 arrives as 185.99999999999997. Rounding the whole
    // and the fraction separately would print "185,10".
    expect(formatQuantity(65.3 + 68.1 + 52.6)).toBe("186");
  });
});

describe("formatArea", () => {
  it("always shows two decimals", () => {
    expect(formatArea(4.2)).toBe("4,20");
    expect(formatArea(6)).toBe("6,00");
    expect(formatArea(5.71)).toBe("5,71");
    expect(formatArea(14.45)).toBe("14,45");
  });
});

describe("parsing what people type", () => {
  it("accepts the shapes a Colombian writes a price in", () => {
    expect(parseMoneyInput("45000")).toBe(4500000);
    expect(parseMoneyInput("45.000")).toBe(4500000);
    expect(parseMoneyInput("$ 45.000")).toBe(4500000);
    expect(parseMoneyInput("1.234,50")).toBe(123450);
  });

  it("returns null instead of NaN, so the form can say why", () => {
    expect(parseMoneyInput("")).toBeNull();
    expect(parseMoneyInput("abc")).toBeNull();
    expect(parseMoneyInput("12,3,4")).toBeNull();
  });

  it("reads quantities with a decimal comma", () => {
    expect(parseQuantityInput("38,5")).toBe(38.5);
    expect(parseQuantityInput("1.742,5")).toBe(1742.5);
    expect(parseQuantityInput("x")).toBeNull();
  });
});
