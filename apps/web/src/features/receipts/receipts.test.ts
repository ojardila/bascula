import { describe, expect, it } from "vitest";
import type { LedgerEntry, PayableLine, PaymentReceipt, Settlement } from "../../api/types";
import { groupReceiptLines, sumGroups } from "./receiptLines";
import { movementReceiptDoc, settlementReceiptDoc } from "./receiptDoc";
import { historyRows } from "./history";

const TODAY = new Date("2026-09-26T12:00:00Z");

function line(p: Partial<PayableLine>): PayableLine {
  return {
    id: Math.random().toString(36).slice(2),
    activityName: "Recolección",
    dateFrom: "2026-08-25",
    dateTo: "2026-08-25",
    weekStart: "2026-08-24",
    plotNames: ["La Cumbre"],
    payMode: "work_unit",
    quantity: 10,
    unitLabel: "kg",
    rateCents: 80_000,
    rateSource: "fixed",
    amountCents: 800_000,
    ...p,
  };
}

describe("groupReceiptLines", () => {
  const lines = [
    line({ quantity: 12.5, amountCents: 1_000_000 }),
    line({ dateFrom: "2026-08-26", dateTo: "2026-08-26", quantity: 20, amountCents: 1_600_000 }),
    line({ plotNames: ["El Mango"], quantity: 5, amountCents: 400_000 }),
    line({
      activityName: "Plateo", payMode: "time_unit", unitLabel: null, plotNames: ["El Mango"],
      quantity: 2, rateCents: 5_000_000, amountCents: 10_000_000,
    }),
    line({ weekStart: "2026-08-31", dateFrom: "2026-09-01", dateTo: "2026-09-01", quantity: 7, amountCents: 560_000 }),
  ];

  it("makes one row per week, labor and lote, and keeps the total exact", () => {
    const groups = groupReceiptLines(lines, TODAY);
    expect(groups.map((g) => [g.weekLabel, g.activityName, g.plotLabel, g.quantityLabel])).toEqual([
      ["24–30 ago", "Plateo", "El Mango", "2 jornales"],
      ["24–30 ago", "Recolección", "El Mango", "5 kg"],
      ["24–30 ago", "Recolección", "La Cumbre", "32,5 kg"],
      ["31 ago – 6 sep", "Recolección", "La Cumbre", "7 kg"],
    ]);
    expect(sumGroups(groups)).toBe(lines.reduce((a, l) => a + l.amountCents, 0));
    expect(groups[2].amountCents).toBe(2_600_000);
    expect(groups[2].count).toBe(2);
  });

  it("never merges two prices into one row", () => {
    const groups = groupReceiptLines([line({}), line({ rateCents: 90_000, amountCents: 900_000 })], TODAY);
    expect(groups).toHaveLength(2);
  });

  it("names a line with no lote", () => {
    expect(groupReceiptLines([line({ plotNames: [] })], TODAY)[0].plotLabel).toBe("Sin lote");
  });
});

const SLIP: PaymentReceipt = {
  id: "0192f3a0-0009-7000-8000-00000000ab3f",
  kind: "pago",
  workerId: "w",
  date: "2026-08-31",
  method: "efectivo",
  paidCents: 1_500_000,
  previousBalanceCents: 200_000,
  currentWeekCents: 1_800_000,
  currentWeekFrom: "2026-08-24",
  currentWeekTo: "2026-08-30",
  deductions: [{ concept: "Mercado", amountCents: 300_000, date: "2026-08-28" }],
  deductionsCents: 300_000,
  remainingCents: 200_000,
  settlementId: "s1",
  settlementIds: ["s1"],
  note: null,
  reversed: false,
};
const WORKER = { name: "Rosa", lastName: "Gómez", documentNumber: "123" };

