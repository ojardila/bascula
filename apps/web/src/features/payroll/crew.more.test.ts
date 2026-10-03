// SPDX-License-Identifier: MIT
/**
 * The crew payroll's reads and writes against a stubbed api: what happens
 * when one person (or the balances) cannot be read, and how the run, the
 * check and the undo report the server's refusals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import type { MintId } from "../../lib/writeOnce";
import type {
  Balance,
  PayableLine,
  Payables,
  Uuid,
  Worker,
} from "../../api/types";
import {
  balanceCentsOf,
  checkPayRun,
  checkSettleRun,
  driftOf,
  loadCrew,
  payApprovalOf,
  payrollRowsOf,
  reasonOf,
  runPayments,
  settleApprovalOf,
  undoRun,
  type CrewMember,
  type PayrollRun,
  type SettleApproval,
} from "./crew";

const W1 = "0192f3a0-0006-7000-8000-0000000000a1" as Uuid;
const W2 = "0192f3a0-0006-7000-8000-0000000000a2" as Uuid;

const worker = (id: Uuid, name: string, documentNumber = ""): Worker =>
  ({
    id,
    name,
    lastName: "",
    documentType: "CC",
    documentNumber,
  }) as unknown as Worker;

const apiError = (status: number, code: string) =>
  new ApiError(status, { error: { code, message: code } });

const lineOf = (
  id: string,
  amountCents: number,
  unitLabel: string | null = null,
): PayableLine =>
  ({
    id: id as Uuid,
    amountCents,
    quantity: 1,
    unitLabel,
    rateCents: amountCents,
    rateSource: "activity_dated",
    weekStart: "2026-08-24",
  }) as unknown as PayableLine;

const payables = (lines: PayableLine[], balanceCents = 0): Payables =>
  ({
    workRecords: lines,
    debts: [],
    grossCents: lines.reduce((a, l) => a + l.amountCents, 0),
    balanceCents,
    totalCents: 0,
  }) as unknown as Payables;

const balance = (workerId: Uuid, balanceCents: number): Balance =>
  ({ workerId, balanceCents }) as unknown as Balance;

const member = (over: Partial<CrewMember>): CrewMember => ({
  worker: worker(W1, "Ana"),
  name: "Ana",
  payables: null,
  balance: null,
  failure: null,
  ...over,
});

const mint = ((k: string) => `id-${k}`) as unknown as MintId;

afterEach(() => vi.restoreAllMocks());

describe("loading the crew", () => {
  it("keeps the rest payable when one person or the balances cannot be read", async () => {
    vi.spyOn(api, "listWorkers").mockResolvedValue([
      worker(W2, "Zoila"),
      worker(W1, "Ana"),
    ]);
    vi.spyOn(api, "listBalances").mockRejectedValue(apiError(500, "INTERNAL"));
    vi.spyOn(api, "workerPayables").mockImplementation(async (id: Uuid) => {
      if (id === W2) throw apiError(500, "INTERNAL");
      return payables([lineOf("l1", 1000)]);
    });
    const crew = await loadCrew();
    expect(crew.map((m) => m.name)).toEqual(["Ana", "Zoila"]);
    expect(crew[0].failure).toBeNull();
    expect(crew[0].balance).toBeNull();
    expect(crew[1].payables).toBeNull();
    expect(crew[1].failure).toEqual(expect.any(String));
  });

  it("joins each person's balance when the balances do load", async () => {
    vi.spyOn(api, "listWorkers").mockResolvedValue([worker(W1, "Ana")]);
    vi.spyOn(api, "listBalances").mockResolvedValue([balance(W1, 5000)]);
    vi.spyOn(api, "workerPayables").mockResolvedValue(payables([]));
    const [ana] = await loadCrew();
    expect(balanceCentsOf(ana)).toBe(5000);
  });
});

describe("the balance and the approvals of one row", () => {
  it("takes the balance from the ledger, then from the payables, else nothing", () => {
    expect(balanceCentsOf(member({ balance: balance(W1, 700) }))).toBe(700);
    expect(balanceCentsOf(member({ payables: payables([], 300) }))).toBe(300);
    expect(balanceCentsOf(member({}))).toBeNull();
  });

  it("has nothing to settle without payables, and no kilos without weighed lines", () => {
    expect(settleApprovalOf(member({}))).toBeNull();
    const a = settleApprovalOf(
      member({ payables: payables([lineOf("l1", 1000)]) }),
    )!;
    expect(a.quantity).toBeNull();
    expect(a.unitLabel).toBeNull();
    expect(a.documentNumber).toBeNull();
  });

  it("pays only a positive balance, without a blank document", () => {
    expect(payApprovalOf(member({ balance: balance(W1, 0) }))).toBeNull();
    expect(payApprovalOf(member({ balance: balance(W1, 900) }))).toMatchObject({
      amountCents: 900,
      documentNumber: null,
    });
  });
});

describe("the checks right before writing", () => {
  const approval = (lines: PayableLine[]): SettleApproval => ({
    workerId: W1,
    name: "Ana",
    documentNumber: null,
    grossCents: lines.reduce((a, l) => a + l.amountCents, 0),
    quantity: null,
    unitLabel: null,
    payableIds: lines.map((l) => l.id),
    lines,
  });

  it("names whoever could not be read again, and whatever arrived meanwhile", async () => {
    const a1 = approval([lineOf("l1", 1000)]);
    const a2 = {
      ...approval([lineOf("l2", 2000)]),
      workerId: W2,
      name: "Zoila",
    };
    vi.spyOn(api, "workerPayables").mockImplementation(async (id: Uuid) => {
      if (id === W2) throw apiError(500, "INTERNAL");
      return payables([lineOf("l1", 1000), lineOf("l9", 500)]);
    });
    const check = await checkSettleRun([a1, a2]);
    expect(check.unreadable.map((u) => u.name)).toEqual(["Zoila"]);
    expect(check.arrivals[0].lines.map((l) => l.id)).toEqual(["l9"]);
    // A late weigh-in is an arrival, not a change in the approved figure.
    expect(check.drifts).toHaveLength(0);
  });

  it("rebuilds the figure from the survivors when a line went away", () => {
    const a = approval([lineOf("l1", 1000), lineOf("l2", 2000)]);
    const drift = driftOf(a, payables([lineOf("l1", 1000)]))!;
    expect(drift.afterCents).toBe(1000);
  });

  it("cannot pay against balances it could not read again", async () => {
    vi.spyOn(api, "listBalances").mockRejectedValue(apiError(500, "INTERNAL"));
    const check = await checkPayRun([
      { workerId: W1, name: "Ana", documentNumber: null, amountCents: 100 },
    ]);
    expect(check.unreadable[0].reason).toBe(
      "No se pudo volver a leer su saldo.",
    );
  });

  it("flags someone missing from the fresh balances and someone whose balance moved", async () => {
    vi.spyOn(api, "listBalances").mockResolvedValue([balance(W2, 150)]);
    const check = await checkPayRun([
      { workerId: W1, name: "Ana", documentNumber: null, amountCents: 100 },
      { workerId: W2, name: "Zoila", documentNumber: null, amountCents: 100 },
    ]);
    expect(check.unreadable.map((u) => u.name)).toEqual(["Ana"]);
    expect(check.drifts[0]).toMatchObject({ name: "Zoila", deltaCents: 50 });
  });
});

describe("the run and its undo", () => {
  it("explains a settlement that found nothing to settle", () => {
    expect(reasonOf(apiError(409, "NOTHING_TO_SETTLE"))).toBe(
      "Ya no quedaba nada pendiente que liquidar.",
    );
  });

  it("stops paying at the first refusal and never tries the rest", async () => {
    const pay = vi
      .spyOn(api, "createPayment")
      .mockRejectedValueOnce(apiError(409, "AMOUNT_EXCEEDS_BALANCE"));
    const rows = await runPayments(
      [
        { workerId: W1, name: "Ana", documentNumber: null, amountCents: 100 },
        { workerId: W2, name: "Zoila", documentNumber: null, amountCents: 200 },
      ],
      "cash" as never,
      mint,
      "",
    );
    expect(pay).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({
      status: "refused",
      reason: "El saldo bajó y el pago aprobado ya no cabe.",
    });
    expect(rows[1].status).not.toBe("done");
  });

  it("counts what was already undone apart from real failures", async () => {
    vi.spyOn(api, "reverseLedgerEntry")
      .mockRejectedValueOnce(apiError(409, "ALREADY_REVERSED"))
      .mockRejectedValueOnce(apiError(500, "INTERNAL"));
    vi.spyOn(api, "voidSettlement")
      .mockRejectedValueOnce(apiError(409, "SETTLEMENT_ALREADY_VOID"))
      .mockRejectedValueOnce(apiError(500, "INTERNAL"));
    const out = await undoRun(
      { payments: ["p1", "p2"] as Uuid[], settlements: ["s1", "s2"] as Uuid[] },
      "error",
      mint,
    );
    expect(out.alreadyUndone).toBe(2);
    expect(out.failures).toHaveLength(2);
    expect(out.paymentsReversed).toBe(0);
    expect(out.settlementsVoided).toBe(0);
  });

  it("prints zero for a done row that carries neither gross nor payment", () => {
    const run = {
      step: "settle",
      rows: [
        {
          workerId: W1,
          name: "Ana",
          documentNumber: null,
          quantity: null,
          grossCents: null,
          paidCents: null,
          balanceAfterCents: null,
          status: "done",
          settlementId: null,
          paymentId: null,
          reason: null,
        },
      ],
      scope: { filters: [], crewSize: 1, crewTotalCents: 0 },
      method: null,
      at: "2026-09-10T12:00:00Z",
      complete: true,
      unitLabel: null,
    } as PayrollRun;
    expect(payrollRowsOf(run)[0].grossCents).toBe(0);
  });
});
