/**
 * CREW PAYROLL, without the screen.
 *
 * On Saturday the farm does not pay one person: it pays thirty, in a line,
 * with the cash counted out on the table. The phone knew how to do it
 * (`PaymentsPanel` and `Payments.runPayroll`); the console only knew how to
 * pay them one at a time (`PayWorkerPage`). `docs/simplificacion.md` §2.1 says
 * it without hedging: crew payroll "moves to the web — and on the web it does
 * not exist yet", and until it exists it cannot be taken away from the phone.
 * This is the testable half of that move; `CrewPayrollPage.tsx` is the other.
 *
 * It is kept apart from the screen for a concrete reason and not out of taste:
 * what lives here is money split among N people, and I want to be able to test
 * it without rendering anything. The four decisions that cost money are all in
 * this file.
 *
 * ── 1. TWO STEPS, NOT ONE ────────────────────────────────────────────────
 *
 * The phone settles and pays in a single act because the weigher is out in the
 * plot with the cash in his hand and there is no second moment. Whoever uses
 * the console is sitting at a computer, and there the two acts are different:
 *
 *   SETTLE   freezes the week's work at the week's price. This is the step
 *            with a race in it —the price and the weigh-ins move— and the one
 *            that needs `expectedGrossCents`.
 *   PAY      hands over the cash against a balance already written in the
 *            ledger. There is no gross here that can move: only another
 *            movement can move it (an advance, a deduction, another payment).
 *
 * Splitting them buys three things a single act does not give you:
 *
 *   a. **The payroll sheet prints off final figures.** After settling there is
 *      not one `weekly_price` line left unfixed, so the paper people sign
 *      carries no provisional figure. In a single act the paper comes out of
 *      the same button as the write and nobody reads it first.
 *   b. **Not everyone who got paid worked, nor does everyone who worked show
 *      up.** People are missing on Saturday. Settling thirty and paying the
 *      twenty-six who came is the real operation; in a single act you would
 *      have to record a payment for four people who received nothing.
 *   c. **The expensive step can be reversed on its own.** Voiding a settlement
 *      releases the work items; reversing a payment gives the balance back.
 *      Glued together, undoing always undoes both.
 *
 * And the cost of splitting them —the half-done state, "settled and unpaid"—
 * is paid for by a property that is needed anyway: **this module does not
 * store that state, it reads it**. A worker who is settled and unpaid is
 * exactly one with a credit balance and no outstanding work items, and that is
 * derived from the server on every load. There is no invisible half payroll;
 * there is a list that step 2 shows again by itself, even if the browser is
 * closed.
 *
 * ── 2. THE RACE GUARD, FOR A GROUP ───────────────────────────────────────
 *
 * For one person it already exists: `expectedGrossCents` + `payableIds`, and
 * the server answers 409 GROSS_CHANGED without writing anything
 * (`api/grossChange.ts`). For thirty, somebody has to decide what "pay nobody"
 * means.
 *
 * **Approval is all or nothing; the writing cannot be.** There is no HTTP
 * transaction that spans thirty settlements, and pretending there is would be
 * worse than not having one. So:
 *
 *   BEFORE writing   `checkSettleRun` re-reads what is outstanding for ALL the
 *                    approved people and compares. If ONE person's gross
 *                    moved, nothing is written for anybody and the screen says
 *                    whose and what moved. This is the all-or-nothing part,
 *                    and it is the part that matters, because it is where 99%
 *                    of the races are: minutes of somebody looking at a screen.
 *   DURING writing   `runSettlements` goes person by person and **stops at the
 *                    first refusal**. The server still has the last word
 *                    —every call carries its own `expectedGrossCents`— and if
 *                    it says no, the world moved within the milliseconds of
 *                    the run: going on signing figures would be signing blind.
 *   AFTER            an exact report is left: who got in, who did not and why,
 *                    and an undo for what did.
 *
 * What it does NOT block, and this has to be said because it is the
 * temptation: a new weigh-in landing on somebody. The settlement names the
 * `payableIds` that were approved, so a weigh-in that arrived afterwards
 * simply is not inside it and stays outstanding for next time. Blocking on
 * that would mean shouting "it changed" every time the weigher records
 * something on a Saturday afternoon, which is exactly when he records most.
 * It is announced (`arrivals`), not blocked.
 *
 * ── 3. NO ZERO THAT MEANS "I DON'T KNOW" ─────────────────────────────────
 *
 * `CrewMember.payables` and `CrewMember.balance` are `null` when they could
 * not be read, and that null travels all the way to the render. An employee
 * whose outstanding work could not be read cannot be ticked: you do not
 * approve what you have not seen.
 *
 * ── 4. THE UNDO ──────────────────────────────────────────────────────────
 *
 * `undoRun`, in the phone's order and for the phone's reason: the payments are
 * reversed first and the settlements voided after, because voiding writes its
 * own reversal of the accrual, and the other way round would leave a payment
 * standing against an accrual that no longer exists.
 */
