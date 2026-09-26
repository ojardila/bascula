/**
 * A RECEIPT, AS DATA, BEFORE IT IS A SCREEN OR A PDF.
 *
 * The worker's history opens a payment, a settlement, an advance or a
 * discount and shows it on the page; "Descargar PDF" writes the same thing to
 * a file. If the page and the file were built separately they would disagree
 * the first time one of them was edited, and a receipt that says one thing on
 * screen and another on paper is worse than none. So both render THIS.
 *
 * Every figure here comes from the server as it stood that day: the week is
 * the settlements' frozen lines, the balances are the ledger read up to the
 * movement. Nothing is recomputed from today's prices.
 */
import type { PaymentReceipt, PayableLine, Settlement, Worker } from "../../api/types";
import { formatDate, formatPeriod } from "../../lib/dates";
import { formatMoney } from "../../lib/money";
import { shortReceiptNumber } from "../../lib/receipt";
import { coveredWeeks, groupReceiptLines, sumGroups, type ReceiptLineGroup } from "./receiptLines";

export type ReceiptKind = "pago" | "anticipo" | "deduccion" | "liquidacion";

export interface SummaryRow {
  label: string;
  cents: number;
  /** How the row moves the balance, printed before the figure. */
  sign: "" | "+" | "−" | "-";
  /** The total rows: bold, with a rule above. */
  strong?: boolean;
}

export interface ReceiptDoc {
  kind: ReceiptKind;
  title: string;
  farmName: string;
  /** `3F7A-91C2`. */
  number: string;
  date: string;
  workerName: string;
  workerDocument: string | null;
  /** "24–30 ago" when there is a period to name. */
  period: string | null;
  /** Set when the movement was later cancelled. */
  voided: { title: string; text: string } | null;
  lines: ReceiptLineGroup[];
  linesTotalCents: number;
  summary: SummaryRow[];
  /** The big figure: what was handed over, withheld or settled. */
  headline: { label: string; cents: number };
  /** Spelled out: "queda a paz y salvo", never a bare signed number. */
  balanceSentence: string | null;
  provisional: boolean;
  note: string | null;
  fileName: string;
}

export const KIND_TITLE: Record<ReceiptKind, string> = {
  pago: "Recibo de pago",
  anticipo: "Comprobante de anticipo",
  deduccion: "Comprobante de descuento",
  liquidacion: "Liquidación",
};

type WorkerLike = Pick<Worker, "name" | "lastName" | "documentNumber">;

export function balanceSentence(after: number): string {
  if (after === 0) return "Después de este movimiento queda a paz y salvo.";
  if (after > 0) return `Queda pendiente a favor del empleado: ${formatMoney(after)}.`;
  return `Queda un anticipo a favor de la finca: ${formatMoney(-after)}.`;
}

function fileNameOf(kind: ReceiptKind, workerName: string, date: string, number: string): string {
  const slug = workerName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const what = kind === "liquidacion" ? "liquidacion" : kind === "pago" ? "recibo" : kind;
  return `${what}-${slug || "empleado"}-${date}-${number}.pdf`;
}

/**
 * A payment, an advance or a discount, from `GET /v1/payments/{id}` and —
 * for a payment — the frozen lines of the settlements it lists.
 */
