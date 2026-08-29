/**
 * The join behind the difference screen.
 *
 * These are arithmetic tests on purpose. The dialog they feed is the last
 * thing between somebody and signing a figure they did not read, and the
 * sentence it prints has to be true about the numbers next to it.
 *
 * The two cases worth the most are the ones that produce a WRONG sentence
 * rather than no sentence:
 *
 *   - `weeksInSettlement` is every week the settlement spans, priced as of
 *     now, NOT the weeks that changed. Read as the latter, a late weighing
 *     comes out as "el precio de la semana cambió".
 *   - `payableIdsProvided: false` means the server was not told what the
 *     screen saw. Read as "nothing was added", it comes out as a reprice too.
 */
import { describe, expect, it } from "vitest";
import {
  explainGrossChange,
  line,
  readGrossDetails,
  reasonsFor,
  sentenceFor,
  type Formatters,
  type ServerGrossDetails,
} from "./grossChange";
import { formatMoney } from "../lib/money";
import { formatDayLong } from "../lib/dates";

const FMT: Formatters = { money: formatMoney, week: formatDayLong };

/** A 409's details, with the fields a case does not care about defaulted. */
function details(over: Partial<ServerGrossDetails>): ServerGrossDetails {
  return {
    expectedCents: 14_840_000,
    actualCents: 15_120_000,
    addedPayableIds: [],
    removedPayableIds: [],
    payableIdsProvided: true,
    weeksInSettlement: [{ weekStart: "2026-08-24", priceCents: 80_000 }],
    ...over,
  };
}

describe("lo que el servidor manda", () => {
  it("se lee tal cual, con los dos números y las dos listas", () => {
    const d = readGrossDetails({
      expectedCents: 14_840_000,
      actualCents: 15_120_000,
      addedPayableIds: ["a", "b"],
      removedPayableIds: [],
      payableIdsProvided: true,
      weeksInSettlement: [{ weekStart: "2026-08-24", priceCents: 85_000 }],
    })!;
    expect(d.expectedCents).toBe(14_840_000);
    expect(d.addedPayableIds).toEqual(["a", "b"]);
    expect(d.payableIdsProvided).toBe(true);
    expect(d.weeksInSettlement).toEqual([{ weekStart: "2026-08-24", priceCents: 85_000 }]);
  });

  it("rechaza una cifra que no sea centavos enteros", () => {
    // It is about to be shown to somebody as pesos in a dialog whose entire
    // purpose is to state the right number. Coercing it would be the one place
    // a wrong figure could not be caught.
    expect(readGrossDetails({ expectedCents: "148400", actualCents: 151_200 })).toBeNull();
    expect(readGrossDetails({ expectedCents: 148_400.5, actualCents: 151_200 })).toBeNull();
    expect(readGrossDetails({})).toBeNull();
  });

  it("lee un payableIdsProvided ausente como false, que es el lado seguro", () => {
    const d = readGrossDetails({ expectedCents: 1, actualCents: 2 })!;
    // Reading it as true would let a screen state "nothing was added" on the
    // strength of two lists the server never filled in.
    expect(d.payableIdsProvided).toBe(false);
  });
});

