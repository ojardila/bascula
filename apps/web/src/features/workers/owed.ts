/**
 * ── ONE SINGLE ANSWER TO "HOW MUCH DO I OWE THEM?" ───────────────────────
 *
 * Three screens gave three figures for the same person on the same day:
 *
 *   the profile        $184.500 in the largest type — the ledger only; what
 *                      was still to be settled went in small print below
 *   the list           "—" on every row and "Total a favor: $0", because
 *                      `/v1/workers` has never sent a `balanceCents`
 *   the dashboard      $334.500 — the sum of the ledgers, without the
 *                      outstanding work
 *   the pay screen     $338.100 — the only correct one, and visible only to
 *                      somebody who had already decided to pay
 *
 * To a person who does not write software that is not a bug: it is the
 * program lying. And after that they believe no figure at all. So the answer
 * is worked out in one place —this one— and every screen shows it the same
 * way, with the breakdown small underneath.
 *
 * ── WHAT "WHAT THEY ARE OWED" MEANS ──────────────────────────────────────
 *
 *   ledger balance     accruals minus payments. What is already written down.
 *   + outstanding      work done that has not been settled yet. It is not an
 *                      accrual yet, but the farm owes it just the same: the
 *                      grower asking "how much do I owe Rosa" is asking about
 *                      the cash they are about to hand over, not about the
 *                      paperwork status of that cash.
 *
 * And that sum is exactly what the pay screen writes:
 * `toPayCents = balance.balanceCents + selectedCents`, which is also the
 * `totalCents` that `/v1/workers/{id}/payables` sends. There is no fourth
 * definition here; there is one, and it has a name.
 *
 * ── NO ZERO THAT MEANS "I DON'T KNOW" ────────────────────────────────────
 *
 * This is the rule that already governs `harvest/totals.ts`, which is why
 * this file looks so much like it: `OwedState` has no numeric member in the
 * `unknown` case, so a screen cannot carelessly print a zero that means "I
 * couldn't ask". A zero is an assertion —"they are square with everybody"—
 * and it is precisely the one that must not be made by accident.
 *
 * The `partial` case deserves its own explanation: outstanding work is never
 * negative, so when the ledger was read and the outstanding work was not, the
 * balance is a valid FLOOR. Saying "at least $184.500" tells you more than a
 * dash does, and it does not lie.
 */
import type { Uuid } from "../../api/types";

/** What the farm knows today about one person's account. */
export interface Owed {
  /**
   * The ledger: accruals minus payments, as the server derives it. Positive
   * is the farm owing; negative is an advance the person is carrying.
   * `null` means "could not be read", never zero.
   */
  balanceCents: number | null;
  /**
   * Work done that has not been settled yet. Always >= 0. `null` means "could
   * not be read".
   */
  pendingCents: number | null;
  /**
   * Part of the outstanding work is paid at the week's price, which can still
   * move. The figure is shown all the same —hiding it would be worse— but
   * flagged.
   */
  pendingIsEstimate: boolean;
}

export const NOTHING_KNOWN: Owed = {
  balanceCents: null,
  pendingCents: null,
  pendingIsEstimate: false,
};

/**
 * The figure, with the provenance the farm deserves.
 *
 * Deliberately without a number in `unknown`: there is nothing to render by
 * mistake.
 */
export type OwedState =
  | { kind: "unknown"; reason: string }
  | { kind: "partial"; cents: number; reason: string; isEstimate: boolean }
  | { kind: "known"; cents: number; isEstimate: boolean };

export function owedState(o: Owed): OwedState {
  if (o.balanceCents === null) {
    return {
      kind: "unknown",
      reason:
        o.pendingCents === null
          ? "No se pudo consultar ni el saldo ni lo pendiente de liquidar. No es cero."
          : "No se pudo consultar el saldo del libro, así que no se puede decir el total. No es cero.",
    };
  }
  if (o.pendingCents === null) {
    return {
      kind: "partial",
      cents: o.balanceCents,
      reason:
        "No se pudo consultar lo pendiente de liquidar, y eso sólo suma. " +
        "La cifra es un mínimo, no el total.",
      isEstimate: false,
    };
  }
  return {
    kind: "known",
    cents: o.balanceCents + o.pendingCents,
    isEstimate: o.pendingIsEstimate && o.pendingCents !== 0,
  };
}

/** The total when it can be asserted, `null` when it cannot. For summing rows. */
export function totalOwedCents(o: Owed): number | null {
  const s = owedState(o);
  return s.kind === "known" ? s.cents : null;
}

/**
 * Adding people up.
 *
 * Propagates the holes the way `foldTotals` does: if one person's ledger
 * could not be read, the farm's total is unknown for that part, and saying so
 * is the only honest option. `unreadable` counts how many it happened to, so
 * the screen can write "of N people" instead of an asterisk.
 */
