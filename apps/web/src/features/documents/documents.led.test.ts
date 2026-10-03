// SPDX-License-Identifier: MIT
/**
 * The WhatsApp receipt names each deduction, the same as the printed one.
 *
 * Found by the coverage ledger (docs/coverage.md): the deduction line of
 * `paymentReceiptText` was reachable but no test sent a deduction through it.
 */
import { describe, expect, it } from "vitest";
import { paymentReceiptText } from "./documents";
import type { Payment } from "../../api/types";

function ledPayment(): Payment {
  return {
    id: "01a0-pago",
    workerId: "01a0-maria",
    amountCents: 12_000_000,
    method: "efectivo",
    receiptNumber: "01a0-pago",
    balanceBeforeCents: 15_360_000,
    balanceAfterCents: 1_360_000,
    date: "2026-08-29",
  };
}

describe("paymentReceiptText deductions", () => {
  it("lists every deduction by concept, between the balance and the payment", () => {
    const text = paymentReceiptText({
      farmName: "La Esperanza",
      worker: { name: "María", lastName: "Restrepo", documentNumber: "" },
      payment: ledPayment(),
      lines: [],
      deductions: [
        { concept: "Mercado", amountCents: 2_000_000, date: "2026-08-26" },
        { concept: "Botas", amountCents: 500_000, date: "2026-08-27" },
      ],
    });
    const rows = text.split("\n");
    const balance = rows.findIndex((l) => l.startsWith("Saldo anterior"));
    const market = rows.findIndex((l) => l.startsWith("Descuento · Mercado: − "));
    const boots = rows.findIndex((l) => l.startsWith("Descuento · Botas: − "));
    const paid = rows.findIndex((l) => l.startsWith("*Pagado"));
    expect(rows[market]).toContain("$20.000");
    expect(rows[boots]).toContain("$5.000");
    expect(balance).toBeLessThan(market);
    expect(market).toBeLessThan(boots);
    expect(boots).toBeLessThan(paid);
  });
});
