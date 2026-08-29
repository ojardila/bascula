/**
 * THE PAPER. RSP-008: "El sistema genera el recibo de pago."
 *
 * The phone has printed a receipt and a payroll sheet since Sprint 1 and the
 * console printed nothing, which meant the two halves of the same product
 * handed a worker different things — or nothing at all, on the half that has
 * the keyboard and the printer. These are the same two documents, built from
 * the web's view models, sharing the phone's design through `documentCss.ts`.
 *
 * Three of them, because the console needs one the phone does not:
 *
 *   paymentReceiptHtml   what a worker takes away after being paid. RSP-008.
 *   settlementHtml       the liquidación itself, line by line, at the prices
 *                        it froze. This is the document that settles an
 *                        argument three weeks later, and it is the one the
 *                        phone has no screen for.
 *   payrollHtml          one line per worker: what the office files after a
 *                        payment run.
 *
 * THE TWO HARD RULES, ON PAPER.
 *
 *   NO ZERO THAT MEANS "I DO NOT KNOW". Every figure printed here is one the
 *   server computed. Where a number is genuinely absent — a balance nobody
 *   asked for, a worker with no document number — the line is omitted rather
 *   than printed as $0 or as a blank in a money column. A "$0" on a receipt is
 *   a claim that nothing is owed.
 *
 *   ESTIMATED IS NOT DEFINITIVE. A payable still priced by the week's price is
 *   not decided yet (`PayableLine.rateSource === "weekly_price"`). On screen
 *   that is a chip; on paper it is an amber block, the word PROVISIONAL in the
 *   row, and a footnote — because a colour alone does not survive the
 *   black-and-white printer in a farm office. `docs/sincronizacion.md` asks for
 *   exactly this: a provisional document "imprime un recibo que dice
 *   «provisional» en letra grande".
 */
import { documentShell, esc } from "./documentCss";
import { formatDate, formatDateRange, formatWeekRange } from "../../lib/dates";
import { formatMoney, formatQuantity } from "../../lib/money";
import type { PayableLine, Payment, Settlement, Worker } from "../../api/types";

const money = (c: number) => formatMoney(c);

interface Header {
  farmName: string;
  /** The document's own date, already a business day in the farm's zone. */
  date: string;
}

function headerHtml(h: Header, subtitle: string): string {
  return `<div class="head">
    <div>
      <div class="brand">${esc(h.farmName)}</div>
      <div class="sub">${esc(subtitle)}</div>
    </div>
    <div class="when">${esc(formatDate(h.date))}</div>
  </div>`;
}

function whoHtml(worker: Pick<Worker, "name" | "lastName" | "documentNumber">): string {
  const name = `${worker.name} ${worker.lastName}`.trim();
  // The document number is omitted when there is none. A "Documento: —" line
  // on a receipt reads as a missing field somebody should have filled in.
  const doc = worker.documentNumber
    ? `<div class="doc">Documento ${esc(worker.documentNumber)}</div>`
    : "";
  return `<div class="who"><div class="nm">${esc(name)}</div>${doc}</div>`;
}

/** True when any line's price is still the week's and could still move. */
export const hasProvisionalLines = (lines: PayableLine[]): boolean =>
  lines.some((l) => l.rateSource === "weekly_price");

const PROVISIONAL_NOTE =
  `<div class="prov"><strong>PROVISIONAL.</strong> Las líneas marcadas se ` +
  `pagan al precio de la semana, que todavía no está fijado. El valor ` +
  `definitivo se conoce al cerrar la semana, y este documento no lo reemplaza.</div>`;

