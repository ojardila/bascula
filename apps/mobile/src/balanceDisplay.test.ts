/**
 * The three conditions for showing a balance the phone did not derive.
 *
 * `simplificacion.md` §1.3 sets them and calls them non-negotiable, because
 * they are the web console's A5/A6/A7 findings moved onto the handset: a
 * number shown without the means to check it. The point of testing the rule as
 * arithmetic, away from any screen, is that it can be pinned exactly — a
 * render test would only ever assert that some text appeared somewhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { balanceDisplay } from "./balanceDisplay.ts";
import type { FullBalance } from "./data/repository.ts";

const AT = "2026-08-23T12:00:00.000Z";

const full = (over: Partial<FullBalance> = {}): FullBalance => ({
  itemisedCents: 0,
  serverCents: null,
  serverAt: null,
  balanceCents: 0,
  provisional: false,
  notItemisableCents: 0,
  ...over,
});

// ---- Condition 2: not knowing is not zero -------------------------------

test("a phone that never heard a balance says «no lo sé», not «$0»", () => {
  const d = balanceDisplay(full(), 0, true);
  assert.equal(d.state, "unknown");
  // The property that makes the mistake impossible rather than unlikely:
  // there is no number on the object to render by accident.
  assert.ok(!("cents" in d));
  assert.ok(!("at" in d));
});

test("a phone that never heard one stays unknown even with a ledger of its own", () => {
  // The trap. This handset has weighed and paid all season and its own sum is
  // 340.000 — but that sum counts only the weighings, and the question on the
  // screen is what the FARM owes. Falling back to the derived figure here is
  // how «medio saldo» gets shown as if it were the whole one.
  const d = balanceDisplay(full({ itemisedCents: 340_000_00 }), 0, true);
  assert.equal(d.state, "unknown");
});

test("a balance of exactly zero is known, and reads differently from unknown", () => {
  const d = balanceDisplay(full({ serverCents: 0, serverAt: AT }), 0, true);
  assert.equal(d.state, "known");
  assert.ok(d.state === "known" && d.cents === 0);
});

// ---- Condition 1: never without saying when -----------------------------

test("every state that carries a number also carries its instant", () => {
  const known = balanceDisplay(full({ serverCents: 340_000_00, serverAt: AT }), 0, true);
  assert.ok(known.state === "known" && known.at === AT);

  const prov = balanceDisplay(
    full({ serverCents: 340_000_00, serverAt: AT, provisional: true }),
    3,
    true,
  );
  assert.ok(prov.state === "provisional" && prov.at === AT);
});

// ---- Condition 3: unsent movements make it provisional ------------------

test("with movements unsent, the figure is the server's brought forward", () => {
  // The server said 500.000 at `AT`, of which 200.000 were jornales this
  // phone cannot itemise — so its own sum at that moment was 300.000. Since
  // then this phone has handed over an advance of 50.000, so its own sum is
  // 250.000. The honest figure is 450.000, NOT 250.000.
  const d = balanceDisplay(
    full({
      serverCents: 500_000_00,
      serverAt: AT,
      notItemisableCents: 200_000_00,
      itemisedCents: 250_000_00,
      provisional: true,
    }),
    1,
    true,
  );
  assert.equal(d.state, "provisional");
  assert.ok(d.state === "provisional");
  assert.equal(d.cents, 450_000_00, "the jornales must not fall off the total");
  assert.notEqual(d.cents, 250_000_00, "this phone's own sum is half a balance");
  assert.equal(d.pending, 1);
});

test("provisional never claims zero movements are waiting", () => {
  // The state is only reachable with a non-empty outbox, but the count comes
  // from the sync status and can be read a tick later. «Provisional: faltan 0
  // por enviar» reads as a bug to the person holding the phone.
  const d = balanceDisplay(
    full({ serverCents: 100_00, serverAt: AT, provisional: true }),
    0,
    true,
  );
  assert.ok(d.state === "provisional" && d.pending === 1);
});

test("once everything is sent, the server's own figure is shown unchanged", () => {
  const d = balanceDisplay(
    full({
      serverCents: 500_000_00,
      serverAt: AT,
      notItemisableCents: 200_000_00,
      itemisedCents: 300_000_00,
      provisional: false,
    }),
    0,
    true,
  );
  assert.ok(d.state === "known" && d.cents === 500_000_00);
  // And the part the kilos on the screen cannot explain travels with it, so
  // the total is not a number the rest of the screen fails to add up to.
  assert.ok(d.state === "known" && d.notItemisableCents === 200_000_00);
});

test("a negative balance is an advance not worked off, and stays signed", () => {
  const d = balanceDisplay(full({ serverCents: -180_00, serverAt: AT }), 0, true);
  assert.ok(d.state === "known" && d.cents === -180_00);
});

// ---- Before the move: a phone that is nobody's client -------------------

test("an unregistered phone shows its own ledger, and is not told «no lo sé»", () => {
  // The regression this parameter exists to prevent. Báscula runs alone on a
  // handset for a whole season — that is what the farm is doing TODAY, before
  // any of this moves — and its own ledger is not half a balance then, it is
  // the whole one. Answering «no lo sé» to a farm about a payroll it has been
  // paying out of this phone for months would be the app breaking, not the app
  // being careful.
  const d = balanceDisplay(full({ itemisedCents: 340_000_00 }), 0, false);
  assert.equal(d.state, "local");
  assert.ok(d.state === "local" && d.cents === 340_000_00);
});

test("unregistered wins over everything, including a stale server figure", () => {
  // A phone that was attached to a farm and then signed out. There is no
  // server to be behind any more, so there is no age to disclose.
  const d = balanceDisplay(
    full({ itemisedCents: 10_00, serverCents: 999_00, serverAt: AT, provisional: true }),
    5,
    false,
  );
  assert.equal(d.state, "local");
  assert.ok(d.state === "local" && d.cents === 10_00);
});
