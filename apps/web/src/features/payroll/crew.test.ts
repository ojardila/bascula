/**
 * THE ARITHMETIC OF CREW PAYROLL, with no screen.
 *
 * What is tested here is what decides whether cash goes out and how much: when
 * an approved figure stopped being valid, when it did NOT —which is the half
 * people forget— and what the paper owns up to. `CrewPayrollPage.test.tsx`
 * exercises the whole path against the mock server; this exercises the rules
 * over plain numbers, which is where the odd cases can be written down without
 * standing up a farm.
 */
import { describe, expect, it } from "vitest";
import { line, sentenceFor } from "../../api/grossChange";
import { ApiError } from "../../api/errors";
import { formatDayLong } from "../../lib/dates";
import { formatMoney } from "../../lib/money";
import {
  driftOf, isComplete, payrollRowsOf, payrollScopeOf, payrollTitleOf, reasonOf,
  runIsPartial, undoHandleOf, undoIsEmpty,
  type PayrollRun, type RunRow, type SettleApproval,
} from "./crew";
import type { PayableLine, Payables, Uuid } from "../../api/types";

const FMT = { money: formatMoney, week: formatDayLong };

/** One person's outstanding work, with the gross the server would return. */
function payables(lines: PayableLine[]): Payables {
  const grossCents = lines.reduce((a, l) => a + l.amountCents, 0);
  return { workRecords: lines, debts: [], grossCents, balanceCents: 0, totalCents: grossCents };
}

function approval(lines: PayableLine[], over: Partial<SettleApproval> = {}): SettleApproval {
  return {
    workerId: "w1" as Uuid,
    name: "María Restrepo",
    documentNumber: "1045882331",
    grossCents: lines.reduce((a, l) => a + l.amountCents, 0),
    quantity: lines.reduce((a, l) => a + l.quantity, 0),
    unitLabel: "kg",
    payableIds: lines.map((l) => l.id),
    lines,
    ...over,
  };
}

/** A weigh-in at the week's price: the only kind of line that gets re-priced. */
const weighed = (id: string, kg: number, rateCents: number): PayableLine =>
  line(id as Uuid, Math.round(kg * rateCents), {
    quantity: kg,
    rateCents,
    rateSource: "weekly_price",
    unitLabel: "kg",
  });

describe("the race guard, person by person inside the group", () => {
  it("says nothing when nothing moved", () => {
    const lines = [weighed("a", 38.5, 80_000), weighed("b", 41, 80_000)];
    expect(driftOf(approval(lines), payables(lines))).toBeNull();
  });

  /**
   * The case that really bites this farm: weigh-ins are paid at the week's
   * price, which is not fixed until you settle. The owner raises the price
   * from the phone and the SAME ids are worth something else, without a single
   * row appearing or disappearing.
   */
  it("sees a change in the week's price and names it", () => {
    const approved = [weighed("a", 38.5, 80_000), weighed("b", 41, 80_000)];
    const now = [weighed("a", 38.5, 84_000), weighed("b", 41, 84_000)];

    const drift = driftOf(approval(approved), payables(now));
    expect(drift).not.toBeNull();
    expect(drift!.beforeCents).toBe(6_360_000);
    expect(drift!.afterCents).toBe(6_678_000);
    expect(drift!.deltaCents).toBe(318_000);
    // The same sentence as the single-person screen, word for word.
    expect(sentenceFor(drift!, FMT)).toContain(
      "el precio de la semana del 24 de agosto pasó de $800 a $840",
    );
  });

  /**
   * THE HALF PEOPLE FORGET. A late weigh-in does NOT change the figure being
   * signed: the settlement names its `payableIds` and the new one simply is
   * not inside. Blocking here would mean shouting "it changed" every Saturday
   * afternoon, which is when the weigher records most — and a guard that
   * always shouts is a guard people learn to ignore.
   */
  it("does NOT block just because new work arrived", () => {
    const approved = [weighed("a", 38.5, 80_000)];
    const now = [...approved, weighed("c", 12, 80_000)];
    expect(driftOf(approval(approved), payables(now))).toBeNull();
  });

  it("does block when an approved work item stopped being outstanding", () => {
    const approved = [weighed("a", 38.5, 80_000), weighed("b", 41, 80_000)];
    const now = [approved[0]];

    const drift = driftOf(approval(approved), payables(now));
    expect(drift).not.toBeNull();
    expect(drift!.afterCents).toBe(3_080_000);
    expect(drift!.removedIds).toEqual(["b"]);
    expect(sentenceFor(drift!, FMT)).toContain("salió una pesada de la liquidación");
  });

  it("and when everything vanished, the figure now is zero and it says so", () => {
    const approved = [weighed("a", 38.5, 80_000)];
    const drift = driftOf(approval(approved), payables([]));
    expect(drift!.afterCents).toBe(0);
    expect(drift!.removedIds).toEqual(["a"]);
  });
});

