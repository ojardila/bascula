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
 * The one multiplication in the system: what a piece of work is worth.
 *
 *   amountCents(quantity, rateCents) = round(quantity * rateCents)
 *
 * `quantity` is a measurement and therefore a float64: kilos on a scale,
 * baskets, or the number of jornales. `rateCents` is an integer. The product
 * is rounded HALF AWAY FROM ZERO — JavaScript's `Math.round` rounds half up,
 * which is the same thing for the non-negative quantities the farm records,
 * and matches Go's `math.Round`. It is NOT banker's rounding: 20832.5 becomes
 * 20833, not 20832.
 *
 * Rounding happens ONCE PER LINE and the lines are then summed as integers.
 * Rounding the sum instead gives a different total — see the
 * `redondeo-medio-centavo` golden case, where the two differ by two cents on
 * four pickups. The receipt the worker checks has to add up exactly, so the
 * line is the unit of rounding.
 *
 * Valid for the three pay modes: `contract` (quantity = 1), `time_unit`
 * (quantity = number of time units), `work_unit` (quantity = kg/arroba/...).
 */
export const amountCents = (quantity: number, rateCents: number) =>
  Math.round(quantity * rateCents);

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
