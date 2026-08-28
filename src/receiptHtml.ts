import type { Lang } from "./format.ts";
import { formatMoney, formatNumber, formatDay, formatWeekRange } from "./format.ts";
import { translate } from "./strings.ts";

/**
 * The printable receipt. Built as HTML because that is what expo-print turns
 * into a PDF, and because a receipt handed to a worker has to be readable
 * without any app: paper survives a lost phone and a changed foreman.
 *
 * Deliberately plain — no colour blocks, no logos — so it prints legibly on
 * the cheap thermal and inkjet printers a farm office actually has.
 */

export interface ReceiptLine {
  week: string;
  weight: number;
  amountCents: number;
}

export interface ReceiptData {
  workerName: string;
  workerDoc?: string | null;
  farmLabel: string;
  unit: string;
  lines: ReceiptLine[];
  /** Signed cents: positive is the farm owing, negative an outstanding advance. */
  balanceCents: number;
  paidCents: number;
  date: string;
}

/** Escapes text going into the document, since names come from user input. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const cents = (c: number, lang: Lang) => formatMoney(c / 100, lang);

export function receiptHtml(r: ReceiptData, lang: Lang): string {
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);

  // Newest week first, the way the worker remembers the season.
  const lines = [...r.lines].sort((a, b) => (a.week < b.week ? 1 : -1));
  const grossCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const kg = lines.reduce((s, l) => s + l.weight, 0);

  const rows = lines
    .map(
      (l) => `<tr>
        <td>${esc(formatWeekRange(l.week, lang))}</td>
        <td class="n">${esc(formatNumber(l.weight, lang))} ${esc(r.unit)}</td>
        <td class="n">${esc(cents(l.amountCents, lang))}</td>
      </tr>`,
    )
    .join("");

  const balance =
    r.balanceCents > 0
      ? `<tr class="bal"><td colspan="2">${esc(t("pay.credit"))}</td>
           <td class="n">${esc(cents(r.balanceCents, lang))}</td></tr>`
      : r.balanceCents < 0
        ? `<tr class="bal"><td colspan="2">${esc(t("pay.owesUs"))}</td>
             <td class="n">-${esc(cents(-r.balanceCents, lang))}</td></tr>`
        : "";

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<style>
  @page { margin: 18mm 14mm; }
  body { font-family: -apple-system, Roboto, Helvetica, Arial, sans-serif;
         font-size: 12pt; color: #000; }
  h1 { font-size: 15pt; margin: 0 0 2mm; }
  .who { font-size: 13pt; font-weight: 700; margin: 0 0 1mm; }
  .meta { color: #444; margin: 0 0 6mm; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10pt; text-transform: uppercase;
       letter-spacing: .04em; color: #444; border-bottom: 1px solid #000;
       padding: 0 0 1.5mm; }
  td { padding: 2mm 0; border-bottom: 1px solid #ddd; }
  .n { text-align: right; white-space: nowrap; }
  .tot td { border-top: 1px solid #000; border-bottom: none;
            font-weight: 700; padding-top: 3mm; }
  .paid td { border: none; font-size: 14pt; font-weight: 700; padding-top: 4mm; }
  .bal td { border-bottom: none; padding-top: 3mm; }
  /* Room for a real signature: the point of taking this to paper. */
  .sign { margin-top: 22mm; display: flex; gap: 12mm; }
  .sign div { flex: 1; border-top: 1px solid #000; padding-top: 2mm;
              font-size: 10pt; color: #444; }
  .foot { margin-top: 10mm; font-size: 9pt; color: #666; }
</style>
</head>
<body>
  <h1>${esc(t("pay.receipt"))}</h1>
  <p class="who">${esc(r.workerName)}</p>
  <p class="meta">${esc(r.workerDoc ? `${r.workerDoc} · ` : "")}${esc(formatDay(r.date, lang))}</p>

  <table>
    <thead>
      <tr><th>${esc(t("reports.week"))}</th>
          <th class="n">${esc(t("pay.gross"))}</th>
          <th class="n">${esc(t("crop.value"))}</th></tr>
    </thead>
    <tbody>
      ${rows}
      <tr class="tot">
        <td>${esc(t("week.total"))}</td>
        <td class="n">${esc(formatNumber(kg, lang))} ${esc(r.unit)}</td>
        <td class="n">${esc(cents(grossCents, lang))}</td>
      </tr>
      ${balance}
      <tr class="paid">
        <td colspan="2">${esc(t("pay.pay"))}</td>
        <td class="n">${esc(cents(r.paidCents, lang))}</td>
      </tr>
    </tbody>
  </table>

  <div class="sign">
    <div>${esc(t("pay.signWorker"))}</div>
    <div>${esc(t("pay.signFarm"))}</div>
  </div>

  <p class="foot">${esc(r.farmLabel)}</p>
</body>
</html>`;
}

export interface BalanceRow {
  name: string;
  doc?: string | null;
  kg: number;
  paidCents: number;
  balanceCents: number;
}

/**
 * The payroll sheet: one line per worker after paying. This is what the office
 * files and what settles an argument three weeks later, so it carries a
 * signature column per person rather than one at the foot.
 */
export function payrollHtml(
  rows: BalanceRow[],
  opts: { title: string; farmLabel: string; unit: string; date: string },
  lang: Lang,
): string {
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const totalPaid = rows.reduce((s, r) => s + r.paidCents, 0);
  const totalKg = rows.reduce((s, r) => s + r.kg, 0);

  const body = rows
    .map(
      (r) => `<tr>
        <td>${esc(r.name)}${r.doc ? `<br /><span class="doc">${esc(r.doc)}</span>` : ""}</td>
        <td class="n">${esc(formatNumber(r.kg, lang))}</td>
        <td class="n">${esc(cents(r.paidCents, lang))}</td>
        <td class="n">${r.balanceCents ? esc(cents(r.balanceCents, lang)) : "—"}</td>
        <td class="sig"></td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<style>
  @page { margin: 14mm 10mm; }
  body { font-family: -apple-system, Roboto, Helvetica, Arial, sans-serif;
         font-size: 11pt; color: #000; }
  h1 { font-size: 14pt; margin: 0 0 1mm; }
  .meta { color: #444; margin: 0 0 5mm; font-size: 10pt; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9pt; text-transform: uppercase;
       letter-spacing: .04em; color: #444; border-bottom: 1px solid #000;
       padding: 0 2mm 1.5mm 0; }
  td { padding: 3mm 2mm 3mm 0; border-bottom: 1px solid #ddd;
       vertical-align: top; }
  .n { text-align: right; white-space: nowrap; }
  .doc { font-size: 9pt; color: #666; }
  /* Signed on the spot, next to the amount each person is taking. */
  .sig { width: 42mm; border-bottom: 1px solid #999; }
  .tot td { border-top: 1px solid #000; border-bottom: none;
            font-weight: 700; padding-top: 3mm; }
  .foot { margin-top: 8mm; font-size: 9pt; color: #666; }
</style>
</head>
<body>
  <h1>${esc(opts.title)}</h1>
  <p class="meta">${esc(opts.farmLabel)} · ${esc(formatDay(opts.date, lang))}</p>

  <table>
    <thead>
      <tr><th>${esc(t("label.workers"))}</th>
          <th class="n">${esc(opts.unit)}</th>
          <th class="n">${esc(t("pay.pay"))}</th>
          <th class="n">${esc(t("pay.credit"))}</th>
          <th>${esc(t("pay.signWorker"))}</th></tr>
    </thead>
    <tbody>
      ${body}
      <tr class="tot">
        <td>${esc(t("week.total"))}</td>
        <td class="n">${esc(formatNumber(totalKg, lang))}</td>
        <td class="n">${esc(cents(totalPaid, lang))}</td>
        <td></td><td></td>
      </tr>
    </tbody>
  </table>

  <p class="foot">${esc(t("pay.people", { n: rows.length }))}</p>
</body>
</html>`;
}
