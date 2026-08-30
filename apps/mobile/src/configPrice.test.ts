/**
 * A price nobody gave us must never be written as 0.
 *
 * The settings screen carried the price across a save with
 * `Config.get()?.costPerUnit ?? 0`. On a handset attached to a farm the box is
 * read-only — the price is the owner's and it arrives from the server — so a
 * phone that had not yet heard one saved a **0** and said «configuración
 * guardada». Every weighing that week then valued at nothing, with no error
 * anywhere: `docs/auditorias.md`'s zero trap, on the one figure the payroll is
 * multiplied by.
 *
 * Two halves, and the second is the one that would have caught it:
 *
 *   1. The rule as arithmetic, away from any screen — `balanceDisplay.test.ts`'s
 *      discipline, and for the same reason: a render test can only assert that
 *      some text appeared somewhere.
 *   2. The screen's SOURCE, pinned. The rule being right is worth nothing if
 *      the save path does not go through it, and the defect lived in the save
 *      path, not in a rule. This is `review.test.ts`'s and `flagOff.test.ts`'s
 *      discipline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { priceToSave, priceIsKnown, priceRefusalKey, type PriceToSave } from "./configPrice.ts";
import { translate } from "./strings.ts";
import type { CropConfig } from "./data/repository.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANGS = ["es", "en", "pt"] as const;

const config = (over: Partial<CropConfig> = {}): CropConfig => ({
  cropType: "cafe",
  label: "Café",
  unit: "kg",
  yieldUnit: "kg por recolector",
  costPerUnit: 800,
  ...over,
});

// ---- 1. The rule -------------------------------------------------------

test("a read-only handset with no stored price refuses, and has no number to write", () => {
  const p = priceToSave("", null, true);
  assert.equal(p.state, "notYet");
  assert.equal(priceIsKnown(p), false);
  // The property that makes the old bug impossible rather than unlikely:
  // there is no amount on the object to reach for, by accident or otherwise.
  assert.ok(!("costPerUnit" in p));
});

test("a null price in a column typed `number` is still no price", () => {
  // The config row exists — it was saved when the crop was picked — and the
  // REAL column has never been filled. This is the shape the phone actually
  // holds before the first pull, and the one `?? 0` sailed straight past.
  const stored = config({ costPerUnit: null as unknown as number });
  const p = priceToSave("", stored, true);
  assert.equal(p.state, "notYet");
  assert.ok(!("costPerUnit" in p));
});

test("a stored 0 is not a price either — it is the bug, already written once", () => {
  const p = priceToSave("", config({ costPerUnit: 0 }), true);
  assert.equal(p.state, "notYet");
});

test("a read-only handset carries the server's price across untouched", () => {
  const p = priceToSave("", config({ costPerUnit: 850 }), true);
  assert.equal(p.state, "stored");
  assert.ok(priceIsKnown(p) && p.costPerUnit === 850);
});

test("what the weigher typed is never what gets saved on a read-only handset", () => {
  // The box is disabled, but state is state: whatever `cost` happens to hold
  // must not reach the database on this branch.
  const p = priceToSave("1", config({ costPerUnit: 850 }), true);
  assert.ok(priceIsKnown(p) && p.costPerUnit === 850);
});

test("an owner's typed price is saved as typed", () => {
  const p = priceToSave("900", config(), false);
  assert.equal(p.state, "typed");
  assert.ok(priceIsKnown(p) && p.costPerUnit === 900);
});

test("an owner's empty or unusable box refuses instead of saving 0", () => {
  // `Number(cost) || 0` turned every one of these into a zero-priced week.
  for (const typed of ["", "   ", "abc", "-500", "0", "NaN"]) {
    const p = priceToSave(typed, config(), false);
    assert.equal(p.state, "invalid", `«${typed}» should not be a price`);
    assert.ok(!("costPerUnit" in p), `«${typed}» must carry no amount`);
  }
});

test("no refusal ever resolves to an amount, in any of the four states", () => {
  const cases = [
    priceToSave("", null, true),
    priceToSave("", config(), false),
    priceToSave("", config({ costPerUnit: 850 }), true),
    priceToSave("900", config(), false),
  ];
  for (const p of cases)
    assert.equal(
      priceIsKnown(p),
      "costPerUnit" in p,
      `${p.state}: the guard and the type must agree about whether there is money here`,
    );
});

// ---- The sentences the refusal is worth nothing without ------------------

// `priceRefusalKey` only accepts the refusing states, which is the point; this
// walks a value through the same guard the screen uses to get there.
function refusalKeyOf(p: PriceToSave): string {
  return priceIsKnown(p) ? `not a refusal at all: ${p.costPerUnit}` : priceRefusalKey(p);
}

test("both refusals say, in all three languages, that nothing was saved", () => {
  const keys = [
    refusalKeyOf(priceToSave("", null, true)),
    refusalKeyOf(priceToSave("", config(), false)),
  ];
  assert.deepEqual(keys, ["settings.priceNotYet", "settings.priceInvalid"]);
  for (const key of keys)
    for (const lang of LANGS) {
      const s = translate(lang, key);
      assert.notEqual(s, key, `${key} is missing from the ${lang} dictionary`);
      assert.match(
        s,
        /No se guardó nada|Nothing was saved|Nada foi salvo/,
        `${key} in ${lang} does not say that nothing was saved`,
      );
    }
});

// ---- 2. The save path actually goes through the rule ---------------------

test("the settings screen never coerces a missing price into a number", () => {
  const src = readFileSync(join(HERE, "screens/Settings.tsx"), "utf8");

  const save = src.slice(src.indexOf("function saveConfig"), src.indexOf("function addOverride"));
  assert.ok(save.length > 0, "saveConfig has moved; this pin needs rewriting");

  // The exact shape that shipped the bug, and its sibling on the other branch.
  assert.doesNotMatch(
    save,
    /costPerUnit\s*\?\?\s*0|Number\(\s*cost\s*\)\s*\|\|\s*0/,
    "saveConfig is coercing a missing price into 0 again",
  );
  // And no other zero fallback has taken their place.
  assert.doesNotMatch(save, /\?\?\s*0|\|\|\s*0/, "saveConfig has a zero fallback in it");

  // It refuses before it can reach an amount, rather than after.
  assert.match(save, /priceToSave\(/, "saveConfig does not consult the price rule");
  assert.match(
    save,
    /if\s*\(\s*!priceIsKnown\([\s\S]*?setSnack\(t\(priceRefusalKey\([\s\S]*?return;/,
    "saveConfig does not refuse and stop when the price is unknown",
  );
  assert.ok(
    save.indexOf("priceIsKnown") < save.indexOf("Config.save("),
    "the guard must come before the write, not after it",
  );
});
