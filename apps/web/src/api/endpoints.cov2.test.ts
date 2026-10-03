// SPDX-License-Identifier: MIT
/**
 * endpoints.ts, round two: the request bodies built from optional input
 * (a note's own id and date, a payment's receiver, a sale's day), and the
 * responses that leave a list or a figure out (a profile with no tasks, a
 * preview with no balance, a settlement with no lines, a stock move that
 * answers bare). Each one is a default that has to land on the safe side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { api, grossChangeOf } from "./endpoints";
import { getTokens, request, setTokens } from "./client";
import { ApiError } from "./errors";
import { GROSS_CHANGED } from "./grossChange";
import { invalidateRefs } from "./refs";
import { server } from "../mocks/node";
import * as db from "../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";
const SETTLEMENT = "0192f3a0-000b-7000-8000-000000000001";
const ID = "0192f3a0-ffff-7000-8000-000000000001";

function signIn() {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
}

/** The JSON body (and URL) of the first request matching `method` and `path`. */
function capture(method: string, path: RegExp) {
  const box: { body: Record<string, unknown> | null; url: URL | null } = { body: null, url: null };
  server.events.on("request:start", async ({ request: req }) => {
    const url = new URL(req.url);
    if (box.url === null && req.method === method && path.test(url.pathname)) {
      box.url = url;
      const text = await req.clone().text();
      box.body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    }
  });
  return box;
}

async function sent(box: ReturnType<typeof capture>) {
  await vi.waitFor(() => expect(box.url).not.toBeNull());
  return box.body!;
}

const conflict = (details: Record<string, unknown>) =>
  HttpResponse.json(
    { error: { code: GROSS_CHANGED, message: "gross changed", details } },
    { status: 409 },
  );

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signIn();
});

afterEach(() => {
  server.events.removeAllListeners();
  vi.restoreAllMocks();
  setTokens(null);
});

describe("signup and the farm", () => {
  it("fills a blank timezone and currency, and survives a reply with no token", async () => {
    setTokens(null);
    const box = capture("POST", /\/v1\/signup$/);
    server.use(http.post("*/v1/signup", () => HttpResponse.json({ provisionTicket: "t" })));
    const res = await api.signup({
      farm: { name: "La Palma", timezone: "", currency: "" },
      owner: { email: "ana@palma.co", name: "Ana", password: "clave-larga-123" },
    });
    expect((await sent(box)).farm).toMatchObject({ timezone: "America/Bogota", currency: "COP" });
    expect(res).toEqual({
      verificationEmailSentTo: "ana@palma.co",
      verificationToken: null,
      verificationRequired: false,
    });
  });

  it("logging out with no session asks nothing of the server", async () => {
    setTokens(null);
    const box = capture("POST", /\/v1\/auth\/logout$/);
    await api.logout();
    expect(box.url).toBeNull();
    expect(getTokens()).toBeNull();
  });

  it("an update without a name leaves the name out", async () => {
    const box = capture("PUT", /\/v1\/farm$/);
    await api.updateFarm({ timezone: "America/Lima" }).catch(() => undefined);
    const body = await sent(box);
    expect(body).not.toHaveProperty("name");
    expect(body.timezone).toBe("America/Lima");
  });

  it("a farm created from the console with no slug in the answer still opens", async () => {
    server.use(
      http.post("*/v1/admin/farms", () =>
        HttpResponse.json({
          id: ID,
          name: "Nueva",
          status: "active",
          createdAt: "2026-09-01T00:00:00Z",
          ownerEmail: "a@b.co",
          ownerCreated: true,
        }),
      ),
    );
    const created = await api.adminCreateFarm({
      name: "Nueva",
      slug: "nueva",
      priceCents: 100,
      timezone: "America/Bogota",
      currency: "COP",
      owner: { email: "a@b.co", name: "", password: "" },
    } as Parameters<typeof api.adminCreateFarm>[0]);
    expect(created.ownerEmail).toBe("a@b.co");
  });
});