function lineRows(lines: PayableLine[]): string {
  return lines
    .map((l, i) => {
      const provisional = l.rateSource === "weekly_price";
      const qty = l.unitLabel
        ? `${formatQuantity(l.quantity)} ${esc(l.unitLabel)}`
        : "contrato";
      return `<tr class="${i % 2 ? "alt" : ""}">
        <td>${esc(formatDateRange(l.dateFrom, l.dateTo))}</td>
        <td>${esc(l.activityName)}${provisional ? '<span class="tag">provisional</span>' : ""}</td>
        <td class="n">${qty}</td>
        <td class="n">${esc(money(l.rateCents))}</td>
        <td class="n amt">${esc(money(l.amountCents))}</td>
      </tr>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ */
/* RSP-008 — el recibo de pago                                         */
/* ------------------------------------------------------------------ */

export interface ReceiptInput {
  farmName: string;
  worker: Pick<Worker, "name" | "lastName" | "documentNumber">;
  payment: Payment;
  /** The work this payment settled. Empty when it paid an existing balance. */
  lines: PayableLine[];
}

/**
 * The receipt, headed by what the worker is taking home.
 *
 * `balanceAfterCents` is printed with its meaning spelled out and not as a
 * bare signed number: positive is the farm still owing, negative is an advance
 * the worker carries. Nobody reading a receipt should have to know the sign
 * convention of a ledger. When it is exactly zero the line says "queda a paz y
 * salvo" — which is a fact — rather than "$0", which reads like a figure
 * nobody computed.
 */
export function paymentReceiptHtml(r: ReceiptInput): string {
  const { payment } = r;
  const rows = lineRows(r.lines);
  const gross = r.lines.reduce((a, l) => a + l.amountCents, 0);

  const table = r.lines.length
    ? `<table>
        <thead>
          <tr><th>Fecha</th><th>Actividad</th><th class="n">Cantidad</th>
              <th class="n">Precio</th><th class="n">Valor</th></tr>
        </thead>
        <tbody>
          ${rows}
          <tr class="tot">
            <td colspan="4">Total liquidado</td>
            <td class="n">${esc(money(gross))}</td>
          </tr>
        </tbody>
      </table>`
    : `<p class="sub">Este pago se abonó al saldo pendiente. No liquidó labores nuevas.</p>`;

  const after = payment.balanceAfterCents;
  const balanceLine =
    after === 0
      ? `<div class="sub">Después de este pago queda a paz y salvo.</div>`
      : after > 0
        ? `<div class="sub">Queda pendiente a favor del empleado: <strong>${esc(
            money(after),
          )}</strong>.</div>`
        : `<div class="sub">Queda un anticipo a favor de la finca: <strong>${esc(
            money(-after),
          )}</strong>.</div>`;

  return documentShell(
    `Recibo de pago · ${r.worker.name} ${r.worker.lastName}`,
    `${headerHtml({ farmName: r.farmName, date: payment.date }, "Recibo de pago")}
     ${whoHtml(r.worker)}
     ${table}
     ${hasProvisionalLines(r.lines) ? PROVISIONAL_NOTE : ""}
     <div class="paid">
       <span class="k">Pagado</span>
       <span class="v">${esc(money(payment.amountCents))}</span>
     </div>
     <div style="margin-top:3mm">${balanceLine}</div>
     <div class="sign">
       <div>Firma del empleado</div>
       <div>Firma por la finca</div>
     </div>
     <p class="foot"><span>Recibo ${esc(payment.receiptNumber)}</span>
       <span>${esc(formatDate(payment.date))}</span></p>`,
  );
}

/* ------------------------------------------------------------------ */
/* La liquidación                                                      */
/* ------------------------------------------------------------------ */

export interface SettlementDocInput {
  farmName: string;
  settlement: Settlement;
  /** Today, in the farm's timezone. Printed as "impreso el". */
  printedOn: string;
}

/**
 * The settlement as a document: which weeks, which lines, at what price.
 *
 * A VOID SETTLEMENT STILL PRINTS, and prints saying so in a red block at the
 * top. Somebody filed the original; reprinting it as though it stood would be
 * the worse failure, and refusing to print it leaves them holding a document
 * they cannot check against anything.
 */
export function settlementHtml(input: SettlementDocInput): string {
  const s = input.settlement;
  const rows = lineRows(s.lines);
  const weighed = s.lines.reduce((a, l) => a + (l.unitLabel ? l.quantity : 0), 0);
  const unit = s.lines.find((l) => l.unitLabel)?.unitLabel ?? null;

  const voidBlock =
    s.status === "void"
      ? `<div class="void">
           <div class="t">Liquidación anulada</div>
           <div>Anulada el ${esc(formatDate((s.voidedAt ?? "").slice(0, 10)))}. Las labores
           volvieron a quedar pendientes y el devengo se canceló con un reverso.
           Este documento se conserva para el archivo; no es un comprobante de pago.</div>
         </div>`
      : "";

  return documentShell(
    `Liquidación · ${s.workerName}`,
    `${headerHtml({ farmName: input.farmName, date: input.printedOn }, "Liquidación")}
     ${voidBlock}
     <div class="who"><div class="nm">${esc(s.workerName)}</div>
       <div class="doc">Periodo ${esc(formatWeekRange(s.periodStart))} — ${esc(
         formatDate(s.periodEnd),
       )}</div></div>
     <div class="meta">
       <div class="card"><div class="k">Bruto liquidado</div>
         <div class="v">${esc(money(s.grossCents))}</div></div>
       <div class="card"><div class="k">Líneas</div>
         <div class="v">${s.lines.length}</div></div>
       ${
         unit
           ? `<div class="card muted"><div class="k">${esc(unit)}</div>
                <div class="v">${esc(formatQuantity(weighed))}</div></div>`
           : ""
       }
     </div>
     <table>
       <thead>
         <tr><th>Fecha</th><th>Actividad</th><th class="n">Cantidad</th>
             <th class="n">Precio</th><th class="n">Valor</th></tr>
       </thead>
       <tbody>
         ${rows}
         <tr class="tot">
           <td colspan="4">Bruto</td>
           <td class="n">${esc(money(s.grossCents))}</td>
         </tr>
       </tbody>
     </table>
     ${hasProvisionalLines(s.lines) ? PROVISIONAL_NOTE : ""}
     ${s.note ? `<p class="sub" style="margin-top:4mm">${esc(s.note)}</p>` : ""}
     <div class="sign">
       <div>Firma del empleado</div>
       <div>Firma por la finca</div>
     </div>
     <p class="foot"><span>Liquidación ${esc(s.id)}</span>
       <span>Impreso el ${esc(formatDate(input.printedOn))}</span></p>`,
  );
}

/* ------------------------------------------------------------------ */
/* La planilla de nómina                                               */
/* ------------------------------------------------------------------ */

export interface PayrollRow {
  name: string;
  documentNumber?: string | null;
  /** Weighed quantity, when there is one to show. Null is printed as "—". */
  quantity: number | null;
  grossCents: number;
  /** Positive: the farm still owes. Negative: an advance the worker carries. */
  balanceCents: number;
  status: "open" | "void";
}

export interface PayrollInput {
  farmName: string;
  title: string;
  date: string;
  unit: string | null;
  rows: PayrollRow[];
}

/**
 * One line per worker, with a signature column NEXT TO each amount rather than
 * one signature at the foot — the phone's note, and it is right: this is the
 * sheet somebody signs on the spot, standing up, holding cash.
 *
 * Void settlements are listed and struck through instead of being filtered
 * out. A payroll sheet that silently omits a cancelled run cannot be
 * reconciled against the ledger, which lists the reversal.
 */
export function payrollHtml(input: PayrollInput): string {
  const live = input.rows.filter((r) => r.status !== "void");
  const totalGross = live.reduce((a, r) => a + r.grossCents, 0);
  const totalQty = live.reduce((a, r) => a + (r.quantity ?? 0), 0);
  const anyQty = live.some((r) => r.quantity !== null);

  const body = input.rows
    .map((r, i) => {
      const isVoid = r.status === "void";
      const strike = isVoid ? "text-decoration:line-through;color:#8c1d18" : "";
      return `<tr class="${i % 2 ? "alt" : ""}" style="${strike}">
        <td class="idx">${i + 1}</td>
        <td class="who-cell"><span class="nm">${esc(r.name)}</span>${
          r.documentNumber ? `<span class="doc">${esc(r.documentNumber)}</span>` : ""
        }</td>
        <td class="n">${r.quantity === null ? "—" : esc(formatQuantity(r.quantity))}</td>
        <td class="n amt">${esc(money(r.grossCents))}</td>
        <td class="n cred">${r.balanceCents ? esc(money(r.balanceCents)) : "—"}</td>
        <td class="sig">${isVoid ? "anulada" : ""}</td>
      </tr>`;
    })
    .join("");

  return documentShell(
    input.title,
    `${headerHtml({ farmName: input.farmName, date: input.date }, input.title)}
     <div class="meta">
       <div class="card"><div class="k">Bruto liquidado</div>
         <div class="v">${esc(money(totalGross))}</div></div>
       ${
         anyQty && input.unit
           ? `<div class="card"><div class="k">${esc(input.unit)}</div>
                <div class="v">${esc(formatQuantity(totalQty))}</div></div>`
           : ""
       }
       <div class="card muted"><div class="k">Liquidaciones</div>
         <div class="v">${live.length}</div></div>
     </div>
     <table>
       <thead>
         <tr><th></th><th>Empleado</th>
             <th class="n">${esc(input.unit ?? "Cantidad")}</th>
             <th class="n">Bruto</th><th class="n">Saldo</th>
             <th>Firma</th></tr>
       </thead>
       <tbody>${body}</tbody>
       <tfoot>
         <tr>
           <td></td><td>Total</td>
           <td class="n">${anyQty ? esc(formatQuantity(totalQty)) : "—"}</td>
           <td class="n amt">${esc(money(totalGross))}</td>
           <td class="n"></td><td></td>
         </tr>
       </tfoot>
     </table>
     <div class="foot">
       <span>${live.length === 1 ? "1 liquidación" : `${live.length} liquidaciones`}${
         input.rows.length > live.length
           ? ` · ${input.rows.length - live.length} anulada${
               input.rows.length - live.length === 1 ? "" : "s"
             }`
           : ""
       }</span>
       <span>Firma por la finca</span>
     </div>`,
  );
}