describe("movementReceiptDoc", () => {
  it("prints the lines and a summary whose arithmetic closes", () => {
    const doc = movementReceiptDoc({
      farmName: "La Esperanza", worker: WORKER, slip: SLIP, today: TODAY,
      lines: [line({ amountCents: 1_000_000 }), line({ plotNames: ["El Mango"], amountCents: 800_000 })],
    });
    expect(doc.number).toBe("0000-AB3F");
    expect(doc.lines).toHaveLength(2);
    expect(doc.linesTotalCents).toBe(SLIP.currentWeekCents);
    const value = (label: string) => doc.summary.find((r) => r.label === label)!.cents;
    expect(value("Saldo anterior") + value("Labores liquidadas") - value("Descuento · Mercado") - value("Pagado"))
      .toBe(value("Queda"));
    expect(doc.balanceSentence).toContain("$2.000");
    expect(doc.period).toBe("24–30 ago");
    // Settled lines carry their settled price: nothing on a receipt is provisional.
    expect(doc.provisional).toBe(false);
    expect(doc.fileName).toBe("recibo-rosa-gomez-2026-08-31-0000-AB3F.pdf");
  });

  it("an advance has no lines, only its own amount", () => {
    const doc = movementReceiptDoc({
      farmName: "F", worker: WORKER, today: TODAY, lines: [line({})],
      slip: { ...SLIP, kind: "anticipo", currentWeekCents: 0, deductions: [], paidCents: 500_000,
        previousBalanceCents: 200_000, remainingCents: -300_000 },
    });
    expect(doc.title).toBe("Comprobante de anticipo");
    expect(doc.lines).toHaveLength(0);
    expect(doc.summary.map((r) => r.label)).toEqual(["Saldo anterior", "Anticipo entregado", "Queda"]);
    expect(doc.balanceSentence).toBe("Queda un anticipo a favor de la finca: $3.000.");
  });

  it("says so when the movement was cancelled later", () => {
    const doc = movementReceiptDoc({ farmName: "F", worker: WORKER, slip: { ...SLIP, reversed: true }, lines: [] });
    expect(doc.voided?.title).toBe("Movimiento anulado");
  });
});

describe("settlementReceiptDoc", () => {
  it("lists the frozen lines and the gross", () => {
    const s = {
      id: "0192f3a0-0009-7000-8000-000000001234", workerId: "w", workerName: "Rosa Gómez",
      periodStart: "2026-08-24", periodEnd: "2026-08-30", grossCents: 1_800_000, status: "open",
      lineCount: 2, note: null, createdAt: "2026-08-31T15:00:00Z", voidedAt: null, voidedLineIds: [],
      lines: [line({ amountCents: 1_000_000 }), line({ amountCents: 800_000 })],
    } as Settlement;
    const doc = settlementReceiptDoc({
      farmName: "F", settlement: { ...s, periodEnd: "2027-08-29" }, date: "2026-08-31", today: TODAY,
    });
    expect(doc.lines).toHaveLength(1);
    expect(doc.linesTotalCents).toBe(1_800_000);
    expect(doc.headline.cents).toBe(1_800_000);
    expect(doc.period).toBe("24–30 ago");
  });
});

describe("historyRows", () => {
  const e = (p: Partial<LedgerEntry>): LedgerEntry => ({
    id: "x", workerId: "w", kind: "pago", concept: "Pago", amountCents: -100, date: "2026-08-31",
    method: null, receiptNumber: null, reversesId: null, settlementId: null, ...p,
  });
  it("names every kind, links it to its document and marks what was cancelled", () => {
    const rows = historyRows([
      e({ id: "r", kind: "reverso", reversesId: "d", amountCents: -1000 }),
      e({ id: "p" }),
      e({ id: "a", kind: "anticipo" }),
      e({ id: "q", kind: "deduccion" }),
      e({ id: "d", kind: "devengo", settlementId: "s", amountCents: 1000 }),
      e({ id: "j", kind: "ajuste" }),
    ]);
    expect(rows.map((r) => [r.label, r.target?.kind ?? null, r.voided])).toEqual([
      ["Pago", "pago", false],
      ["Anticipo", "anticipo", false],
      ["Descuento", "descuento", false],
      ["Liquidación", "liquidacion", true],
      ["Ajuste", null, false],
    ]);
    expect(rows[3].target?.entryId).toBe("s");
  });
});
