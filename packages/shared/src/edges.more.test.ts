// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { amountCents } from "./money.ts";
import { createUuidV7, isUuidV7 } from "./uuid.ts";

test("amountCents reads a quantity written with a positive exponent exactly", () => {
  assert.equal(amountCents("1e3", 250), 250_000);
  assert.equal(amountCents("2.5E1", 100), 2_500);
});

test("a v7 id is still made when the platform has no crypto", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    const id = createUuidV7()(new Date("2026-09-10T12:00:00Z"));
    assert.ok(isUuidV7(id));
  } finally {
    if (saved) Object.defineProperty(globalThis, "crypto", saved);
  }
});
