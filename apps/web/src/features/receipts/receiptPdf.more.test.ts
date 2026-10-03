// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadReceiptPdf, pdfText, receiptPdfBytes } from "./receiptPdf";
import type { ReceiptDoc } from "./receiptDoc";

const line = (i: number, provisional = false) => ({
  key: `k${i}`,
  weekStart: "2026-08-24",
  weekLabel: "24–30 ago",
  activityName: `Recolección ${i}`,
  plotLabel: "La Cumbre",
  quantity: 10 + i,
  quantityLabel: `${10 + i} kg`,
  rateCents: 80_000,
  amountCents: 800_000 + i,
  provisional,
  count: 1,
});

const PLAIN: ReceiptDoc = {
  kind: "liquidacion",
  title: "Liquidación",
  farmName: "La Esperanza 🌱",
  number: "0000-CD12",
  date: "2026-08-31",
  workerName: "Los Primos",
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
  receivedBy: "Yorman “el Mono”",
  fileName: "liquidacion.pdf",
};

const isPdf = (b: ArrayBuffer) =>
  String.fromCharCode(...new Uint8Array(b).slice(0, 5)) === "%PDF-";

describe("the PDF, other shapes", () => {
  it("writes a settlement with no lines, no period and who received the money", async () => {
    expect(isPdf(await receiptPdfBytes(PLAIN))).toBe(true);
  }, 20000);

  it("breaks onto more pages when the lines do not fit", async () => {
    const many = Array.from({ length: 70 }, (_, i) => line(i, i % 2 === 0));
    expect(
      isPdf(
        await receiptPdfBytes({
          ...PLAIN,
          kind: "pago",
          title: "Recibo de pago",
          lines: many,
          workerDocument: "CC 123",
          period: "24–30 ago",
          provisional: true,
          note: "Pagado en efectivo…",
          balanceSentence: "Queda pendiente a favor del empleado: $1.000.",
        }),
      ),
    ).toBe(true);
  }, 30000);

  it("drops characters the PDF font cannot draw and straightens quotes", () => {
    expect(pdfText("“Hola” ‘ok’ 🌱…")).toBe(`"Hola" 'ok' ...`);
  });
});

describe("downloadReceiptPdf", () => {
  const originalUA = navigator.userAgent;
  let createObjectURL: ReturnType<typeof vi.fn>;

  function setUA(ua: string, touch = 0) {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: ua,
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      configurable: true,
      value: touch,
    });
  }

  beforeEach(() => {
    createObjectURL = vi.fn(() => "blob:receipt");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    setUA(originalUA, 0);
    delete (navigator as unknown as Record<string, unknown>).share;
    delete (navigator as unknown as Record<string, unknown>).canShare;
    vi.restoreAllMocks();
  });

  it("downloads the file on a desktop", async () => {
    setUA("Mozilla/5.0 (X11; Linux x86_64)");
    await expect(downloadReceiptPdf(PLAIN)).resolves.toBe("downloaded");
    expect(createObjectURL).toHaveBeenCalled();
  }, 20000);

  it("fails when the browser cannot make a download link", async () => {
    setUA("Mozilla/5.0 (X11; Linux x86_64)");
    createObjectURL.mockImplementation(() => {
      throw new Error("no blobs");
    });
    await expect(downloadReceiptPdf(PLAIN)).resolves.toBe("failed");
  }, 20000);

  it("fails when the PDF cannot be written", async () => {
    await expect(
      downloadReceiptPdf({
        ...PLAIN,
        lines: undefined,
      } as unknown as ReceiptDoc),
    ).resolves.toBe("failed");
  });

  it("uses the share sheet on an iPhone", async () => {
    setUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    const share = vi.fn(async () => undefined);
    Object.assign(navigator, { share, canShare: () => true });
    await expect(downloadReceiptPdf(PLAIN)).resolves.toBe("shared");
    expect(share).toHaveBeenCalled();
  }, 20000);

  it("reports a share the person cancelled on an iPad", async () => {
    setUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5);
    Object.assign(navigator, {
      share: vi.fn(async () => {
        throw new DOMException("cancelled", "AbortError");
      }),
      canShare: () => true,
    });
    await expect(downloadReceiptPdf(PLAIN)).resolves.toBe("cancelled");
  }, 20000);

  it("falls back to a download when the share sheet fails", async () => {
    setUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    Object.assign(navigator, {
      share: vi.fn(async () => {
        throw new Error("not allowed");
      }),
      canShare: () => true,
    });
    await expect(downloadReceiptPdf(PLAIN)).resolves.toBe("downloaded");
  }, 20000);

  it("downloads on an iPhone that cannot share files", async () => {
    setUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    Object.assign(navigator, { canShare: () => false });
    await expect(downloadReceiptPdf(PLAIN)).resolves.toBe("downloaded");
  }, 20000);
});
