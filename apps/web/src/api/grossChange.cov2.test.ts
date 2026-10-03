// SPDX-License-Identifier: MIT
/**
 * grossChange.ts, the corners the arithmetic suite leaves: malformed weeks in
 * the server's details, a week whose approved lines disagree on the price,
 * plural removals, counts past nine, and a change with no visible cause that
 * the server WAS told about.
 */
import { describe, expect, it } from "vitest";
import {
  explainGrossChange,
  line,
  readGrossDetails,
  reasonsFor,
  type Formatters,
  type ServerGrossDetails,
} from "./grossChange";
import { formatMoney } from "../lib/money";
import { formatDayLong } from "../lib/dates";

const FMT: Formatters = { money: formatMoney, week: formatDayLong };

function details(over: Partial<ServerGrossDetails>): ServerGrossDetails {
  return {
    expectedCents: 100,
    actualCents: 200,
    addedPayableIds: [],
    removedPayableIds: [],
    payableIdsProvided: true,
    weeksInSettlement: [],
    ...over,
  };
}

describe("readGrossDetails — weeks that are not weeks", () => {
  it("drops null, non-objects and entries without a day or a whole price", () => {
    const d = readGrossDetails({
      expectedCents: 1,
      actualCents: 2,
      weeksInSettlement: [
        null,
        "2026-08-24",
        { weekStart: 20260824, priceCents: 1 },
        { weekStart: "2026-08-24", priceCents: 1.5 },
        { weekStart: "2026-08-31", priceCents: 900 },
      ],
    })!;
    expect(d.weeksInSettlement).toEqual([{ weekStart: "2026-08-31", priceCents: 900 }]);
  });
});

describe("explainGrossChange — a week whose lines disagree", () => {
  it("says nothing about that week rather than guess which price was read", () => {
    const approved = [
      line("1", 100, { rateSource: "weekly_price", rateCents: 80_000 }),
      line("2", 100, { rateSource: "weekly_price", rateCents: 85_000 }),
    ];
    const change = explainGrossChange(
      details({ weeksInSettlement: [{ weekStart: "2026-08-24", priceCents: 90_000 }] }),
      approved,
      [],
    );
    expect(change.repriced).toEqual([]);
  });
});

describe("reasonsFor — wording", () => {
  it("counts labores past nine in digits and pluralises a removal", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `id-${i}`);
    const removed = ids.slice(0, 2).map((id) => line(id, 1, { unitLabel: null }));
    const change = explainGrossChange(
      details({ addedPayableIds: ids, removedPayableIds: ["id-0", "id-1"] }),
      removed,
      [],
    );
    expect(reasonsFor(change, FMT)).toEqual([
      "entraron 12 labores más",
      "salieron dos labores de la liquidación",
    ]);
  });

  it("says the pending work changed when the server knew what the screen saw", () => {
    const change = explainGrossChange(details({ payableIdsProvided: true }), [], []);
    expect(reasonsFor(change, FMT)).toEqual(["las labores pendientes cambiaron"]);
  });
});