describe("why somebody did not get in, said for whoever holds the cash", () => {
  it("names the moved gross, the already-claimed work item and the dropped balance", () => {
    expect(
      reasonOf(
        new ApiError(409, {
          error: {
            code: "GROSS_CHANGED",
            message: "x",
            details: { beforeCents: 1, afterCents: 2 },
          },
        }),
      ),
    ).toContain("El bruto cambió");
    expect(
      reasonOf(new ApiError(409, { error: { code: "PAYABLE_ALREADY_CLAIMED", message: "x" } })),
    ).toContain("Otra liquidación");
    expect(
      reasonOf(new ApiError(409, { error: { code: "AMOUNT_EXCEEDS_BALANCE", message: "x" } })),
    ).toContain("El saldo bajó");
  });

  /** A cause is never invented: a network failure is reported as a network failure. */
  it("does not invent a cause for something that has none", () => {
    expect(reasonOf(new Error("boom"))).not.toContain("bruto");
  });
});

/* ------------------------------------------------------------------ */
/* The paper                                                           */
/* ------------------------------------------------------------------ */

const row = (name: string, over: Partial<RunRow> = {}): RunRow => ({
  workerId: name as Uuid,
  name,
  documentNumber: null,
  quantity: 10,
  grossCents: 1_000_000,
  paidCents: null,
  balanceAfterCents: null,
  status: "done",
  settlementId: `s-${name}` as Uuid,
  paymentId: null,
  reason: null,
  ...over,
});

const run = (rows: RunRow[], over: Partial<PayrollRun> = {}): PayrollRun => ({
  step: "settle",
  rows,
  scope: { filters: [], crewSize: rows.length, crewTotalCents: 3_000_000 },
  method: null,
  at: "2026-08-29T12:00:00Z",
  complete: isComplete(rows),
  unitLabel: "kg",
  ...over,
});

describe("the payroll sheet owns up to its scope", () => {
  it("a run over the whole crew does not declare itself partial", () => {
    const r = run([row("María"), row("Jhon"), row("Luz")]);
    expect(runIsPartial(r)).toBe(false);
    expect(payrollScopeOf(r).filters).toEqual([]);
    expect(payrollTitleOf(r)).toBe("Planilla de liquidación de cuadrilla");
  });

  /** The bite `SettlementsPage` took out of us, inherited. */
  it("says there was a filter on", () => {
    const r = run([row("Rosa")], {
      scope: { filters: ["empleado contiene «Rosa»"], crewSize: 1, crewTotalCents: 1_000_000 },
    });
    expect(payrollScopeOf(r).filters).toContain("empleado contiene «Rosa»");
    expect(payrollTitleOf(r)).toContain("(parcial)");
  });

  /**
   * And the way only this screen has, the one that is EASIER to do without
   * noticing than typing into a search box: unticking four out of thirty.
   */
  it("says how many people were unticked, even with no filter at all", () => {
    const r = run([row("María")], {
      scope: { filters: [], crewSize: 30, crewTotalCents: 30_000_000 },
    });
    expect(payrollScopeOf(r).filters).toContain("se dejó fuera a 29 personas de la cuadrilla");
    expect(runIsPartial(r)).toBe(true);
  });

  it("names one by one whoever did not get in, with their reason", () => {
    const r = run([
      row("María"),
      row("Jhon", { status: "refused", reason: "El saldo bajó y el pago aprobado ya no cabe." }),
      row("Luz", { status: "skipped", settlementId: null }),
    ]);
    const phrase = payrollScopeOf(r).filters.join(" ");
    expect(phrase).toContain("no entraron 2");
    expect(phrase).toContain("Jhon (El saldo bajó");
    expect(phrase).toContain("Luz (no se llegó a intentar)");
  });

  /**
   * A line with a signature box next to it, for somebody who was handed
   * nothing, is an invitation to sign it.
   */
  it("only whoever got in gets a line", () => {
    const r = run([row("María"), row("Jhon", { status: "refused", reason: "x" })]);
    expect(payrollRowsOf(r).map((x) => x.name)).toEqual(["María"]);
  });

  /** No zero that means "I don't know": the later balance has not been read yet. */
  it("does not invent a later balance on the settlement sheet", () => {
    expect(payrollRowsOf(run([row("María")]))[0].balanceCents).toBeNull();
  });

  it("and does carry one on the payment sheet, next to what was handed over", () => {
    const r = run(
      [row("María", { paidCents: 2_000_000, balanceAfterCents: 0, paymentId: "p1" as Uuid })],
      { step: "pay" },
    );
    const [printed] = payrollRowsOf(r);
    expect(printed.paidCents).toBe(2_000_000);
    expect(printed.balanceCents).toBe(0);
    expect(payrollTitleOf(r)).toBe("Planilla de nómina");
  });
});

describe("what a run leaves behind to be undone", () => {
  it("collects the payments and the settlements from every run", () => {
    const settled = run([row("María"), row("Jhon")]);
    const paid = run(
      [
        row("María", { paymentId: "p1" as Uuid, settlementId: null }),
        row("Jhon", { paymentId: "p2" as Uuid, settlementId: null }),
      ],
      { step: "pay" },
    );
    const handle = undoHandleOf([settled, paid]);
    expect(handle.settlements).toEqual(["s-María", "s-Jhon"]);
    expect(handle.payments).toEqual(["p1", "p2"]);
    expect(undoIsEmpty(handle)).toBe(false);
  });

  it("does not offer to undo what was never written", () => {
    const r = run([row("María", { status: "refused", settlementId: null, reason: "x" })]);
    expect(undoIsEmpty(undoHandleOf([r]))).toBe(true);
    expect(isComplete(r.rows)).toBe(false);
  });
});
