import type { Lang } from "./i18n";
import { formatMoney, formatNumber, formatDay, formatWeekRange, translate } from "./i18n";
import { fromCents, type Balance, type SettlementItem } from "./db";

export interface ReceiptInput {
  workerName: string;
  farmLabel: string; // crop config label, stands in for the farm name
  unit: string;
  monday: string;
  items: Pick<SettlementItem, "week" | "weight" | "amountCents" | "localDay">[];
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
 * is the point of the document — and it is per WEIGHING, not per week: a
 * worker remembers the loads they carried on Tuesday and remembers no week at
 * all. It falls back to the week only for a document whose weighings this
 * phone does not hold.
 */
export function buildReceipt(r: ReceiptInput, lang: Lang): string {
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const L: string[] = [];

  L.push(`*${t("pay.receipt")}*`);
  L.push(`${r.workerName} — ${formatDay(r.date, lang)}`);
  L.push("");

  // Newest first, so the worker can check each load they remember carrying.
  const perDay = r.items.length > 0 && r.items.every((i) => !!i.localDay);
  const key = (i: (typeof r.items)[number]) => (perDay ? i.localDay! : i.week);
  const sorted = [...r.items].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  const grouped = new Map<string, { kg: number; cents: number; loads: number }>();
  for (const i of sorted) {
    const cur = grouped.get(key(i)) ?? { kg: 0, cents: 0, loads: 0 };
    cur.kg += i.weight;
    cur.cents += i.amountCents;
    cur.loads += 1;
    grouped.set(key(i), cur);
  }
  for (const [when, v] of grouped) {
    L.push(
      `${perDay ? formatDay(when, lang) : formatWeekRange(when, lang)}  ${formatNumber(
        v.kg,
        lang,
      )} ${r.unit}  ${formatMoney(fromCents(v.cents), lang)}`,
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
  L.push(`*${t("pay.paidOut")}: ${formatMoney(fromCents(r.paidCents), lang)}*`);

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
