/**
 * The paper, under test.
 *
 * Three things are checked here and they are the three that would actually
 * hurt: a document that reaches out to the network, a document that prints a
 * zero it does not know, and a document that prints an estimate as though it
 * were decided. Everything else about a receipt is taste.
 */
import { describe, expect, it } from "vitest";
import { paymentReceiptHtml, payrollHtml, settlementHtml } from "./documents";
import { line } from "../../api/grossChange";
import type { Payment, Settlement, Worker } from "../../api/types";

const worker = {
  name: "María",
  lastName: "Restrepo Ospina",
  documentNumber: "43.215.678",
} as Pick<Worker, "name" | "lastName" | "documentNumber">;

const payment: Payment = {
  id: "01a0-pago",
  workerId: "01a0-maria",
  amountCents: 15_360_000,
  method: "efectivo",
  receiptNumber: "01a0-pago",
  balanceBeforeCents: 15_360_000,
  balanceAfterCents: 0,
  date: "2026-08-29",
};

const settlement: Settlement = {
  id: "01a0-liq",
  workerId: "01a0-maria",
  workerName: "María Restrepo Ospina",
  periodStart: "2026-08-24",
  periodEnd: "2026-08-30",
  grossCents: 15_360_000,
  status: "open",
  lineCount: 2,
  note: null,
  createdAt: "2026-08-29T12:00:00Z",
  voidedAt: null,
  lines: [line("1", 8_000_000), line("2", 7_360_000)],
  voidedLineIds: [],
};

/**
 * The publishing policy forbids external hosts outright, and a farm office
 * prints with no internet. A stylesheet or a font that fails to load turns a
 * receipt somebody is about to sign into unstyled text, so this is asserted
 * on every document rather than trusted to review.
 */
function hasNoExternalReference(html: string) {
  expect(html).not.toMatch(/https?:\/\//);
  expect(html).not.toMatch(/<link\b/i);
  expect(html).not.toMatch(/<script\b/i);
  expect(html).not.toMatch(/@import/);
  expect(html).not.toMatch(/url\(/);
}

describe("el recibo de pago (RSP-008)", () => {
  it("no pide nada a la red", () => {
    hasNoExternalReference(paymentReceiptHtml({ farmName: "La Esperanza", worker, payment, lines: settlement.lines }));
  });

  it("dice «queda a paz y salvo» en vez de imprimir un $0", () => {
    const html = paymentReceiptHtml({
      farmName: "La Esperanza",
      worker,
      payment,
      lines: settlement.lines,
    });
    // A "$0" where a balance goes is a claim somebody will read as a figure.
    expect(html).toContain("queda a paz y salvo");
  });

  it("distingue lo que la finca debe de lo que el empleado debe", () => {
    const owed = paymentReceiptHtml({
      farmName: "La Esperanza",
      worker,
      payment: { ...payment, balanceAfterCents: 2_000_000 },
      lines: [],
    });
    expect(owed).toContain("Queda pendiente a favor del empleado");

    const advance = paymentReceiptHtml({
      farmName: "La Esperanza",
      worker,
      payment: { ...payment, balanceAfterCents: -2_000_000 },
      lines: [],
    });
    // The sign convention of a ledger is not something a worker should have to
    // know, so the direction is named in words. And the figure is printed
    // POSITIVE next to the words that give it its direction.
    expect(advance).toContain("Queda un anticipo a favor de la finca");
    expect(advance).toContain("$20.000");
  });

  it("omite el documento cuando no hay, en vez de imprimir un guion", () => {
    const html = paymentReceiptHtml({
      farmName: "La Esperanza",
      worker: { ...worker, documentNumber: "" },
      payment,
      lines: [],
    });
    expect(html).not.toContain("Documento");
  });

  it("escapa lo que escribió una persona", () => {
    const html = paymentReceiptHtml({
      farmName: '<script>alert("x")</script>',
      worker: { ...worker, name: "Ana & <b>" },
      payment,
      lines: [],
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Ana &amp; &lt;b&gt;");
    hasNoExternalReference(html);
  });
});

describe("lo estimado no se imprime como definitivo", () => {
  const provisional = [line("1", 8_000_000, { rateSource: "weekly_price" })];

  it("marca la línea y explica por qué, no sólo con un color", () => {
    const html = paymentReceiptHtml({
      farmName: "La Esperanza",
      worker,
      payment,
      lines: provisional,
    });
    // The word, in the row: a colour alone does not survive the
    // black-and-white printer in a farm office.
    expect(html).toContain("provisional");
    expect(html).toContain("PROVISIONAL.");
    expect(html).toContain("todavía no está fijado");
  });

  it("y no lo dice cuando todo está congelado", () => {
    const html = paymentReceiptHtml({
      farmName: "La Esperanza",
      worker,
      payment,
      lines: settlement.lines,
    });
    expect(html).not.toContain("PROVISIONAL.");
  });
});

describe("la liquidación", () => {
  it("imprime aunque esté anulada, y lo dice", () => {
    const html = settlementHtml({
      farmName: "La Esperanza",
      settlement: { ...settlement, status: "void", voidedAt: "2026-08-30T09:00:00Z" },
      printedOn: "2026-08-31",
    });
    // Somebody was handed the original. Refusing to reprint it leaves them
    // holding a document they cannot check against anything.
    expect(html).toContain("Liquidación anulada");
    expect(html).toContain("no es un comprobante de pago");
    expect(html).toContain("$153.600");
    hasNoExternalReference(html);
  });
});

describe("la planilla", () => {
  it("lista las anuladas tachadas en vez de esconderlas, y no las suma", () => {
    const html = payrollHtml({
      farmName: "La Esperanza",
      title: "Planilla de liquidaciones",
      date: "2026-08-29",
      unit: null,
      rows: [
        { name: "María", quantity: null, grossCents: 10_000_000, balanceCents: 0, status: "open" },
        { name: "Jhon", quantity: null, grossCents: 5_000_000, balanceCents: 0, status: "void" },
      ],
    });
    expect(html).toContain("María");
    expect(html).toContain("Jhon");
    expect(html).toContain("line-through");
    expect(html).toContain("1 anulada");
    // The total is over the live rows only: a void settlement wrote a devengo
    // and a reverso that cancel, so counting it states a figure the ledger
    // does not agree with.
    expect(html).toContain("$100.000");
    expect(html).not.toContain("$150.000");
  });

  it("imprime «—» donde no hay cantidad, nunca un cero", () => {
    const html = payrollHtml({
      farmName: "La Esperanza",
      title: "Planilla",
      date: "2026-08-29",
      unit: null,
      rows: [
        { name: "María", quantity: null, grossCents: 10_000_000, balanceCents: 0, status: "open" },
      ],
    });
    // "0 kg" would say the picker weighed nothing. "—" says nobody asked.
    expect(html).toContain("—");
  });
});
