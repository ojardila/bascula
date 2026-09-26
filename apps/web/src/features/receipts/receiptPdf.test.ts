import { describe, expect, it } from "vitest";
import { pdfText, receiptPdfBytes } from "./receiptPdf";
import type { ReceiptDoc } from "./receiptDoc";

const DOC: ReceiptDoc = {
  kind: "pago",
  title: "Recibo de pago",
  farmName: "La Esperanza",
  number: "0000-AB3F",
  date: "2026-08-31",
  workerName: "Rosa Gómez Ñañez",
  workerDocument: "123",
  period: "24–30 ago",
  voided: { title: "Movimiento anulado", text: "Se anuló después." },
  lines: [
    {
      key: "k", weekStart: "2026-08-24", weekLabel: "24–30 ago", activityName: "Recolección",
      plotLabel: "La Cumbre", quantity: 32.5, quantityLabel: "32,5 kg", rateCents: 80_000,
      amountCents: 2_600_000, provisional: true, count: 2,
    },
  ],
  linesTotalCents: 2_600_000,
  summary: [
    { label: "Saldo anterior", cents: 0, sign: "" },
    { label: "Labores liquidadas", cents: 2_600_000, sign: "+" },
    { label: "Pagado", cents: 2_600_000, sign: "−" },
    { label: "Queda", cents: 0, sign: "", strong: true },
  ],
  headline: { label: "Pagado", cents: 2_600_000 },
  balanceSentence: "Después de este movimiento queda a paz y salvo.",
  provisional: true,
  note: "Nota",
  fileName: "recibo.pdf",
};

describe("the PDF", () => {
  it("writes a PDF file", async () => {
    const bytes = new Uint8Array(await receiptPdfBytes(DOC));
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(2000);
  }, 20000);

  it("keeps Spanish letters and turns typographic dashes into hyphens", () => {
    expect(pdfText("Recolección · 24–30 ago − Ñañez")).toBe("Recolección · 24-30 ago - Ñañez");
  });
});
