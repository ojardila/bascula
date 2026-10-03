// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadReceiptPdf, receiptPdfBytes } from "./receiptPdf";
import type { ReceiptDoc } from "./receiptDoc";

const DOC: ReceiptDoc = {
  kind: "liquidacion",
  title: "Liquidación",
  farmName: "La Esperanza",
  number: "0000-CD12",
  date: "2026-08-31",
  workerName: "Ana Ruiz",
  workerDocument: null,
  period: null,
  voided: null,
  lines: [],
  linesTotalCents: 0,
  summary: [{ label: "Queda", cents: 0, sign: "", strong: true }],
  headline: { label: "Liquidado", cents: 0 },
  balanceSentence: null,
  provisional: false,
  note: null,
  receivedBy: null,
  fileName: "liquidacion.pdf",
};

const text = (b: ArrayBuffer) => new TextDecoder("latin1").decode(new Uint8Array(b));

describe("receipt PDF, the page break under the totals", () => {
  it("moves a note that does not fit onto a second page", async () => {
    const note = Array.from({ length: 80 }, (_, i) => `Renglón ${i} de la nota.`).join("\n");
    const out = text(await receiptPdfBytes({ ...DOC, note }));
    expect(out).toMatch(/Página 2 de \d/);
  }, 30000);
});

describe("downloadReceiptPdf, the edges", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("downloads when there is no navigator, and frees the link a minute later", async () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:x") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("navigator", undefined);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await expect(downloadReceiptPdf(DOC)).resolves.toBe("downloaded");
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith("blob:x");
  }, 30000);
});
