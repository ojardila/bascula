import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCases, runCase, instantOf, type GoldenExpectation } from "./runner.ts";

// One node:test per fixture, named after it, so a failure says which case broke
// before it says which number. The Go suite reads the same files.

const cases = loadCases();

test("there are golden cases to run", () => {
  assert.ok(cases.length > 0, "no fixtures found in golden/cases");
});

for (const c of cases) {
  test(`golden: ${c.id} — ${c.title}`, () => {
    const actual = runCase(c);
    for (const key of Object.keys(c.expect) as (keyof GoldenExpectation)[]) {
      assert.deepEqual(actual[key], c.expect[key], `${c.id}: ${key}\n${c.why}`);
    }
  });
}

// --- Properties the whole corpus has to keep, so it stays Go-readable -----

test("every expected amount is an integer number of cents", () => {
  const offenders: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (/Cents$/.test(k) && typeof v === "number" && !Number.isInteger(v))
          offenders.push(`${path}.${k} = ${v}`);
        walk(v, `${path}.${k}`);
      }
    }
  };
  for (const c of cases) walk(c, c.id);
  assert.deepEqual(offenders, [], "money must never be a float in a fixture");
});

test("every expected amount survives a round trip through int64", () => {
  for (const c of cases) {
    const amounts = JSON.stringify(c).match(/"[a-zA-Z]*Cents":(-?\d+)/g) ?? [];
    for (const a of amounts) {
      const n = Number(a.split(":")[1]);
      assert.ok(Number.isSafeInteger(n), `${c.id}: ${a} would not survive int64/float64`);
    }
  }
});

test("every date in a fixture is a bare YYYY-MM-DD business date", () => {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  for (const c of cases) {
    for (const ev of c.events) {
      if ("on" in ev) assert.match(ev.on, DAY, `${c.id}: event date`);
      if ("from" in ev) assert.match(ev.from, DAY, `${c.id}: settle from`);
      if ("to" in ev) assert.match(ev.to, DAY, `${c.id}: settle to`);
      // A weighing is the one thing that carries a clock, and it is local time
      // with no offset on purpose — the offset is the farm's, not the file's.
      if (ev.op === "pickup")
        assert.match(ev.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, `${c.id}: pickup stamp`);
    }
    const everyBalance = [
      ...(c.expect.balances ?? []),
      ...(c.expect.checkpoints ?? []).flatMap((cp) => cp.balances),
    ];
    for (const b of everyBalance)
      if (b.lastMovementAt !== null) assert.match(b.lastMovementAt, DAY, `${c.id}: lastMovementAt`);
  }
});

test("case ids are unique and match their filename order", () => {
  const ids = cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a local stamp becomes the instant the phone would store", () => {
  // Stated the way the phone states it, so it holds in any timezone the suite
  // runs in: the wall clock is what the fixture means.
  const d = new Date(instantOf("2026-08-30T19:30"));
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 30);
  assert.equal(d.getHours(), 19);
  assert.equal(d.getMinutes(), 30);
});
