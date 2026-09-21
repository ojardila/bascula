import { describe, expect, it } from "vitest";
import { buildReceiptBreakdown } from "./receiptBreakdown";

describe("buildReceiptBreakdown", () => {
  it("names previous balance so semana + anterior − descuentos − pago = queda", () => {
    const b = buildReceiptBreakdown({
      paidCents: 12_000_000,
      remainingCents: 1_360_000,
      currentWeekCents: 15_360_000,
      deductions: [{ concept: "Mercado", amountCents: 2_000_000, date: "2026-08-26" }],
    });
    expect(b.previousBalanceCents).toBe(0);
    expect(b.deductionsCents).toBe(2_000_000);
    expect(
      b.previousBalanceCents + b.currentWeekCents - b.deductionsCents - b.paidCents,
    ).toBe(b.remainingCents);
  });
});
