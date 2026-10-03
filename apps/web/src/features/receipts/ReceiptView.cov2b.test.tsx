// SPDX-License-Identifier: MIT
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReceiptDoc } from "./receiptDoc";
import { ReceiptView } from "./ReceiptView";

const line = (i: number, provisional: boolean) => ({
  key: `k${i}`,
  weekStart: "2026-08-24",
  weekLabel: "24–30 ago",
  activityName: `Labor ${i}`,
  plotLabel: "La Cumbre",
  quantity: 10,
  quantityLabel: "10 kg",
  rateCents: 80_000,
  amountCents: 800_000,
  provisional,
  count: 1,
});

const BASE: ReceiptDoc = {
  kind: "liquidacion",
  title: "Liquidación",
  farmName: "La Esperanza",
  number: "0000-CD12",
  date: "2026-08-31",
  workerName: "Ana Ruiz",
  workerDocument: null,
  period: "24–30 ago",
  voided: { title: "Liquidación anulada", text: "No es un comprobante de pago." },
  lines: [line(1, true), line(2, false)],
  linesTotalCents: 1_600_000,
  summary: [{ label: "Total liquidado", cents: 1_600_000, sign: "", strong: true }],
  headline: { label: "Total liquidado", cents: 1_600_000 },
  balanceSentence: null,
  provisional: true,
  note: null,
  receivedBy: "Yorman",
  fileName: "liquidacion.pdf",
};

describe("ReceiptView, a voided settlement with provisional lines", () => {
  it("shows the void notice, the period without a document, each line and the provisional warning", () => {
    render(<ReceiptView doc={BASE} />);
    expect(screen.getByText("Liquidación anulada.")).toBeInTheDocument();
    expect(screen.getByText(/Liquidación N\.º/)).toBeInTheDocument();
    expect(screen.getByText("Periodo 24–30 ago")).toBeInTheDocument();
    const cards = screen.getAllByTestId("receipt-line");
    expect(within(cards[0]).getByText("Labor 1 (provisional)")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Labor 2")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Labor 1 (provisional)")).toBeInTheDocument();
    expect(within(table).getByText("Labor 2")).toBeInTheDocument();
    expect(screen.getByText("Yorman")).toBeInTheDocument();
    expect(screen.getByText("PROVISIONAL.")).toBeInTheDocument();
  });

  it("shows a payment receipt with a document and no period", () => {
    render(
      <ReceiptView
        doc={{ ...BASE, kind: "pago", voided: null, workerDocument: "CC 123", period: null, provisional: false, receivedBy: null }}
      />,
    );
    expect(screen.getByText(/Recibo N\.º/)).toBeInTheDocument();
    expect(screen.getByText("Documento CC 123")).toBeInTheDocument();
    expect(screen.queryByText("PROVISIONAL.")).not.toBeInTheDocument();
  });
});