describe("plots", () => {
  it("creates with a drawn boundary and a point, and edits without touching either", async () => {
    const boundary = {
      type: "Polygon",
      coordinates: [[[-75, 5], [-75.001, 5], [-75.001, 5.001], [-75, 5]]],
    } as never;
    const created = capture("POST", /\/v1\/plots$/);
    await api
      .createPlot({
        id: ID,
        name: "Nuevo",
        department: "",
        municipality: "",
        areaHa: 1,
        boundary,
        location: undefined,
        crops: [],
      })
      .catch(() => undefined);
    const body = await sent(created);
    expect(body.boundary).toEqual(boundary);
    expect(body.location).toBeNull();

    server.events.removeAllListeners();
    const edited = capture("PATCH", /\/v1\/plots\//);
    await api.updatePlot(ID, { name: "Otro" }).catch(() => undefined);
    const patch = await sent(edited);
    expect(patch).not.toHaveProperty("boundary");
    expect(patch).not.toHaveProperty("location");
  });

  it("sends a redrawn boundary and an erased point on edit", async () => {
    const boundary = { type: "Polygon", coordinates: [] } as never;
    const edited = capture("PATCH", /\/v1\/plots\//);
    await api.updatePlot(ID, { boundary, location: undefined }).catch(() => undefined);
    const patch = await sent(edited);
    expect(patch.boundary).toEqual(boundary);
    expect(patch.location).toBeNull();
  });

  it("names the plots a new boundary overlaps, and reads a reply with no list", async () => {
    const plot = { id: ID, name: "Uno", status: "active", crops: [] };
    server.use(
      http.put("*/v1/plots/:id/boundary", () =>
        HttpResponse.json({ plot, overlaps: [{ id: "p2", name: "Dos", extra: 1 }] }),
      ),
    );
    expect((await api.setPlotBoundary(ID, {})).overlaps).toEqual([{ id: "p2", name: "Dos" }]);
    server.use(http.put("*/v1/plots/:id/boundary", () => HttpResponse.json({ plot })));
    expect((await api.setPlotBoundary(ID, {})).overlaps).toEqual([]);
  });
});

describe("workers", () => {
  it("reads a profile that sent no tasks, ledger or notes as empty lists", async () => {
    const wire = await request<Record<string, unknown>>(
      "GET",
      `/v1/workers/${MARIA}/profile?limit=50`,
    );
    server.use(
      http.get("*/v1/workers/:id/profile", () =>
        HttpResponse.json({ worker: wire.worker, balance: wire.balance }),
      ),
    );
    const p = await api.workerProfile(MARIA);
    expect(p.workRecords).toEqual([]);
    expect(p.ledger).toEqual([]);
    expect(p.notes).toEqual([]);
  });

  it("re-sends a note with the id and the day it was first given", async () => {
    const box = capture("POST", /\/v1\/workers\/[^/]+\/notes$/);
    await api.addNote(MARIA, "Llegó tarde", { id: ID, date: "2026-08-03" }).catch(() => undefined);
    expect(await sent(box)).toMatchObject({ id: ID, text: "Llegó tarde", date: "2026-08-03" });
  });

  it("a first note mints its own id and leaves the day to the server", async () => {
    const box = capture("POST", /\/v1\/workers\/[^/]+\/notes$/);
    await api.addNote(MARIA, "Buen día").catch(() => undefined);
    const body = await sent(box);
    expect(String(body.id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).not.toHaveProperty("date");
  });
});

describe("activities", () => {
  it("renames nothing when only the category changed", async () => {
    const act = db.tenantOf(db.FARM_ID)!.activities[0];
    const box = capture("PATCH", /\/v1\/activities\//);
    await api.updateActivity(act.id, { category: "Cosecha" }).catch(() => undefined);
    const body = await sent(box);
    expect(body).not.toHaveProperty("name");
  });

  it("a rate with no start day leaves the day to the server", async () => {
    const box = capture("PUT", /\/v1\/activities\/[^/]+\/rate$/);
    await api.setActivityRate(ID, 5000, "").catch(() => undefined);
    expect(await sent(box)).toEqual({ rateCents: 5000 });
  });

  it("a per-unit activity with no unit is priced per kilo", async () => {
    server.use(
      http.get("*/v1/catalogs/work-units", () => HttpResponse.json({ items: [] })),
      http.post("*/v1/catalogs/work-units", async ({ request: req }) => {
        const b = (await req.json()) as { code: string };
        return HttpResponse.json({ id: "unit-kg", code: b.code, label: b.code });
      }),
    );
    const units = capture("POST", /\/v1\/catalogs\/work-units$/);
    await api
      .createActivity({
        id: ID,
        name: "Pesada",
        category: "Cosecha",
        payMode: "work_unit",
        workUnit: "",
        rateSource: "fixed",
        defaultRateCents: 100,
      })
      .catch(() => undefined);
    expect(await sent(units)).toEqual({ code: "kg", label: "kg" });
  });

  it("a weekly-price activity on a farm with no standing price is refused in Spanish", async () => {
    server.use(
      http.get("*/v1/farm", () =>
        HttpResponse.json({
          id: db.FARM_ID,
          name: "La Esperanza",
          slug: "x",
          timezone: "America/Bogota",
          currency: "COP",
        }),
      ),
    );
    await expect(
      api.createActivity({
        id: ID,
        name: "Recolección",
        category: "Cosecha",
        payMode: "time_unit",
        timeUnit: "jornal",
        rateSource: "weekly_price",
      }),
    ).rejects.toThrow(/todavía no tiene un precio base/);
  });
});

describe("work records and prices", () => {
  it("sends empty plot lists when the record names none", async () => {
    const box = capture("POST", /\/v1\/work-records$/);
    await api
      .createWorkRecord({
        id: ID,
        workerId: MARIA,
        activityId: ID,
        dateFrom: "2026-08-03",
        dateTo: "2026-08-03",
        quantity: 1,
      } as unknown as Parameters<typeof api.createWorkRecord>[0])
      .catch(() => undefined);
    expect(await sent(box)).toMatchObject({ plotIds: [], plotCropIds: [] });
  });

  it("puts a plot's special price under /lotes", async () => {
    const box = capture("PUT", /\/v1\/prices\/special\//);
    await api.setSpecialPrice("lote", ID, "2026-08-05", 900).catch(() => undefined);
    await sent(box);
    expect(box.url!.pathname).toBe(`/v1/prices/special/lotes/${ID}/2026-08-03`);
  });

  it("removes a plot's special price under /lotes", async () => {
    const box = capture("DELETE", /\/v1\/prices\/special\//);
    await api.deleteSpecialPrice("lote", ID, "2026-08-05").catch(() => undefined);
    await sent(box);
    expect(box.url!.pathname).toBe(`/v1/prices/special/lotes/${ID}/2026-08-03`);
  });
});

describe("settlements", () => {
  it("previews the named lines, and reads a reply with no lines or balance as empty", async () => {
    const box = capture("POST", /\/v1\/settlements\/preview$/);
    server.use(
      http.post("*/v1/settlements/preview", () => HttpResponse.json({ grossCents: 500 })),
    );
    const p = await api.previewSettlement(MARIA, [ID]);
    expect((await sent(box)).payableIds).toEqual([ID]);
    expect(p).toEqual({ lines: [], grossCents: 500, balanceCents: 0 });
  });

  it("passes a gross conflict through untouched when its figures are unreadable", async () => {
    server.use(http.post("*/v1/settlements", () => conflict({ expectedCents: "x" })));
    const err = await api
      .settle(MARIA, [ID], { expectedGrossCents: 100 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(grossChangeOf(err)).toBeNull();
  });

  it("explains a gross conflict even when the caller kept no lines", async () => {
    server.use(
      http.post("*/v1/settlements", () =>
        conflict({ expectedCents: 100, actualCents: 250, payableIdsProvided: true }),
      ),
    );
    const err = await api
      .settle(MARIA, [ID], { expectedGrossCents: 100 })
      .catch((e: unknown) => e);
    expect(grossChangeOf(err)).toMatchObject({ beforeCents: 100, afterCents: 250, removed: [] });
  });

  it("names the worker with a dash and counts no lines when the list says neither", async () => {
    server.use(
      http.get("*/v1/settlements", () =>
        HttpResponse.json({
          items: [
            {
              id: SETTLEMENT,
              workerId: ID,
              periodStart: "2026-08-03",
              periodEnd: "2026-08-09",
              grossCents: 100,
              status: "open",
              createdAt: "2026-08-10T00:00:00Z",
            },
          ],
        }),
      ),
    );
    const list = await api.listSettlements();
    expect(list.items[0]).toMatchObject({ workerName: "—", lineCount: 0 });
  });

  it("falls back to the ledgers when the list route is missing", async () => {
    server.use(
      http.get("*/v1/settlements", () =>
        HttpResponse.json({ error: { code: "METHOD_NOT_ALLOWED", message: "x" } }, { status: 405 }),
      ),
    );
    const list = await api.listSettlements();
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.unreadableLedgers).toBe(0);
    expect(list.items.every((s) => s.workerName !== "")).toBe(true);
  });

  it("reads a settlement detail with no lines as empty", async () => {
    const wire = await request<Record<string, unknown>>("GET", `/v1/settlements/${SETTLEMENT}`);
    server.use(
      http.get("*/v1/settlements/:id", () => HttpResponse.json({ ...wire, items: undefined })),
    );
    const s = await api.getSettlement(SETTLEMENT);
    expect(s.lines).toEqual([]);
    expect(s.voidedLineIds).toEqual([]);
  });

  it("reads a GROSS_CHANGED error without figures as no explanation", () => {
    const e = new ApiError(409, { error: { code: GROSS_CHANGED, message: "x", details: {} } });
    expect(grossChangeOf(e)).toBeNull();
  });
});

describe("money in and out", () => {
  it("a payment and an advance say which member took the cash", async () => {
    const pay = capture("POST", /\/v1\/payments$/);
    await api
      .createPayment({ id: ID, workerId: MARIA, amountCents: 100, method: "efectivo", receivedBy: OWNER })
      .catch(() => undefined);
    expect(await sent(pay)).toMatchObject({ receivedBy: OWNER });

    const adv = capture("POST", /\/v1\/advances$/);
    await api
      .createAdvance({ id: ID, workerId: MARIA, amountCents: 100, method: "efectivo", receivedBy: OWNER })
      .catch(() => undefined);
    expect(await sent(adv)).toMatchObject({ receivedBy: OWNER });
  });

  it("a deduction with no day leaves the day to the server", async () => {
    const box = capture("POST", /\/v1\/deductions$/);
    await api
      .createDeduction({ id: ID, workerId: MARIA, amountCents: -100, concept: "Botas", date: "" })
      .catch(() => undefined);
    const body = await sent(box);
    expect(body).not.toHaveProperty("date");
    expect(body.amountCents).toBe(100);
  });
});

describe("inventory and sales", () => {
  it("asks for a page of stock moves by its size", async () => {
    const box = capture("GET", /\/v1\/stock\/moves$/);
    await api.listStockMoves({ limit: 20 }).catch(() => undefined);
    await sent(box);
    expect(box.url!.searchParams.get("limit")).toBe("20");
  });

  it("asks for stock moves without a page size when none is given", async () => {
    const box = capture("GET", /\/v1\/stock\/moves$/);
    await api.listStockMoves().catch(() => undefined);
    await sent(box);
    expect(box.url!.searchParams.has("limit")).toBe(false);
  });

  it("a move with no day is today's, and a bare reply is read as the move", async () => {
    const box = capture("POST", /\/v1\/stock\/moves$/);
    const wireMove = {
      id: ID,
      productId: "p",
      product: "Abono",
      warehouseId: "w",
      warehouse: "Bodega",
      plotId: null,
      plot: null,
      plotCropId: null,
      qty: 2,
      reason: "compra",
      note: null,
      createdAt: "2026-08-03T00:00:00Z",
    };
    server.use(http.post("*/v1/stock/moves", () => HttpResponse.json(wireMove)));
    const res = await api.createStockMove({
      id: ID,
      productId: "p",
      warehouseId: "w",
      qty: 2,
      reason: "compra",
    } as Parameters<typeof api.createStockMove>[0]);
    expect(await sent(box)).not.toHaveProperty("localDay");
    expect(res.move.productName).toBe("Abono");
    expect(res.labelBatch).toBeNull();
  });

  it("a sale does not allow negative stock unless asked, and an edit may move its day", async () => {
    const box = capture("POST", /\/v1\/sales$/);
    await api
      .createSale({
        id: ID,
        productId: "p",
        warehouseId: "w",
        quantity: 1,
        amountCents: 100,
        date: "2026-08-03",
      })
      .catch(() => undefined);
    expect((await sent(box)).allowNegativeStock).toBe(false);

    const edit = capture("PATCH", /\/v1\/sales\//);
    await api.updateSale(ID, { date: "2026-08-04" }).catch(() => undefined);
    expect(String((await sent(edit)).localDay)).toMatch(/^2026-08-04T/);
  });

  it("a product edit without a name leaves the name out", async () => {
    const box = capture("PATCH", /\/v1\/products\//);
    await api.updateProduct(ID, { note: "x" }).catch(() => undefined);
    expect(await sent(box)).not.toHaveProperty("name");
  });
});
