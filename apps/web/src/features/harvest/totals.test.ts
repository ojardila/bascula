/**
 * The one rule the whole harvest module rests on, pinned.
 *
 * The server made `kg` and `valueCents` nullable on purpose, and the contract
 * says why: a report is where a zero is most credible and therefore most
 * dangerous. A farm read `$0` against every harvest record in the console
 * because a null amount was rendered as a figure.
 *
 * That design is only worth anything if the client honours it, and `?? 0` is
 * one keystroke away in every component that touches a figure. These tests
 * exist so that keystroke fails the build.
 */
import { describe, expect, it } from "vitest";
import {
  NO_TOTALS,
  foldTotals,
  kgForDrawing,
  kgState,
  totalsOfRecords,
  valueState,
  type Totals,
} from "./totals";

function totals(over: Partial<Totals> = {}): Totals {
  return { ...NO_TOTALS, ...over };
}

describe("a figure nothing established is never a zero", () => {
  it("reads a null kg as unknown, not as nothing picked", () => {
    const t = totals({ records: 4, kg: null, recordsNotInKg: 4 });
    expect(kgState(t)).toEqual({ kind: "unknown", missing: 4, records: 4 });
  });

  it("reads a null value as unknown, not as nothing owed", () => {
    const t = totals({ records: 2, valueCents: null, recordsWithoutValue: 2 });
    expect(valueState(t)).toEqual({ kind: "unknown", missing: 2, records: 2 });
  });

  it("keeps a REAL zero distinguishable from an absent one", () => {
    // A settled week that genuinely came to nothing is a fact, and it must not
    // be hidden behind the same dash that means "we could not work it out".
    expect(valueState(totals({ records: 1, valueCents: 0 }))).toEqual({ kind: "final", cents: 0 });
    expect(kgState(totals({ records: 1, kg: 0 }))).toEqual({ kind: "known", kg: 0 });
  });
});

describe("a partial sum is never presented as a whole one", () => {
  it("flags kilos left out because their unit does not convert", () => {
    const t = totals({ records: 5, kg: 120, recordsNotInKg: 2 });
    expect(kgState(t)).toEqual({ kind: "partial", kg: 120, missing: 2 });
  });

  it("flags value left out, and carries the estimate flag with it", () => {
    const t = totals({ records: 5, valueCents: 900, recordsWithoutValue: 1, valueIsEstimate: true });
    expect(valueState(t)).toEqual({ kind: "partial", cents: 900, missing: 1, isEstimate: true });
  });
});

describe("estimated and definitive do not look alike", () => {
  it("separates a value still riding on the week's price from a settled one", () => {
    expect(valueState(totals({ records: 1, valueCents: 100, valueIsEstimate: true })).kind).toBe(
      "estimate",
    );
    expect(valueState(totals({ records: 1, valueCents: 100, valueIsEstimate: false })).kind).toBe(
      "final",
    );
  });
});

describe("folding rows keeps the admissions", () => {
  it("stays partial when one of the rows was partial", () => {
    const folded = foldTotals([
      totals({ records: 2, kg: 50, valueCents: 400 }),
      totals({ records: 1, kg: null, recordsNotInKg: 1, valueCents: null, recordsWithoutValue: 1 }),
    ]);
    expect(folded.records).toBe(3);
    expect(kgState(folded)).toEqual({ kind: "partial", kg: 50, missing: 1 });
    expect(valueState(folded)).toEqual({ kind: "partial", cents: 400, missing: 1, isEstimate: false });
  });

  it("stays unknown when nothing at all could be established", () => {
    const folded = foldTotals([
      totals({ records: 1, recordsNotInKg: 1, recordsWithoutValue: 1 }),
      totals({ records: 1, recordsNotInKg: 1, recordsWithoutValue: 1 }),
    ]);
    expect(folded.kg).toBeNull();
    expect(folded.valueCents).toBeNull();
    expect(kgState(folded).kind).toBe("unknown");
    expect(valueState(folded).kind).toBe("unknown");
  });

  it("marks the fold as an estimate when any contributor was one", () => {
    const folded = foldTotals([
      totals({ records: 1, valueCents: 100, valueIsEstimate: false }),
      totals({ records: 1, valueCents: 100, valueIsEstimate: true }),
    ]);
    expect(valueState(folded).kind).toBe("estimate");
  });

  it("folds nothing into unknown rather than into zero", () => {
    expect(valueState(foldTotals([])).kind).toBe("unknown");
  });
});

describe("folding records the session may not price", () => {
  const priced = { quantity: 10, unitLabel: "kg", estimatedAmountCents: 800_00, amountIsEstimate: true };
  // What the weigher's row looks like once it has been through the adapter:
  // the server projected the money out, so the amount is withheld.
  const withheld = { quantity: 10, unitLabel: "kg", estimatedAmountCents: null, amountIsEstimate: null };

  it("declares a withheld amount as a hole instead of adding it as zero", () => {
    const t = totalsOfRecords([priced, withheld]);
    expect(t.valueCents).toBe(800_00);
    expect(t.recordsWithoutValue).toBe(1);
    // "al menos $800, 1 sin valor" — a floor, labelled as one.
    expect(valueState(t)).toEqual({
      kind: "partial",
      cents: 800_00,
      missing: 1,
      isEstimate: true,
    });
    // The kilos were never withheld: he weighs them, he may read them.
    expect(kgState(t)).toEqual({ kind: "known", kg: 20 });
  });

  it("says nothing at all when every amount was withheld", () => {
    const t = totalsOfRecords([withheld, withheld]);
    expect(t.valueCents).toBeNull();
    expect(valueState(t)).toEqual({ kind: "unknown", missing: 2, records: 2 });
    // And it is not called an estimate: a withheld amount is not a provisional
    // one, it is an absent one.
    expect(t.valueIsEstimate).toBe(false);
  });

  it("still totals a list nothing was withheld from", () => {
    const t = totalsOfRecords([priced, priced]);
    expect(t.recordsWithoutValue).toBe(0);
    expect(valueState(t)).toEqual({ kind: "estimate", cents: 1_600_00 });
  });
});

describe("the one place a hole may be treated as zero", () => {
  it("gives geometry a number, because a missing week has no bar to draw", () => {
    // Named to be uncomfortable. This is for bar widths only; every figure a
    // person reads goes through kgState / valueState instead.
    expect(kgForDrawing(totals({ kg: null }))).toBe(0);
    expect(kgForDrawing(totals({ kg: 42 }))).toBe(42);
  });
});
