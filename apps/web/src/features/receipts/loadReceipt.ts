/**
 * Everything a historical receipt needs, in as few round trips as it takes.
 *
 * A payment's week is the frozen lines of the settlements the server lists
 * for it (`settlementIds`), fetched in parallel. They are the settlement's
 * own rows — quantity, price and value as they were written — so a price
 * changed since then does not reach the receipt.
 */
import { api } from "../../api/endpoints";
import type { Uuid } from "../../api/types";
import { todayInFarm } from "../../lib/dates";
import { movementReceiptDoc, settlementReceiptDoc, type ReceiptDoc } from "./receiptDoc";

export type HistoryKind = "pago" | "anticipo" | "descuento" | "liquidacion";

export const HISTORY_KINDS: HistoryKind[] = ["pago", "anticipo", "descuento", "liquidacion"];

export async function loadReceiptDoc(args: {
  workerId: Uuid;
  kind: HistoryKind;
  entryId: Uuid;
  farmName: string;
  timezone: string;
}): Promise<ReceiptDoc> {
  const worker = await api.getWorker(args.workerId).catch(() => null);
  const who = worker ?? { name: "—", lastName: "", documentNumber: "" };

  if (args.kind === "liquidacion") {
    const settlement = await api.getSettlement(args.entryId);
    return settlementReceiptDoc({
      farmName: args.farmName,
      settlement,
      worker,
      date: settlement.createdAt
        ? todayInFarm(args.timezone, new Date(settlement.createdAt))
        : undefined,
    });
  }

  const slip = await api.getPayment(args.entryId);
  const settlements = slip.kind === "pago"
    ? await Promise.all(slip.settlementIds.map((id) => api.getSettlement(id)))
    : [];
  return movementReceiptDoc({
    farmName: args.farmName,
    worker: who,
    slip,
    lines: settlements.flatMap((s) => s.lines),
  });
}
