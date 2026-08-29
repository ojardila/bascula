/**
 * Money. Every rule in this file is one that costs real pesos if the phone and
 * the server disagree, which is the whole reason the package exists.
 *
 * Two invariants inherited from the phone and kept by the API
 * (`docs/arquitectura-api.md` §0):
 *
 *   1. Amounts are INTEGER cents. A REAL balance drifts, and these balances
 *      carry over for months — a worker's savings held by the farm.
 *   2. Positive means the farm owes the worker. A positive balance is the
 *      worker's credit; a negative one is what they owe back.
 */

import type { LedgerKind } from "./enums.ts";

/** Pesos as typed by a human -> integer cents. */
export const toCents = (amount: number) => Math.round(amount * 100);

/** Integer cents -> pesos, for display only. Never store the result. */
export const fromCents = (cents: number) => cents / 100;

/**
 * A quantity as an EXACT decimal: `units` scaled down by ten to the `scale`.
 * `1.005` -> `{ units: 1005n, scale: 3 }`. `null` when the input is not a
 * finite decimal at all (NaN, Infinity, a stray "", a "1,5" with a comma).
 *
 * Where the float has to stop, and why it can:
 *
 * A quantity is typed as text — `RegisterPickup` reads a `TextInput` — and
 * `parseFloat` turns it into the NEAREST DOUBLE to what the picker weighed.
 * `1.005` has no exact binary form, so what the column holds is a hair under
 * it. `pickups.weight` is REAL and hands that same double back, so by the time
 * a settlement asks for a line the decimal the human wrote is already gone.
 *
 * It is recoverable, though. `String(x)` gives the SHORTEST decimal that
 * round-trips to `x`, and a quantity with at most three decimals and twelve
 * digits (the `numeric(12,3)` the server stores it in) is far inside the
 * ~15 significant digits a double round-trips exactly — so the shortest form
 * IS the decimal that was typed, digit for digit. Reading those digits is the
 * point where the number stops being a float; everything after it is integer
 * arithmetic and cannot drift.
 *
 * `string` is accepted for the path that never lost them in the first place:
 * Postgres sends `numeric` as text and the sync layer is free to hand it over
 * untouched instead of going through `Number()`.
 */
function exactDecimal(value: number | string): { units: bigint; scale: number } | null {
  const text = typeof value === "number" ? String(value) : value.trim();
  // Exponent form is what `String` produces past 1e21 and below 1e-6. It never
  // comes out of a scale, but a `time_unit` price test or a bad import can
  // reach it, and silently answering NaN there would be worse than folding it
  // into the scale.
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m) return null;
  const [, sign, whole = "", fraction = "", exponent] = m;
  if (!whole && !fraction) return null;
  let units = BigInt(`${whole}${fraction}` || "0");
  let scale = fraction.length - Number(exponent ?? 0);
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { units: sign === "-" ? -units : units, scale };
}

/**
 * The one multiplication in the system: what a piece of work is worth.
 *
 *   amountCents(quantity, rateCents) = round(quantity * rateCents)
 *
 * `quantity` is a measurement — kilos on a scale, baskets, or the number of
 * jornales — with at most three decimals. `rateCents` is an integer. The
 * product is rounded HALF AWAY FROM ZERO: 20832.5 becomes 20833, not 20832.
 * It is NOT banker's rounding, and it is not `Math.round` on a float either.
 *
 * The multiplication is done on the quantity's DECIMAL DIGITS in BigInt, not
 * in float64, and that is the whole point of this function. `Math.round(1.005
 * * 7500)` answers 7537: the double nearest 1.005 is below it, the exact
 * product 7537.5 lands at 7537.499999999999 and rounds DOWN. The server does
 * the same multiplication over `big.Rat` and Postgres over `numeric`, both
 * exact, and both answer 7538. Four such lines on one settlement are four
 * cents of gross, and the phone that derived its own gross is then told
 * `409 GROSS_CHANGED` and blames a price change that never happened. The
 * error is always the same direction: one minor unit short, against the
 * worker. See the `tres-decimales-que-el-float-pierde` golden case, which
 * fails on every one of its four lines if this goes back to a float.
 *
 * Rounding happens ONCE PER LINE and the lines are then summed as integers.
 * Rounding the sum instead gives a different total — see the
 * `redondeo-medio-centavo` golden case, where the two differ by two cents on
 * four pickups. The receipt the worker checks has to add up exactly, so the
 * line is the unit of rounding.
 *
 * Valid for the three pay modes: `contract` (quantity = 1), `time_unit`
 * (quantity = number of time units), `work_unit` (quantity = kg/arroba/...).
 *
 * A non-finite input answers NaN, which is what the float form did; the
 * callers that must refuse it (`requirePositive`) already check the result.
 */
