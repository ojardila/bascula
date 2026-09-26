/**
 * The worker's financial history, as rows a person can open.
 *
 * The ledger is the source and it is kept whole: nothing is summed or merged
 * here. What changes is how each movement is named and where it leads:
 *
 *   pago       -> its receipt: weeks, labor, lote, discounts, balances
 *   devengo    -> the settlement it came from ("Liquidación")
 *   anticipo   -> its own slip
 *   deduccion  -> its own slip ("Descuento")
 *   ajuste     -> listed, not opened: there is no document behind it
 *   reverso    -> not listed on its own; the movement it cancelled is marked
 *                 "Anulado" instead, which is how a person reads it
 */
import type { LedgerEntry } from "../../api/types";
import type { HistoryKind } from "./loadReceipt";

export interface HistoryRow {
  id: string;
  label: string;
  concept: string;
  date: string;
  amountCents: number;
  voided: boolean;
  /** Where the row opens, or null when there is no document behind it. */
  target: { kind: HistoryKind; entryId: string } | null;
}

export function historyRows(ledger: LedgerEntry[]): HistoryRow[] {
  const cancelled = new Set(ledger.filter((e) => e.reversesId).map((e) => e.reversesId as string));
  const rows: HistoryRow[] = [];
  for (const e of ledger) {
    if (e.kind === "reverso") continue;
    const voided = cancelled.has(e.id);
    let label: string;
    let target: HistoryRow["target"] = null;
    switch (e.kind) {
      case "pago":
        label = "Pago";
        target = { kind: "pago", entryId: e.id };
        break;
      case "devengo":
        label = "Liquidación";
        target = e.settlementId ? { kind: "liquidacion", entryId: e.settlementId } : null;
        break;
      case "anticipo":
        label = "Anticipo";
        target = { kind: "anticipo", entryId: e.id };
        break;
      case "deduccion":
        label = "Descuento";
        target = { kind: "descuento", entryId: e.id };
        break;
      default:
        label = "Ajuste";
    }
    rows.push({
      id: e.id,
      label,
      concept: e.concept,
      date: e.date,
      amountCents: e.amountCents,
      voided,
      target,
    });
  }
  return rows;
}
