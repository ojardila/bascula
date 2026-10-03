// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/endpoints";
import { signInOwner } from "../../test/renderWithAuth";
import { loadReceiptDoc } from "./loadReceipt";
import { settlementReceiptDoc } from "./receiptDoc";

const SETTLEMENT_ID = "0192f3a0-000b-7000-8000-000000000001";

describe("loadReceiptDoc with an undated settlement", () => {
  beforeEach(() => signInOwner());
  afterEach(() => vi.restoreAllMocks());

  it("falls back to the settlement's own date when it has no creation time", async () => {
    const real = await api.getSettlement(SETTLEMENT_ID);
    vi.spyOn(api, "getSettlement").mockResolvedValue({ ...real, createdAt: "" });
    const doc = await loadReceiptDoc({
      workerId: real.workerId,
      kind: "liquidacion",
      entryId: SETTLEMENT_ID,
      farmName: "La Esperanza",
      timezone: "America/Bogota",
    });
    expect(doc.date).toBe(real.periodEnd);
  });
});

describe("settlementReceiptDoc without a date", () => {
  it("dates the receipt on the day the settlement was created", async () => {
    signInOwner();
    const real = await api.getSettlement(SETTLEMENT_ID);
    const doc = settlementReceiptDoc({
      farmName: "F",
      settlement: { ...real, createdAt: "2026-08-22T10:00:00Z" },
    });
    expect(doc.date).toBe("2026-08-22");
  });
});
