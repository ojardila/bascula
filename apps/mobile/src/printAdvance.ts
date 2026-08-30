/**
 * Printing the advance voucher, in one place because it is printed from two.
 *
 * An advance is handed over from `Adjust` (the movement screen) and from
 * `PayWorker` (the §6.1 gate, when there is no signal to settle with). Both
 * used to end the same way: a snackbar, and the worker walking off with
 * nothing on paper. `docs/sincronizacion.md` §6.2 promises otherwise — «the
 * weigher hands over cash in the lote, PRINTS AN ADVANCE VOUCHER, and the
 * worker sees their balance go down» — and `simplificacion.md` §2.1 keeps «give
 * an advance, print its voucher» in the after column, unchanged. It was the one
 * line of that promise the app did not keep.
 *
 * It matters more the closer the farm gets to the cut. After it, an advance
 * voucher is the ONLY document a worker can be handed in the field, so it is
 * load-bearing rather than a nicety.
 */

import * as Print from "expo-print";

import { Config, People } from "./db";
import { advanceReceiptHtml } from "./receiptHtml";
import type { Lang } from "../../../packages/shared/src/format.ts";

/**
 * Prints the voucher for an advance that has ALREADY been written.
 *
 * Order matters and is the caller's job: the ledger row goes in first, then
 * this. A voucher printed for a movement that failed to save is a signed piece
 * of paper claiming cash changed hands against a balance that never moved.
 *
 * Resolves either way. A worker's cash does not become un-handed because the
 * print dialog was dismissed or the office printer is off, so a failure here
 * must never be reported as a failure of the advance — the caller has already
 * told them it was saved, and that is still true.
 */
export async function printAdvance(
  personId: number,
  amountCents: number,
  date: string,
  lang: Lang,
  note?: string | null,
): Promise<void> {
  try {
    const cfg = Config.get();
    const person = People.byId(personId);
    await Print.printAsync({
      html: advanceReceiptHtml(
        {
          workerName: person ? `${person.name} ${person.lastName}`.trim() : "",
          workerDoc: person?.docId,
          farmLabel: cfg?.label ?? "",
          amountCents,
          date,
          note: note ?? null,
        },
        lang,
      ),
    });
  } catch {
    /* dismissed, or no printer. The advance itself is already on the books. */
  }
}
