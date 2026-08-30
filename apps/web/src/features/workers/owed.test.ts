/**
 * ONE SINGLE ANSWER TO "HOW MUCH DO I OWE THEM?", AND ITS HOLES.
 *
 * These tests are not about arithmetic —adding two integers needs no test—
 * but about what happens when one of the two halves is missing. That is the
 * failure this module exists to prevent: the profile showed $184.500, the
 * list showed "—" and a total of $0, the dashboard $334.500 and the pay
 * screen $338.100. Four screens, four figures, and the only correct one
 * hidden behind the decision to pay.
 *
 * What is asserted here is that no path through this module returns a number
 * that means "I don't know".
 */
import { describe, expect, it } from "vitest";
import {
  owedByWorker,
  owedOf,
  owedState,
  sumOwed,
  sumOwedToFarmWorkers,
  totalOwedCents,
  type Owed,
} from "./owed";

const owed = (balanceCents: number | null, pendingCents: number | null, est = false): Owed => ({
  balanceCents,
  pendingCents,
  pendingIsEstimate: est,
});

describe("one person's figure", () => {
  it("is the ledger plus what is left to settle — the same one the pay screen writes", () => {
    // María, on the seeded farm: balance 184.500, outstanding 153.600.
    const s = owedState(owed(184_500_00, 153_600_00));
    expect(s.kind).toBe("known");
    expect(s.kind === "known" && s.cents).toBe(338_100_00);
    expect(totalOwedCents(owed(184_500_00, 153_600_00))).toBe(338_100_00);
  });

  it("flags the figure when part of it is still paid at the week's price", () => {
    const s = owedState(owed(184_500_00, 153_600_00, true));
    expect(s.kind === "known" && s.isEstimate).toBe(true);
  });

  /** An estimate of zero pesos has nothing in it that can move. */
  it("does not flag as provisional what has nothing outstanding", () => {
    const s = owedState(owed(184_500_00, 0, true));
    expect(s.kind === "known" && s.isEstimate).toBe(false);
  });

  it("without the ledger there is no total, and no number to paint by mistake", () => {
    const s = owedState(owed(null, 153_600_00));
    expect(s.kind).toBe("unknown");
    // The point: the `unknown` case has NO numeric member. A screen cannot get
    // a zero out of here without TypeScript stopping it.
    expect(Object.prototype.hasOwnProperty.call(s, "cents")).toBe(false);
    expect(totalOwedCents(owed(null, 153_600_00))).toBeNull();
  });

  /**
   * Outstanding work can only ADD, so the balance is a legitimate floor.
   * Saying "at least $184.500" tells you more than a dash and does not lie.
   */
  it("without the outstanding work it gives a floor, not a dash and not a total", () => {
    const s = owedState(owed(184_500_00, null));
    expect(s.kind).toBe("partial");
    expect(s.kind === "partial" && s.cents).toBe(184_500_00);
    expect(totalOwedCents(owed(184_500_00, null))).toBeNull();
  });

  it("a negative balance is an advance the person is carrying, and it is kept", () => {
    const s = owedState(owed(-45_000_00, 0));
    expect(s.kind === "known" && s.cents).toBe(-45_000_00);
  });
});

describe("the farm's figure", () => {
  it("adds up only what could be established whole, and says how many are missing", () => {
    const sum = sumOwed([owed(100_00, 50_00), owed(200_00, null), owed(null, null)]);
    // With one half-read account the farm's TOTAL can no longer be asserted…
    expect(sum.cents).toBeNull();
    // …but the floor can, and with it we can write "at least".
    expect(sum.floorCents).toBe(350_00);
    expect(sum.counted).toBe(1);
    expect(sum.unreadable).toBe(2);
  });

  it("when everything was read, the total is the total", () => {
    const sum = sumOwed([owed(100_00, 50_00), owed(200_00, 0)]);
    expect(sum.cents).toBe(350_00);
    expect(sum.unreadable).toBe(0);
  });

  /**
   * The cash to be counted out on Saturday does not go down because somebody
   * is in debt. An advance stays on that person's row and is not subtracted
   * from the farm's total.
   */
  it("does not subtract advances from what the farm owes everybody else", () => {
    expect(sumOwedToFarmWorkers([owed(100_00, 0), owed(-40_00, 0)]).cents).toBe(100_00);
  });

  it("does not say zero for a farm where nothing was read", () => {
    expect(sumOwed([owed(null, null)]).cents).toBeNull();
    expect(sumOwed([owed(null, null)]).floorCents).toBeNull();
  });
});

describe("building the accounts out of the two list reads", () => {
  const W1 = "w1";
  const W2 = "w2";

  it("joins the ledger with what is left to settle, person by person", () => {
    const map = owedByWorker(
      [{ workerId: W1, balanceCents: 100_00 }],
      [
        { workerId: W1, settled: false, estimatedAmountCents: 50_00, amountIsEstimate: true },
        { workerId: W1, settled: true, estimatedAmountCents: 900_00, amountIsEstimate: false },
        { workerId: W2, settled: false, estimatedAmountCents: 70_00, amountIsEstimate: false },
      ],
    );
    // What is already settled is not counted twice: it is inside the balance.
    expect(totalOwedCents(map.get(W1)!)).toBe(150_00);
    expect(map.get(W1)!.pendingIsEstimate).toBe(true);
    // No row in /v1/balances but a read that went through means their ledger
    // really is at zero: not one entry in it.
    expect(totalOwedCents(map.get(W2)!)).toBe(70_00);
  });

  it("a read that fell over leaves its half null, never zero", () => {
    const noBalances = owedByWorker(null, [
      { workerId: W1, settled: false, estimatedAmountCents: 50_00, amountIsEstimate: false },
    ]);
    expect(noBalances.get(W1)!.balanceCents).toBeNull();
    expect(owedState(noBalances.get(W1)!).kind).toBe("unknown");

    const noRecords = owedByWorker([{ workerId: W1, balanceCents: 100_00 }], null);
    expect(noRecords.get(W1)!.pendingCents).toBeNull();
    expect(owedState(noRecords.get(W1)!).kind).toBe("partial");
  });

  it("a withheld amount makes the account unknown, not smaller", () => {
    // The server projects every figure of money out of a work record for a
    // session that may not read prices. Adding those rows as zero would show
    // an account that is CONFIDENTLY too small — the direction that costs
    // somebody their pay — so one unreadable row makes the pending half null,
    // which `owedState` reports as unknown rather than as a figure.
    const map = owedByWorker(
      [{ workerId: W1, balanceCents: 100_00 }],
      [
        { workerId: W1, settled: false, estimatedAmountCents: 50_00, amountIsEstimate: true },
        { workerId: W1, settled: false, estimatedAmountCents: null, amountIsEstimate: null },
      ],
    );
    expect(map.get(W1)!.pendingCents).toBeNull();
    expect(owedState(map.get(W1)!).kind).toBe("partial");
    expect(totalOwedCents(map.get(W1)!)).toBeNull();
  });

  it("asserts nothing about somebody who shows up in neither read", () => {
    const map = owedByWorker(null, null);
    expect(owedState(owedOf(map, "nobody", false, false)).kind).toBe("unknown");
    // And with both reads good, it does: that employee is at zero.
    expect(totalOwedCents(owedOf(map, "nobody", true, true))).toBe(0);
  });
});
