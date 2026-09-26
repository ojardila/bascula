/**
 * ONE LINE PER WEEK, ACTIVITY AND LOTE.
 *
 * A receipt used to list every weighing on its own row, or only a total per
 * week. Neither lets a worker check it: forty rows of "Recolección 12 kg" is
 * noise, and one figure per week says nothing about which lote the money came
 * from. What they remember is "the week of the 24th I picked in La Cumbre and
 * did a day of plateo in El Mango", so that is the row.
 *
 * The grouping never computes money. Each group's value is the SUM of the
 * frozen amounts of the lines under it, so the groups add up to exactly what
 * the settlement froze and the receipt's total cannot drift from the ledger
 * by a peso of rounding. Lines with a different price are never merged: a
 * row reads "quantity × price = value", and two prices under one row would
 * make that sentence false.
 */
import type { PayableLine, PayMode } from "../../api/types";
import { formatQuantity } from "../../lib/money";
import { formatWeekRange } from "../../lib/dates";

export interface ReceiptLineGroup {
  key: string;
  /** The Monday of the week. */
  weekStart: string;
  /** "24–30 ago". */
  weekLabel: string;
  activityName: string;
  /** "La Cumbre" or "La Cumbre, El Mango", or "Sin lote". */
  plotLabel: string;
  quantity: number;
  /** "1.250,5 kg", "3 jornales", "contrato". */
  quantityLabel: string;
  rateCents: number;
  amountCents: number;
  /** Priced by the week's price, which may still move. */
  provisional: boolean;
  /** How many records went into the row. */
  count: number;
}

export const NO_PLOT = "Sin lote";

function modeOf(l: PayableLine): PayMode {
  if (l.payMode) return l.payMode;
  return l.unitLabel ? "work_unit" : "contract";
}

export function quantityLabel(quantity: number, mode: PayMode, unitLabel: string | null): string {
  if (mode === "contract") return "contrato";
  if (mode === "time_unit") {
    const q = formatQuantity(quantity);
    return `${q} ${quantity === 1 ? "jornal" : "jornales"}`;
  }
  return `${formatQuantity(quantity)} ${unitLabel ?? ""}`.trim();
}

/**
 * `frozen`: the lines come from a settlement, whose rows carry the price they
 * were settled at. A work record priced "by the week" is no longer provisional
 * once a settlement has written its price down, so nothing is flagged.
 */
export function groupReceiptLines(
  lines: PayableLine[],
  today: Date = new Date(),
  opts: { frozen?: boolean } = {},
): ReceiptLineGroup[] {
  const groups = new Map<string, ReceiptLineGroup>();
  for (const l of lines) {
    const plots = [...l.plotNames].sort((a, b) => a.localeCompare(b, "es"));
    const plotLabel = plots.length ? plots.join(", ") : NO_PLOT;
    const mode = modeOf(l);
    const provisional = !opts.frozen && l.rateSource === "weekly_price";
    const key = [l.weekStart, l.activityName, plotLabel, mode, l.unitLabel ?? "", l.rateCents, provisional].join("|");
    const g = groups.get(key);
    if (g) {
      g.quantity += l.quantity;
      g.amountCents += l.amountCents;
      g.count += 1;
      g.quantityLabel = quantityLabel(g.quantity, mode, l.unitLabel);
    } else {
      groups.set(key, {
        key,
        weekStart: l.weekStart,
        weekLabel: formatWeekRange(l.weekStart, today),
        activityName: l.activityName,
        plotLabel,
        quantity: l.quantity,
        quantityLabel: quantityLabel(l.quantity, mode, l.unitLabel),
        rateCents: l.rateCents,
        amountCents: l.amountCents,
        provisional,
        count: 1,
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.weekStart.localeCompare(b.weekStart) ||
      a.activityName.localeCompare(b.activityName, "es") ||
      a.plotLabel.localeCompare(b.plotLabel, "es"),
  );
}

export const sumGroups = (groups: ReceiptLineGroup[]): number =>
  groups.reduce((a, g) => a + g.amountCents, 0);

/**
 * The weeks the lines actually cover, Monday of the first to Sunday of the
 * last. A settlement's own `periodEnd` is the range that was ASKED for
 * ("everything up to…"), which can be a year out; the receipt names the work.
 */
export function coveredWeeks(groups: ReceiptLineGroup[]): { from: string; to: string } | null {
  if (!groups.length) return null;
  const mondays = groups.map((g) => g.weekStart).sort();
  const last = new Date(`${mondays[mondays.length - 1]}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + 6);
  return { from: mondays[0], to: last.toISOString().slice(0, 10) };
}
