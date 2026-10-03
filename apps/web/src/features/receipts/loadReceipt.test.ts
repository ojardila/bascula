import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/endpoints";
import { signInOwner } from "../../test/renderWithAuth";
import * as db from "../../mocks/db";
import { loadReceiptDoc } from "./loadReceipt";

const SETTLEMENT_ID = "0192f3a0-000b-7000-8000-000000000001";
const ADVANCE_ID = "0192f3a0-0009-7000-8000-000000000003";

function tenant() {
  const t = db.tenantOf(db.FARM_ID);
  if (!t) throw new Error("no seeded tenant");
  return t;
}

describe("loadReceiptDoc", () => {
  beforeEach(() => signInOwner());
  afterEach(() => vi.restoreAllMocks());

  it("builds a settlement's receipt dated on the farm's business day", async () => {
    const s = tenant().settlements.find((x) => x.id === SETTLEMENT_ID)!;
    const doc = await loadReceiptDoc({
      workerId: s.workerId,
      kind: "liquidacion",
      entryId: s.id,
      farmName: "La Esperanza",
      timezone: "America/Bogota",
    });
    expect(doc.kind).toBe("liquidacion");
    expect(doc.farmName).toBe("La Esperanza");
    // 23:45 UTC on the 22nd is still the 22nd in Bogotá.
    expect(doc.date).toBe("2026-08-22");
    expect(doc.workerName).not.toBe("—");
  });

  it("builds an advance without fetching any settlement", async () => {
    const entry = tenant().ledger.find((l) => l.id === ADVANCE_ID)!;
    const getSettlement = vi.spyOn(api, "getSettlement");
    const doc = await loadReceiptDoc({
      workerId: entry.workerId,
      kind: "anticipo",
      entryId: entry.id,
      farmName: "La Esperanza",
      timezone: "America/Bogota",
    });
    expect(doc.kind).toBe("anticipo");
    expect(getSettlement).not.toHaveBeenCalled();
  });

  it("puts a payment's settled lines on it and survives a worker it cannot read", async () => {
    const real = await api.getPayment(ADVANCE_ID);
    vi.spyOn(api, "getPayment").mockResolvedValue({
      ...real,
      kind: "pago",
      settlementIds: [SETTLEMENT_ID],
    });
    vi.spyOn(api, "getWorker").mockRejectedValue(new Error("gone"));
    const getSettlement = vi.spyOn(api, "getSettlement");

    const doc = await loadReceiptDoc({
      workerId: real.workerId,
      kind: "pago",
      entryId: ADVANCE_ID,
      farmName: "La Esperanza",
      timezone: "America/Bogota",
    });
    expect(getSettlement).toHaveBeenCalledWith(SETTLEMENT_ID);
    expect(doc.kind).toBe("pago");
    expect(doc.workerName).toBe("—");
    expect(doc.lines.length).toBeGreaterThan(0);
  });
});
