/**
 * Money. Integer cents, always. Never a float.
 *
 * The rules here are a deliberate port of `apps/mobile/src/format.ts` and
 * `db.ts` (`toCents`, `Math.round(weight * costPerUnitCents)`), not a fresh
 * implementation: the phone and the web have to render the same peso figure
 * for the same work, or the worker holding a paper receipt from one and
 * looking at a screen from the other sees two different numbers.
 *
 * They will move to `packages/shared` once that package exists; this file is
 * the seam where that swap happens, which is why nothing else in the app does
 * arithmetic on money.
 *
 * Formatting is done by hand rather than with Intl for the same reason the
 * mobile app does it: es-CO groups thousands with "." and marks decimals with
 * ",", and "1,500" meaning a thousand and a half in one convention and one and
 * a half in the other is not a cosmetic difference on a payslip.
 */

/** An integer number of cents. 1 peso = 100 cents. */
export type Cents = number;

const GROUP = ".";
const DECIMAL = ",";

function group(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += GROUP;
    out += digits[i];
  }
  return out;
}

/** Pesos (possibly fractional) -> integer cents. */
export const toCents = (pesos: number): Cents => Math.round(pesos * 100);

/** Integer cents -> pesos as a float. Only for display and for tests. */
export const fromCents = (cents: Cents): number => cents / 100;

/**
 * The one multiplication in the product: quantity x unit rate.
 *
 * Mirrors `Math.round(weight * costPerUnitCents)` in the mobile ledger and the
 * `amount_cents = round(quantity x rate_cents)` rule of arquitectura-api.md.
 * Valid for the three pay modes: contract (quantity = 1), time_unit (quantity
 * = number of day-wages) and work_unit (quantity = kg / arrobas / baskets).
 */
export function amountCents(quantity: number, rateCents: Cents): Cents {
  return Math.round(quantity * rateCents);
}

/**
 * Money without decimals: 3080000 cents -> "$30.800".
 *
 * Colombian pesos are not quoted with cents in the field, so the display
 * rounds to the peso. The sign is only shown when something survives the
 * rounding, so -40 cents prints "$0" and never "-$0".
 */
export function formatMoney(cents: Cents): string {
  const pesos = Math.round(Math.abs(cents) / 100);
  const sign = cents < 0 && pesos > 0 ? "-" : "";
  return `${sign}$${group(String(pesos))}`;
}

/** Same, but always carries an explicit + or - . For ledger rows. */
export function formatMoneySigned(cents: Cents): string {
  const pesos = Math.round(Math.abs(cents) / 100);
  if (pesos === 0) return "$0";
  return `${cents < 0 ? "−" : "+"} $${group(String(pesos))}`;
}

/**
 * Weights and counts: 1742.5 -> "1.742,5".
 *
 * Rounds once, in tenths. Taking the integer part first and rounding the
 * remainder separately lets the remainder reach 10 and print as a second
 * digit: a sum of 65.3 + 68.1 + 52.6 arrives as 185.99999999999997 and would
 * render "185,10" instead of "186". That number is what the worker checks
 * their weight against.
 */
export function formatQuantity(value: number): string {
  const tenths = Math.round(Math.abs(value) * 10);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  const sign = value < 0 && tenths > 0 ? "-" : "";
  return `${sign}${group(String(whole))}${frac ? DECIMAL + frac : ""}`;
}

/** Hectares, two decimals: 4.2 -> "4,20". */
export function formatArea(ha: number): string {
  const hundredths = Math.round(Math.abs(ha) * 100);
  const whole = Math.floor(hundredths / 100);
  const frac = String(hundredths % 100).padStart(2, "0");
  const sign = ha < 0 && hundredths > 0 ? "-" : "";
  return `${sign}${group(String(whole))}${DECIMAL}${frac}`;
}

/**
 * Reads what a person typed into a peso field and returns integer cents.
 *
 * Accepts "30800", "30.800", "$ 30.800", "30800,50". Returns null for
 * anything that is not a number, so the caller can say which field is wrong
 * and why instead of silently storing NaN.
 */
export function parseMoneyInput(raw: string): Cents | null {
  const cleaned = raw.replace(/[$\s\u00a0]/g, "").replace(/\./g, "").replace(",", ".");
  if (cleaned === "" || !/^-?\d*(\.\d*)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return toCents(n);
}

/**
 * LO QUE SE PONE EN UNA CASILLA DE PESOS QUE SE VA A EDITAR.
 *
 * `formatMoney` redondea al peso a propósito: en Colombia no se cotiza con
 * centavos y una pantalla llena de «,00» se lee peor. Pero los formularios de
 * modificar hacían lo mismo *dentro del campo*:
 *
 *     String(Math.round(expense.amountCents / 100))
 *
 * Un gasto de $125.50 se abría con «126» en la casilla. Quien entraba a
 * corregir la NOTA y pulsaba Guardar mandaba 12600 en vez de 12550 sin haber
 * tocado el valor: cincuenta centavos que nadie escribió, en un registro que
 * después no cuadra contra la factura. Los mismos cincuenta centavos por los
 * que se arregló `packages/shared` cuando el teléfono redondeaba hacia abajo.
 *
 * Esta función es la inversa exacta de `parseMoneyInput`: lo que sale de aquí,
 * metido allí, devuelve los mismos centavos. Los centavos sólo se escriben
 * cuando los hay, así que el caso corriente sigue viéndose «30800».
 */
export function moneyInputValue(cents: Cents): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const pesos = Math.floor(abs / 100);
  const rest = abs % 100;
  const body = rest === 0
    ? String(pesos)
    : `${pesos}${DECIMAL}${String(rest).padStart(2, "0")}`;
  return neg ? `-${body}` : body;
}

/** Same idea for a quantity field: "38,5" -> 38.5. */
export function parseQuantityInput(raw: string): number | null {
  const cleaned = raw.replace(/[\s\u00a0]/g, "").replace(/\./g, "").replace(",", ".");
  if (cleaned === "" || !/^-?\d*(\.\d*)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