describe("cuando entraron pesadas", () => {
  const approved = [line("1", 8_000_000), line("2", 6_840_000)];
  const fresh = [...approved, line("3", 140_000), line("4", 140_000)];

  it("las nombra, y no culpa al precio de la semana", () => {
    const change = explainGrossChange(
      details({ addedPayableIds: ["3", "4"] }),
      approved,
      fresh,
    );
    expect(change.deltaCents).toBe(280_000);
    expect(change.added.map((l) => l.id)).toEqual(["3", "4"]);
    // THE TRAP. `weeksInSettlement` carried the week — it always does — and
    // its price is the same one the approved lines were showing, so nothing
    // was repriced and nothing is reported as repriced.
    expect(change.repriced).toEqual([]);

    expect(sentenceFor(change, FMT)).toBe(
      "Cuando abrió esta pantalla eran $148.400; ahora son $151.200 " +
        "porque entraron dos pesadas más.",
    );
  });

  it("un día de poda es una labor, no una pesada", () => {
    const podaFresh = [
      ...approved,
      line("3", 280_000, { unitLabel: null, activityName: "Poda" }),
    ];
    const change = explainGrossChange(
      details({ addedPayableIds: ["3"] }),
      approved,
      podaFresh,
    );
    expect(reasonsFor(change, FMT)).toEqual(["entró una labor más"]);
  });

  it("cuenta los ids, no las filas que pudo resolver", () => {
    // A payable that was deleted outright resolves to no line at all. Counting
    // the table instead of the ids would under-report what moved the figure.
    const change = explainGrossChange(
      details({ addedPayableIds: ["3", "4"] }),
      approved,
      [...approved, line("3", 140_000)],
    );
    expect(change.added).toHaveLength(1);
    expect(reasonsFor(change, FMT)).toEqual(["entraron dos pesadas más"]);
  });
});

describe("cuando cambió el precio de la semana", () => {
  const approved = [
    line("1", 8_000_000, { rateCents: 80_000, rateSource: "weekly_price" }),
    line("2", 6_840_000, { rateCents: 80_000, rateSource: "weekly_price" }),
  ];

  it("dice qué semana y de cuánto a cuánto", () => {
    const change = explainGrossChange(
      details({
        actualCents: 15_582_000,
        weeksInSettlement: [{ weekStart: "2026-08-24", priceCents: 85_000 }],
      }),
      approved,
      approved,
    );
    expect(change.repriced).toEqual([
      { weekStart: "2026-08-24", fromRateCents: 80_000, toRateCents: 85_000, lineCount: 2 },
    ]);
    expect(sentenceFor(change, FMT)).toBe(
      "Cuando abrió esta pantalla eran $148.400; ahora son $155.820 porque " +
        "el precio de la semana del 24 de agosto pasó de $800 a $850.",
    );
  });

  it("ignora una semana cuyo precio no se movió", () => {
    const change = explainGrossChange(details({}), approved, approved);
    expect(change.repriced).toEqual([]);
  });

  it("ignora una línea cuyo precio se congeló al registrarla", () => {
    // A frozen rate cannot have been moved by a weekly price, so a week whose
    // only lines are frozen is not a reprice no matter what the price is now.
    const frozen = [line("1", 8_000_000, { rateCents: 80_000, rateSource: "fixed" })];
    const change = explainGrossChange(
      details({ weeksInSettlement: [{ weekStart: "2026-08-24", priceCents: 85_000 }] }),
      frozen,
      frozen,
    );
    expect(change.repriced).toEqual([]);
  });
});

describe("cuando el servidor no supo qué se vio", () => {
  it("no dice «no cambió nada»: dice que no se pudo establecer", () => {
    const change = explainGrossChange(
      details({ payableIdsProvided: false }),
      [],
      [],
    );
    expect(change.causeIsKnown).toBe(false);
    expect(reasonsFor(change, FMT)).toEqual([
      "las labores pendientes cambiaron y no se pudo establecer qué se movió",
    ]);
  });
});

describe("dos motivos a la vez", () => {
  it("se unen en una frase, no en una lista", () => {
    const approved = [
      line("1", 5_000_000, { rateCents: 50_000, rateSource: "weekly_price" }),
      line("2", 5_000_000, { rateCents: 50_000, rateSource: "weekly_price" }),
    ];
    const change = explainGrossChange(
      details({
        expectedCents: 10_000_000,
        actualCents: 11_500_000,
        addedPayableIds: ["3"],
        removedPayableIds: ["2"],
        weeksInSettlement: [{ weekStart: "2026-08-24", priceCents: 55_000 }],
      }),
      approved,
      [line("3", 6_000_000)],
    );
    expect(sentenceFor(change, FMT)).toBe(
      "Cuando abrió esta pantalla eran $100.000; ahora son $115.000 porque " +
        "entró una pesada más, salió una pesada de la liquidación y " +
        "el precio de la semana del 24 de agosto pasó de $500 a $550.",
    );
  });
});
