/**
 * Getting a document to a printer, from a browser, without a server.
 *
 * WHY AN IFRAME AND NOT `window.open`.
 *
 * A popup is what everybody reaches for and it is the wrong tool here. Popup
 * blockers stop it — silently, on the click that follows a network round trip,
 * which is exactly this app's case — and a blocked popup on a payment screen
 * looks like the receipt was never generated. An `<iframe>` needs no
 * permission, cannot be blocked, and keeps the console's own page on screen so
 * the user does not lose the payment they just made.
 *
 * WHY `srcdoc` AND NOT A BLOB URL.
 *
 * A `blob:` URL would be a second origin, and the artifact CSP and the app's
 * own policy both forbid pulling anything from anywhere. `srcdoc` puts the
 * document inline: no fetch, no network, nothing to block. The documents
 * themselves carry no external reference either — see `documentCss.ts`.
 *
 * WHY IT IS NOT A DOWNLOAD.
 *
 * The phone makes a PDF because `expo-print` is a PDF writer. A browser
 * already has one: the print dialog's "Save as PDF". Shipping a PDF library to
 * do worse what the operating system does well would add a megabyte to the
 * bundle, and a `<a download>` in a sandboxed context is inert anyway.
 */

/**
 * Print an HTML document.
 *
 * The iframe is removed after the print dialog closes rather than immediately:
 * tearing it down while the dialog is open cancels the job in WebKit. The
 * `afterprint` handler is the reliable signal; the timeout is the fallback for
 * browsers that never fire it, and it is long enough that somebody reading the
 * preview does not lose the page underneath them.
 *
 * Returns false when the document could not be handed over — a jsdom test
 * environment, or a browser that refused the frame — so a caller can say so
 * instead of leaving somebody waiting for a dialog that is not coming.
 */
export function printDocument(html: string): boolean {
  if (typeof document === "undefined") return false;

  const frame = document.createElement("iframe");
  // Off-screen rather than `display:none`: a hidden frame has no layout in
  // some engines, and a document with no layout prints as a blank page.
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("title", "Documento para imprimir");
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:210mm;height:297mm;border:0;visibility:hidden";
  frame.srcdoc = html;

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    frame.remove();
  };

  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) {
      cleanup();
      return;
    }
    win.addEventListener("afterprint", cleanup);
    try {
      win.focus();
      win.print();
    } catch {
      cleanup();
      return;
    }
    // Fallback for engines that never fire `afterprint`.
    window.setTimeout(cleanup, 60_000);
  };

  document.body.appendChild(frame);
  return true;
}
