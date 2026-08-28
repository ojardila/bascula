/**
 * CSV building, kept pure so the escaping rules can be tested. The farm's
 * whole season lives in one phone's SQLite file: if that phone is lost, so is
 * the record of what everyone picked and what the farm still owes them. This
 * is the way that data gets out.
 */

/**
 * Quotes a field only when it needs it, and doubles any quotes inside.
 * Names like "Muñoz, Carlos" and notes carrying a comma or a line break would
 * otherwise split into extra columns and shift every value after them.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvField).join(",");
}

/**
 * Spreadsheets open CSV in the system encoding unless told otherwise, and the
 * accents in "María" or "Muñoz" come out broken. The BOM is what makes Excel
 * read it as UTF-8.
 */
export function csvDocument(header: string[], rows: unknown[][]): string {
  return "﻿" + [csvRow(header), ...rows.map(csvRow)].join("\r\n") + "\r\n";
}
