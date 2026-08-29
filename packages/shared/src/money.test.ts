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

test("the exact product reaches the half even when the double cannot", () => {
  // The golden case `tres-decimales-que-el-float-pierde`, in one line each.
  // 1,005 has no binary form: the nearest double is BELOW it, so the product
  // lands at 7537,499999999999 and a float round answers 7537. The exact
  // product is 7537,5 and the answer is 7538 — which is what big.Rat on the
  // server and numeric in Postgres both say.
  assert.equal(Math.round(1.005 * 7500), 7537); // what this used to answer
  assert.equal(amountCents(1.005, 7500), 7538);
  assert.equal(amountCents(1.001, 7500), 7508);
  assert.equal(amountCents(1.003, 7500), 7523);
  assert.equal(amountCents(1.007, 7500), 7553);
  // Four lines of one settlement: four cents of gross, and a phone that
  // derived 30118 gets 409 GROSS_CHANGED against a server that says 30122.
  const gross = [1.001, 1.003, 1.005, 1.007].reduce((s, q) => s + amountCents(q, 7500), 0);
  assert.equal(gross, 30122);
});

test("a quantity that never became a float is taken as text", () => {
  // Postgres sends numeric(12,3) as a decimal string. The sync layer may hand
  // it over untouched instead of going through Number(); same answer either
  // way, one fewer round trip through a double.
  assert.equal(amountCents("1.005", 7500), 7538);
  assert.equal(amountCents("1.005", 7500), amountCents(1.005, 7500));
  assert.equal(amountCents("52.500", 80000), 4200000);
  assert.equal(amountCents("0", 80000), 0);
});

test("half away from zero, on both signs", () => {
  // Only `ajuste` can be negative and it never reaches here, but the Go twin
  // rounds the magnitude and Postgres round(numeric) does too. Half UP would
  // answer -7537 on the second line.
  assert.equal(amountCents(1.005, 7500), 7538);
  assert.equal(amountCents(-1.005, 7500), -7538);
  assert.equal(amountCents("-2.5", 8333), -20833);
});

test("a quantity that is not a decimal answers NaN, and does not throw", () => {
  // What the float form did. `requirePositive` in the repository is what
  // refuses it; blowing up inside the multiplication would take payroll down.
  assert.ok(Number.isNaN(amountCents(NaN, 8000)));
  assert.ok(Number.isNaN(amountCents(Infinity, 8000)));
  assert.ok(Number.isNaN(amountCents("", 8000)));
  assert.ok(Number.isNaN(amountCents("1,005", 8000))); // a comma is not a point
  assert.ok(Number.isNaN(amountCents(1.005, NaN)));
});

test("exact against an independent oracle, over the rates a farm writes", () => {
  // The bug only ever fired when the exact product landed on a half, and it
  // always landed one minor unit SHORT — never long. This walks the whole
  // three-decimal grid against rates that are multiples of 250 (the $7.750
  // and $8.250 a farm really writes) and checks every line against integer
  // thousandths, which is a different arithmetic from the one under test.
  //
  // The oracle: quantity has at most three decimals, so quantity x 1000 is an
  // integer and (units x rate) / 1000 is the exact product, in Number rather
  // than BigInt. Safe here because units x rate stays far under 2^53.
  const oracle = (units: number, rate: number): number => {
    const product = units * rate;
    const quotient = Math.floor(product / 1000);
    return (product % 1000) * 2 >= 1000 ? quotient + 1 : quotient;
  };

  let checked = 0;
  let onHalf = 0;
  for (let units = 1; units <= 2000; units++) {
    const text = `${Math.floor(units / 1000)}.${String(units % 1000).padStart(3, "0")}`;
    const asFloat = Number(text);
    for (let k = 1; k <= 400; k++) {
      const rate = k * 250;
      const want = oracle(units, rate);
      assert.equal(amountCents(text, rate), want);
      assert.equal(amountCents(asFloat, rate), want);
      checked++;
      if ((units * rate) % 1000 === 500) {
        onHalf++;
        // Where the two forms differ, the old one was always low, never high.
        assert.ok(Math.round(asFloat * rate) <= want);
      }
    }
  }
  assert.equal(checked, 800_000);
  assert.ok(onHalf > 1000, `the grid has to contain half-products; it had ${onHalf}`);
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
