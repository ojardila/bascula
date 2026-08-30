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

describe("the pay receipt (RSP-008)", () => {
  it("asks the network for nothing", () => {
    hasNoExternalReference(paymentReceiptHtml({ farmName: "La Esperanza", worker, payment, lines: settlement.lines }));
  });

  it("says the worker is square with everybody instead of printing a $0", () => {
    const html = paymentReceiptHtml({
      farmName: "La Esperanza",
      worker,
      payment,
      lines: settlement.lines,
    });
    // A "$0" where a balance goes is a claim somebody will read as a figure.
    expect(html).toContain("queda a paz y salvo");
  });

  it("tells what the farm owes apart from what the employee owes", () => {
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

  it("leaves the document number out when there is none, rather than printing a dash", () => {
    const html = paymentReceiptHtml({
      farmName: "La Esperanza",
      worker: { ...worker, documentNumber: "" },
      payment,
      lines: [],
    });
    expect(html).not.toContain("Documento");
  });

  it("does not print the movement UUID on the receipt the worker takes home", () => {
    const html = paymentReceiptHtml({
      farmName: "La Esperanza",
      worker,
      payment: { ...payment, id: "0192f3a0-0009-7000-8000-000000000009", receiptNumber: "3F7A-91C2" },
      lines: [],
    });
    expect(html).toContain("Recibo N.º 3F7A-91C2");
    expect(html).not.toContain("0192f3a0-0009-7000-8000-000000000009");
  });

  it("escapes anything a person typed", () => {
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

describe("a provisional figure is not printed as a settled one", () => {
  const provisional = [line("1", 8_000_000, { rateSource: "weekly_price" })];

  it("marks the row and explains why, not with a colour alone", () => {
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

  it("and says none of that when every price is already frozen", () => {
    const html = paymentReceiptHtml({
      farmName: "La Esperanza",
      worker,
      payment,
      lines: settlement.lines,
    });
    expect(html).not.toContain("PROVISIONAL.");
  });
});

describe("the settlement", () => {
  it("prints even when it has been voided, and says so", () => {
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

  it("prints both ends of a period that is not one week", () => {
    const html = settlementHtml({
      farmName: "La Esperanza",
      settlement: { ...settlement, periodStart: "2026-08-24", periodEnd: "2027-08-15" },
      printedOn: "2026-08-31",
    });
    expect(html).toContain("24 ago 2026");
    expect(html).toContain("15 ago 2027");
    expect(html).not.toContain("24–30 ago —");
    expect(html).not.toContain(settlement.id);
  });

  /**
   * A settlement is signed and filed, and the API issues it no receipt number,
   * so the id is the only thing that says which settlement a signed sheet is.
   * The worker's name alone made two settlements of the same person into the
   * same document.
   */
  it("numbers the paper so two settlements of one worker are told apart", () => {
    const of = (id: string) =>
      settlementHtml({
        farmName: "La Esperanza",
        settlement: { ...settlement, id },
        printedOn: "2026-08-31",
      });

    const first = of("0192f3a0-0009-7000-8000-00000000aaaa");
    const second = of("0192f3a0-0009-7000-8000-00000000bbbb");

    expect(first).toContain("Liquidación N.º 0000-AAAA · María Restrepo Ospina");
    expect(second).toContain("Liquidación N.º 0000-BBBB · María Restrepo Ospina");
    // The number is short enough to read off a printed footer, and the whole
    // UUID still stays off the paper.
    expect(first).not.toContain("0192f3a0-0009-7000-8000-00000000aaaa");
  });
});

describe("the payroll sheet", () => {
  it("lists voided settlements struck through instead of hiding them, and leaves them out of the total", () => {
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

  /**
   * ── A SIGNED PAYROLL SHEET CANNOT BE A SEARCH RESULT ───────────────────
   *
   * The settlements screen prints the rows its filters left, which is right —
   * printing one crew's sheet is the point. What was wrong is that the paper
   * said nothing about it: the farm's name, today's date, a signature column,
   * and a total. Typing "Rosa" into the search box turned a $2.220.080 payroll
   * into a $335.280 one and the sheet gave no hint. It is the document that
   * gets filed and signed.
   */
  it("says on the paper that it is partial, and which filter made it so", () => {
    const html = payrollHtml({
      farmName: "La Esperanza",
      title: "Planilla de liquidaciones (parcial)",
      date: "2026-08-29",
      unit: null,
      rows: [
        { name: "Rosa Quintero", quantity: null, grossCents: 33_528_000, balanceCents: 0, status: "open" },
      ],
      scope: {
        filters: ["empleado contiene «Rosa»"],
        totalRows: 6,
        totalGrossCents: 222_008_000,
      },
    });
    // Said once loudly, in the same block the provisional warning uses, so it
    // survives a black-and-white printer.
    expect(html).toContain("PLANILLA PARCIAL");
    expect(html).toContain("1 de 6 liquidaciones");
    expect(html).toContain("empleado contiene «Rosa»");
    // And the figure the sheet is NOT showing, so the reader can tell how much
    // of the farm is missing rather than having to know.
    expect(html).toContain("$2.220.080");
    expect(html).toContain("$335.280");
    // Repeated next to the signature, which is the half of the page somebody
    // is actually looking at when they sign it.
    expect(html).toContain("PARCIAL · empleado contiene «Rosa»");
    // The total card cannot claim to be the farm's.
    expect(html).toContain("Bruto liquidado (filtrado)");
  });

  /** …and an unfiltered sheet carries none of that, because it needs none. */
  it("puts no warnings on a sheet that is the whole list", () => {
    const html = payrollHtml({
      farmName: "La Esperanza",
      title: "Planilla de liquidaciones",
      date: "2026-08-29",
      unit: null,
      rows: [
        { name: "Rosa Quintero", quantity: null, grossCents: 33_528_000, balanceCents: 0, status: "open" },
      ],
      scope: { filters: [], totalRows: 1, totalGrossCents: 33_528_000 },
    });
    expect(html).not.toContain("PARCIAL");
    expect(html).toContain("Bruto liquidado");
  });

  it("prints a dash where there is no quantity, never a zero", () => {
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
