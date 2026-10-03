/**
 * Receipt documents for the kinds and gaps the main suite does not reach: a
 * discount, a payment with no new work, a worker with no name or document,
 * and a settlement opened without its worker or its date.
 */
import { describe, expect, it } from "vitest";
import type { PaymentReceipt, Settlement } from "../../api/types";
import { line } from "../../api/grossChange";
import { movementReceiptDoc, settlementReceiptDoc } from "./receiptDoc";

const TODAY = new Date("2026-09-26T12:00:00Z");

const slip = (p: Partial<PaymentReceipt>): PaymentReceipt => ({
  id: "0192f3a0-0009-7000-8000-00000000dddd",
  kind: "pago",
  workerId: "w1",
  date: "2026-09-19",
  method: "efectivo",
  paidCents: 500_000,
  previousBalanceCents: 500_000,
  currentWeekCents: 0,
  currentWeekFrom: null,
  currentWeekTo: null,
  deductions: [],
  deductionsCents: 0,
  remainingCents: 0,
  settlementId: null,
  settlementIds: [],
  note: null,
  reversed: false,
  ...p,
});

const settlement: Settlement = {
  id: "0192f3a0-0009-7000-8000-00000000eeee",
  workerId: "w1",
  workerName: "Ana Ruiz",
  periodStart: "2026-08-24",
  periodEnd: "2026-08-30",
  grossCents: 3_000_000,
  status: "open",
  lineCount: 0,
  note: null,
  createdAt: "",
  voidedAt: null,
  lines: [],
  voidedLineIds: [],
};

describe("movementReceiptDoc", () => {
  it("heads a discount with its note and keeps the note off the foot", () => {
    const doc = movementReceiptDoc({
      farmName: "F",
      worker: { name: "Ana", lastName: "Ruiz", documentNumber: "43.1" },
      slip: slip({ kind: "deduccion", note: "Mercado" }),
      lines: [],
      today: TODAY,
    });
    expect(doc.summary.map((r) => r.label)).toContain("Descuento · Mercado");
    expect(doc.note).toBeNull();
    expect(doc.workerDocument).toBe("43.1");
    expect(doc.fileName).toMatch(/^deduccion-ana-ruiz-2026-09-19-/);
  });

  it("calls a discount with no note just that", () => {
    const doc = movementReceiptDoc({
      farmName: "F",
      worker: { name: "Ana", lastName: "", documentNumber: "" },
      slip: slip({ kind: "deduccion" }),
      lines: [],
    });
    expect(doc.summary.map((r) => r.label)).toContain("Descuento");
  });

  it("does not list settled work on a payment of an old balance", () => {
    const doc = movementReceiptDoc({
      farmName: "F",
      worker: { name: "", lastName: "", documentNumber: "" },
      slip: slip({ kind: "pago" }),
      lines: [],
    });
    expect(doc.summary.map((r) => r.label)).not.toContain("Labores liquidadas");
    expect(doc.workerDocument).toBeNull();
    // A nameless worker still gets a file name that says what it is.
    expect(doc.fileName).toMatch(/^recibo-empleado-2026-09-19-/);
  });
});

describe("settlementReceiptDoc", () => {
  it("falls back to the settlement's own name, period and end date", () => {
    const doc = settlementReceiptDoc({
      farmName: "F",
      settlement,
      today: TODAY,
    });
    expect(doc.workerName).toBe("Ana Ruiz");
    expect(doc.workerDocument).toBeNull();
    expect(doc.date).toBe("2026-08-30");
    expect(doc.period).toContain("24");
    expect(doc.voided).toBeNull();
  });

  it("dates a void settlement by when it was voided, or by its own date", () => {
    const voided = settlementReceiptDoc({
      farmName: "F",
      settlement: {
        ...settlement,
        status: "void",
        voidedAt: "2026-09-02T10:00:00Z",
        lines: [line("1", 3_000_000)],
      },
      date: "2026-08-30",
      today: TODAY,
    });
    expect(voided.voided?.text).toMatch(/^Anulada el 02\/09\/2026/);
    const undated = settlementReceiptDoc({
      farmName: "F",
      settlement: { ...settlement, status: "void" },
      date: "2026-08-30",
      today: TODAY,
    });
    expect(undated.voided?.text).toMatch(/^Anulada el 30\/08\/2026/);
  });
});
