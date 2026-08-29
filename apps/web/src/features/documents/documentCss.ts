/**
 * THE PRINTED DOCUMENTS' LOOK, TAKEN FROM THE PHONE.
 *
 * `apps/mobile/src/receiptHtml.ts` already solved this: the brand green
 * (#2e7d32 header, #1b5e20 for figures), millimetre page margins, the slim
 * rule instead of a filled banner "so a farm office printer is not flooded
 * with ink on every sheet", the zebra rows, the signature lines. That work is
 * reused rather than redone, and this file is where it lives on the web.
 *
 * WHY THIS IS A TRANSCRIPTION AND NOT AN IMPORT.
 *
 * The phone's module cannot be imported here. It pulls in `./strings.ts` —
 * the mobile app's whole i18n layer, which the console does not have and does
 * not want — and `packages/shared/src/format.ts`, whose `formatMoney` takes
 * pesos where every figure in this app is cents and goes through `lib/money`.
 * Importing across `apps/mobile` -> `apps/web` would also make one app's build
 * depend on the other's, which nothing else in this repository does.
 *
 * So the CSS — the part that IS the design — is copied verbatim and the
 * markup around it is written against the web's own view models. When the
 * brand changes, both files change; that is the cost, and it is written down
 * here rather than discovered.
 *
 * TWO CONSTRAINTS THAT ARE NOT NEGOTIABLE.
 *
 *   NO EXTERNAL HOSTS. No CDN, no webfont, no remote image. The publishing
 *   policy forbids it, printing must work on a farm office machine with no
 *   internet, and a stylesheet that fails to load turns a receipt somebody is
 *   about to sign into unstyled text. Hence the system font stack, which is
 *   the phone's stack unchanged.
 *
 *   EVERY VALUE IS ESCAPED. Names, notes and activity labels are user input,
 *   and this file builds HTML with template strings. `esc` is not optional
 *   anywhere a value is interpolated.
 */

/** Escapes text going into the document, since names come from user input. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Copied from `apps/mobile/src/receiptHtml.ts`, with three additions the phone
 * has no use for: `.prov` for a provisional figure, `.void` for a cancelled
 * document, and `.meta` for the two-column header block a settlement needs.
 */
export const DOCUMENT_CSS = `
  @page { margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         font-size: 11pt; color: #16261a; margin: 0; }

  .head { border-top: 3px solid #2e7d32; padding-top: 4mm; margin-bottom: 6mm;
          display: flex; justify-content: space-between; align-items: flex-start; }
  .brand { font-size: 15pt; font-weight: 800; color: #1b5e20; letter-spacing: -.01em; }
  .sub { color: #5a6b5c; font-size: 10pt; margin-top: .5mm; }
  .when { text-align: right; color: #5a6b5c; font-size: 9.5pt; line-height: 1.5; }

  .who { border: 1px solid #d8e2d9; border-radius: 2mm; padding: 4mm;
         margin-bottom: 6mm; }
  .who .nm { font-size: 14pt; font-weight: 800; }
  .who .doc { color: #7a8a7c; font-size: 9.5pt; margin-top: 1mm; }

  .meta { display: flex; gap: 3mm; margin-bottom: 6mm; }
  .meta .card { flex: 1; border: 1px solid #d8e2d9; border-radius: 2mm;
                padding: 3mm 3.5mm; }
  .meta .k { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em;
             color: #5a6b5c; }
  .meta .v { font-size: 13pt; font-weight: 800; color: #1b5e20; margin-top: 1mm; }
  .meta .card.muted .v { color: #3949ab; }

  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 8.5pt; text-transform: uppercase;
             letter-spacing: .06em; color: #fff; background: #2e7d32;
             padding: 2.5mm 2mm; font-weight: 600; }
  thead th:first-child { border-radius: 1.5mm 0 0 0; }
  thead th:last-child { border-radius: 0 1.5mm 0 0; }
  tbody td { padding: 3mm 2mm; border-bottom: 1px solid #e6ece7; vertical-align: middle; }
  tbody tr.alt td { background: #f6f9f6; }
  .idx { width: 8mm; color: #98a89a; font-size: 9pt; }
  .who-cell .nm { display: block; font-weight: 600; }
  .who-cell .doc { display: block; font-size: 8.5pt; color: #7a8a7c; margin-top: .5mm; }
  .n { text-align: right; white-space: nowrap; }
  .amt { font-weight: 700; }
  .cred { color: #3949ab; }
  .sig { width: 46mm; border-bottom: 1px solid #b6c3b8; }

  .tot td { border-top: 2px solid #2e7d32; border-bottom: none;
            font-weight: 800; padding-top: 3.5mm; }
  .bal td { border-bottom: none; padding-top: 2.5mm; color: #3949ab;
            font-weight: 600; }
  .bal.owes td { color: #8a5a00; }

  tfoot td { padding: 3.5mm 2mm; border-top: 2px solid #2e7d32; font-weight: 800;
             font-size: 11pt; }
  tfoot .amt { color: #1b5e20; }

  /* What the worker is taking home, set apart from the arithmetic above it. */
  .paid { margin-top: 5mm; border: 2px solid #2e7d32; border-radius: 2mm;
          padding: 4mm; display: flex; justify-content: space-between;
          align-items: baseline; }
  .paid .k { font-size: 10pt; text-transform: uppercase; letter-spacing: .06em;
             color: #5a6b5c; }
  .paid .v { font-size: 20pt; font-weight: 800; color: #1b5e20; }

  /* A figure that is not decided yet must not print like one that is. Amber,
     named in words, and repeated in the footnote — a colour alone does not
     survive a black-and-white office printer. */
  .prov { border: 1.5px solid #8a5a00; background: #fff8e6; border-radius: 2mm;
          padding: 3mm 3.5mm; margin-top: 4mm; color: #6b4600; font-size: 9.5pt; }
  .prov strong { color: #6b4600; }
  td .tag { display: inline-block; margin-left: 2mm; font-size: 8pt;
            text-transform: uppercase; letter-spacing: .05em; color: #8a5a00;
            border: 1px solid #d9c48a; border-radius: 1mm; padding: 0 1.2mm; }

  /* A cancelled document still prints, because somebody filed the original. */
  .void { border: 2px solid #b3261e; border-radius: 2mm; padding: 3mm 3.5mm;
          margin-bottom: 6mm; color: #8c1d18; }
  .void .t { font-size: 13pt; font-weight: 800; letter-spacing: .04em;
             text-transform: uppercase; }

  .sign { margin-top: 24mm; display: flex; gap: 12mm; }
  .sign div { flex: 1; border-top: 1px solid #b6c3b8; padding-top: 2mm;
              font-size: 9.5pt; color: #5a6b5c; }
  .foot { margin-top: 8mm; padding-top: 2.5mm; border-top: 1px solid #e6ece7;
          font-size: 8.5pt; color: #7a8a7c; display: flex;
          justify-content: space-between; }
`;

/** Wraps a body in the page shell. Nothing here reaches the network. */
export function documentShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>${DOCUMENT_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}
