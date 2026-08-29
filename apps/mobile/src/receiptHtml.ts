import type { Lang } from "../../../packages/shared/src/format.ts";
import { formatMoney, formatNumber, formatDay, formatWeekRange } from "../../../packages/shared/src/format.ts";
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
      (l, i) => `<tr class="${i % 2 ? "alt" : ""}">
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
        ? `<tr class="bal owes"><td colspan="2">${esc(t("pay.owesUs"))}</td>
             <td class="n">-${esc(cents(-r.balanceCents, lang))}</td></tr>`
        : "";

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<style>
  @page { margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         font-size: 11pt; color: #16261a; margin: 0; }

  .head { border-top: 3px solid #2e7d32; padding-top: 4mm; margin-bottom: 6mm;
          display: flex; justify-content: space-between; align-items: flex-start; }
  .brand { font-size: 15pt; font-weight: 800; color: #1b5e20; }
  .sub { color: #5a6b5c; font-size: 10pt; margin-top: .5mm; }
  .when { text-align: right; color: #5a6b5c; font-size: 9.5pt; }

  .who { border: 1px solid #d8e2d9; border-radius: 2mm; padding: 4mm;
         margin-bottom: 6mm; }
  .who .nm { font-size: 14pt; font-weight: 800; }
  .who .doc { color: #7a8a7c; font-size: 9.5pt; margin-top: 1mm; }

  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 8.5pt; text-transform: uppercase;
             letter-spacing: .06em; color: #fff; background: #2e7d32;
             padding: 2.5mm 2mm; font-weight: 600; }
  thead th:first-child { border-radius: 1.5mm 0 0 0; }
  thead th:last-child { border-radius: 0 1.5mm 0 0; }
  tbody td { padding: 3mm 2mm; border-bottom: 1px solid #e6ece7; }
  tbody tr.alt td { background: #f6f9f6; }
  .n { text-align: right; white-space: nowrap; }

  .tot td { border-top: 2px solid #2e7d32; border-bottom: none;
            font-weight: 800; padding-top: 3.5mm; }
  .bal td { border-bottom: none; padding-top: 2.5mm; color: #3949ab;
            font-weight: 600; }
  .bal.owes td { color: #8a5a00; }

  /* What the worker is taking home, set apart from the arithmetic above it. */
  .paid { margin-top: 5mm; border: 2px solid #2e7d32; border-radius: 2mm;
          padding: 4mm; display: flex; justify-content: space-between;
          align-items: baseline; }
  .paid .k { font-size: 10pt; text-transform: uppercase; letter-spacing: .06em;
             color: #5a6b5c; }
  .paid .v { font-size: 20pt; font-weight: 800; color: #1b5e20; }

  .sign { margin-top: 24mm; display: flex; gap: 12mm; }
  .sign div { flex: 1; border-top: 1px solid #b6c3b8; padding-top: 2mm;
              font-size: 9.5pt; color: #5a6b5c; }
  .foot { margin-top: 8mm; padding-top: 2.5mm; border-top: 1px solid #e6ece7;
          font-size: 8.5pt; color: #7a8a7c; }
</style>
</head>
<body>
  <div class="head">
    <div>
      <div class="brand">${esc(r.farmLabel)}</div>
      <div class="sub">${esc(t("pay.receipt"))}</div>
    </div>
    <div class="when">${esc(formatDay(r.date, lang))}</div>
  </div>

  <div class="who">
    <div class="nm">${esc(r.workerName)}</div>
    ${r.workerDoc ? `<div class="doc">${esc(r.workerDoc)}</div>` : ""}
  </div>

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
    </tbody>
  </table>

  <div class="paid">
    <span class="k">${esc(t("pay.pay"))}</span>
    <span class="v">${esc(cents(r.paidCents, lang))}</span>
  </div>

  <div class="sign">
    <div>${esc(t("pay.signWorker"))}</div>
    <div>${esc(t("pay.signFarm"))}</div>
  </div>

  <p class="foot">${esc(t("pay.receipt"))} · ${esc(formatDay(r.date, lang))}</p>
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
  const totalCredit = rows.reduce((s, r) => s + Math.max(r.balanceCents, 0), 0);

  const body = rows
    .map(
      (r, i) => `<tr class="${i % 2 ? "alt" : ""}">
        <td class="idx">${i + 1}</td>
        <td class="who"><span class="nm">${esc(r.name)}</span>${
          r.doc ? `<span class="doc">${esc(r.doc)}</span>` : ""
        }</td>
        <td class="n">${esc(formatNumber(r.kg, lang))}</td>
        <td class="n amt">${esc(cents(r.paidCents, lang))}</td>
        <td class="n cred">${r.balanceCents ? esc(cents(r.balanceCents, lang)) : "—"}</td>
        <td class="sig"></td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<style>
  @page { margin: 12mm 10mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         font-size: 10.5pt; color: #16261a; margin: 0; }

  /* A slim rule instead of a filled banner: the same identity, without
     flooding a farm office printer with ink on every sheet. */
  .head { border-top: 3px solid #2e7d32; padding-top: 4mm; margin-bottom: 6mm;
          display: flex; justify-content: space-between; align-items: flex-start; }
  .brand { font-size: 15pt; font-weight: 800; color: #1b5e20; letter-spacing: -.01em; }
  .sub { color: #5a6b5c; font-size: 10pt; margin-top: .5mm; }
  .when { text-align: right; color: #5a6b5c; font-size: 9.5pt; line-height: 1.5; }

  /* The three numbers the office checks first, before reading any row. */
  .cards { display: flex; gap: 3mm; margin-bottom: 6mm; }
  .card { flex: 1; border: 1px solid #d8e2d9; border-radius: 2mm; padding: 3mm 3.5mm; }
  .card .k { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em;
             color: #5a6b5c; }
  .card .v { font-size: 14pt; font-weight: 800; color: #1b5e20; margin-top: 1mm; }
  .card.muted .v { color: #3949ab; }

  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 8.5pt; text-transform: uppercase;
             letter-spacing: .06em; color: #fff; background: #2e7d32;
             padding: 2.5mm 2mm; font-weight: 600; }
  thead th:first-child { border-radius: 1.5mm 0 0 0; }
  thead th:last-child { border-radius: 0 1.5mm 0 0; }
  tbody td { padding: 3mm 2mm; border-bottom: 1px solid #e6ece7; vertical-align: middle; }
  tbody tr.alt td { background: #f6f9f6; }
  .idx { width: 8mm; color: #98a89a; font-size: 9pt; }
  .who .nm { display: block; font-weight: 600; }
  .who .doc { display: block; font-size: 8.5pt; color: #7a8a7c; margin-top: .5mm; }
  .n { text-align: right; white-space: nowrap; }
  .amt { font-weight: 700; }
  .cred { color: #3949ab; }
  /* Signed on the spot, next to the amount each person is taking. */
  .sig { width: 46mm; border-bottom: 1px solid #b6c3b8; }

  tfoot td { padding: 3.5mm 2mm; border-top: 2px solid #2e7d32; font-weight: 800;
             font-size: 11pt; }
  tfoot .amt { color: #1b5e20; }

  .foot { margin-top: 7mm; padding-top: 2.5mm; border-top: 1px solid #e6ece7;
          font-size: 8.5pt; color: #7a8a7c; display: flex;
          justify-content: space-between; }
</style>
</head>
<body>
  <div class="head">
    <div>
      <div class="brand">${esc(opts.farmLabel)}</div>
      <div class="sub">${esc(opts.title)}</div>
    </div>
    <div class="when">${esc(formatDay(opts.date, lang))}</div>
  </div>

  <div class="cards">
    <div class="card">
      <div class="k">${esc(t("pay.pay"))}</div>
      <div class="v">${esc(cents(totalPaid, lang))}</div>
    </div>
    <div class="card">
      <div class="k">${esc(opts.unit)}</div>
      <div class="v">${esc(formatNumber(totalKg, lang))}</div>
    </div>
    <div class="card muted">
      <div class="k">${esc(t("pay.credit"))}</div>
      <div class="v">${esc(cents(totalCredit, lang))}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr><th></th>
          <th>${esc(t("label.workers"))}</th>
          <th class="n">${esc(opts.unit)}</th>
          <th class="n">${esc(t("pay.pay"))}</th>
          <th class="n">${esc(t("pay.credit"))}</th>
          <th>${esc(t("pay.signWorker"))}</th></tr>
    </thead>
    <tbody>
      ${body}
    </tbody>
    <tfoot>
      <tr>
        <td></td>
        <td>${esc(t("week.total"))}</td>
        <td class="n">${esc(formatNumber(totalKg, lang))}</td>
        <td class="n amt">${esc(cents(totalPaid, lang))}</td>
        <td class="n"></td>
        <td></td>
      </tr>
    </tfoot>
  </table>

  <div class="foot">
    <span>${esc(rows.length === 1 ? t("pay.people.one") : t("pay.people", { n: rows.length }))}</span>
    <span>${esc(t("pay.signFarm"))}</span>
  </div>
</body>
</html>`;
}