export function amountCents(quantity: number | string, rateCents: number): number {
  const q = exactDecimal(quantity);
  if (q === null || !Number.isFinite(rateCents)) return NaN;

  // The rate is integer cents by construction (`toCents`); rounding it here
  // rather than truncating keeps a rate that arrived through a float from
  // losing a cent of its own.
  const product = q.units * BigInt(Math.round(rateCents));
  const scale = 10n ** BigInt(q.scale);

  // Half AWAY FROM ZERO, so the magnitude is what gets rounded. `ajuste` is
  // the only kind that can be negative and it never reaches here, but the Go
  // twin is defined this way and a rule that holds on one sign only is a rule
  // waiting to be ported wrong.
  const magnitude = product < 0n ? -product : product;
  const rounded =
    (magnitude % scale) * 2n >= scale ? magnitude / scale + 1n : magnitude / scale;
  return Number(product < 0n ? -rounded : rounded);
}

/**
 * The sign a `kind` is allowed to carry. This is the table in
 * `docs/diagramas/movil.md` §8, and it is enforced by a CHECK in
 * `apps/mobile/src/schema.ts` — this constant exists so a client can refuse
 * the movement before the database does, and so Go enforces the same table.
 *
 *   positive  the farm recognises a debt towards the worker
 *   negative  value flowing the other way: cash out, or a discount
 *   free      may go either way, but never zero
 */
export type LedgerSign = "positive" | "negative" | "free";

export const LEDGER_SIGN: Readonly<Record<LedgerKind, LedgerSign>> = Object.freeze({
  /** Settled work the farm acknowledges owing. */
  devengo: "positive",
  /** Cash handed to the worker. */
  pago: "negative",
  /** Cash handed over before the work is settled. */
  anticipo: "negative",
  /** Meals, lodging, tools, shop. */
  deduccion: "negative",
  /** A correction, either direction. */
  ajuste: "free",
  /** Cancels another movement, so it carries the opposite sign of that one. */
  reverso: "free",
});

/**
 * Callers pass magnitudes in positive; the sign belongs to the data layer.
 * `pago`, `anticipo` and `deduccion` are negated on the way in — doing it at
 * the call site is how a payment eventually gets stored positive and starts
 * counting as an earning.
 *
 * `free` kinds (`ajuste`, `reverso`) are passed through already signed.
 */
export function signedAmount(kind: LedgerKind, magnitudeCents: number): number {
  const sign = LEDGER_SIGN[kind];
  if (sign === "free") return Math.round(magnitudeCents);
  const magnitude = Math.abs(Math.round(magnitudeCents));
  return sign === "negative" ? -magnitude : magnitude;
}

/**
 * Mirrors the CHECK constraints on `ledger`, so a client can say "el monto
 * debe ser mayor que cero" instead of surfacing a SQLite error. Zero is never
 * valid for any kind: a movement that moves nothing is not a movement.
 */
export function isValidLedgerAmount(kind: LedgerKind, amount: number): boolean {
  if (!Number.isInteger(amount) || amount === 0) return false;
  switch (LEDGER_SIGN[kind]) {
    case "positive":
      return amount > 0;
    case "negative":
      return amount < 0;
    default:
      return true;
  }
}