import { api, grossChangeOf } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import {
  explainGrossChange,
  type GrossChange,
  type ServerGrossDetails,
} from "../../api/grossChange";
import type {
  Balance,
  DayISO,
  PayableLine,
  Payables,
  PayMethod,
  Uuid,
  Worker,
} from "../../api/types";
import type { MintId } from "../../lib/writeOnce";
import type { PayrollRow, PayrollScope } from "../documents/documents";

/* ------------------------------------------------------------------ */
/* The crew                                                            */
/* ------------------------------------------------------------------ */

/**
 * One employee, with what the farm knows about them today.
 *
 * `payables` and `balance` are null when the read failed, NEVER zero. A zero
 * here would say "owes nothing", which is an assertion, and what actually
 * happened is that we could not ask.
 */
export interface CrewMember {
  worker: Worker;
  /** "First Last", already composed: the table and the paper want it the same. */
  name: string;
  payables: Payables | null;
  balance: Balance | null;
  /** Why it could not be read, when it could not. */
  failure: string | null;
}

const fullName = (w: Worker) => `${w.name} ${w.lastName}`.trim();

/**
 * The whole crew, in one read.
 *
 * One `GET /v1/balances` for everybody and one `GET /v1/workers/{id}/payables`
 * per head. The fan-out is deliberate and no route avoids it: what is
 * outstanding is per worker and has to come from the same query the settlement
 * will run against, or the screen and the write would disagree — which is
 * exactly the failure `expectedGrossCents` exists to catch, and there is no
 * sense in causing it here to save requests.
 *
 * One worker failing does NOT take the screen down: that row becomes
 * unreadable and the rest stay payable. A failure of `/v1/balances` leaves
 * every balance null, and then step 2 cannot be approved — which is right: you
 * do not hand over cash against a balance you could not read.
 */
export async function loadCrew(): Promise<CrewMember[]> {
  const [workers, balances] = await Promise.all([
    api.listWorkers(),
    api.listBalances().catch(() => null),
  ]);
  const byWorker = balances && new Map(balances.map((b) => [b.workerId, b]));

  const rows = await Promise.all(
    workers.map(async (worker): Promise<CrewMember> => {
      const balance = byWorker?.get(worker.id) ?? null;
      try {
        return {
          worker,
          name: fullName(worker),
          payables: await api.workerPayables(worker.id),
          balance,
          failure: null,
        };
      } catch (e) {
        return {
          worker,
          name: fullName(worker),
          payables: null,
          balance,
          failure: messageFor(e),
        };
      }
    }),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name, "es"));
}

/**
 * The ledger balance, from either of the two routes that derive it.
 *
 * `/v1/balances` and `/v1/workers/{id}/payables` compute the same `SUM` over
 * the same ledger; taking the second when the first never arrived is not
 * mixing two numbers, it is the same number through another door. Null when
 * neither is there, and then the row cannot be approved.
 */
export function balanceCentsOf(m: CrewMember): number | null {
  if (m.balance) return m.balance.balanceCents;
  if (m.payables) return m.payables.balanceCents;
  return null;
}

/* ------------------------------------------------------------------ */
/* Step 1 — settle                                                     */
/* ------------------------------------------------------------------ */

