/**
 * Reading a `ReportTotals` without ever printing a zero that means "I do not
 * know".
 *
 * The server was deliberate about this and the contract says so in as many
 * words: `kg` and `valueCents` are nullable, and each null arrives with a
 * count beside it — `recordsNotInKg`, `recordsWithoutValue` — so a partial sum
 * can never be read as a whole one. That design is only worth anything if the
 * client honours it, and `total.kg ?? 0` is one keystroke away in every
 * component that touches a figure.
 *
 * So no screen in this module reads `.kg` or `.valueCents` directly. They read
 * `kgState` and `valueState`, which return a tagged union with no numeric
 * member in the `unknown` case — there is nothing to accidentally render. The
 * components in `Figures.tsx` consume those unions and refuse to take a bare
 * number at all.
 *
 * Four states, and all four are visible on screen:
 *
 *   unknown   nothing here could be established -> a dash and a reason
 *   partial   some of it could not -> the figure is a FLOOR, labelled as one
 *   estimate  all of it priced, but the week's price can still move it
 *   final     all of it priced and frozen: this is what was paid
 *
 * `partial` is the interesting one, and showing the number with "al menos" is
 * the right answer rather than hiding it: a farm that can see $1.200.000 of a
 * week priced and two labors that could not be is better informed than one
 * shown a dash for the whole week.
 */
import type { WireReportTotals } from "../../api/wire";

export type Totals = WireReportTotals;

/** A quantity that knows how much of itself is missing. */
export type QuantityState =
  | { kind: "unknown"; missing: number; records: number }
  | { kind: "partial"; kg: number; missing: number }
  | { kind: "known"; kg: number };

export function kgState(t: Totals): QuantityState {
  if (t.kg === null) return { kind: "unknown", missing: t.recordsNotInKg, records: t.records };
  if (t.recordsNotInKg > 0) return { kind: "partial", kg: t.kg, missing: t.recordsNotInKg };
  return { kind: "known", kg: t.kg };
}

/** Money, with the provenance a farm is owed. */
export type ValueState =
  | { kind: "unknown"; missing: number; records: number }
  | { kind: "partial"; cents: number; missing: number; isEstimate: boolean }
  | { kind: "estimate"; cents: number }
  | { kind: "final"; cents: number };

export function valueState(t: Totals): ValueState {
  if (t.valueCents === null) {
    return { kind: "unknown", missing: t.recordsWithoutValue, records: t.records };
  }
  if (t.recordsWithoutValue > 0) {
    return {
      kind: "partial",
      cents: t.valueCents,
      missing: t.recordsWithoutValue,
      isEstimate: t.valueIsEstimate,
    };
  }
  return t.valueIsEstimate
    ? { kind: "estimate", cents: t.valueCents }
    : { kind: "final", cents: t.valueCents };
}

/**
 * The kilos, for arithmetic that is allowed to treat a hole as nothing —
 * bar widths and chart heights, and nothing else.
 *
 * Named to be uncomfortable on purpose. Drawing a bar needs a number and a
 * missing week has no bar; that is a fair use. Printing the same value beside
 * it is not, which is why this is not called `kgOr0` and is never used outside
 * a geometry calculation.
 */
export const kgForDrawing = (t: Totals): number => t.kg ?? 0;

/** True when nothing at all is known about this row's kilos. */
export const hasNoKilos = (t: Totals): boolean => t.kg === null;

/**
 * Fold a set of rows into one total, propagating the admissions.
 *
 * Used where the screen shows a figure the server did not send as a single row
 * — the header of a filtered list, for instance. A sum of rows in which one
 * row's kilos are unknown is itself partial, and this keeps it that way rather
 * than quietly dropping the hole.
 */
export function foldTotals(rows: Totals[]): Totals {
  let kg: number | null = null;
  let valueCents: number | null = null;
  const out: Totals = {
    records: 0,
    kg: null,
    recordsNotInKg: 0,
    valueCents: null,
    recordsWithoutValue: 0,
    recordsSpanningWeeks: 0,
    valueIsEstimate: false,
  };
  for (const r of rows) {
    out.records += r.records;
    out.recordsNotInKg += r.recordsNotInKg;
    out.recordsWithoutValue += r.recordsWithoutValue;
    if (r.kg !== null) kg = (kg ?? 0) + r.kg;
    if (r.valueCents !== null) valueCents = (valueCents ?? 0) + r.valueCents;
    if (r.valueIsEstimate) out.valueIsEstimate = true;
  }
  out.kg = kg;
  out.valueCents = valueCents;
  return out;
}

/**
 * ── THE SAME MACHINERY, FOR THE SCREENS THAT PREDATE IT ─────────────────
 *
 * `/v1/reports/*` hands the harvest module a `ReportTotals` with the holes
 * already declared. The older screens — the dashboard, `/labores`, an
 * employee's file, a plot's file — do not have that: they hold a list of
 * `WorkRecord`s and were adding up `estimatedAmountCents` into a bare number.
 *
 * A bare number is exactly what loses `amountIsEstimate`. The server sends
 * that flag on every record expressly so that what the farm OWES and what it
 * has PAID cannot look alike, and it had zero readers anywhere in `features/`:
 * the dashboard printed "$1.507.920" for 44 labores that are 100% estimate,
 * with no mark, and so did the foot of `/labores` and the employee's file.
 *
 * Rather than invent a second vocabulary for the same fact, those screens fold
 * their records into a `Totals` here and render it with `<Value>`, which
 * already knows how to say "provisional · al precio de la semana".
 */
export interface RecordLike {
  quantity: number;
  unitLabel: string | null;
  estimatedAmountCents: number;
  amountIsEstimate: boolean;
}

export function totalsOfRecords(records: RecordLike[]): Totals {
  const inKg = records.filter((r) => r.unitLabel === "kg");
  return {
    records: records.length,
    // Null rather than 0 when not one row is weighed in kilos: "0 kg" is a
    // claim that nothing was picked.
    kg: inKg.length > 0 ? inKg.reduce((a, r) => a + r.quantity, 0) : null,
    recordsNotInKg: records.length - inKg.length,
    // Records here are already one week's worth, so none of them straddles.
    recordsSpanningWeeks: 0,
    // Null rather than 0 for an empty list, for the same reason. With rows,
    // `estimatedAmountCents` is always a number on the wire — the server
    // computes it — so there is no per-row hole to declare here.
    valueCents: records.length > 0 ? records.reduce((a, r) => a + r.estimatedAmountCents, 0) : null,
    recordsWithoutValue: 0,
    // ONE estimated row makes the whole sum an estimate. It is the same rule
    // `foldTotals` uses, and the conservative direction: a total that contains
    // something provisional is provisional.
    valueIsEstimate: records.some((r) => r.amountIsEstimate),
  };
}

/** An empty row, for a column or a cell the server did not send. */
export const NO_TOTALS: Totals = {
  records: 0,
  kg: null,
  recordsNotInKg: 0,
  valueCents: null,
  recordsWithoutValue: 0,
  valueIsEstimate: false,
  recordsSpanningWeeks: 0,
};
