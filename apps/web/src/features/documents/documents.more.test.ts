// SPDX-License-Identifier: MIT
/**
 * The less common shapes of the three documents: a week the receipt can name,
 * a settlement with no weighed unit, a payment run sheet with a missing paid
 * figure, and the chat text's three balance sentences.
 */
import { describe, expect, it } from "vitest";
import {
  paymentReceiptHtml,
  paymentReceiptText,
  payrollHtml,
  settlementHtml,
} from "./documents";
import { line } from "../../api/grossChange";
import type { Payment, Settlement } from "../../api/types";

const worker = { name: "Ana", lastName: "Ruiz", documentNumber: "" };

const payment = (after: number): Payment => ({
  id: "p1",
  workerId: "w1",
  amountCents: 1_000_000,
  method: "efectivo",
  receiptNumber: "3F7A-91C2",
  balanceBeforeCents: 1_000_000 + after,
  balanceAfterCents: after,
  date: "2026-09-19",
});

const settlement: Settlement = {
  id: "0192f3a0-0009-7000-8000-00000000cccc",
  workerId: "w1",
  workerName: "Ana Ruiz",
  periodStart: "2026-08-24",
  periodEnd: "2026-08-30",
  grossCents: 3_000_000,
  status: "open",
  lineCount: 1,
  note: null,
  createdAt: "2026-08-29T12:00:00Z",
  voidedAt: null,
  lines: [line("1", 3_000_000)],
  voidedLineIds: [],
};

describe("the payment receipt", () => {
  it("names the week it paid when it knows it", () => {
    const html = paymentReceiptHtml({
      farmName: "La Esperanza",
      worker,
      payment: payment(0),
      lines: [],
      breakdown: {
        previousBalanceCents: 0,
        currentWeekCents: 1_000_000,
        currentWeekFrom: "2026-09-14",
        currentWeekTo: "2026-09-20",
        deductions: [],
        deductionsCents: 0,
        paidCents: 1_000_000,
        remainingCents: 0,
      },
    });
    expect(html).toMatch(/Semana actual \([^)]*14[^)]*20 sep[^)]*\)/);
  });

  it("says plainly in a chat message what is left, either way", () => {
    const text = (after: number) =>
      paymentReceiptText({
        farmName: "La Esperanza",
        worker,
        payment: payment(after),
        lines: [],
      });
    expect(text(0)).toContain("queda a paz y salvo");
    expect(text(250_000)).toContain(
      "Queda pendiente a favor del empleado: $2.500",
    );
    expect(text(-250_000)).toContain(
      "Queda un anticipo a favor de la finca: $2.500",
    );
  });
});

describe("the settlement document", () => {
  it("leaves out the weighed total when no line has a unit, and prints the note", () => {
    const html = settlementHtml({
      farmName: "La Esperanza",
      settlement: {
        ...settlement,
        note: "Pago en la oficina <martes>",
        lines: [
          line("1", 3_000_000, { unitLabel: null, payMode: "time_unit" }),
        ],
      },
      printedOn: "2026-08-31",
    });
    expect(html).not.toContain('<div class="card muted"><div class="k">kg');
    expect(html).toContain("Pago en la oficina &lt;martes&gt;");
  });

  it("warns when a line was paid at the week's price", () => {
    const html = settlementHtml({
      farmName: "La Esperanza",
      settlement: {
        ...settlement,
        lines: [line("1", 3_000_000, { rateSource: "weekly_price" })],
      },
      printedOn: "2026-08-31",
    });
    expect(html).toContain("PROVISIONAL");
  });

  it("still prints a void settlement whose date was lost", () => {
    const html = settlementHtml({
      farmName: "La Esperanza",
      settlement: { ...settlement, status: "void", voidedAt: null },
      printedOn: "2026-08-31",
    });
    expect(html).toContain("Liquidación anulada");
  });
});

describe("the payment run sheet", () => {
  it("adds a paid column, with a dash for a row nobody paid, and the weighed total", () => {
    const html = payrollHtml({
      farmName: "La Esperanza",
      title: "Planilla de pagos",
      date: "2026-08-29",
      unit: "kg",
      rows: [
        {
          name: "Ana",
          documentNumber: "1.234",
          quantity: 120.5,
          grossCents: 9_000_000,
          balanceCents: 0,
          paidCents: 9_000_000,
          status: "open",
        },
        {
          name: "Luis",
          quantity: 30,
          grossCents: 2_000_000,
          balanceCents: 2_000_000,
          paidCents: null,
          status: "open",
        },
      ],
    });
    expect(html).toContain("Pagado");
    expect(html).toContain("Entregado");
    expect(html).toContain("$90.000");
    expect(html).toContain("1.234");
    // 150,5 kg weighed between the two.
    expect(html).toContain("150,5");
    expect(html.match(/<td class="n amt">—<\/td>/g)).toHaveLength(1);
  });

  it("prints a dash for the total when nobody's quantity is known", () => {
    const html = payrollHtml({
      farmName: "La Esperanza",
      title: "Planilla",
      date: "2026-08-29",
      unit: "kg",
      rows: [
        {
          name: "Ana",
          quantity: null,
          grossCents: 1_000_000,
          balanceCents: null,
          status: "open",
        },
      ],
    });
    expect(html).toContain('<td class="n">—</td>');
    expect(html).not.toContain("Entregado");
  });
});