/** What one person contributes to the run, exactly as it was read on screen. */
export interface SettleApproval {
  workerId: Uuid;
  name: string;
  documentNumber: string | null;
  /**
   * THE SERVER'S FIGURE (`payables.grossCents`), not a sum of our own over the
   * table. Adding it up here would be a second implementation of the pricing,
   * and the day a rounding rule changes the two would disagree — and the one
   * that gets written is the server's.
   */
  grossCents: number;
  /** Kilos (or arrobas, or crates). Null when nothing was paid by weight. */
  quantity: number | null;
  /** The unit those kilos are in, for the heading on the paper. */
  unitLabel: string | null;
  payableIds: Uuid[];
  /** The lines behind that figure: without them we cannot say WHAT changed. */
  lines: PayableLine[];
}

/** Null when this person has nothing outstanding to settle. */
export function settleApprovalOf(m: CrewMember): SettleApproval | null {
  const lines = m.payables?.workRecords ?? [];
  if (!m.payables || lines.length === 0) return null;
  const weighed = lines.filter((l) => l.unitLabel !== null);
  return {
    workerId: m.worker.id,
    name: m.name,
    documentNumber: m.worker.documentNumber || null,
    grossCents: m.payables.grossCents,
    quantity: weighed.length ? weighed.reduce((a, l) => a + l.quantity, 0) : null,
    unitLabel: weighed[0]?.unitLabel ?? null,
    payableIds: lines.map((l) => l.id),
    lines,
  };
}

/** True when some line is still at the week's price: provisional, not firm. */
export const hasProvisional = (a: SettleApproval): boolean =>
  a.lines.some((l) => l.rateSource === "weekly_price");

/** The same thing that happens to one person, with a name on top. */
export interface CrewDrift extends GrossChange {
  workerId: Uuid;
  name: string;
}

/** Work that landed after the screen loaded. Does not block; is announced. */
export interface Arrival {
  workerId: Uuid;
  name: string;
  lines: PayableLine[];
}

/** Somebody whose figure could not be confirmed. Blocks. */
export interface Unreadable {
  workerId: Uuid;
  name: string;
  reason: string;
}

export interface CrewCheck {
  /** If it carries even one, nothing is written for anybody. */
  drifts: CrewDrift[];
  /** Nothing is written for these either: you do not approve what you could not read. */
  unreadable: Unreadable[];
  /** Informational. */
  arrivals: Arrival[];
}

export const checkPassed = (c: CrewCheck): boolean =>
  c.drifts.length === 0 && c.unreadable.length === 0;

/**
 * Look again at one person's figures and say whether they moved.
 *
 * What gets compared is THE FIGURE THAT IS ABOUT TO BE SIGNED: the sum of the
 * approved `payableIds`, priced as they stand now. A new weigh-in is not in
 * that sum —the settlement names its own set— and so it is not a difference.
 * An approved weigh-in that vanished is, and a week's price that moved is too.
 *
 * The explanation is built by `explainGrossChange`, the same code that turns
 * the server's 409 into words on the single-person screen. Here it is fed a
 * `ServerGrossDetails` assembled locally, so that the sentence the user reads
 * is literally the same in both places rather than two similar-looking
 * wordings.
 */
export function driftOf(a: SettleApproval, fresh: Payables): CrewDrift | null {
  const freshById = new Map(fresh.workRecords.map((l) => [l.id, l] as const));
  const approved = new Set(a.payableIds);
  const survivors = a.payableIds.filter((id) => freshById.has(id));
  const sameSet =
    survivors.length === a.payableIds.length &&
    fresh.workRecords.length === a.payableIds.length;

  // If the set is identical, the figure that counts is the server's, not a sum
  // of our own. Only once it is not do we have to rebuild it line by line.
  const actualCents = sameSet
    ? fresh.grossCents
    : survivors.reduce((s, id) => s + (freshById.get(id)?.amountCents ?? 0), 0);

  if (actualCents === a.grossCents && survivors.length === a.payableIds.length) return null;

  /**
   * Each week's price, NOW, read off the fresh lines. The server sends this in
   * its 409; here it is derived from what is outstanding, which is the same
   * source. `explainGrossChange` only reports a week when that price differs
   * from the one the approved lines carried — it is a comparison, not a read,
   * and that is why a late weigh-in is never announced as a price change.
   */
  const priceNow = new Map<DayISO, number>();
  for (const l of fresh.workRecords) {
    if (l.rateSource === "weekly_price") priceNow.set(l.weekStart, l.rateCents);
  }

  const details: ServerGrossDetails = {
    expectedCents: a.grossCents,
    actualCents,
    addedPayableIds: fresh.workRecords.filter((l) => !approved.has(l.id)).map((l) => l.id),
    removedPayableIds: a.payableIds.filter((id) => !freshById.has(id)),
    // Here we ALWAYS know what was approved: this very screen approved it.
    payableIdsProvided: true,
    weeksInSettlement: [...priceNow].map(([weekStart, priceCents]) => ({
      weekStart,
      priceCents,
    })),
  };

  return {
    workerId: a.workerId,
    name: a.name,
    ...explainGrossChange(details, a.lines, fresh.workRecords),
  };
}

