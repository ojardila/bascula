/**
 * "DESCARGAR PDF", AS A REAL FILE.
 *
 * The console already prints through the browser's own dialog (see
 * `documents/print.ts`), and on a computer that is fine. On a phone it is
 * not: iOS prints an iframe as the page behind it, Android hides "Guardar
 * como PDF" two menus down, and a farm owner standing in the patio with a
 * worker waiting does not find either. So the receipt is written as a PDF
 * here, in the browser, from the same `ReceiptDoc` the page shows, and handed
 * over as a file: downloaded on a computer and on Android, and through the
 * share sheet on an iPhone (where "Guardar en Archivos" and WhatsApp are one
 * tap away, and where a plain download from an installed app goes nowhere).
 *
 * jsPDF is loaded only when somebody presses the button, so the weigher's
 * phone never downloads it. Its built-in Helvetica covers Spanish (á, ñ, ¿),
 * and nothing here reaches the network.
 */
import type { ReceiptDoc } from "./receiptDoc";
import { formatDate } from "../../lib/dates";
import { formatMoney } from "../../lib/money";

const GREEN: [number, number, number] = [46, 125, 50];
const DARK_GREEN: [number, number, number] = [27, 94, 32];
const GREY: [number, number, number] = [90, 107, 92];
const RED: [number, number, number] = [140, 29, 24];
const AMBER: [number, number, number] = [107, 70, 0];

/**
 * The built-in PDF fonts speak Latin-1: á, ñ, º and · are fine, but the
 * typographic dash and minus the screen uses would print as garbage. They
 * become plain hyphens on paper — same meaning, every PDF reader.
 */
