/**
 * The four figures a farm receipt has to name, and how they add up.
 *
 * Semana actual + saldo anterior − descuentos − pago = queda. Previous
 * balance is derived from that identity so a receipt cannot print a
 * leftover that disagrees with the payment that was just written.
 */
export interface ReceiptDeduction {
  concept: string;
  /** Positive: how much was withheld. */
  amountCents: number;
  date: string;
}

export interface ReceiptBreakdown {
  previousBalanceCents: number;
  currentWeekCents: number;
  currentWeekFrom: string | null;
  currentWeekTo: string | null;
  deductions: ReceiptDeduction[];
  deductionsCents: number;
  paidCents: number;
  remainingCents: number;
}

export function buildReceiptBreakdown(args: {
  paidCents: number;
  remainingCents: number;
  currentWeekCents: number;
  currentWeekFrom?: string | null;
  currentWeekTo?: string | null;
  deductions: ReceiptDeduction[];
}): ReceiptBreakdown {
  const deductionsCents = args.deductions.reduce((a, d) => a + d.amountCents, 0);
  return {
    previousBalanceCents:
      args.remainingCents - args.currentWeekCents + deductionsCents + args.paidCents,
    currentWeekCents: args.currentWeekCents,
    currentWeekFrom: args.currentWeekFrom ?? null,
    currentWeekTo: args.currentWeekTo ?? null,
    deductions: args.deductions,
    deductionsCents,
    paidCents: args.paidCents,
    remainingCents: args.remainingCents,
  };
}