/**
 * The group check, right before writing. Writes nothing.
 *
 * One read per person, in parallel. That is what it costs to be able to say
 * "nobody was paid" and have it be true.
 */
export async function checkSettleRun(approvals: SettleApproval[]): Promise<CrewCheck> {
  const out: CrewCheck = { drifts: [], unreadable: [], arrivals: [] };

  const fresh = await Promise.all(
    approvals.map(async (a) => {
      try {
        return { a, payables: await api.workerPayables(a.workerId), reason: null };
      } catch (e) {
        return { a, payables: null, reason: messageFor(e) };
      }
    }),
  );

  for (const { a, payables, reason } of fresh) {
    if (!payables) {
      out.unreadable.push({ workerId: a.workerId, name: a.name, reason: reason ?? "" });
      continue;
    }
    const drift = driftOf(a, payables);
    if (drift) out.drifts.push(drift);

    const approved = new Set(a.payableIds);
    const arrived = payables.workRecords.filter((l) => !approved.has(l.id));
    if (arrived.length > 0) {
      out.arrivals.push({ workerId: a.workerId, name: a.name, lines: arrived });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Step 2 — pay                                                        */
/* ------------------------------------------------------------------ */

/**
 * What gets handed to one person: the balance the ledger says they are owed,
 * read on screen and checked again before writing.
 */
export interface PayApproval {
  workerId: Uuid;
  name: string;
  documentNumber: string | null;
  amountCents: number;
}

/** Null when there is no credit balance, or when it could not be read. */
export function payApprovalOf(m: CrewMember): PayApproval | null {
  const cents = balanceCentsOf(m);
  if (cents === null || cents <= 0) return null;
  return {
    workerId: m.worker.id,
    name: m.name,
    documentNumber: m.worker.documentNumber || null,
    amountCents: cents,
  };
}

export interface PayDrift {
  workerId: Uuid;
  name: string;
  beforeCents: number;
  afterCents: number;
  deltaCents: number;
}

export interface PayCheck {
  drifts: PayDrift[];
  unreadable: Unreadable[];
}

export const payCheckPassed = (c: PayCheck): boolean =>
  c.drifts.length === 0 && c.unreadable.length === 0;

/**
 * The same guard, applied to the other number.
 *
 * After settling there is no gross left to move: what may have changed is the
 * balance, and only through another movement —an advance handed over out in
 * the plot, a deduction, a payment made from the phone. If ONE person's
 * balance is not the one that was approved, nobody gets paid: handing over an
 * approved $300.000 against a balance that has already dropped to $120.000 is
 * exactly the overpayment `AMOUNT_EXCEEDS_BALANCE` catches one at a time, said
 * earlier and for everybody.
 *
 * A balance that went UP does not pass in silence either. Underpaying loses no
 * money, but it sends the person home with the account still open and nobody
 * having told them — and whoever signs the payroll sheet signs a number that
 * is no longer theirs.
 */
export async function checkPayRun(approvals: PayApproval[]): Promise<PayCheck> {
  const out: PayCheck = { drifts: [], unreadable: [] };
  let balances: Balance[] | null = null;
  try {
    balances = await api.listBalances();
  } catch {
    balances = null;
  }
  const byWorker = balances && new Map(balances.map((b) => [b.workerId, b]));

  for (const a of approvals) {
    const now = byWorker?.get(a.workerId);
    if (!now) {
      out.unreadable.push({
        workerId: a.workerId,
        name: a.name,
        reason: "No se pudo volver a leer su saldo.",
      });
      continue;
    }
    if (now.balanceCents !== a.amountCents) {
      out.drifts.push({
        workerId: a.workerId,
        name: a.name,
        beforeCents: a.amountCents,
        afterCents: now.balanceCents,
        deltaCents: now.balanceCents - a.amountCents,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export type RunStatus = "done" | "refused" | "skipped";

/**
 * One line of the report. It serves both steps because the paper is the same
 * too: who, how many kilos, how much, and a signature.
 */
export interface RunRow {
  workerId: Uuid;
  name: string;
  documentNumber: string | null;
  quantity: number | null;
  /** Only in the settle step. */
  grossCents: number | null;
  /** Only in the pay step. */
  paidCents: number | null;
  /** What the ledger says after the payment. Null when it never got paid. */
  balanceAfterCents: number | null;
  status: RunStatus;
  settlementId: Uuid | null;
  paymentId: Uuid | null;
  /** Why they did not get in, in Spanish for the reader. Null when they did. */
  reason: string | null;
}

/** What the filter and the tickboxes left out. Goes to the screen AND the paper. */
export interface RunScope {
  /** One sentence per active filter, already in Spanish for the reader. */
  filters: string[];
  /** How many people there were before filtering and unticking. */
  crewSize: number;
  /** What that whole crew added up to. */
  crewTotalCents: number;
}

export interface PayrollRun {
  step: "settle" | "pay";
  rows: RunRow[];
  scope: RunScope;
  method: PayMethod | null;
  /** ISO. Only for ordering and for the paper. */
  at: string;
  /** False when it stopped halfway: there are `refused` or `skipped` rows. */
  complete: boolean;
  unitLabel: string | null;
}

/**
 * The run stopped halfway.
 *
 * It is thrown INSIDE `useWriteOnce.run` on purpose. `run` retires the ids
 * when the function finishes cleanly —the next payroll identical to this one
 * is a new payroll and must not be mistaken for a retry— but a half-finished
 * run needs exactly the opposite: the ids must survive, so that "Reintentar"
 * sends the same ones again and the server answers with what it already wrote
 * (`ON CONFLICT (id) DO NOTHING`) instead of writing it twice. Throwing is the
 * only way to tell `run` that this was not an ending.
 */
export class RunIncomplete extends Error {
  constructor(readonly rows: RunRow[]) {
    super("The payroll run did not complete");
    this.name = "RunIncomplete";
  }
}

const baseRow = (
  a: { workerId: Uuid; name: string; documentNumber: string | null },
  extra: Partial<RunRow>,
): RunRow => ({
  workerId: a.workerId,
  name: a.name,
  documentNumber: a.documentNumber,
  quantity: null,
  grossCents: null,
  paidCents: null,
  balanceAfterCents: null,
  status: "skipped",
  settlementId: null,
  paymentId: null,
  reason: null,
  ...extra,
});

/**
 * Why it was refused, said for somebody standing there with cash in hand.
 *
 * The three codes that matter get their own wording; everything else falls
 * through to the general message in `errors.ts`, which is already phrased for
 * a reader. What is never done is inventing a cause: `messageFor` on a network
 * failure says it was the network, and that is what should be read.
 */
export function reasonOf(e: unknown): string {
  const change = grossChangeOf(e);
  if (change) {
    return "El bruto cambió justo al escribir: no se firmó la cifra aprobada.";
  }
  if (e instanceof ApiError) {
    if (e.code === "PAYABLE_ALREADY_CLAIMED") {
      return "Otra liquidación tomó esas labores primero.";
    }
    if (e.code === "NOTHING_TO_SETTLE") {
      return "Ya no quedaba nada pendiente que liquidar.";
    }
    if (e.code === "AMOUNT_EXCEEDS_BALANCE") {
      return "El saldo bajó y el pago aprobado ya no cabe.";
    }
  }
  return messageFor(e);
}

/**
 * Settle, person by person, stopping at the first refusal.
 *
 * Sequential and not parallel, and not out of politeness to the server: in
 * parallel there is no such thing as "the first one that fails", and thirty
 * writes that already left cannot be un-sent. In series there is a stopping
 * point at every iteration, and the report can tell the truth: these got in,
 * this one was refused, these were never attempted.
 *
 * Every `id` comes from `mint`, which is stable by intent: retrying the same
 * run resends the same ids and the server answers with what it already wrote.
 */
export async function runSettlements(
  approvals: SettleApproval[],
  mint: MintId,
  note: string,
): Promise<RunRow[]> {
  const rows = approvals.map((a) =>
    baseRow(a, { quantity: a.quantity, grossCents: a.grossCents }),
  );

  for (let i = 0; i < approvals.length; i++) {
    const a = approvals[i];
    try {
      const s = await api.settle(a.workerId, a.payableIds, {
        expectedGrossCents: a.grossCents,
        expectedLines: a.lines,
        note,
        id: mint(`settlement:${a.workerId}`),
      });
      rows[i] = { ...rows[i], status: "done", settlementId: s.id, grossCents: s.grossCents };
    } catch (e) {
      rows[i] = { ...rows[i], status: "refused", reason: reasonOf(e) };
      return rows;
    }
  }
  return rows;
}

/**
 * Pay, in the same shape.
 *
 * `api.createPayment` with no `payableIds`: nothing is settled here, cash is
 * handed over against a balance step 1 already wrote. That is what makes this
 * step free of a gross race and leaves the balance as its only guard.
 */
export async function runPayments(
  approvals: PayApproval[],
  method: PayMethod,
  mint: MintId,
  note: string,
): Promise<RunRow[]> {
  const rows = approvals.map((a) => baseRow(a, { paidCents: a.amountCents }));

  for (let i = 0; i < approvals.length; i++) {
    const a = approvals[i];
    try {
      const p = await api.createPayment({
        id: mint(`payment:${a.workerId}`),
        workerId: a.workerId,
        amountCents: a.amountCents,
        method,
        note,
      });
      rows[i] = {
        ...rows[i],
        status: "done",
        paymentId: p.id,
        paidCents: p.amountCents,
        balanceAfterCents: p.balanceAfterCents,
      };
    } catch (e) {
      rows[i] = { ...rows[i], status: "refused", reason: reasonOf(e) };
      return rows;
    }
  }
  return rows;
}

export const isComplete = (rows: RunRow[]): boolean => rows.every((r) => r.status === "done");

/* ------------------------------------------------------------------ */
/* Undo                                                                */
/* ------------------------------------------------------------------ */

/** What a launched payroll left written, and therefore what can be taken back. */
export interface UndoHandle {
  payments: Uuid[];
  settlements: Uuid[];
}

export interface UndoResult {
  paymentsReversed: number;
  settlementsVoided: number;
  /** The ones already undone. Not failures: they are a retry that arrived. */
  alreadyUndone: number;
  failures: string[];
}

export const undoIsEmpty = (h: UndoHandle | null): boolean =>
  !h || (h.payments.length === 0 && h.settlements.length === 0);

/**
 * Undo the payroll: the payments first, the settlements after.
 *
 * The order is the phone's (`PaymentsPanel.undoLastRun`) and for the phone's
 * reason: voiding a settlement writes its own reversal of the accrual, so
 * doing it the other way round would leave a payment standing against an
 * accrual that no longer exists — a negative balance nobody can explain.
 *
 * It does NOT stop at the first failure, and this is the exception to the rule
 * above: nothing new is being signed here, something is being taken back.
 * Leaving half the payments standing because the seventh hit a network error
 * is worse than carrying on and saying which ones are left.
 *
 * What was already undone —409 ALREADY_REVERSED, SETTLEMENT_ALREADY_VOID— is
 * counted separately and not as a failure: it is exactly what a second attempt
 * at the same undo answers, and calling it an error would send somebody off to
 * fix something that is already fine.
 */
export async function undoRun(
  handle: UndoHandle,
  reason: string,
  mint: MintId,
): Promise<UndoResult> {
  const out: UndoResult = {
    paymentsReversed: 0,
    settlementsVoided: 0,
    alreadyUndone: 0,
    failures: [],
  };

  for (const id of handle.payments) {
    try {
      await api.reverseLedgerEntry(id, reason);
      out.paymentsReversed++;
    } catch (e) {
      if (e instanceof ApiError && e.code === "ALREADY_REVERSED") out.alreadyUndone++;
      else out.failures.push(messageFor(e));
    }
  }

  for (const id of handle.settlements) {
    try {
      await api.voidSettlement(id, mint(`void:${id}`));
      out.settlementsVoided++;
    } catch (e) {
      if (e instanceof ApiError && e.code === "SETTLEMENT_ALREADY_VOID") out.alreadyUndone++;
      else out.failures.push(messageFor(e));
    }
  }
  return out;
}

/** What a run wrote, ready to be undone. */
export function undoHandleOf(runs: PayrollRun[]): UndoHandle {
  const payments: Uuid[] = [];
  const settlements: Uuid[] = [];
  for (const run of runs) {
    for (const r of run.rows) {
      if (r.paymentId) payments.push(r.paymentId);
      if (r.settlementId) settlements.push(r.settlementId);
    }
  }
  return { payments, settlements };
}

/* ------------------------------------------------------------------ */
/* The paper                                                           */
/* ------------------------------------------------------------------ */

/**
 * Only the rows that GOT IN get a line on the payroll sheet.
 *
 * This is the sheet people sign. A line with a signature box next to it, for
 * somebody who was handed nothing, is an invitation to sign it. Whoever did
 * not get in is named above and below, in the scope, which is where you read
 * and not where you sign.
 */
export function payrollRowsOf(run: PayrollRun): PayrollRow[] {
  return run.rows
    .filter((r) => r.status === "done")
    .map((r) => ({
      name: r.name,
      documentNumber: r.documentNumber,
      quantity: r.quantity,
      grossCents: r.grossCents ?? r.paidCents ?? 0,
      // Null, not zero: in the settle step no later balance has been read yet,
      // and a "$0" there would say "square with everybody".
      balanceCents: r.balanceAfterCents,
      paidCents: r.paidCents,
      status: "open" as const,
    }));
}

/**
 * WHAT THIS PAPER HAS TO OWN UP TO.
 *
 * The settlements sheet bit us once already: with a filter on, it came out
 * with the farm's letterhead, today's date and a column of signatures, and
 * nowhere did it say it was the result of a search (`documents.ts`,
 * `PayrollScope`). Here there are two ways to narrow it down and both count:
 *
 *   the search box    the same as always;
 *   the tickboxes     unticking four people out of thirty produces just as
 *                     partial a sheet, and it is EASIER to do without
 *                     noticing than typing into a search box.
 *
 * And a third one that only this screen has: whoever did not get in because
 * the run stopped. They are named, one by one, with their reason.
 */
export function payrollScopeOf(run: PayrollRun): PayrollScope {
  const filters = [...run.scope.filters];

  const left = run.scope.crewSize - run.rows.length;
  if (left > 0) {
    filters.push(
      left === 1
        ? "se dejó fuera a 1 persona de la cuadrilla"
        : `se dejó fuera a ${left} personas de la cuadrilla`,
    );
  }

  const missed = run.rows.filter((r) => r.status !== "done");
  if (missed.length > 0) {
    filters.push(
      `no entraron ${missed.length}: ` +
        missed
          .map((r) => `${r.name} (${r.reason ?? "no se llegó a intentar"})`)
          .join("; "),
    );
  }

  return {
    filters,
    // How many lines the complete sheet for this crew would have had.
    totalRows: run.scope.crewSize,
    totalGrossCents: run.scope.crewTotalCents,
  };
}

/** True when the paper has to declare itself partial. */
export const runIsPartial = (run: PayrollRun): boolean =>
  payrollScopeOf(run).filters.length > 0;

const STEP_TITLE: Record<PayrollRun["step"], string> = {
  settle: "Planilla de liquidación de cuadrilla",
  pay: "Planilla de nómina",
};

export const payrollTitleOf = (run: PayrollRun): string =>
  runIsPartial(run) ? `${STEP_TITLE[run.step]} (parcial)` : STEP_TITLE[run.step];
