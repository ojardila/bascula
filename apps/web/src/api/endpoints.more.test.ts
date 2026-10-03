// SPDX-License-Identifier: MIT
/**
 * endpoints.ts against answers the mock server never gives: envelopes with
 * fields missing, the settlements list falling back to the per-worker fan-out
 * with holes in it, and the requests a caller must never be able to send.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { api } from "./endpoints";
import { setTokens } from "./client";
import { ApiError } from "./errors";
import { invalidateRefs } from "./refs";
import { server } from "../mocks/node";
import * as db from "../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

afterEach(() => server.events.removeAllListeners());

describe("the farm's own data", () => {
  it("sends blanked contact fields as null and leaves untouched ones out", async () => {
    let sent: Record<string, unknown> | null = null;
    server.events.on("request:start", async ({ request }) => {
      if (
        request.method === "PUT" &&
        new URL(request.url).pathname === "/v1/farm"
      ) {
        sent = (await request.clone().json()) as Record<string, unknown>;
      }
    });
    await api.updateFarm({
      name: "La Esperanza",
      timezone: "America/Bogota",
      currency: "COP",
      priceCents: 80_000,
      phone: "",
      country: "",
      city: "",
      address: "",
      areaHa: 12.5,
    });
    expect(sent).toEqual({
      name: "La Esperanza",
      timezone: "America/Bogota",
      currency: "COP",
      priceCents: 80_000,
      phone: null,
      country: null,
      city: null,
      address: null,
      areaHa: 12.5,
    });
  });
});

describe("envelopes with nothing in them", () => {
  it("stock, sales and expenses read as empty lists and zero totals", async () => {
    server.use(
      http.get("*/v1/stock", () => HttpResponse.json({})),
      http.get("*/v1/sales", () => HttpResponse.json({})),
      http.get("*/v1/expenses", () => HttpResponse.json({})),
    );
    expect(await api.stockLevels()).toEqual([]);
    expect(await api.listSales()).toEqual({
      items: [],
      totalCents: 0,
      totalQty: 0,
    });
    expect(await api.listExpenses()).toEqual({
      items: [],
      count: 0,
      totalCents: 0,
    });
  });
});

describe("settling", () => {
  it("refuses to settle 'everything pending' without naming the payables", async () => {
    await expect(
      api.settle("0192f3a0-0006-7000-8000-000000000001", [], {
        expectedGrossCents: 100,
      }),
    ).rejects.toThrow(/requires the payables the user approved/);
  });
});

describe("the settlements list without its route", () => {
  it("rebuilds it from the ledgers and counts what it could not read", async () => {
    let failedOneLedger = false;
    server.use(
      http.get("*/v1/settlements", () =>
        HttpResponse.json(
          { error: { code: "METHOD_NOT_ALLOWED", message: "no" } },
          { status: 405 },
        ),
      ),
      http.get("*/v1/workers/:id/ledger", () => {
        if (failedOneLedger) return undefined;
        failedOneLedger = true;
        return HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom" } },
          { status: 400 },
        );
      }),
    );
    const list = await api.listSettlements();
    expect(list.unreadableLedgers).toBe(1);
    expect(list.unreadableSettlements).toBe(0);
  });

  it("counts a settlement that would not load", async () => {
    server.use(
      http.get("*/v1/settlements", () =>
        HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "no" } },
          { status: 404 },
        ),
      ),
      http.get("*/v1/settlements/:id", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom" } },
          { status: 400 },
        ),
      ),
    );
    const list = await api.listSettlements();
    expect(list.items).toEqual([]);
    expect(list.unreadableSettlements).toBeGreaterThan(0);
  });

  it("does not paper over a real failure with the slow fallback", async () => {
    server.use(
      http.get("*/v1/settlements", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    await expect(api.listSettlements()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("an activity at the week's price", () => {
  it("is refused in Spanish when the farm has no standing price to seed it with", async () => {
    const farm = await api.getFarm();
    server.use(
      http.get("*/v1/farm", () =>
        HttpResponse.json({ ...toWireFarm(farm), priceCents: 0 }),
      ),
    );
    const err = await api
      .createActivity({
        id: "0192f3a0-0007-7000-8000-0000000000f1",
        name: "Recolección nueva",
        category: "cosecha",
        payMode: "work_unit",
        workUnit: "kg",
        rateSource: "weekly_price",
      } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("FARM_PRICE_UNSET");
  });
});

/** Enough of `GET /v1/farm` for `toFarmSummary` to read back. */
function toWireFarm(f: Awaited<ReturnType<typeof api.getFarm>>) {
  return {
    id: db.FARM_ID,
    name: f.name,
    slug: "la-esperanza",
    timezone: f.timezone,
    currency: f.currency,
    suspendedAt: null,
    areaHa: null,
    city: null,
    country: null,
    phone: null,
    address: null,
  };
}