export function movementReceiptDoc(args: {
  farmName: string;
  worker: WorkerLike;
  slip: PaymentReceipt;
  lines: PayableLine[];
  today?: Date;
}): ReceiptDoc {
  const { slip, worker } = args;
  const kind: ReceiptKind = slip.kind;
  const workerName = `${worker.name} ${worker.lastName}`.trim();
  const number = shortReceiptNumber(slip.id);
  const lines = kind === "pago" ? groupReceiptLines(args.lines, args.today, { frozen: true }) : [];
  const linesTotalCents = sumGroups(lines);

  const summary: SummaryRow[] = [
    { label: "Saldo anterior", cents: slip.previousBalanceCents, sign: "" },
  ];
  if (kind === "pago") {
    if (slip.currentWeekCents !== 0) {
      summary.push({ label: "Labores liquidadas", cents: slip.currentWeekCents, sign: "+" });
    }
    for (const d of slip.deductions) {
      summary.push({ label: `Descuento · ${d.concept}`, cents: d.amountCents, sign: "−" });
    }
    summary.push({ label: "Pagado", cents: slip.paidCents, sign: "−" });
  } else if (kind === "anticipo") {
    summary.push({ label: "Anticipo entregado", cents: slip.paidCents, sign: "−" });
  } else {
    summary.push({
      label: slip.note ? `Descuento · ${slip.note}` : "Descuento",
      cents: slip.paidCents,
      sign: "−",
    });
  }
  summary.push({ label: "Queda", cents: slip.remainingCents, sign: "", strong: true });

  const covered = coveredWeeks(lines);
  const period = covered
    ? formatPeriod(covered.from, covered.to, args.today)
    : kind === "pago" && slip.currentWeekFrom && slip.currentWeekTo
      ? formatPeriod(slip.currentWeekFrom, slip.currentWeekTo, args.today)
      : null;

  return {
    kind,
    title: KIND_TITLE[kind],
    farmName: args.farmName,
    number,
    date: slip.date,
    workerName,
    workerDocument: worker.documentNumber || null,
    period,
    voided: slip.reversed
      ? {
          title: "Movimiento anulado",
          text:
            "Este movimiento se anuló después con una corrección. Se muestra tal " +
            "como quedó el día que se hizo, para el archivo; ya no cuenta en el saldo.",
        }
      : null,
    lines,
    linesTotalCents,
    summary,
    headline: {
      label: kind === "pago" ? "Pagado" : kind === "anticipo" ? "Anticipo" : "Descontado",
      cents: slip.paidCents,
    },
    balanceSentence: balanceSentence(slip.remainingCents),
    provisional: lines.some((l) => l.provisional),
    note: kind === "deduccion" ? null : slip.note,
    fileName: fileNameOf(kind, workerName, slip.date, number),
  };
}

/** A settlement, from `GET /v1/settlements/{id}`: its frozen lines. */
export function settlementReceiptDoc(args: {
  farmName: string;
  settlement: Settlement;
  worker?: WorkerLike | null;
  /** The business day it was written on, in the farm's zone. */
  date?: string;
  today?: Date;
}): ReceiptDoc {
  const s = args.settlement;
  const workerName = args.worker
    ? `${args.worker.name} ${args.worker.lastName}`.trim()
    : s.workerName;
  const number = shortReceiptNumber(s.id);
  const lines = groupReceiptLines(s.lines, args.today, { frozen: true });
  const covered = coveredWeeks(lines);
  const date = args.date ?? (s.createdAt ? s.createdAt.slice(0, 10) : s.periodEnd);
  return {
    kind: "liquidacion",
    title: KIND_TITLE.liquidacion,
    farmName: args.farmName,
    number,
    date,
    workerName,
    workerDocument: args.worker?.documentNumber || null,
    period: covered
      ? formatPeriod(covered.from, covered.to, args.today)
      : formatPeriod(s.periodStart, s.periodEnd, args.today),
    voided:
      s.status === "void"
        ? {
            title: "Liquidación anulada",
            text:
              `Anulada el ${formatDate((s.voidedAt ?? date).slice(0, 10))}. Las labores volvieron ` +
              "a quedar pendientes y lo ganado se canceló con una corrección. Se conserva " +
              "para el archivo; no es un comprobante de pago.",
          }
        : null,
    lines,
    linesTotalCents: sumGroups(lines),
    summary: [{ label: "Total liquidado", cents: s.grossCents, sign: "", strong: true }],
    headline: { label: "Total liquidado", cents: s.grossCents },
    balanceSentence: null,
    provisional: lines.some((l) => l.provisional),
    note: s.note ?? null,
    fileName: fileNameOf("liquidacion", workerName, date, number),
  };
}
