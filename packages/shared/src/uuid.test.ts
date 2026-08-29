import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createUuidV7,
  isUuidV7,
  uuidV7Counter,
  uuidV7Time,
} from "./uuid.ts";

/**
 * The id has one job beyond being unique: sorting it must sort history. Every
 * test below is about that, because if it stops holding the failure is silent
 * — the server keeps accepting rows and simply files them in the wrong order.
 */

/** A generator with no entropy at all, so shape and ordering are exact. */
const fixed = (hi: number, lo: number) => createUuidV7(() => ({ hi, lo }));

test("the canonical shape, the version nibble and the variant bits", () => {
  const id = createUuidV7()(Date.UTC(2026, 7, 27, 12, 0, 0));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(isUuidV7(id));
  assert.equal(id.length, 36);
});

test("the first 48 bits are the millisecond it was minted for", () => {
  const ms = Date.UTC(2026, 7, 27, 6, 30, 15, 250);
  assert.equal(uuidV7Time(createUuidV7()(ms)), ms);
  // And the far ends of a plausible range, in case the split drops a bit.
  for (const t of [0, 1, 0xffff, 0x10000, Date.UTC(2099, 11, 31)])
    assert.equal(uuidV7Time(createUuidV7()(t)), t);
});

test("every random bit lands where the layout says, and none escape it", () => {
  // All ones for the 64 bits offered: 62 must survive, and the two variant
  // bits must overwrite the rest rather than the timestamp or the version.
  const id = fixed(0xffffffff, 0xffffffff)(0);
  assert.equal(id, "00000000-0000-7000-bfff-ffffffffffff");
  // All zeros: nothing but the version and variant markers may be set.
  assert.equal(fixed(0, 0)(0), "00000000-0000-7000-8000-000000000000");
});

test("same millisecond, different rows: the counter breaks the tie in order", () => {
  const next = fixed(0, 0);
  const ms = Date.UTC(2026, 7, 27);
  const ids = [next(ms), next(ms), next(ms), next(ms)];
  assert.deepEqual(ids.map(uuidV7Counter), [0, 1, 2, 3]);
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, 4);
});

test("a clock that jumps backwards still cannot produce a smaller id", () => {
  // The one that matters on a cheap phone whose time is set by hand.
  const next = fixed(0, 0);
  const ids = [
    next(Date.UTC(2026, 7, 27, 10)),
    next(Date.UTC(2026, 7, 27, 9)), // the owner corrected the clock
    next(Date.UTC(2026, 7, 27, 8)),
  ];
  assert.deepEqual([...ids].sort(), ids);
});

test("fed instants in order, the ids come out in the same order", () => {
  const next = createUuidV7();
  const days = Array.from({ length: 400 }, (_, i) => Date.UTC(2026, 0, 1) + i * 86400000);
  const ids = days.map((d) => next(d));
  assert.deepEqual([...ids].sort(), ids);
  assert.deepEqual(ids.map(uuidV7Time), days);
});

test("4096 rows in one millisecond borrow the next one instead of repeating", () => {
  const next = fixed(0, 0);
  const ms = Date.UTC(2026, 7, 27);
  const ids = Array.from({ length: 4100 }, () => next(ms));
  assert.equal(new Set(ids).size, 4100);
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(uuidV7Time(ids[4096]!), ms + 1);
});

test("two generators do not share a counter", () => {
  // The migration walks the farm's whole history; the repository is meanwhile
  // stamping today's writes. One shared counter would drag the migration's
  // first row up to today.
  const a = createUuidV7();
  const b = createUuidV7();
  a(Date.UTC(2026, 7, 27));
  assert.equal(uuidV7Time(b(Date.UTC(2020, 0, 1))), Date.UTC(2020, 0, 1));
});

test("isUuidV7 rejects a v4, a truncation and a non-string", () => {
  assert.equal(isUuidV7("f47ac10b-58cc-4372-a567-0e02b2c3d479"), false); // v4
  assert.equal(isUuidV7("0198a1b2-c3d4-7abc-8def-0123456789a"), false);
  assert.equal(isUuidV7("0198A1B2-C3D4-7ABC-8DEF-0123456789AB"), false); // upper
  assert.equal(isUuidV7(null), false);
  assert.equal(isUuidV7(42), false);
  assert.throws(() => uuidV7Time("nope"), /not a uuidv7/);
});
