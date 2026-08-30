/**
 * What a screen is allowed to say about somebody's balance.
 *
 * The phone does not compute the farm's money any more — it reads a figure the
 * server derived and repeats it. Repeating a number you did not derive is only
 * honest under conditions, and they are the same three that the web console's
 * A5/A6/A7 findings were about, moved here because the number moved here:
 *
 *   1. **Never without saying when.** A balance is true as of an instant, and
 *      six days later it is a rumour. The instant travels WITH the amount, in
 *      the same breath, not in a caption somebody scrolls past.
 *   2. **Not knowing is not zero.** A phone that has never heard a balance
 *      knows nothing about it. «$0» is a claim — it says the account is
 *      settled — and it is the claim most likely to be wrong on a handset that
 *      was just handed to somebody. That is why `unknown` below has NO numeric
 *      member: there is no field to accidentally render as a total, and a
 *      screen that forgets to handle the case fails to compile rather than
 *      quietly printing zero.
 *   3. **Unsent movements make it provisional, and it says so.** Cash handed
 *      over in the lote this morning is real and the server has not heard of
 *      it. The honest figure is then the server's last word ADJUSTED by what
 *      this phone has done since — not this phone's own sum, which silently
 *      drops the jornales and the contracts the server counts and the handset
 *      cannot itemise.
 *
 * This file is deliberately React-free and SQLite-free, so the rule can be
 * tested as arithmetic instead of by rendering a screen.
 */

import type { FullBalance } from "./data/repository.ts";

/**
 * A union of states, with no numeric member for the unknown one.
 *
 * `at` is non-null on every state that carries a number. That is the type
 * saying condition 1 out loud: there is no way to obtain an amount from this
 * without also obtaining the instant it was true.
 */
export type BalanceDisplay =
  /**
   * This phone is not connected to a farm on the server, so it is not behind
   * anything — it IS the book, and its own ledger is the whole balance.
   *
   * This state is not a fallback and it is not a lesser answer. It is what
   * Báscula was before any of this: a product that runs alone on a handset for
   * a whole season, which is what the farm is running TODAY, before the
   * move. Collapsing it into `unknown` would have told a farm that has
   * never synced that it does not know its own payroll, which it does.
   */
  | { state: "local"; cents: number }
  /**
   * This phone answers to a server and has never heard a balance for this
   * person. Show «no lo sé» — see condition 2.
   */
  | { state: "unknown" }
  /**
   * The server's figure, and this phone owes the server nothing, so it is
   * still the server's figure.
   */
  | {
      state: "known";
      cents: number;
      /** ISO instant the figure was true. Never null. */
      at: string;
      /** Of `cents`, what this phone cannot break down: jornales, contratos. */
      notItemisableCents: number;
    }
  /**
   * The server's last word, adjusted by what this phone has done since and
   * not yet sent. Label it provisional and say how many movements are waiting.
   */
  | {
      state: "provisional";
      cents: number;
      at: string;
      notItemisableCents: number;
      /** Movements in the outbox. Zero is impossible in this state. */
      pending: number;
    };

/**
 * `FullBalance` → what to put on the screen.
 *
 * `pending` is the outbox depth, which the repository does not carry on the
 * balance row; the caller has it from the sync status.
 *
 * The provisional arithmetic, spelled out because it is the part that is easy
 * to get subtly wrong:
 *
 *   `notItemisableCents` is `server − derived`, both measured in the SAME pass
 *   at instant `serverAt`. So `derived = server − notItemisable`, and the
 *   server's figure brought forward by everything this phone has done since is
 *
 *       server + (itemised − derived)
 *     = server + itemised − (server − notItemisable)
 *     = itemised + notItemisable
 *
 *   which is what is returned. Note what it is NOT: `itemisedCents` on its
 *   own. That is the phone's own ledger sum, and for a worker who also did
 *   jornales it is half a balance — the exact lie `engine.ts` reports as a
 *   calculation bug and that a single balance exists to end.
 */
export function balanceDisplay(
  full: FullBalance,
  pending: number,
  registered: boolean,
): BalanceDisplay {
  // Before any of the three conditions: is there a server at all?
  //
  // `registered` is `SyncStatus.registered` — whether this handset is attached
  // to a farm. If it is not, nothing above it holds a better figure than the
  // one below, and the phone's own ledger is not "half a balance", it is THE
  // balance. Getting this wrong the other way is the expensive mistake: a farm
  // that has not migrated yet would open the app and be told «no lo sé» about
  // a season it has been paying out of this handset for months.
  if (!registered) return { state: "local", cents: full.itemisedCents };

  // Condition 2. Attached to a farm, and it has never said what this person's
  // balance is. That is not zero, and it stays not-zero no matter what this
  // phone's own ledger happens to sum to.
  if (full.serverCents === null || full.serverAt === null) return { state: "unknown" };

  if (full.provisional)
    return {
      state: "provisional",
      cents: full.itemisedCents + full.notItemisableCents,
      at: full.serverAt,
      notItemisableCents: full.notItemisableCents,
      // A phone can be provisional because of somebody ELSE's unsent weighing,
      // so the count is the outbox's and the floor is one: the state cannot be
      // reached with nothing waiting, and a «faltan 0 por enviar» would read as
      // a bug to the person holding the phone.
      pending: Math.max(1, pending),
    };

  return {
    state: "known",
    cents: full.serverCents,
    at: full.serverAt,
    notItemisableCents: full.notItemisableCents,
  };
}

/**
 * The one line that carries the amount and its age together.
 *
 * Returns the KEY and the variables rather than a formatted string, because
 * the three dictionaries live in `strings.ts` and this file has no `t`. The
 * point is that the caller cannot render the amount without rendering this.
 */
export function balanceAgeKey(d: BalanceDisplay): string | null {
  switch (d.state) {
    // Nothing to date: the figure was derived here, now, from this phone's own
    // ledger. There is no lag to disclose.
    case "local":
      return null;
    case "unknown":
      return null;
    case "known":
      return "pay.asOf";
    case "provisional":
      return "pay.asOfProvisional";
  }
}
