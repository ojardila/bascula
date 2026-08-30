import type { Lang } from "./i18n";
import { formatMoney, formatNumber, formatDay, formatWeekRange, translate } from "./i18n";
import { fromCents, type Balance, type SettlementItem } from "./db";

export interface ReceiptInput {
  workerName: string;
  farmLabel: string; // crop config label, stands in for the farm name
  unit: string;
  monday: string;
  items: Pick<SettlementItem, "week" | "weight" | "amountCents">[];
  /**
   * The settlement's own gross. Not the sum of `items` when the document came
   * down the feed covering a week the worker also spent on a jornal: the
   * header travels whole, the lines that are not paid by the unit of work do
   * not (§2.2), and adding up what is left declares less than the worker
   * earned. See `receiptHtml.ReceiptData.grossCents`.
   */
  grossCents?: number;
  paidCents: number;
  balance: Balance;
  date: string; // YYYY-MM-DD
}

/**
 * A plain-text receipt for the worker, meant to be shared over WhatsApp.
 * Text rather than PDF on purpose: it arrives readable in the chat itself,
 * survives any phone, and needs no viewer, storage permission or extra
 * dependency. Workers distrust a weight they cannot check, so the breakdown
 * per week is the point of the document.
 */
export function buildReceipt(r: ReceiptInput, lang: Lang): string {
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const L: string[] = [];

  L.push(`*${t("pay.receipt")}*`);
  L.push(`${r.workerName} — ${formatDay(r.date, lang)}`);
  L.push("");

  // Per-week breakdown, newest first, so the worker can check each weighing.
  const byWeek = [...r.items].sort((a, b) => (a.week < b.week ? 1 : -1));
  const grouped = new Map<string, { kg: number; cents: number }>();
  for (const i of byWeek) {
    const cur = grouped.get(i.week) ?? { kg: 0, cents: 0 };
    cur.kg += i.weight;
    cur.cents += i.amountCents;
    grouped.set(i.week, cur);
  }
  for (const [week, v] of grouped) {
    L.push(
      `${formatWeekRange(week, lang)}  ${formatNumber(v.kg, lang)} ${r.unit}  ${formatMoney(fromCents(v.cents), lang)}`,
    );
  }

  const itemisedCents = r.items.reduce((s, i) => s + i.amountCents, 0);
  const grossCents = r.grossCents ?? itemisedCents;
  const otherCents = grossCents - itemisedCents;

  // The money in this document that this phone holds no weighing for. It goes
  // on its own line, above the total, so the worker can see that the figure is
  // bigger than the weeks listed for a reason and not by mistake.
  if (otherCents !== 0) {
    L.push(`${t("pay.otherWork")}  ${formatMoney(fromCents(otherCents), lang)}`);
  }

  if (grouped.size > 1 || otherCents !== 0) {
    L.push("");
    L.push(`${t("pay.totalWeek")}: ${formatMoney(fromCents(grossCents), lang)}`);
  }

  L.push("");
  L.push(`*${t("pay.pay")}: ${formatMoney(fromCents(r.paidCents), lang)}*`);

  if (r.balance.balanceCents > 0) {
    L.push(`${t("pay.credit")}: ${formatMoney(fromCents(r.balance.balanceCents), lang)}`);
  } else if (r.balance.balanceCents < 0) {
    // An outstanding advance is the line the worker most needs documented.
    L.push(`${t("pay.owesUs")}: ${formatMoney(fromCents(-r.balance.balanceCents), lang)}`);
  }

  L.push("");
  L.push(`⚖️ ${r.farmLabel}`);
  return L.join("\n");
}
