// SPDX-License-Identifier: MIT
/**
 * The kilo price rules kept on the device (offline/priceBook.ts).
 *
 * What must hold: the estimate a phone gives with no signal is the one the
 * server would give — persona > lote > semana > finca, each dated by the
 * weighing's Monday — and not the farm's base price for everybody.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setTokens } from "../api/client";
import { invalidateRefs } from "../api/refs";
import * as db from "../mocks/db";
import { server } from "../mocks/node";
import { amountCents } from "../../../../packages/shared/src/money";
import {
  EMPTY_BOOK, ensureWeek, kiloPriceFor, loadPriceBook, recentMondays, syncPriceBook, withWeeks,
} from "./priceBook";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const tenant = () => db.tenantOf(db.FARM_ID)!;

function signIn(userId: string) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

/** The San José set-up: base $800, one week at $900, a lote at $950, a person at $1.000. */
function seedSanJose() {
  const t = tenant();
  const [jose, other] = t.workers;
  const [mirador, bajio] = t.plots;
  t.basePrices = [{ validFrom: "2000-01-03", priceCents: 80_000, createdAt: "" }];
  t.weekPrices = [{ weekStart: "2026-09-07", priceCents: 90_000 }];
  t.specialPrices = [
    { kind: "lote", targetId: mirador.id, validFrom: "2026-08-17", priceCents: 95_000, createdAt: "" },
    { kind: "persona", targetId: jose.id, validFrom: "2026-09-14", priceCents: 100_000, createdAt: "" },
  ];
  return { jose: jose.id, other: other.id, mirador: mirador.id, bajio: bajio.id };
}

const noSignal = () =>
  server.use(
    http.get("*/v1/prices/*", () => HttpResponse.error()),
  );

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signIn(OWNER);
});

describe("recentMondays", () => {
  it("is this Monday and the ones before it", () => {
    expect(recentMondays("2026-09-24", 3)).toEqual(["2026-09-21", "2026-09-14", "2026-09-07"]);
  });
});

describe("the price book synced to the device", () => {
  it("resolves every priority level like the server, and keeps doing it with no signal", async () => {
    const ids = seedSanJose();
    const online = await syncPriceBook(db.FARM_ID, recentMondays("2026-09-24"));
    expect(online).not.toBeNull();

    noSignal();
    const book = await syncPriceBook(db.FARM_ID, recentMondays("2026-09-24"));
    expect(book).toEqual(online);

    const at = (workerId: string, plotId: string, day: string) =>
      kiloPriceFor(book!, { workerId, plotIds: [plotId], day })?.priceCents;

    // Persona beats lote, from its Monday on.
    expect(at(ids.jose, ids.mirador, "2026-09-24")).toBe(100_000);
    expect(at(ids.jose, ids.bajio, "2026-09-16")).toBe(100_000);
    // Before José's own price started, the lote's applies…
    expect(at(ids.jose, ids.mirador, "2026-09-09")).toBe(95_000);
    // …and the lote beats the week's own price.
    expect(at(ids.other, ids.mirador, "2026-09-09")).toBe(95_000);
    // The week's own price beats the base, only in that week.
    expect(at(ids.other, ids.bajio, "2026-09-09")).toBe(90_000);
    expect(at(ids.other, ids.bajio, "2026-09-24")).toBe(80_000);

    // What the owner reads on the form: 40 kg for José at $1.000, not $800.
    expect(amountCents(40, at(ids.jose, ids.bajio, "2026-09-24")!)).toBe(4_000_000);
  });

  it("agrees with the mock server's kilo_price() for every person, lote and week", async () => {
    seedSanJose();
    const mondays = recentMondays("2026-09-24");
    const book = (await syncPriceBook(db.FARM_ID, mondays))!;
    const t = tenant();
    for (const w of t.workers) {
      for (const p of t.plots) {
        for (const monday of mondays) {
          expect(kiloPriceFor(book, { workerId: w.id, plotIds: [p.id], day: monday })?.priceCents)
            .toBe(db.kiloPriceOf(t, { workerId: w.id, plotIds: [p.id] }, monday).priceCents);
        }
      }
    }
  });

  it("with no signal and nothing kept, says nothing rather than guess", async () => {
    noSignal();
    expect(await syncPriceBook(db.FARM_ID, recentMondays("2026-09-24"))).toBeNull();
    expect(await loadPriceBook(db.FARM_ID)).toBeNull();
  });

  it("a price changed on the server replaces the device's copy on the next sync", async () => {
    const ids = seedSanJose();
    await syncPriceBook(db.FARM_ID, recentMondays("2026-09-24"));
    tenant().specialPrices!.push({ kind: "persona", targetId: ids.jose, validFrom: "2026-09-21", priceCents: null, createdAt: "" });
    const book = (await syncPriceBook(db.FARM_ID, recentMondays("2026-09-24")))!;
    expect(kiloPriceFor(book, { workerId: ids.jose, plotIds: [ids.mirador], day: "2026-09-24" })?.priceCents).toBe(95_000);
    expect(kiloPriceFor(book, { workerId: ids.jose, plotIds: [ids.mirador], day: "2026-09-16" })?.priceCents).toBe(100_000);
  });

  it("fetches a week outside the synced ones when online, and falls back to the base offline", async () => {
    seedSanJose();
    tenant().weekPrices.push({ weekStart: "2026-06-01", priceCents: 70_000 });
    const book = (await syncPriceBook(db.FARM_ID, ["2026-09-21"]))!;
    const other = tenant().workers[1].id;
    const bajio = tenant().plots[1].id;
    // Without the week, the base history answers.
    expect(kiloPriceFor(book, { workerId: other, plotIds: [bajio], day: "2026-06-03" })?.priceCents).toBe(80_000);
    const more = await ensureWeek(db.FARM_ID, book, "2026-06-01");
    expect(kiloPriceFor(more, { workerId: other, plotIds: [bajio], day: "2026-06-03" })?.priceCents).toBe(70_000);
    expect((await loadPriceBook(db.FARM_ID))!.weekPrices.some((w) => w.weekStart === "2026-06-01")).toBe(true);

    noSignal();
    const same = await ensureWeek(db.FARM_ID, book, "2026-05-25");
    expect(same).toBe(book);
  });
});

describe("withWeeks", () => {
  it("replaces the Mondays asked about and drops a week that no longer has its own price", () => {
    const a = withWeeks(EMPTY_BOOK, ["2026-09-07"], [{ weekStart: "2026-09-07", priceCents: 90_000 }]);
    const b = withWeeks(a, ["2026-09-07", "2026-09-14"], [{ weekStart: "2026-09-14", priceCents: 91_000 }]);
    expect(b.weekPrices).toEqual([{ weekStart: "2026-09-14", priceCents: 91_000 }]);
  });
});