export interface OwedSum {
  /** What could be asserted in full. Null if anybody was missing a half. */
  cents: number | null;
  /**
   * The FLOOR: the same, also counting those whose ledger alone could be
   * read. It lets us say "at least $X" instead of a dash when what failed was
   * the outstanding work, which can only add. Null when absolutely nothing
   * could be read.
   */
  floorCents: number | null;
  /** How many people went into `cents` whole. */
  counted: number;
  /** How many were left out because their account could not be read whole. */
  unreadable: number;
  isEstimate: boolean;
}

export function sumOwed(rows: Owed[]): OwedSum {
  let cents: number | null = null;
  let floorCents: number | null = null;
  let counted = 0;
  let unreadable = 0;
  let isEstimate = false;
  for (const r of rows) {
    const s = owedState(r);
    if (s.kind === "unknown") {
      unreadable += 1;
      continue;
    }
    if (s.kind === "partial") {
      unreadable += 1;
      floorCents = (floorCents ?? 0) + s.cents;
      continue;
    }
    cents = (cents ?? 0) + s.cents;
    floorCents = (floorCents ?? 0) + s.cents;
    counted += 1;
    if (s.isEstimate) isEstimate = true;
  }
  // A single half-read account makes the farm's total uncertain, even if all
  // the others came through: the floor is still useful and the total no
  // longer is.
  if (unreadable > 0) cents = null;
  return { cents, floorCents, counted, unreadable, isEstimate };
}

/**
 * Only what the farm owes outwards.
 *
 * An advance leaves somebody with a negative balance, and subtracting it from
 * what the farm owes everybody else would give a figure that is not the cash
 * to be counted out on Saturday. So negatives go into the farm's total as
 * zero — and are NOT hidden: that person's own row still says what it says.
 */
export function sumOwedToFarmWorkers(rows: Owed[]): OwedSum {
  return sumOwed(
    rows.map((r) => {
      const s = owedState(r);
      if (s.kind !== "known" || s.cents >= 0) return r;
      return { balanceCents: 0, pendingCents: 0, pendingIsEstimate: false };
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Building the farm's map out of reads we already know how to do     */
/* ------------------------------------------------------------------ */

/** The least we need from a work item to tell whether it is outstanding. */
export interface PendingRecordLike {
  workerId: Uuid;
  settled: boolean;
  /** Null when the session may not read money. See `WorkRecord`. */
  estimatedAmountCents: number | null;
  amountIsEstimate: boolean | null;
}

/** The least we need from a balance. */
export interface BalanceLike {
  workerId: Uuid;
  balanceCents: number;
}

/**
 * Everybody's account, out of two reads the list screens could already do:
 * `/v1/balances` (one) and `/v1/work-records` (one).
 *
 * This is NOT a fan-out of `/v1/workers/{id}/payables`, one per head. That
 * fan-out is the right thing in payroll —where the figure is about to be
 * SIGNED and has to come out of the same query the settlement runs— and it
 * would be thirty requests every time somebody opens the employee list. Here
 * the figure is read, not signed, and `estimatedAmountCents` is the same
 * number `payables` adds up: the server computes it with the same rule on
 * both routes.
 *
 * `balances` or `records` being `null` means that read failed, and then the
 * matching half of every account stays `null` — not zero.
 */
export function owedByWorker(
  balances: BalanceLike[] | null,
  records: PendingRecordLike[] | null,
): Map<Uuid, Owed> {
  const out = new Map<Uuid, Owed>();

  const get = (id: Uuid): Owed => {
    let o = out.get(id);
    if (!o) {
      o = {
        balanceCents: balances ? 0 : null,
        pendingCents: records ? 0 : null,
        pendingIsEstimate: false,
      };
      out.set(id, o);
    }
    return o;
  };

  for (const b of balances ?? []) {
    get(b.workerId).balanceCents = b.balanceCents;
  }
  for (const r of records ?? []) {
    if (r.settled) continue;
    const o = get(r.workerId);
    if (r.estimatedAmountCents === null) {
      // Withheld, not zero: this session may not read what the record is
      // worth. An account with one unreadable row is an account we cannot
      // total, and `pendingCents: null` is the shape this module already uses
      // for "that read did not happen" — `owedState` renders it as unknown
      // instead of a figure. Adding 0 would understate what the farm owes,
      // which is the direction that costs somebody their pay.
      o.pendingCents = null;
      continue;
    }
    o.pendingCents = (o.pendingCents ?? 0) + r.estimatedAmountCents;
    if (r.amountIsEstimate) o.pendingIsEstimate = true;
  }
  return out;
}

/** The account of a person who shows up in neither of the two reads. */
export function owedOf(
  map: Map<Uuid, Owed>,
  workerId: Uuid,
  balancesRead: boolean,
  recordsRead: boolean,
): Owed {
  return (
    map.get(workerId) ?? {
      // No row in `/v1/balances` and a read that went through means that
      // person's ledger really is at zero: not one entry in it. Same with the
      // work items. This is the only zero this file asserts.
      balanceCents: balancesRead ? 0 : null,
      pendingCents: recordsRead ? 0 : null,
      pendingIsEstimate: false,
    }
  );
}
