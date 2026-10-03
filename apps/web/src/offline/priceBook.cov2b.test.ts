// SPDX-License-Identifier: MIT
/**
 * The price book's remaining rules: which base price a Monday falls under
 * when the history has several (and future) rows, what happens with no base
 * at all, and a server that refuses instead of being unreachable.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setTokens } from "../api/client";
import { invalidateRefs } from "../api/refs";
import * as db from "../mocks/db";
import { server } from "../mocks/node";
import { EMPTY_BOOK, ensureWeek, kiloPriceFor, syncPriceBook } from "./priceBook";
import { resetStoreForTests } from "./store";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MONDAY = "2026-09-21";

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

function prices(opts: {
  base: { currentCents: number; history: { validFrom: string; priceCents: number }[] };
  week: (monday: string) => Response;
}) {
  server.use(
    http.get("*/v1/prices/special", () => HttpResponse.json({ items: [] })),
    http.get("*/v1/prices/base", () =>
      HttpResponse.json({ ...opts.base, confirmed: true, thisWeek: MONDAY }),
    ),
    http.get("*/v1/prices/weeks/:monday", ({ params }) => opts.week(String(params.monday))),
  );
}

const weekAt = (cents: number) => (monday: string) =>
  HttpResponse.json({ weekStart: monday, priceCents: cents });

describe("the week override against the base in force", () => {
  it("compares with the latest base row on or before the Monday, ignoring future rows", async () => {
    prices({
      base: {
        currentCents: 85_000,
        history: [
          { validFrom: "2026-06-01", priceCents: 85_000 },
          { validFrom: "2026-01-05", priceCents: 80_000 },
          { validFrom: "2026-03-02", priceCents: 82_000 },
          { validFrom: "2027-01-04", priceCents: 99_000 },
        ],
      },
      week: weekAt(85_000),
    });
    const book = await syncPriceBook(db.FARM_ID, [MONDAY]);
    // Same as the base of that Monday: not a week of its own.
    expect(book?.weekPrices).toEqual([]);
  });

  it("with no base history, compares with the farm's price", async () => {
    prices({ base: { currentCents: 70_000, history: [] }, week: weekAt(70_000) });
    const book = await syncPriceBook(db.FARM_ID, [MONDAY]);
    expect(book?.farmPriceCents).toBe(70_000);
    expect(book?.weekPrices).toEqual([]);
  });

  it("with no base at all, any week price is the week's own", async () => {
    prices({ base: { currentCents: 0, history: [] }, week: weekAt(70_000) });
    const book = await syncPriceBook(db.FARM_ID, [MONDAY]);
    expect(book?.farmPriceCents).toBeNull();
    expect(book?.weekPrices).toEqual([{ weekStart: MONDAY, priceCents: 70_000 }]);
  });

  it("drops a week the server refuses to answer, without losing the book", async () => {
    prices({
      base: { currentCents: 80_000, history: [{ validFrom: "2026-01-05", priceCents: 80_000 }] },
      week: () => HttpResponse.json({ error: { code: "NOT_FOUND", message: "no" } }, { status: 404 }),
    });
    const book = await syncPriceBook(db.FARM_ID, [MONDAY]);
    expect(book?.weekPrices).toEqual([]);
    expect(book?.farmPriceCents).toBe(80_000);
  });
});

describe("syncPriceBook when the server answers with an error", () => {
  it("says nothing instead of using the device's copy", async () => {
    server.use(
      http.get("*/v1/prices/special", () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      ),
    );
    expect(await syncPriceBook(db.FARM_ID, [MONDAY])).toBeNull();
  });
});

describe("ensureWeek", () => {
  it("returns the same book when the Monday is already in it", async () => {
    const book = { ...EMPTY_BOOK, weekPrices: [{ weekStart: MONDAY, priceCents: 90_000 }] };
    expect(await ensureWeek(db.FARM_ID, book, MONDAY)).toBe(book);
  });

  it("still returns the new week when the device cannot keep it", async () => {
    prices({ base: { currentCents: 0, history: [] }, week: weekAt(90_000) });
    resetStoreForTests();
    globalThis.indexedDB = undefined as unknown as IDBFactory;
    const next = await ensureWeek(db.FARM_ID, EMPTY_BOOK, MONDAY);
    expect(next.weekPrices).toEqual([{ weekStart: MONDAY, priceCents: 90_000 }]);
  });
});

describe("kiloPriceFor", () => {
  it("has no price for a weighing without a day", () => {
    expect(kiloPriceFor({ ...EMPTY_BOOK, farmPriceCents: 80_000 }, { workerId: "", day: "" })).toBeNull();
  });

  it("falls back to the farm's price when the weighing names no lote", () => {
    const price = kiloPriceFor({ ...EMPTY_BOOK, farmPriceCents: 80_000 }, { workerId: "", day: MONDAY });
    expect(price?.priceCents).toBe(80_000);
  });
});
