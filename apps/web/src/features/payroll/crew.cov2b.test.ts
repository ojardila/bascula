// SPDX-License-Identifier: MIT
/**
 * The race guard when, in the same look, one approved weigh-in left and a new
 * one arrived: the figure being signed moved, and the arrival is named as an
 * addition rather than mistaken for the reason.
 */
import { describe, expect, it } from "vitest";
import { line } from "../../api/grossChange";
import { driftOf, type SettleApproval } from "./crew";
import type { PayableLine, Payables, Uuid } from "../../api/types";

const weighed = (id: string, kg: number, rateCents: number): PayableLine =>
  line(id as Uuid, Math.round(kg * rateCents), {
    quantity: kg,
    rateCents,
    rateSource: "weekly_price",
    unitLabel: "kg",
  });

const payables = (lines: PayableLine[]): Payables => {
  const grossCents = lines.reduce((a, l) => a + l.amountCents, 0);
  return { workRecords: lines, debts: [], grossCents, balanceCents: 0, totalCents: grossCents };
};

const approval = (lines: PayableLine[]): SettleApproval => ({
  workerId: "w1" as Uuid,
  name: "María Restrepo",
  documentNumber: null,
  grossCents: lines.reduce((a, l) => a + l.amountCents, 0),
  quantity: null,
  unitLabel: "kg",
  payableIds: lines.map((l) => l.id),
  lines,
});

describe("a weigh-in left while another arrived", () => {
  it("blocks on the one that left and lists the arrival as added", () => {
    const approved = [weighed("a", 10, 80_000), weighed("b", 20, 80_000)];
    const now = [approved[0], weighed("c", 5, 80_000)];

    const drift = driftOf(approval(approved), payables(now))!;
    expect(drift).not.toBeNull();
    expect(drift.afterCents).toBe(800_000);
    expect(drift.removedIds).toEqual(["b"]);
    expect(drift.addedIds).toEqual(["c"]);
  });
});
