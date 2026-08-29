/**
 * The arithmetic of the warehouse, such as it is.
 *
 * There is one rule and it is the whole file: **A QUANTITY IN STOCK IS NEVER
 * SET, ONLY MOVED.** `docs/modelo-datos.md` puts it as "existencias derivadas
 * de movimientos, igual que el saldo se deriva del ledger", and the database
 * enforces it with an append-only table. What that means for the interface is
 * that there is no field anywhere in this app that reads "cantidad en stock"
 * and accepts typing, and no function here that computes one from a target.
 *
 * The functions below exist because of the one place the rule is awkward: a
 * movement's quantity is SIGNED, and asking a storekeeper to type a minus sign
 * in front of a merma is asking for the day they forget. So the form works in
 * positive numbers and the sign comes from the reason.
 *
 * THE SERVER DOES THE SAME THING, and that is not a redundancy worth removing.
 * `handleCreateStockMove` coerces the sign to match the reason before writing,
 * and the `stock_sign` CHECK refuses the pair if anything got past it — so a
 * mismatch is corrected rather than refused, and `{qty: 40, reason: "merma"}`
 * is a merma of −40 and a 201. Doing it here as well is what lets the form
 * show the person what the movement will do BEFORE they commit to it: a
 * preview that said "quedan 68" and then recorded 28 would be worse than no
 * preview at all.
 */
import type { StockReason } from "../api/types";
import { STOCK_REASON_SIGN } from "../api/types";

/**
 * A positive number the person typed -> the signed quantity the wire wants.
 *
 * `traslado` and `ajuste` are the two reasons whose sign is free, so those are
 * the only ones where the form has to ask which way, and `direction` is that
 * answer. For every other reason the direction is not a question: a `cosecha`
 * that reduced the stock is not a thing that can happen.
 */
export function signedQty(
  magnitude: number,
  reason: StockReason,
  direction: "in" | "out" = "in",
): number {
  const size = Math.abs(magnitude);
  switch (STOCK_REASON_SIGN[reason]) {
    case "in":
      return size;
    case "out":
      return -size;
    case "either":
      return direction === "out" ? -size : size;
  }
}

/** True when the reason leaves the sign to the person. */
export const reasonNeedsDirection = (reason: StockReason): boolean =>
  STOCK_REASON_SIGN[reason] === "either";

/**
 * What a movement is worth saying out loud: "+ 320 Bulto" / "− 12 Kilo".
 *
 * The minus is U+2212, not a hyphen, for the same reason `formatMoneySigned`
 * uses it: at 14 px a hyphen next to a digit reads as a dash.
 */
export function formatSignedQty(qty: number, unit?: string | null): string {
  const size = Math.abs(qty);
  const grouped = size.toLocaleString("es-CO", { maximumFractionDigits: 3 });
  return `${qty < 0 ? "−" : "+"} ${grouped}${unit ? ` ${unit}` : ""}`;
}

/**
 * What the warehouse would hold after this movement.
 *
 * Only ever used to SHOW somebody the consequence before they commit to it —
 * "quedan 18 bultos" under the form. It is never sent anywhere and never
 * stored: the real number comes back from the server, summed from the rows.
 */
export const stockAfter = (current: number, signed: number): number =>
  Math.round((current + signed) * 1000) / 1000;

/**
 * Would this sale take out more than the warehouse holds?
 *
 * The server answers 409 INSUFFICIENT_STOCK for exactly this and the form asks
 * first, so the person can fix the number, or record the missing entry, or
 * tick "regístrelo de todos modos" — rather than filling in a whole sale and
 * being refused at the end.
 */
export function exceedsStock(available: number, requested: number): boolean {
  return requested > available;
}
