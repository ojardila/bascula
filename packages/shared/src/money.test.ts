import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toCents,
  fromCents,
  amountCents,
  signedAmount,
  isValidLedgerAmount,
  LEDGER_SIGN,
} from "./money.ts";
import { LEDGER_KINDS } from "./enums.ts";

// These are the rules Go has to reproduce exactly. Each test names the way two
// languages drift apart if it is written from memory instead of from here.

test("cents are integers, in both directions", () => {
  assert.equal(toCents(800), 80000);
  assert.equal(toCents(83.33), 8333);
  assert.equal(fromCents(80000), 800);
  // 0.1 + 0.2 arithmetic: a naive floor() drops a cent per line.
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents(1471.07), 147107);
});

test("amountCents rounds half away from zero, not to even", () => {
  // 2.5 * 8333 is exactly 20832.5. Banker's rounding — Python's round(),
  // Java's HALF_EVEN, a naive Go strconv round-trip — answers 20832.
  assert.equal(amountCents(2.5, 8333), 20833);
  assert.equal(amountCents(4.5, 8333), 37499); // exactly 37498.5
  assert.equal(amountCents(0.5, 8333), 4167); // exactly 4166.5
  // A control: here half-up and half-even agree, so it proves nothing alone.
  assert.equal(amountCents(1.5, 8333), 12500);
});

test("rounding per line and rounding the sum are different totals", () => {
  // The receipt the worker checks lists lines, so the line is where rounding
  // happens. Rounding the total instead is two cents cheaper here, and the
  // difference grows with the number of pickups.
  const qty = [2.5, 4.5, 1.5, 0.5];
  const rate = 8333;
  const perLine = qty.reduce((s, q) => s + amountCents(q, rate), 0);
  const onTheSum = Math.round(qty.reduce((s, q) => s + q * rate, 0));
  assert.equal(perLine, 74999);
  assert.equal(onTheSum, 74997);
  assert.notEqual(perLine, onTheSum);
});

test("amountCents holds for the three pay modes", () => {
  assert.equal(amountCents(1, 12000000), 12000000); // contract: quantity = 1
  assert.equal(amountCents(6, 5000000), 30000000); // time_unit: six jornales
  assert.equal(amountCents(52.5, 80000), 4200000); // work_unit: 52,5 kg
});

test("a float weight that came back from SQL still lands on an integer", () => {
  // SUM() in SQLite returns 185.99999999999997 for 65.3 + 68.1 + 52.6.
  const fromSql = 65.3 + 68.1 + 52.6;
  assert.equal(amountCents(fromSql, 80000), 14880000);
});

test("the sign table covers every kind, and only the real ones", () => {
  assert.deepEqual(Object.keys(LEDGER_SIGN).sort(), [...LEDGER_KINDS].sort());
});

test("callers hand over magnitudes; the sign is ours", () => {
  assert.equal(signedAmount("devengo", 100000), 100000);
  assert.equal(signedAmount("pago", 100000), -100000);
  assert.equal(signedAmount("anticipo", 100000), -100000);
  assert.equal(signedAmount("deduccion", 100000), -100000);
  // A magnitude that arrives already negated must not flip back to positive:
  // that is a payment turning into an earning.
  assert.equal(signedAmount("pago", -100000), -100000);
  // Free kinds keep the direction they were given.
  assert.equal(signedAmount("ajuste", -2500), -2500);
  assert.equal(signedAmount("reverso", 100000), 100000);
});

test("the ledger's CHECK constraints, before SQLite has to say it", () => {
  assert.ok(isValidLedgerAmount("devengo", 1));
  assert.ok(!isValidLedgerAmount("devengo", -1));
  assert.ok(isValidLedgerAmount("pago", -1));
  assert.ok(!isValidLedgerAmount("pago", 1));
  assert.ok(isValidLedgerAmount("ajuste", -5));
  assert.ok(isValidLedgerAmount("ajuste", 5));
  // Zero is never a movement, for any kind.
  for (const kind of LEDGER_KINDS) assert.ok(!isValidLedgerAmount(kind, 0));
  // Nor is a fraction of a cent.
  assert.ok(!isValidLedgerAmount("ajuste", 1.5));
});
