// SPDX-License-Identifier: MIT
/**
 * CSV files a farm office opens in Excel.
 *
 * Semicolon-separated with a UTF-8 BOM, because that is what Excel in a
 * Spanish-speaking locale opens correctly on a double click: with commas the
 * whole row lands in column A (the comma is the decimal separator there), and
 * without the BOM "Báscula" arrives as "BÃ¡scula". Numbers are written with a
 * decimal comma and no thousands separator, so Excel reads them as numbers.
 */
export type Cell = string | number | null | undefined;

const SEP = ";";

/**
 * Text a spreadsheet would evaluate as a formula. Excel and Sheets run a cell
 * that starts with `=`, `+`, `-` or `@` (or a tab / carriage return before
 * one), so a worker name like `=HYPERLINK(...)` would execute on the office
 * computer. Full-width variants are included because some setups normalise
 * them to the ASCII ones.
 */
const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;
/** A plain number typed as text (`-5000`, `-12,5`) is data, not a formula. */
const PLAIN_NUMBER = /^-?\d+([.,]\d+)?$/;

/** Prefixes formula-looking text with `'` so the spreadsheet shows it as text. */
export function neutralizeFormula(s: string): string {
  return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s;
}

function cell(v: Cell): string {
  if (v === null || v === undefined) return "";
  // Only text is guarded: numbers (negative amounts included) stay numeric.
  const s = typeof v === "number" ? formatNumber(v) : neutralizeFormula(v);
  return /[";\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** `1234.5` -> `1234,5`. No grouping: a thousands dot would turn it into text. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded).replace(".", ",");
}

/** Pesos from integer cents, as a plain number Excel can add up. */
export const pesos = (cents: number | null | undefined): number | null =>
  cents === null || cents === undefined ? null : Math.round(cents / 100);

export function toCsv(header: string[], rows: Cell[][]): string {
  const lines = [header, ...rows].map((r) => r.map(cell).join(SEP));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

/** Saves `csv` as a file. Returns false where the browser cannot. */
export function downloadCsv(filename: string, csv: string): boolean {
  try {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}
