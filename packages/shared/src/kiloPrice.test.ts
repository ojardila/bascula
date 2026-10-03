// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveKiloPrice, type KiloPriceBook } from "./kiloPrice.ts";

// Mirrors the San José exceptions used for live verification: base $800,
// week 2026-09-07 $900, lote El Mirador $950 from 2026-08-17, employee José
// Arley $1.000 from 2026-09-14. Same rule as kilo_price() (migration 00034).
const JOSE = "emp-jose";
const OTHER = "emp-other";
const MIRADOR = "plot-mirador";
const BAJIO = "plot-bajio";

function book(over: Partial<KiloPriceBook> = {}): KiloPriceBook {
  return {
    employeePrices: [{ employeeId: JOSE, validFrom: "2026-09-14", priceCents: 100_000 }],
    plotPrices: [{ plotId: MIRADOR, validFrom: "2026-08-17", priceCents: 95_000 }],
    weekPrices: [{ weekStart: "2026-09-07", priceCents: 90_000 }],
    basePrices: [{ validFrom: "2000-01-03", priceCents: 80_000 }],
    ...over,
  };
}

test("falls back to the farm base price", () => {
  const r = resolveKiloPrice(book({ employeePrices: [], plotPrices: [], weekPrices: [] }), {
    employeeId: OTHER, plotIds: [BAJIO], weekStart: "2026-09-21",
  });
  assert.deepEqual(r, { priceCents: 80_000, source: "finca" });
});

test("the week override beats the farm base", () => {
  const r = resolveKiloPrice(book({ employeePrices: [], plotPrices: [] }), {
    employeeId: OTHER, plotIds: [BAJIO], weekStart: "2026-09-07",
  });
  assert.deepEqual(r, { priceCents: 90_000, source: "semana" });
});

test("the lote price beats the week override and the farm base", () => {
  const r = resolveKiloPrice(book({ employeePrices: [] }), {
    employeeId: OTHER, plotIds: [MIRADOR], weekStart: "2026-09-07",
  });
  assert.deepEqual(r, { priceCents: 95_000, source: "lote" });
});

test("the employee price beats lote, week and farm", () => {
  const r = resolveKiloPrice(book(), { employeeId: JOSE, plotIds: [MIRADOR], weekStart: "2026-09-21" });
  assert.deepEqual(r, { priceCents: 100_000, source: "persona" });
});

test("effective dates: an employee price does not apply before its Monday", () => {
  const r = resolveKiloPrice(book(), { employeeId: JOSE, plotIds: [MIRADOR], weekStart: "2026-09-07" });
  assert.deepEqual(r, { priceCents: 95_000, source: "lote" });
});

test("effective dates: a lote price does not apply before its Monday", () => {
  const r = resolveKiloPrice(book({ employeePrices: [], weekPrices: [] }), {
    employeeId: OTHER, plotIds: [MIRADOR], weekStart: "2026-08-10",
  });
  assert.deepEqual(r, { priceCents: 80_000, source: "finca" });
});

test("effective dates: a week override only applies to its own week", () => {
  const r = resolveKiloPrice(book({ employeePrices: [], plotPrices: [] }), {
    employeeId: OTHER, plotIds: [BAJIO], weekStart: "2026-09-14",
  });
  assert.deepEqual(r, { priceCents: 80_000, source: "finca" });
});

test("effective dates: the latest entry at or before the week wins", () => {
  const r = resolveKiloPrice(
    book({
      employeePrices: [
        { employeeId: JOSE, validFrom: "2026-09-28", priceCents: 120_000 },
        { employeeId: JOSE, validFrom: "2026-09-14", priceCents: 100_000 },
        { employeeId: JOSE, validFrom: "2026-08-03", priceCents: 85_000 },
      ],
    }),
    { employeeId: JOSE, plotIds: [MIRADOR], weekStart: "2026-09-21" },
  );
  assert.deepEqual(r, { priceCents: 100_000, source: "persona" });
});

test("a null price ends the exception from that Monday", () => {
  const r = resolveKiloPrice(
    book({
      employeePrices: [
        { employeeId: JOSE, validFrom: "2026-09-14", priceCents: 100_000 },
        { employeeId: JOSE, validFrom: "2026-09-21", priceCents: null },
      ],
    }),
    { employeeId: JOSE, plotIds: [MIRADOR], weekStart: "2026-09-21" },
  );
  assert.deepEqual(r, { priceCents: 95_000, source: "lote" });
});

test("another employee's price never applies", () => {
  const r = resolveKiloPrice(book({ plotPrices: [], weekPrices: [] }), {
    employeeId: OTHER, plotIds: [BAJIO], weekStart: "2026-09-21",
  });
  assert.deepEqual(r, { priceCents: 80_000, source: "finca" });
});

test("several lotes take the lote price only when every lote agrees", () => {
  const agree = book({
    employeePrices: [], weekPrices: [],
    plotPrices: [
      { plotId: MIRADOR, validFrom: "2026-08-17", priceCents: 95_000 },
      { plotId: BAJIO, validFrom: "2026-08-17", priceCents: 95_000 },
    ],
  });
  assert.deepEqual(
    resolveKiloPrice(agree, { employeeId: OTHER, plotIds: [MIRADOR, BAJIO], weekStart: "2026-09-21" }),
    { priceCents: 95_000, source: "lote" },
  );
  const disagree = book({
    employeePrices: [], weekPrices: [],
    plotPrices: [
      { plotId: MIRADOR, validFrom: "2026-08-17", priceCents: 95_000 },
      { plotId: BAJIO, validFrom: "2026-08-17", priceCents: 92_000 },
    ],
  });
  assert.deepEqual(
    resolveKiloPrice(disagree, { employeeId: OTHER, plotIds: [MIRADOR, BAJIO], weekStart: "2026-09-21" }),
    { priceCents: 80_000, source: "finca" },
  );
});

test("several lotes skip the lote rule when one has no special price", () => {
  const r = resolveKiloPrice(book({ employeePrices: [], weekPrices: [] }), {
    employeeId: OTHER, plotIds: [MIRADOR, BAJIO], weekStart: "2026-09-21",
  });
  assert.deepEqual(r, { priceCents: 80_000, source: "finca" });
});

test("the base price is effective-dated too", () => {
  const r = resolveKiloPrice(
    book({
      employeePrices: [], plotPrices: [], weekPrices: [],
      basePrices: [
        { validFrom: "2000-01-03", priceCents: 70_000 },
        { validFrom: "2026-08-03", priceCents: 80_000 },
        { validFrom: "2026-10-05", priceCents: 85_000 },
      ],
    }),
    { employeeId: OTHER, plotIds: [], weekStart: "2026-09-21" },
  );
  assert.deepEqual(r, { priceCents: 80_000, source: "finca" });
});

test("the farm standing price is the last resort, and nothing is invented without one", () => {
  const empty = { employeePrices: [], plotPrices: [], weekPrices: [], basePrices: [] };
  assert.deepEqual(
    resolveKiloPrice({ ...empty, farmPriceCents: 75_000 }, { employeeId: OTHER, weekStart: "2026-09-21" }),
    { priceCents: 75_000, source: "finca" },
  );
  assert.equal(resolveKiloPrice({ ...empty, farmPriceCents: null }, { employeeId: OTHER, weekStart: "2026-09-21" }), null);
});
