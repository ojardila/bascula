/**
 * A guard against paying twice must not become a guard against paying at all.
 *
 * `runBulk` sets `busy.current = true` before the payroll and lifts it in a
 * 400ms timer at the end of the happy path. That is right for the failure it
 * was written against — a second tap while thirty settlements and thirty
 * payments are on the wire. It is wrong for every other one: if `runPayroll`
 * throws, the timer is never reached, `busy.current` stays true for the life
 * of the screen, and the payroll button is dead with nothing on it saying why.
 *
 * The person holding the phone is standing in front of the crew on a Saturday.
 * A button that has silently stopped working is the worst shape this failure
 * can take, and it is the shape the guard produces by default.
 *
 * Pinned on the SOURCE rather than rendered. What matters is the control flow
 * of the release, and a render test can only assert that some text appeared.
 * This is `configPrice.test.ts`'s and `flagOff.test.ts`'s discipline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const src = readFileSync(join(HERE, "PaymentsPanel.tsx"), "utf8");

/** The catch block alone -- not the rest of the function behind it. */
function catchBlock(): string {
  const body = runBulkSource();
  const start = body.indexOf("} catch");
  assert.ok(start >= 0, "runBulk no longer catches anything");
  const end = body.indexOf("\n    }", start);
  assert.ok(end > start, "could not find the end of the catch block");
  return body.slice(start, end);
}

function runBulkSource(): string {
  const start = src.indexOf("function runBulk");
  assert.ok(start >= 0, "runBulk has moved; this pin needs rewriting");
  const rest = src.slice(start + 1);
  const end = rest.indexOf("\n  function ") + 1;
  return rest.slice(0, end > 0 ? end : rest.length);
}

test("runBulk takes the guard and never leaves without giving it back", () => {
  const body = runBulkSource();

  assert.match(body, /busy\.current = true/, "runBulk no longer takes the guard");

  // The payroll call is inside a try. Without it the only release is the
  // happy-path timer, which a throw skips.
  assert.match(
    body,
    /try\s*\{[\s\S]*Payments\.runPayroll\(/,
    "Payments.runPayroll is not inside a try -- a throw leaves the button dead",
  );

  // And the catch actually releases, rather than only reporting.
  const block = catchBlock();
  assert.match(
    block,
    /busy\.current = false/,
    "the failure path never lifts busy.current; the payroll button stays dead",
  );
  assert.match(
    block,
    /setRunning\(false\)/,
    "the failure path leaves the spinner running for the life of the screen",
  );
});

test("a failed payroll says so instead of going quiet", () => {
  const block = catchBlock();
  assert.match(
    block,
    /setSnack\(/,
    "a payroll that threw tells the user nothing at all",
  );
});

test("the failure path does not wait 400ms to let go", () => {
  // The delay exists so a second tap cannot duplicate a result that was just
  // rendered. On the failure path there is no such result, and every extra
  // moment is a moment the button is dead in front of the crew.
  const block = catchBlock();
  assert.doesNotMatch(
    block,
    /setTimeout\([\s\S]*busy\.current = false/,
    "the failure path defers the release behind a timer",
  );
});
