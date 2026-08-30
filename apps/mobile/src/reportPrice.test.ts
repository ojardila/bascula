/**
 * «$0» is a claim. A farm whose price has not arrived is owed «we do not know».
 *
 * Three report screens each took `c?.costPerUnit ?? 0` and handed it straight
 * to a money function: the farm-wide payout (`Reports`), the real cost per
 * kilo (`PerformancePanel`), and a plot's value (`CropDetail`). With no price
 * every one of them computed at zero and displayed the result as a figure —
 * so the app told a farm its coffee was worth nothing, in three places, each
 * of them confidently.
 *
 * The same fault three times over is the lesson `docs/auditorias.md` closes
 * with: a pattern solved in one place does not spread on its own. So the rule
 * is `priceForReport` in one file, and these are the tests that say all three
 * screens go through it.
 *
 * `null` rather than 0 is the point. It cannot be passed on to arithmetic by
 * accident — it has to be handled to be rendered — which is the same reason
 * `balanceDisplay`'s `unknown` carries no number.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { priceForReport } from "./configPrice.ts";
import type { CropConfig } from "./data/repository.ts";

const HERE = new URL(".", import.meta.url).pathname;
const cfg = (costPerUnit: unknown) => ({ costPerUnit, unit: "kg" } as unknown as CropConfig);

// ---- 1. The rule ---------------------------------------------------------

test("a usable price comes back untouched", () => {
  assert.equal(priceForReport(cfg(800)), 800);
  assert.equal(priceForReport(cfg(0.5)), 0.5);
});

test("every shape of «no price» comes back as null, never as a number", () => {
  for (const bad of [0, -1, NaN, Infinity, null, undefined, "800", ""]) {
    assert.equal(priceForReport(cfg(bad)), null, `${String(bad)} was accepted as a price`);
  }
  assert.equal(priceForReport(null), null);
  assert.equal(priceForReport(undefined), null);
});

test("zero is refused, because zero is the bug", () => {
  // A stored 0 is what a phone wrote before the settings screen learned to
  // refuse it. Reports must not treat those rows as a real price of nothing.
  assert.equal(priceForReport(cfg(0)), null);
});

// ---- 2. All three screens actually go through it -------------------------

const SCREENS = [
  { file: "Reports.tsx", was: /totalPayout\(c \? c\.costPerUnit : 0\)/ },
  { file: "CropDetail.tsx", was: /value\(cropId, c\?\.costPerUnit \?\? 0\)/ },
  { file: "PerformancePanel.tsx", was: /realCost\(c\?\.costPerUnit \?\? 0\)/ },
];

for (const { file, was } of SCREENS) {
  test(`${file} prices through the rule instead of coercing to 0`, () => {
    const src = readFileSync(join(HERE, "screens", file), "utf8");

    assert.doesNotMatch(src, was, `${file} is coercing a missing price into 0 again`);
    assert.match(src, /priceForReport\(/, `${file} does not consult the report price rule`);
    // And it renders the absence rather than a money figure.
    assert.match(src, /=== null \? "—"/, `${file} renders no «—» for an unknown amount`);
  });
}

test("no report screen still hands a bare `?? 0` price to a money function", () => {
  // The sweep, not the three known sites: this is the shape, wherever it is.
  for (const file of ["Reports.tsx", "CropDetail.tsx", "PerformancePanel.tsx"]) {
    const src = readFileSync(join(HERE, "screens", file), "utf8");
    assert.doesNotMatch(
      src,
      /costPerUnit\s*\?\?\s*0/,
      `${file} still coerces a missing price into 0 somewhere`,
    );
  }
});
