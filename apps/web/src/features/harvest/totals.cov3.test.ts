// SPDX-License-Identifier: MIT
/**
 * `totalsOfRecords` handed a row whose amount field is missing altogether —
 * a server that drops the key instead of sending null. The row is not null,
 * so it counts as priced, and it must add nothing rather than turn the sum
 * into NaN.
 */
import { describe, expect, it } from "vitest";
import { totalsOfRecords, type RecordLike } from "./totals";

describe("totalsOfRecords with a row missing its amount", () => {
  it("adds it as zero and keeps the rest of the sum", () => {
    const rows: RecordLike[] = [
      { quantity: 10, unitLabel: "kg", estimatedAmountCents: 50_000, amountIsEstimate: false },
      {
        quantity: 5,
        unitLabel: "kg",
        estimatedAmountCents: undefined as unknown as null,
        amountIsEstimate: false,
      },
    ];
    const t = totalsOfRecords(rows);
    expect(t.valueCents).toBe(50_000);
    expect(t.recordsWithoutValue).toBe(0);
    expect(t.kg).toBe(15);
  });
});