export function pdfText(s: string): string {
  return s
    .replace(/[\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .split("")
    .filter((ch) => ch.charCodeAt(0) <= 0xff)
    .join("");
}

const money = (c: number) => formatMoney(c);
const signed = (sign: string, c: number) => (sign ? `${sign} ${money(c)}` : money(c));

export async function receiptPdfBlob(doc: ReceiptDoc): Promise<Blob> {
  return new Blob([await receiptPdfBytes(doc)], { type: "application/pdf" });
}

export async function receiptPdfBytes(input: ReceiptDoc): Promise<ArrayBuffer> {
  const doc = sanitize(input);
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const W = pdf.internal.pageSize.getWidth();
  const M = 16;
  let y = 18;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(16);
  pdf.setTextColor(...DARK_GREEN);
  pdf.text(doc.farmName, M, y);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(...GREY);
  pdf.text(formatDate(doc.date), W - M, y, { align: "right" });
  y += 6;
  pdf.setFontSize(12);
  pdf.text(doc.title, M, y);
  y += 3;
  pdf.setDrawColor(...GREEN);
  pdf.setLineWidth(0.6);
  pdf.line(M, y, W - M, y);
  y += 8;

  if (doc.voided) {
    pdf.setDrawColor(...RED);
    pdf.setTextColor(...RED);
    const text = pdf.splitTextToSize(doc.voided.text, W - 2 * M - 8) as string[];
    const h = 9 + text.length * 4.6;
    pdf.roundedRect(M, y, W - 2 * M, h, 2, 2);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(12);
    pdf.text(doc.voided.title.toUpperCase(), M + 4, y + 6);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.text(text, M + 4, y + 11);
    y += h + 6;
  }

  pdf.setTextColor(20, 20, 20);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(14);
  pdf.text(`${doc.kind === "liquidacion" ? "Liquidación" : "Recibo"} N.º ${doc.number}`, M, y);
  y += 7;
  pdf.setFontSize(13);
  pdf.text(doc.workerName, M, y);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(...GREY);
  const sub = [
    doc.workerDocument ? `Documento ${doc.workerDocument}` : null,
    doc.period ? `Periodo ${doc.period}` : null,
  ].filter(Boolean).join("   ·   ");
  if (sub) {
    y += 5.5;
    pdf.text(sub, M, y);
  }
  y += 6;

  if (doc.lines.length) {
    autoTable(pdf, {
      startY: y,
      margin: { left: M, right: M },
      head: [["Semana", "Labor", "Lote", "Cantidad", "Precio", "Valor"]],
      body: doc.lines.map((l) => [
        l.weekLabel,
        l.provisional ? `${l.activityName} (provisional)` : l.activityName,
        l.plotLabel,
        l.quantityLabel,
        money(l.rateCents),
        money(l.amountCents),
      ]),
      foot: [["", "", "", "", "Total labores", money(doc.linesTotalCents)]],
      styles: { font: "helvetica", fontSize: 10, cellPadding: 2.2, textColor: [20, 20, 20] },
      headStyles: { fillColor: GREEN, textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [255, 255, 255], textColor: DARK_GREEN, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [246, 249, 246] },
      columnStyles: {
        3: { halign: "right" },
        4: { halign: "right" },
        5: { halign: "right", fontStyle: "bold" },
      },
      didParseCell: (data) => {
        if (data.section !== "head" && data.column.index >= 3) data.cell.styles.halign = "right";
        if (data.section === "head" && data.column.index >= 3) data.cell.styles.halign = "right";
      },
    });
    y = (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  }

  autoTable(pdf, {
    startY: y,
    margin: { left: M, right: M },
    head: [["Concepto", "Valor"]],
    body: doc.summary.map((r) => [r.label, signed(r.sign, r.cents)]),
    styles: { font: "helvetica", fontSize: 11, cellPadding: 2.4, textColor: [20, 20, 20] },
    headStyles: { fillColor: GREEN, textColor: 255, fontStyle: "bold" },
    columnStyles: { 1: { halign: "right", fontStyle: "bold" } },
    didParseCell: (data) => {
      if (data.section === "head" && data.column.index === 1) data.cell.styles.halign = "right";
      const row = doc.summary[data.row.index];
      if (data.section === "body" && row?.strong) {
        data.cell.styles.fontStyle = "bold";
        data.cell.styles.textColor = DARK_GREEN;
        data.cell.styles.lineWidth = { top: 0.5, bottom: 0, left: 0, right: 0 };
        data.cell.styles.lineColor = GREEN;
      }
    },
  });
  y = (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;

  const need = (h: number) => {
    if (y + h > pdf.internal.pageSize.getHeight() - 16) {
      pdf.addPage();
      y = 18;
    }
  };

  need(18);
  pdf.setDrawColor(...GREEN);
  pdf.setLineWidth(0.7);
  pdf.roundedRect(M, y, W - 2 * M, 14, 2, 2);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(...GREY);
  pdf.text(doc.headline.label.toUpperCase(), M + 4, y + 8.8);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(18);
  pdf.setTextColor(...DARK_GREEN);
  pdf.text(money(doc.headline.cents), W - M - 4, y + 9.5, { align: "right" });
  y += 20;

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10.5);
  pdf.setTextColor(20, 20, 20);
  for (const para of [doc.balanceSentence, doc.note].filter(Boolean) as string[]) {
    const t = pdf.splitTextToSize(para, W - 2 * M) as string[];
    need(t.length * 5 + 2);
    pdf.text(t, M, y);
    y += t.length * 5 + 2;
  }
  if (doc.provisional) {
    pdf.setTextColor(...AMBER);
    const t = pdf.splitTextToSize(
      "PROVISIONAL: las líneas marcadas se pagan al precio de la semana, que todavía no está fijado.",
      W - 2 * M,
    ) as string[];
    need(t.length * 5 + 2);
    pdf.text(t, M, y);
    y += t.length * 5 + 2;
  }

  need(34);
  y += 22;
  pdf.setDrawColor(182, 195, 184);
  pdf.setLineWidth(0.3);
  const half = (W - 2 * M - 12) / 2;
  pdf.line(M, y, M + half, y);
  pdf.line(M + half + 12, y, W - M, y);
  pdf.setFontSize(9.5);
  pdf.setTextColor(...GREY);
  pdf.text("Firma del empleado", M, y + 4.5);
  pdf.text("Firma por la finca", M + half + 12, y + 4.5);

  const pages = pdf.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i);
    pdf.setFontSize(8.5);
    pdf.setTextColor(122, 138, 124);
    const H = pdf.internal.pageSize.getHeight();
    pdf.text(`${doc.title} N.º ${doc.number} · ${doc.workerName}`, M, H - 10);
    pdf.text(`Página ${i} de ${pages}`, W - M, H - 10, { align: "right" });
  }

  return pdf.output("arraybuffer");
}

function sanitize(d: ReceiptDoc): ReceiptDoc {
  const t = pdfText;
  return {
    ...d,
    title: t(d.title),
    farmName: t(d.farmName),
    workerName: t(d.workerName),
    workerDocument: d.workerDocument ? t(d.workerDocument) : null,
    period: d.period ? t(d.period) : null,
    voided: d.voided ? { title: t(d.voided.title), text: t(d.voided.text) } : null,
    lines: d.lines.map((l) => ({
      ...l,
      weekLabel: t(l.weekLabel),
      activityName: t(l.activityName),
      plotLabel: t(l.plotLabel),
      quantityLabel: t(l.quantityLabel),
    })),
    summary: d.summary.map((r) => ({ ...r, label: t(r.label), sign: r.sign === "−" ? "-" : r.sign })),
    headline: { ...d.headline, label: t(d.headline.label) },
    balanceSentence: d.balanceSentence ? t(d.balanceSentence) : null,
    note: d.note ? t(d.note) : null,
  };
}

export type PdfOutcome = "downloaded" | "shared" | "cancelled" | "failed";

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

/**
 * Hand the file over. A download everywhere it works; the share sheet on iOS,
 * where it is the only thing that reliably reaches "Guardar en Archivos".
 */
export async function downloadReceiptPdf(doc: ReceiptDoc): Promise<PdfOutcome> {
  let blob: Blob;
  try {
    blob = await receiptPdfBlob(doc);
  } catch {
    return "failed";
  }
  const nav = navigator as Navigator & {
    canShare?: (d: { files: File[] }) => boolean;
    share?: (d: { files: File[]; title?: string }) => Promise<void>;
  };
  if (isIOS() && typeof File !== "undefined") {
    const file = new File([blob], doc.fileName, { type: "application/pdf" });
    if (nav.canShare?.({ files: [file] }) && nav.share) {
      try {
        await nav.share({ files: [file], title: doc.title });
        return "shared";
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      }
    }
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "downloaded";
  } catch {
    return "failed";
  }
}
