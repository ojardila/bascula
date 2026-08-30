/**
 * Does the mock still behave like the server?
 *
 * The mock exists so the unit suite can run without Docker, and it is only
 * worth having while it agrees with `services/api`. The moment it drifts, every
 * test that passes against it is testing a fiction — which is exactly what
 * happened in Sprint 1, when 72 green tests coexisted with a `POST /v1/signup`
 * that had been a 400 from the day it was written.
 *
 * So the mock gets its own contract test. These cases drive it over HTTP and
 * assert the things that are properties of the REAL API — the error codes from
 * `internal/domain/errors.go`, the role matrix from `internal/auth/perm.go`,
 * the `{items}` envelope, the refresh rotation, the settle-then-pay ordering,
 * and the peso arithmetic. Every assertion here was checked against the Go
 * handlers, not against the mock's own behaviour.
 *
 * This is the cheap half of the check. The expensive half is `e2e/live-api.test.ts`,
 * which runs the same journey against a real server and a real database. This
 * one runs on every save; that one runs when somebody has the API up. Between
 * them there is nowhere for a divergence to hide for long.
 */
import { describe, expect, it, beforeEach } from "vitest";
import * as db from "./db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";
const EDINSON = "0192f3a0-0006-7000-8000-000000000004";

function tok(id: string) {
  const now = Date.now();
  return `mock-access.${id}.${db.FARM_ID}.${now}.${now + 900_000}`;
}
const H = (id: string) => ({ Authorization: `Bearer ${tok(id)}`, "Content-Type": "application/json" });

async function get(path: string, id: string) {
  const res = await fetch(path, { headers: H(id) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}
async function post(path: string, id: string, body?: unknown) {
  const res = await fetch(path, { method: "POST", headers: H(id), body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}
async function patchJson(path: string, id: string, body?: unknown) {
  const res = await fetch(path, { method: "PATCH", headers: H(id), body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}
async function del(path: string, id: string) {
  const res = await fetch(path, { method: "DELETE", headers: H(id) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

beforeEach(() => db.resetDb());

describe("the mock is the server", () => {
  it("health and me", async () => {
    const h = await fetch("/health");
    expect(await h.json()).toEqual({ status: "ok" });
    const me = await get("/v1/me", OWNER);
    expect(me.body).toMatchObject({ role: "owner", superadmin: false });
    expect(me.body.farm).toEqual({
      id: db.FARM_ID, name: "La Esperanza", timezone: "America/Bogota", currency: "COP",
    });
    expect(me.body.memberships).toBeUndefined();
  });

  it("login answers a session and no user", async () => {
    const res = await fetch("/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "oscar@laesperanza.co", password: "esperanza" }),
    });
    const s = await res.json();
    expect(res.status).toBe(200);
    expect(s).toMatchObject({ expiresIn: 900, farmName: "La Esperanza", role: "owner" });
    expect(s.user).toBeUndefined();

    const bad = await fetch("/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "oscar@laesperanza.co", password: "nope" }),
    });
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rotates refresh tokens and refuses a reuse", async () => {
    const login = await (await fetch("/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "oscar@laesperanza.co", password: "esperanza" }),
    })).json();
    const first = await fetch("/v1/auth/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    });
    expect(first.status).toBe(200);
    const again = await fetch("/v1/auth/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    });
    expect(again.status).toBe(401);
    expect((await again.json()).error.code).toBe("TOKEN_REUSED");
  });

  it("expires an access token so the client can refresh", async () => {
    const t = tok(OWNER);
    db.expireAccessTokens();
    const res = await fetch("/v1/me", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("TOKEN_EXPIRED");
  });

  it("signup validates like the real handler", async () => {
    const bad = await fetch("/v1/signup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ farm: { name: "X", priceCents: 1 }, owner: { email: "a@b.co", password: "short" } }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("BAD_REQUEST");

    const ok = await fetch("/v1/signup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        farm: { name: "El Mirador", priceCents: 90000 },
        owner: { email: "h@elmirador.co", name: "H", password: "unacontrasena" },
      }),
    });
    expect(ok.status).toBe(201);
    const body = await ok.json();
    expect(body.verificationRequired).toBe(true);
    expect(body.verificationToken).toBeTruthy();

    const blocked = await fetch("/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "h@elmirador.co", password: "unacontrasena" }),
    });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.code).toBe("EMAIL_NOT_VERIFIED");

    await fetch("/v1/auth/verify-email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: body.verificationToken }),
    });
    const now = await fetch("/v1/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "h@elmirador.co", password: "unacontrasena" }),
    });
    expect(now.status).toBe(200);
    // A brand new farm is empty but for the seed.
    const s = await now.json();
    const acc = { Authorization: `Bearer ${s.accessToken}` };
    const w = await (await fetch("/v1/workers", { headers: acc })).json();
    expect(w.items).toEqual([]);
    const a = await (await fetch("/v1/activities", { headers: acc })).json();
    expect(a.items.map((x: { name: string }) => x.name)).toEqual(["Recoleccion"]);
  });

  it("gives the weigher narrow projections and 403 on money", async () => {
    const list = await get("/v1/workers", WEIGHER);
    expect(list.status).toBe(200);
    for (const row of list.body.items) {
      expect(Object.keys(row).sort()).toEqual(["id", "lastName", "name", "tag"]);
    }
    const acts = await get("/v1/activities", WEIGHER);
    for (const a of acts.body.items) expect("rate" in a).toBe(false);

    for (const path of [
      `/v1/workers/${MARIA}/profile`, "/v1/balances", `/v1/workers/${MARIA}/balance`,
      `/v1/workers/${MARIA}/ledger`, "/v1/pending?workerId=x&from=2026-08-01&to=2026-08-31",
      "/v1/prices/weeks/2026-08-24", `/v1/activities/${"0192f3a0-0007-7000-8000-000000000002"}/rates`,
    ]) {
      const r = await get(path, WEIGHER);
      expect([path, r.status]).toEqual([path, 403]);
      expect(r.body.error.code).toBe("FORBIDDEN");
    }
    for (const path of ["/v1/payments", "/v1/advances", "/v1/deductions", "/v1/adjustments",
      "/v1/settlements", "/v1/settlements/preview", "/v1/ledger/x/reverse"]) {
      const r = await post(path, WEIGHER, { workerId: MARIA, amountCents: 100 });
      expect([path, r.status]).toEqual([path, 403]);
    }
    // Admins do get in.
    expect((await get("/v1/balances", OWNER)).status).toBe(200);
  });

  it("keeps every figure of money out of the weigher's work records", async () => {
    // The double projects work records by role now, and nothing asserted that
    // it does — which is how a double stops being the server. The four keys
    // must be ABSENT rather than null: a null still tells the scale that a
    // price exists and is being withheld, and the raw body is the only place
    // that difference is visible.
    const MONEY = ["rateCents", "amountCents", "estimatedAmountCents", "amountIsEstimate"];
    const price = (await get("/v1/farm", OWNER)).body.priceCents as number;
    expect(typeof price).toBe("number");

    const created = await post("/v1/work-records", WEIGHER, {
      workerId: MARIA,
      // Recolección de café: priced by the week, which is the only kind of
      // work a weigher may record — and the reason the leak was total.
      activityId: "0192f3a0-0007-7000-8000-000000000001",
      quantity: 1,
      dateFrom: "2026-08-27",
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const bodies: Record<string, unknown> = {
      "POST /v1/work-records": created.body,
      "GET /v1/work-records": (await get("/v1/work-records", WEIGHER)).body,
      "GET /v1/work-records/{id}": (await get(`/v1/work-records/${id}`, WEIGHER)).body,
      // The two /v1/pickups facades are not in the double at all — they are
      // the handset's door and the console never calls them. They are covered
      // on the server side, in contract_test.go, where they exist.
      "PATCH /v1/work-records/{id}": (
        await patchJson(`/v1/work-records/${id}`, WEIGHER, { note: "x" })
      ).body,
    };
    for (const [route, body] of Object.entries(bodies)) {
      const raw = JSON.stringify(body);
      for (const key of MONEY) expect([route, key, raw.includes(key)]).toEqual([route, key, false]);
      // One kilo at the week's price IS the price of a kilo, so the digits
      // themselves must not be in the payload either.
      expect([route, raw.includes(String(price))]).toEqual([route, false]);
    }

    // And the owner still gets them, so the assertions above are not passing
    // because the amounts stopped being computed.
    const mine = await get(`/v1/work-records/${id}`, OWNER);
    for (const key of MONEY) expect([key, key in mine.body]).toEqual([key, true]);
    expect(mine.body.estimatedAmountCents).toBe(price);
  });

  it("keeps the wireframe figures to the peso", async () => {
    const bal = await get(`/v1/workers/${MARIA}/balance`, OWNER);
    expect(bal.body.balanceCents).toBe(18450000); // $184.500
    const pend = await get(
      `/v1/pending?workerId=${MARIA}&from=2026-08-01&to=2026-08-31`, OWNER);
    expect(pend.body.totalCents).toBe(15360000); // $153.600
    const kilos = pend.body.items.find((p: { payableId: string }) =>
      p.payableId === "0192f3a0-0008-7000-8000-000000000001");
    expect(kilos.amountCents).toBe(3080000); // 38,5 kg x $800
    expect(kilos.rateCents).toBe(80000);
    expect(typeof kilos.quantity).toBe("number");
    // Pending needs from and to.
    const bad = await get(`/v1/pending?workerId=${MARIA}`, OWNER);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("BAD_REQUEST");
  });

  it("settles, then pays, and refuses an overpayment", async () => {
    // `expectedGrossCents` is REQUIRED, exactly as `handleCreateSettlement`
    // requires it. Omitting it is a 400 and not a settlement: a money guard a
    // client may leave out is a guard that is off in the moment it matters.
    const noFigure = await post("/v1/settlements", OWNER, {
      id: crypto.randomUUID(), workerId: MARIA, from: "2026-08-01", to: "2026-08-31",
    });
    expect(noFigure.status).toBe(400);

    const settle = await post("/v1/settlements", OWNER, {
      id: crypto.randomUUID(), workerId: MARIA, from: "2026-08-01", to: "2026-08-31",
      expectedGrossCents: 15360000,
    });
    expect(settle.status).toBe(201);
    expect(settle.body.grossCents).toBe(15360000);
    // One devengo, and the balance moved by exactly the gross.
    const after = await get(`/v1/workers/${MARIA}/balance`, OWNER);
    expect(after.body.balanceCents).toBe(18450000 + 15360000);
    // Nothing left pending, and re-settling is a 409 — NOTHING_TO_SETTLE and
    // not GROSS_CHANGED, because the server establishes there is nothing to
    // price before it asks whether the price is the expected one.
    const again = await post("/v1/settlements", OWNER, {
      id: crypto.randomUUID(), workerId: MARIA, from: "2026-08-01", to: "2026-08-31",
      expectedGrossCents: 15360000,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("NOTHING_TO_SETTLE");

    const tooMuch = await post("/v1/payments", OWNER, {
      id: crypto.randomUUID(), workerId: MARIA, amountCents: 99_999_999, method: "efectivo",
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe("AMOUNT_EXCEEDS_BALANCE");
    expect(tooMuch.body.error.details.balanceCents).toBe(33810000);

    const paid = await post("/v1/payments", OWNER, {
      id: crypto.randomUUID(), workerId: MARIA, amountCents: 10000000, method: "efectivo",
    });
    expect(paid.status).toBe(201);
    expect(paid.body.kind).toBe("pago");
    expect(paid.body.amountCents).toBe(-10000000);

    // Voiding puts it all back.
    const voided = await post(`/v1/settlements/${settle.body.id}/void`, OWNER);
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe("void");
    const back = await get(`/v1/workers/${MARIA}/balance`, OWNER);
    expect(back.body.balanceCents).toBe(18450000 - 10000000);
  });

  it("refuses to delete a settled work record", async () => {
    const r = await fetch("/v1/work-records/0192f3a0-0008-7000-8000-000000000006", {
      method: "DELETE", headers: H(OWNER),
    });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("WORK_RECORD_SETTLED");
    const one = await get("/v1/work-records/0192f3a0-0008-7000-8000-000000000006", OWNER);
    expect(one.body.settled).toBe(true);
    expect(one.body.status).toBeUndefined();
  });

  it("creates work records the way handlers_work_records.go does", async () => {
    const weekly = "0192f3a0-0007-7000-8000-000000000001";
    const dated = "0192f3a0-0007-7000-8000-000000000006";
    // weekly_price leaves the price open
    const a = await post("/v1/work-records", OWNER, {
      id: crypto.randomUUID(), activityId: weekly, workerId: MARIA,
      quantity: 10, dateFrom: "2026-08-25",
    });
    expect(a.status).toBe(201);
    expect(a.body.rateCents).toBeNull();
    expect(a.body.amountCents).toBeNull();
    expect(a.body.weekStart).toBe("2026-08-24T00:00:00Z");
    expect(a.body.startedAt).toBe("2026-08-25T17:00:00Z");
    // Idempotent by id.
    const id = crypto.randomUUID();
    const b1 = await post("/v1/work-records", OWNER, {
      id, activityId: weekly, workerId: MARIA, quantity: 5, dateFrom: "2026-08-25" });
    const b2 = await post("/v1/work-records", OWNER, {
      id, activityId: weekly, workerId: MARIA, quantity: 5, dateFrom: "2026-08-25" });
    expect(b1.status).toBe(201);
    expect(b2.status).toBe(200);
    // A dated price over a range is refused.
    const c = await post("/v1/work-records", OWNER, {
      id: crypto.randomUUID(), activityId: dated, workerId: MARIA,
      quantity: 3, dateFrom: "2026-08-20", dateTo: "2026-08-22" });
    expect(c.status).toBe(400);
    expect(c.body.error.details.code).toBe("RANGE_NEEDS_FROZEN_RATE");
    // ...unless the rate is named.
    const d = await post("/v1/work-records", OWNER, {
      id: crypto.randomUUID(), activityId: dated, workerId: MARIA, rateCents: 350000,
      quantity: 3, dateFrom: "2026-08-20", dateTo: "2026-08-22" });
    expect(d.status).toBe(201);
    expect(d.body.rateSource).toBe("explicit");
    expect(d.body.amountCents).toBe(1050000);
    // A weigher may only record weekly-priced work.
    const e = await post("/v1/work-records", WEIGHER, {
      id: crypto.randomUUID(), activityId: dated, workerId: MARIA, quantity: 1, dateFrom: "2026-08-25" });
    expect(e.status).toBe(403);
  });

  it("logical deletes and 204s", async () => {
    const del = await fetch(`/v1/workers/${EDINSON}`, { method: "DELETE", headers: H(OWNER) });
    expect(del.status).toBe(204);
    const list = await get("/v1/workers", OWNER);
    expect(list.body.items.some((w: { id: string }) => w.id === EDINSON)).toBe(false);
    const all = await get("/v1/workers?includeDeleted=true", OWNER);
    expect(all.body.items.find((w: { id: string }) => w.id === EDINSON).deletedAt).toBeTruthy();

    const plot = await fetch("/v1/plots/0192f3a0-0004-7000-8000-000000000001", {
      method: "DELETE", headers: H(OWNER) });
    expect(plot.status).toBe(409);
    expect((await plot.json()).error.code).toBe("PLOT_HAS_ACTIVE_CROPS");
  });

  it("prices weeks by their Monday only", async () => {
    const ok = await get("/v1/prices/weeks/2026-08-24", OWNER);
    expect(ok.body).toEqual({ weekStart: "2026-08-24", priceCents: 80000 });
    const unset = await get("/v1/prices/weeks/2026-09-07", OWNER);
    expect(unset.body.priceCents).toBe(80000); // the farm's standing price
    const notMonday = await get("/v1/prices/weeks/2026-08-25", OWNER);
    expect(notMonday.status).toBe(400);
    const put = await fetch("/v1/prices/weeks/2026-08-31", {
      method: "PUT", headers: H(OWNER), body: JSON.stringify({ priceCents: 82000 }) });
    expect(put.status).toBe(200);
  });

  it("catalogues answer {items} and 200 on create", async () => {
    const l = await get("/v1/catalogs/crop-types", OWNER);
    expect(l.body.items.length).toBe(4);
    const c = await post("/v1/catalogs/crop-types", OWNER, { name: "café" });
    expect(c.status).toBe(200);
    expect(c.body.name).toBe("Café"); // idempotent by lower(name)
    const u = await get("/v1/catalogs/work-units", OWNER);
    expect(u.body.items[0]).toHaveProperty("kgFactor");
  });

  it("has a worker profile with tasks, not workRecords", async () => {
    const p = await get(`/v1/workers/${MARIA}/profile`, OWNER);
    expect(Object.keys(p.body).sort()).toEqual(["balance", "ledger", "notes", "tasks", "worker"]);
    expect(p.body.worker.docId).toBe("1045882331");
    expect(p.body.worker.documentNumber).toBeUndefined();
    expect(p.body.ledger[0]).toHaveProperty("kind");
    expect(p.body.ledger[0].concept).toBeUndefined();
  });

  it("reverses a ledger entry once", async () => {
    const target = "0192f3a0-0009-7000-8000-000000000003";
    const one = await post(`/v1/ledger/${target}/reverse`, OWNER, { note: "corrige" });
    expect(one.status).toBe(201);
    expect(one.body.amountCents).toBe(5000000);
    const two = await post(`/v1/ledger/${target}/reverse`, OWNER, {});
    expect(two.status).toBe(409);
    expect(two.body.error.code).toBe("ALREADY_REVERSED");
  });

  it("serves the payment screen in one call", async () => {
    const r = await get(`/v1/workers/${MARIA}/payables`, OWNER);
    expect(r.status).toBe(200);
    expect(r.body.grossCents).toBe(15360000);
    expect(r.body.balanceCents).toBe(18450000);
    expect(r.body.totalCents).toBe(33810000); // $338.100
    // Debts are shown, never subtracted again: they are inside balanceCents.
    expect(r.body.debts.map((d: { kind: string }) => d.kind).sort())
      .toEqual(["anticipo", "deduccion"]);
    expect((await get("/v1/workers/0192f3a0-0006-7000-8000-0000000000ff/payables", OWNER)).status)
      .toBe(404);
    expect((await get(`/v1/workers/${MARIA}/payables`, WEIGHER)).status).toBe(403);
  });

  it("keeps notes append-only and private", async () => {
    const l = await get(`/v1/workers/${MARIA}/notes`, OWNER);
    expect(l.body.items.length).toBe(2);
    expect(l.body.items[0].text).toContain("adelanto");
    const c = await post(`/v1/workers/${MARIA}/notes`, OWNER, { text: "Nueva nota", date: "2026-08-28" });
    expect(c.status).toBe(201);
    expect(c.body.date).toBe("2026-08-28T00:00:00Z");
    expect((await post(`/v1/workers/${MARIA}/notes`, OWNER, { text: "  " })).status).toBe(400);
    expect((await get(`/v1/workers/${MARIA}/notes`, WEIGHER)).status).toBe(403);
  });

  it("serves the farm, without the price for a weigher", async () => {
    const owner = await get("/v1/farm", OWNER);
    expect(owner.body.priceCents).toBe(80000);
    expect(owner.body.minorUnit).toBe(2);
    const weigher = await get("/v1/farm", WEIGHER);
    expect(weigher.status).toBe(200);
    expect("priceCents" in weigher.body).toBe(false);
    expect(weigher.body.timezone).toBe("America/Bogota");
    const put = await fetch("/v1/farm", {
      method: "PUT", headers: H(OWNER), body: JSON.stringify({ timezone: "Mars/Olympus" }) });
    expect(put.status).toBe(400);
    const ok = await fetch("/v1/farm", {
      method: "PUT", headers: H(OWNER), body: JSON.stringify({ name: "La Esperanza II" }) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).name).toBe("La Esperanza II");
  });

  it("keeps the console outside the farm", async () => {
    const SUPER = "0192f3a0-0001-7000-8000-000000000009";
    expect((await get("/v1/admin/farms", OWNER)).status).toBe(403);
    const l = await get("/v1/admin/farms", SUPER);
    expect(l.status).toBe(200);
    expect(l.body.items.length).toBe(4);
    for (const f of l.body.items) {
      expect(Object.keys(f).sort()).toEqual([
        "city", "country", "createdAt", "currency", "id", "name", "status", "suspendedAt", "timezone",
      ]);
    }
    expect(l.body.items.find((f: { name: string }) => f.name === "La Palma").status).toBe("suspended");
    const sus = await fetch("/v1/admin/farms/0192f3a0-0000-7000-8000-000000000002", {
      method: "PATCH", headers: H(SUPER), body: JSON.stringify({ status: "suspended" }) });
    expect(sus.status).toBe(200);
    expect((await sus.json()).status).toBe("suspended");
  });

  it("patches with a status transition, both ways", async () => {
    const off = await fetch(`/v1/workers/${EDINSON}`, {
      method: "PATCH", headers: H(OWNER), body: JSON.stringify({ status: "inactive" }) });
    expect(off.status).toBe(200);
    expect((await off.json()).deletedAt).toBeTruthy();
    const on = await fetch(`/v1/workers/${EDINSON}`, {
      method: "PATCH", headers: H(OWNER), body: JSON.stringify({ status: "active", phone: "3001112233" }) });
    const back = await on.json();
    expect(back.deletedAt).toBeNull();
    expect(back.phone).toBe("3001112233");
    const bad = await fetch(`/v1/workers/${EDINSON}`, {
      method: "PATCH", headers: H(OWNER), body: JSON.stringify({ status: "Inactive" }) });
    expect(bad.status).toBe(400);

    const act = "0192f3a0-0007-7000-8000-000000000002";
    const scheme = await fetch(`/v1/activities/${act}`, {
      method: "PATCH", headers: H(OWNER), body: JSON.stringify({ payScheme: "contrato" }) });
    expect(scheme.status).toBe(400);
    const arch = await fetch(`/v1/activities/${act}`, {
      method: "PATCH", headers: H(OWNER), body: JSON.stringify({ status: "inactive" }) });
    expect((await arch.json()).archivedAt).toBeTruthy();

    const wr = await fetch("/v1/work-records/0192f3a0-0008-7000-8000-000000000005", {
      method: "PATCH", headers: H(OWNER), body: JSON.stringify({ quantity: 20 }) });
    const patched = await wr.json();
    expect(patched.quantity).toBe(20);
    expect(patched.amountCents).toBe(7000000); // 20 x $3.500
    const settled = await fetch("/v1/work-records/0192f3a0-0008-7000-8000-000000000006", {
      method: "PATCH", headers: H(OWNER), body: JSON.stringify({ note: "x" }) });
    expect(settled.status).toBe(409);
  });

  /**
   * Everything in here was checked against the running server before it was
   * written down, because the sprint-1 version of this test asserted the
   * opposite of what the server does: it expected a Polygon back, and PostGIS
   * stores a MultiPolygon column and promotes with `ST_Multi`. A mock that
   * hands a Polygon back is a mock that lets the map screen be built on a
   * shape the first reload against production would break.
   *
   *     PUT square at 5,66 N -> 200, MultiPolygon, computedAreaHa 122.506
   *     PUT a bow tie        -> 400 INVALID_GEOMETRY "Self-intersection[...]"
   *     POST plot + boundary -> 201, stored, measured
   */
  it("stores a boundary the way PostGIS does: MultiPolygon out, measured, and validated", async () => {
    const drawn = await get("/v1/plots/0192f3a0-0004-7000-8000-000000000003", OWNER);
    expect(drawn.body.boundary.type).toBe("MultiPolygon");
    expect(drawn.body.computedAreaHa).toBe(5.69);

    const empty = await fetch("/v1/plots/0192f3a0-0004-7000-8000-000000000002/boundary", {
      method: "PUT", headers: H(OWNER), body: JSON.stringify({}) });
    expect(empty.status).toBe(400);

    // The example square out of `openapi.yaml`. PostGIS measures it at
    // 122,506 ha; anything wildly off means the area sum drifted.
    const put = await fetch("/v1/plots/0192f3a0-0004-7000-8000-000000000002/boundary", {
      method: "PUT", headers: H(OWNER),
      body: JSON.stringify({
        boundary: {
          type: "Polygon",
          coordinates: [[[-75.88, 5.66], [-75.87, 5.66], [-75.87, 5.67], [-75.88, 5.67], [-75.88, 5.66]]],
        },
      }) });
    expect(put.status).toBe(200);
    const body = await put.json();
    expect(body.plot.boundary.type).toBe("MultiPolygon");
    expect(body.plot.computedAreaHa).toBeCloseTo(122.506, 2);
    expect(body.overlaps).toEqual([]);

    // A bow tie: two sides cross, so there is no area anybody would agree on.
    const bowtie = await fetch("/v1/plots/0192f3a0-0004-7000-8000-000000000002/boundary", {
      method: "PUT", headers: H(OWNER),
      body: JSON.stringify({
        boundary: {
          type: "Polygon",
          coordinates: [[[-75.88, 5.66], [-75.87, 5.67], [-75.87, 5.66], [-75.88, 5.67], [-75.88, 5.66]]],
        },
      }) });
    expect(bowtie.status).toBe(400);
    expect((await bowtie.json()).error.code).toBe("INVALID_GEOMETRY");
  });

  /** Two lots on the same ground: a warning beside the stored polygon. */
  it("reports overlapping plots without refusing the write", async () => {
    const square = (west: number) => ({
      type: "Polygon",
      coordinates: [[[west, 5.66], [west + 0.01, 5.66], [west + 0.01, 5.67], [west, 5.67], [west, 5.66]]],
    });
    const first = await fetch("/v1/plots/0192f3a0-0004-7000-8000-000000000001/boundary", {
      method: "PUT", headers: H(OWNER), body: JSON.stringify({ boundary: square(-75.9) }) });
    expect(first.status).toBe(200);
    const second = await fetch("/v1/plots/0192f3a0-0004-7000-8000-000000000002/boundary", {
      method: "PUT", headers: H(OWNER), body: JSON.stringify({ boundary: square(-75.895) }) });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.plot.boundary).not.toBeNull();
    expect(body.overlaps.map((o: { name: string }) => o.name)).toContain("El Alto");
  });

  /** The form is one form: the shape drawn on it is stored with the rest. */
  it("stores a boundary sent with the plot itself", async () => {
    const res = await fetch("/v1/plots", {
      method: "POST", headers: H(OWNER),
      body: JSON.stringify({
        id: "0192f3a0-0004-7000-8000-0000000000aa",
        name: "Lote dibujado",
        areaHa: 1,
        department: "Caldas",
        municipality: "Chinchiná",
        crops: [{ cropType: "Café" }],
        boundary: {
          type: "Polygon",
          coordinates: [[[-75.885, 5.665], [-75.883, 5.665], [-75.883, 5.667], [-75.885, 5.667], [-75.885, 5.665]]],
        },
      }) });
    expect(res.status).toBe(201);
    const plot = await res.json();
    expect(plot.boundary.type).toBe("MultiPolygon");
    // PostGIS answers 4.9 for this square.
    expect(plot.computedAreaHa).toBeCloseTo(4.9, 1);
  });

  it("404s and unauthorises properly", async () => {
    const missing = await get("/v1/workers/0192f3a0-0006-7000-8000-0000000000ff", OWNER);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
    const anon = await fetch("/v1/me");
    expect(anon.status).toBe(401);
    expect((await anon.json()).error.code).toBe("UNAUTHORIZED");
  });
});

/**
 * PRODUCTOS, EXISTENCIAS, VENTAS Y GASTOS — RSP-018 … RSP-033.
 *
 * The routes landed mid-sprint, so this block was written twice: once against
 * the store layer alone, and then again against `openapi.yaml`,
 * `routes.go:125-182` and `handlers_{products,stock,sales,expenses}.go`. The
 * second pass moved five things, and each one is marked WAS below — they are
 * the places where a shape that looked obvious from the schema was not the
 * shape the contract published, and they are worth keeping visible rather than
 * quietly correcting.
 *
 * The two rules the interface is built on top of, and which this file's job is
 * to make impossible to build against by accident:
 *
 *   STOCK LEVELS ARE DERIVED. There is no stock column, no route that sets a
 *   quantity, and no way to edit a movement. The number on the screen is a
 *   SUM, every time.
 *
 *   AN EXPENSE IS CHARGED TO ONE THING. An activity, or a plot/crop. Not both and
 *   not neither — `expense_target` counts the two and demands exactly 1.
 */
describe("products, stock, sales and expenses", () => {
  const CATEGORY_RAW = "0192f3a0-000e-7000-8000-000000000001";
  const UNIT_BULTO = "0192f3a0-000f-7000-8000-000000000001";
  const MAIN_STORE = "0192f3a0-0010-7000-8000-000000000001";
  const WET_MILL = "0192f3a0-0010-7000-8000-000000000002";

  const PERGAMINO = "0192f3a0-0011-7000-8000-000000000001";
  const ABONO = "0192f3a0-0011-7000-8000-000000000003";

  const HARVEST_MOVE = "0192f3a0-0012-7000-8000-000000000004"; // +40 bultos pergamino
  const VOIDED_SALE_MOVE = "0192f3a0-0012-7000-8000-00000000000a";
  const VOID_REVERSAL = "0192f3a0-0012-7000-8000-00000000000b";

  const SALE = "0192f3a0-0014-7000-8000-000000000001";
  const VOIDED_SALE = "0192f3a0-0014-7000-8000-000000000002";
  const CUSTOMER = "0192f3a0-0013-7000-8000-000000000001";

  const EL_ALTO = "0192f3a0-0004-7000-8000-000000000001";
  const EL_ALTO_CAFE = "0192f3a0-0005-7000-8000-000000000001";
  const BAJO_DEL_RIO = "0192f3a0-0004-7000-8000-000000000003";
  const GUADANADA = "0192f3a0-0007-7000-8000-000000000002";

  const move = (extra: Record<string, unknown>) => ({
    productId: ABONO,
    warehouseId: MAIN_STORE,
    localDay: "2026-08-27",
    ...extra,
  });

  /* -- existencias -------------------------------------------------- */

  it("derives what is on the shelf from the movements, and stores no total", async () => {
    const list = await get("/v1/products", OWNER);
    expect(list.status).toBe(200);
    const byName = Object.fromEntries(
      list.body.items.map((p: { name: string; stock: number }) => [p.name, p.stock]),
    );
    // 1200 + 860 − 2000, 40 − 12 − 5 + 5, 25 − 8 − 1, 6. Not one of these is
    // written anywhere in the seed: `productCols` sums them on every read.
    expect(byName["Café cereza"]).toBe(60);
    expect(byName["Café pergamino seco"]).toBe(28);
    expect(byName["Abono compuesto"]).toBe(16);
    expect(byName["Fungicida"]).toBe(6);

    // And the total moves the moment a movement is appended — nothing to
    // refresh, because there is nothing that could be stale.
    const added = await post("/v1/stock/moves", OWNER, move({ qty: 4, reason: "compra" }));
    expect(added.status).toBe(201);
    const again = await get(`/v1/products/${ABONO}`, OWNER);
    expect(again.body.stock).toBe(20);
  });

  it("offers no way at all to set a quantity", async () => {
    // There is no PATCH and no PUT on a movement: `stock_moves_is_append_only()`
    // raises on both, and `REVOKE UPDATE, DELETE ON stock_moves` is the belt to
    // that brace. MSW answers an unhandled route by throwing, so an absent
    // route is a rejected fetch and not a 404 — which is the point: the route
    // is not there to be called.
    await expect(
      fetch(`/v1/stock/moves/${HARVEST_MOVE}`, { method: "PATCH", headers: H(OWNER), body: "{}" }),
    ).rejects.toBeTruthy();

    // Nor does the product accept one. `stock` is not in `NewProduct`, and the
    // patch handler simply has nothing to put it in.
    const patched = await patchJson(`/v1/products/${ABONO}`, OWNER, { stock: 999 });
    expect(patched.status).toBe(200);
    expect(patched.body.stock).toBe(16);
  });

  it("reads stock per warehouse, and hides the pairs that net to zero", async () => {
    const levels = await get("/v1/stock", OWNER);
    expect(levels.status).toBe(200);
    // WAS `{items}`. The envelope carries the sum of what it lists.
    expect(levels.body.total).toBe(110); // 60 + 28 + 16 + 6
    const rows = levels.body.items as Array<{ product: string; warehouse: string; qty: number }>;
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.product === "Café cereza")).toMatchObject({
      warehouse: "Beneficiadero",
      storageUnit: "Kilo",
      qty: 60,
    });
    // `stock_levels` carries `HAVING SUM(qty) <> 0`, so a product that came in
    // and went out again is absent rather than present as a zero. A page of
    // zeroes for everything the farm ever touched is a page nobody reads.
    expect(rows.some((r) => r.product === "Café pasilla")).toBe(false);

    const narrowed = await get(`/v1/stock?warehouseId=${WET_MILL}`, OWNER);
    expect(narrowed.body.items).toHaveLength(1);

    // `confirmOurs`: a narrowing id is checked BEFORE it is summed, because a
    // sum over somebody else's id answers 0, and "0 bultos" is a perfectly
    // credible wrong answer.
    const foreign = await get("/v1/stock?productId=0192f3a0-0011-7000-8000-0000000000ff", OWNER);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.message).toMatch(/no product with that id on this farm/);
  });

  it("breaks one product down by warehouse, and 404s for one that is not ours", async () => {
    // A route that did not exist when this block was first written.
    const res = await get(`/v1/products/${PERGAMINO}/stock`, OWNER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ productId: PERGAMINO, total: 28 });
    expect(res.body.byWarehouse).toEqual([
      expect.objectContaining({ warehouse: "Bodega principal", qty: 28 }),
    ]);
    // The sharpest form of the zero trap in this module — one product, one
    // number — so it is a 404 and never a believable zero.
    expect((await get("/v1/products/0192f3a0-0011-7000-8000-0000000000ff/stock", OWNER)).status)
      .toBe(404);
  });

  /* -- stock_sign --------------------------------------------------- */

  it("applies the sign the reason implies instead of refusing the caller's", async () => {
    // WAS: a mismatched sign was a 400. It is not — `handleCreateStockMove`
    // FLIPS it. "The sign follows from the reason rather than from the caller,
    // so a client that sends 40 for a merma gets a merma of 40 out and not a
    // refusal it has to guess its way out of." The database still checks the
    // pair; the flip is the courtesy, not the guarantee.
    //
    // This one mattered: a screen built against the refusal would have shipped
    // a validation error the server never sends.
    const cases: Array<[string, number, number]> = [
      ["cosecha", 5, 5],
      ["cosecha", -5, 5],
      ["compra", 5, 5],
      ["compra", -5, 5],
      ["consumo", -5, -5],
      ["consumo", 5, -5],
      ["merma", -5, -5],
      ["merma", 5, -5],
      // traslado and ajuste are the two `stock_sign` leaves free, so there is
      // nothing to infer and the caller's sign stands.
      ["traslado", 5, 5],
      ["traslado", -5, -5],
      ["ajuste", 5, 5],
      ["ajuste", -5, -5],
    ];
    for (const [reason, sent, stored] of cases) {
      const res = await post(
        "/v1/stock/moves",
        OWNER,
        move({ qty: sent, reason, allowNegative: true }),
      );
      expect([reason, sent, res.status]).toEqual([reason, sent, 201]);
      expect([reason, sent, res.body.move.qty]).toEqual([reason, sent, stored]);
    }

    // `CHECK (qty <> 0)`.
    const zero = await post("/v1/stock/moves", OWNER, move({ qty: 0, reason: "ajuste" }));
    expect(zero.status).toBe(400);

    // The enum is closed, and the 400 names the seven so nobody has to guess.
    const unknown = await post("/v1/stock/moves", OWNER, move({ qty: 1, reason: "donacion" }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toMatch(/cosecha, compra, venta, consumo, merma/);
  });

  it("refuses a 'venta' movement with no sale behind it", async () => {
    // stock_venta_has_sale. This is what keeps the sales list and the
    // warehouse from ever contradicting each other: there is no way to write
    // the movement without the sale.
    const res = await post("/v1/stock/moves", OWNER, move({ qty: -1, reason: "venta" }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/record the sale at POST \/v1\/sales/);
  });

  it("keeps a crop with the plot it was named with", async () => {
    // stock_crop_needs_plot.
    const orphan = await post(
      "/v1/stock/moves",
      OWNER,
      move({ qty: 1, reason: "compra", plotCropId: EL_ALTO_CAFE }),
    );
    expect(orphan.status).toBe(400);
    expect(orphan.body.error.message).toMatch(/needs the plotId/);

    // check_stock_move_crop(): "lote 3, café del lote 7" would make every
    // per-plot report quietly wrong.
    const mismatched = await post(
      "/v1/stock/moves",
      OWNER,
      move({ qty: 1, reason: "compra", plotId: BAJO_DEL_RIO, plotCropId: EL_ALTO_CAFE }),
    );
    expect(mismatched.status).toBe(400);
    expect(mismatched.body.error.message).toMatch(/is not planted in plot/);

    const good = await post(
      "/v1/stock/moves",
      OWNER,
      move({ qty: 1, reason: "compra", plotId: EL_ALTO, plotCropId: EL_ALTO_CAFE }),
    );
    expect(good.status).toBe(201);
    // WAS a bare movement. It is `{move, labelBatch?}` — an envelope, because
    // the stickers are asked for on the movement itself.
    expect(good.body.move.plot).toBe("El Alto");
    expect(good.body.labelBatch).toBeUndefined();

    // A plot of another farm is a 404 from `confirmOurs`, before anything is
    // written.
    const foreign = await post(
      "/v1/stock/moves",
      OWNER,
      move({ qty: 1, reason: "compra", plotId: "0192f3a0-0004-7000-8000-0000000000ff" }),
    );
    expect(foreign.status).toBe(404);
  });

  /* -- reversal ----------------------------------------------------- */

  it("undoes a movement exactly once, and never a reversal", async () => {
    const first = await post(`/v1/stock/moves/${HARVEST_MOVE}/reverse`, OWNER, { note: "mal pesado" });
    expect(first.status).toBe(201);
    // A BARE movement here, unlike POST /v1/stock/moves: a reversal generates
    // no stickers, so there is no envelope to put it in.
    expect(first.body).toMatchObject({ reason: "ajuste", qty: -40, reversesId: HARVEST_MOVE });

    // ux_moves_reverses is a partial UNIQUE index: once.
    const twice = await post(`/v1/stock/moves/${HARVEST_MOVE}/reverse`, OWNER, {});
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("ALREADY_REVERSED");

    // check_stock_reverso(): "a reversal cannot be reversed".
    const ofReversal = await post(`/v1/stock/moves/${first.body.id}/reverse`, OWNER, {});
    expect(ofReversal.status).toBe(409);
    expect(ofReversal.body.error.code).toBe("ALREADY_REVERSED");

    // The origin learns it was undone through a sub-select, not through an
    // UPDATE — the row itself was never touched.
    const moves = await get(`/v1/stock/moves?productId=${PERGAMINO}`, OWNER);
    const origin = moves.body.items.find((m: { id: string }) => m.id === HARVEST_MOVE);
    expect(origin.reversedById).toBe(first.body.id);
  });

  it("shows the seeded void as a reversal that already happened", async () => {
    const moves = await get(`/v1/stock/moves?productId=${PERGAMINO}`, OWNER);
    const reversal = moves.body.items.find((m: { id: string }) => m.id === VOID_REVERSAL);
    expect(reversal).toMatchObject({ reason: "ajuste", qty: 5, reversesId: VOIDED_SALE_MOVE });
  });

  /* -- ventas ------------------------------------------------------- */

  it("writes the sale and its movement together, and voids by reversing", async () => {
    const before = (await get(`/v1/products/${PERGAMINO}`, OWNER)).body.stock;
    expect(before).toBe(28);

    const sale = await post("/v1/sales", OWNER, {
      productId: PERGAMINO,
      warehouseId: MAIN_STORE,
      customerId: CUSTOMER,
      qty: 8,
      amountCents: 960_000_00,
      localDay: "2026-08-27",
    });
    expect(sale.status).toBe(201);
    expect(sale.body.stockMoveId).toBeTruthy();
    expect(sale.body.reversalMoveId).toBeNull();
    expect(sale.body).toMatchObject({ product: "Café pergamino seco", storageUnit: "Bulto" });

    // CreateSale writes both in one transaction, so the warehouse moved.
    expect((await get(`/v1/products/${PERGAMINO}`, OWNER)).body.stock).toBe(20);
    const movement = (await get(`/v1/stock/moves?productId=${PERGAMINO}`, OWNER)).body.items.find(
      (m: { id: string }) => m.id === sale.body.stockMoveId,
    );
    expect(movement).toMatchObject({ reason: "venta", qty: -8, saleId: sale.body.id });

    // VoidSale flags the row AND puts the coffee back. Flagging alone would
    // leave it sold in the list and gone from the warehouse forever.
    //
    // WAS `POST /v1/sales/{id}/void`. It is DELETE, answering 200 with the
    // sale — the body matters, because the caller needs the `voidedAt` and the
    // `reversalMoveId` it now carries.
    const voided = await del(`/v1/sales/${sale.body.id}`, OWNER);
    expect(voided.status).toBe(200);
    expect(voided.body.voidedAt).toBeTruthy();
    expect(voided.body.reversalMoveId).toBeTruthy();
    expect((await get(`/v1/products/${PERGAMINO}`, OWNER)).body.stock).toBe(28);

    // There is no un-void: a sale recorded by mistake is followed by a new
    // sale, never by an undo of the undo.
    const twice = await del(`/v1/sales/${sale.body.id}`, OWNER);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("SALE_ALREADY_VOID");
  });

  it("guards the warehouse, and lets the guard be overridden on purpose", async () => {
    const tooMuch = await post("/v1/sales", OWNER, {
      productId: PERGAMINO,
      warehouseId: MAIN_STORE,
      qty: 400,
      amountCents: 100_00,
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe("INSUFFICIENT_STOCK");
    // The two numbers travel with the refusal so the screen can put them in
    // the sentence instead of sending somebody to look them up. WAS
    // `available`; the field is `onHand`.
    expect(tooMuch.body.error.details).toEqual({ onHand: 28, requested: 400 });

    // The same escape hatch `allowOverpayment` gives a payment larger than the
    // balance: the guard exists because the web is a keyboard, the override
    // exists because the warehouse is not always in the database before the
    // truck leaves.
    const anyway = await post("/v1/sales", OWNER, {
      productId: PERGAMINO,
      warehouseId: MAIN_STORE,
      qty: 400,
      amountCents: 100_00,
      allowNegativeStock: true,
    });
    expect(anyway.status).toBe(201);
    expect((await get(`/v1/products/${PERGAMINO}`, OWNER)).body.stock).toBe(-372);
  });

  it("guards a plain outgoing movement too, under the OTHER spelling of the flag", async () => {
    // The override is `allowNegative` on a movement and `allowNegativeStock`
    // on a sale. Two names for one idea, and both are in the published
    // schemas — so a screen that sends the wrong one gets its write refused,
    // and this is the test that would catch it.
    const short = await post("/v1/stock/moves", OWNER, move({ qty: -99, reason: "consumo" }));
    expect(short.status).toBe(409);
    expect(short.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(short.body.error.details).toEqual({ onHand: 16, requested: 99 });

    // The sale's spelling does nothing here.
    const wrongFlag = await post(
      "/v1/stock/moves",
      OWNER,
      move({ qty: -99, reason: "consumo", allowNegativeStock: true }),
    );
    expect(wrongFlag.status).toBe(409);

    const waived = await post(
      "/v1/stock/moves",
      OWNER,
      move({ qty: -99, reason: "consumo", allowNegative: true }),
    );
    expect(waived.status).toBe(201);
    expect((await get(`/v1/products/${ABONO}`, OWNER)).body.stock).toBe(-83);
  });

  it("will not move the quantity of a sale, because a movement already says it", async () => {
    const res = await patchJson(`/v1/sales/${SALE}`, OWNER, { qty: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/void the sale and record it again/);

    // `status` is accepted only to be refused too, and with its own sentence:
    // a sale is not deactivated like a product, it is voided, and voiding
    // gives the stock back.
    const off = await patchJson(`/v1/sales/${SALE}`, OWNER, { status: "inactive" });
    expect(off.status).toBe(400);
    expect(off.body.error.message).toMatch(/use DELETE to void a sale/);
    const on = await patchJson(`/v1/sales/${SALE}`, OWNER, { status: "active" });
    expect(on.status).toBe(400);
    expect(on.body.error.message).toMatch(/not restored: record a new one/);

    // Everything else patches.
    const ok = await patchJson(`/v1/sales/${SALE}`, OWNER, { amountCents: 1_500_000_00 });
    expect(ok.status).toBe(200);
    expect(ok.body.amountCents).toBe(1_500_000_00);

    // `UPDATE ... WHERE voided_at IS NULL` matches no row on a voided sale.
    const dead = await patchJson(`/v1/sales/${VOIDED_SALE}`, OWNER, { note: "x" });
    expect(dead.status).toBe(404);
  });

  it("lists the live sales by default and the voided one on request", async () => {
    const live = await get("/v1/sales", OWNER);
    expect(live.body.items.map((s: { id: string }) => s.id)).toEqual([SALE]);
    // `{items, totalCents, totalQty}`, and the totals count live sales only.
    expect(live.body).toMatchObject({ totalCents: 1_440_000_00, totalQty: 12 });

    const all = await get("/v1/sales?status=all", OWNER);
    expect(all.body.items).toHaveLength(2);
    // The voided one is listed and is still not money the farm took.
    expect(all.body).toMatchObject({ totalCents: 1_440_000_00, totalQty: 12 });
    const voided = await get("/v1/sales?status=inactive", OWNER);
    expect(voided.body.items.map((s: { id: string }) => s.id)).toEqual([VOIDED_SALE]);
  });

  /* -- stickers ----------------------------------------------------- */

  it("produces the stickers RSP-025 asks for, without owning a printer", async () => {
    // WAS `POST /v1/stock/moves/{id}/labels`. There is no such route: the
    // stickers are asked for ON the movement, with `labels`, and the write
    // answers `{move, labelBatch}`. One round trip, and no way to end up with
    // a movement whose batch never got created.
    const res = await post(
      "/v1/stock/moves",
      OWNER,
      move({ productId: PERGAMINO, qty: 40, reason: "cosecha", labels: 4 }),
    );
    expect(res.status).toBe(201);
    expect(res.body.move.qty).toBe(40);
    expect(res.body.labelBatch.count).toBe(4);
    expect(res.body.labelBatch.labels.map((l: { qty: number }) => l.qty)).toEqual([10, 10, 10, 10]);
    expect(res.body.labelBatch.labels[0]).toMatchObject({
      product: "Café pergamino seco",
      storageUnit: "Bulto",
      warehouse: "Bodega principal",
      localDay: "2026-08-27",
    });

    // The batch is fetched back by id, which is the half of RSP-025 that
    // whatever holds the paper actually calls.
    const fetched = await get(`/v1/label-batches/${res.body.labelBatch.id}`, OWNER);
    expect(fetched.status).toBe(200);
    expect(fetched.body.labels).toHaveLength(4);

    // No labels asked for, no batch in the envelope.
    const plain = await post("/v1/stock/moves", OWNER, move({ qty: 1, reason: "compra" }));
    expect(plain.body.labelBatch).toBeUndefined();
    expect(plain.body.move.labelBatchId).toBeNull();

    // 0..500.
    expect((await post("/v1/stock/moves", OWNER, move({ qty: 1, reason: "compra", labels: 501 })))
      .status).toBe(400);

    // An uneven split: the last sticker takes the remainder, and then every
    // label is rounded to the three decimals `numeric(14,3)` stores. 40 over 3
    // therefore prints 39,999 and not 40 — what the Go does, asserted rather
    // than smoothed over. `GetLabelBatch`'s comment claims the total still
    // adds up, which is true for 11 over 4 (2,75 each) and not for this one.
    // Flagged to the API pair; until they decide, the mock matches the code.
    const uneven = await post(
      "/v1/stock/moves",
      OWNER,
      move({ productId: PERGAMINO, qty: 40, reason: "cosecha", labels: 3 }),
    );
    expect(uneven.body.labelBatch.labels.map((l: { qty: number }) => l.qty))
      .toEqual([13.333, 13.333, 13.333]);
  });

  /* -- gastos ------------------------------------------------------- */

  it("charges an expense to one thing and refuses both or neither", async () => {
    const base = { concept: "Cal agrícola", amountCents: 90_000_00, localDay: "2026-08-27" };

    // ONE CODE, TWO SENTENCES. A form needs to know which half is wrong; a
    // screen may only ever branch on the code.
    const neither = await post("/v1/expenses", OWNER, base);
    expect(neither.status).toBe(400);
    expect(neither.body.error.code).toBe("EXPENSE_TARGET_INVALID");
    expect(neither.body.error.message).toMatch(/cannot be charged to neither/);

    const both = await post("/v1/expenses", OWNER, {
      ...base,
      activityId: GUADANADA,
      plotId: EL_ALTO,
    });
    expect(both.status).toBe(400);
    expect(both.body.error.code).toBe("EXPENSE_TARGET_INVALID");
    expect(both.body.error.message).toMatch(/not to both/);

    // Exactly one, either way round. `target` is DERIVED from which column is
    // set and is never taken from the caller.
    const onActivity = await post("/v1/expenses", OWNER, { ...base, activityId: GUADANADA });
    expect(onActivity.status).toBe(201);
    expect(onActivity.body).toMatchObject({ target: "activity", activity: "Guadañada", plot: null });

    const onPlot = await post("/v1/expenses", OWNER, {
      ...base,
      concept: "Cal agrícola El Alto",
      plotId: EL_ALTO,
      plotCropId: EL_ALTO_CAFE,
    });
    expect(onPlot.status).toBe(201);
    expect(onPlot.body).toMatchObject({ target: "plot", plot: "El Alto", crop: "Café", activity: null });

    // A crop on its own is NOT a target: `validateExpenseTarget` weighs
    // activityId and plotId only, so this is "neither" rather than
    // expense_crop_needs_plot — the same refusal arrived at from the other
    // side.
    const orphanCrop = await post("/v1/expenses", OWNER, { ...base, plotCropId: EL_ALTO_CAFE });
    expect(orphanCrop.status).toBe(400);
    expect(orphanCrop.body.error.code).toBe("EXPENSE_TARGET_INVALID");
    expect(orphanCrop.body.error.message).toMatch(/cannot be charged to neither/);
  });

  it("moves an imputation from an activity to a plot without leaving both set", async () => {
    // UpdateExpense patches the three target columns as a TRIPLE, because
    // COALESCE would keep the old activity_id alive and expense_target would
    // then refuse the result, correctly and unhelpfully.
    const res = await patchJson("/v1/expenses/0192f3a0-0015-7000-8000-000000000002", OWNER, {
      activityId: null,
      plotId: BAJO_DEL_RIO,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ target: "plot", plot: "Bajo del Río", activityId: null });
  });

  it("totals the live expenses and leaves the inactive one out of the sum", async () => {
    const res = await get("/v1/expenses", OWNER);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(4);
    // WAS nested under `totals`. `{items, totalCents, count}` at the top level.
    // 1.250.000 + 180.000 + 420.000 + 350.000
    expect(res.body).toMatchObject({ count: 4, totalCents: 2_200_000_00 });

    const all = await get("/v1/expenses?status=all", OWNER);
    expect(all.body.items).toHaveLength(5);
    // The deleted row is visible and is still not money the farm spent.
    expect(all.body).toMatchObject({ count: 4, totalCents: 2_200_000_00 });

    const gone = await del("/v1/expenses/0192f3a0-0015-7000-8000-000000000003", OWNER);
    expect(gone.status).toBe(204);
    expect(await get("/v1/expenses", OWNER)).toMatchObject({
      body: { count: 3, totalCents: 1_780_000_00 },
    });
    // RSP-033 is a flag, so it comes back.
    const restored = await patchJson(
      "/v1/expenses/0192f3a0-0015-7000-8000-000000000003",
      OWNER,
      { status: "active" },
    );
    expect(restored.body.deletedAt).toBeNull();
  });

  it("never touches anybody's ledger", async () => {
    // RSP-030's "gasto" is the cost of a spraying; RSP-007's is what an
    // employee owes the farm. The document uses one word for both, and wiring
    // them together takes money out of somebody's wages — silently, and
    // correctly according to the code.
    const before = (await get(`/v1/workers/${MARIA}/balance`, OWNER)).body.balanceCents;
    await post("/v1/expenses", OWNER, {
      concept: "Jornal de la fumigación",
      amountCents: 500_000_00,
      activityId: GUADANADA,
    });
    expect((await get(`/v1/workers/${MARIA}/balance`, OWNER)).body.balanceCents).toBe(before);
  });

  /* -- the catalogues and the products ------------------------------ */

  it("adds a catalogue entry when a picker sends a name it has not seen", async () => {
    const created = await post("/v1/products", OWNER, {
      name: "Miel de café",
      category: "Subproducto", // new
      storageUnit: "Caneca", // new
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ category: "Subproducto", storageUnit: "Caneca", stock: 0 });

    // Idempotent by lower(name), so a picker cannot accumulate five of them.
    const categories = await get("/v1/catalogs/product-categories", OWNER);
    expect(categories.body.items.filter((c: { name: string }) => c.name === "Subproducto")).toHaveLength(1);
    await post("/v1/catalogs/storage-units", OWNER, { name: "caneca" });
    const units = await get("/v1/catalogs/storage-units", OWNER);
    expect(units.body.items.filter((u: { name: string }) => /caneca/i.test(u.name))).toHaveLength(1);

    // BODEGAS ARE NOT A CATALOGUE PATH. They look exactly like one from here
    // — id, name, idempotent by lower(name), the same handler on the server —
    // and they still live at /v1/warehouses. Guessing the path from the shape
    // is how a whole module ends up calling a 404.
    expect((await get("/v1/warehouses", OWNER)).body.items).toHaveLength(2);
    // Nothing is registered at the catalogue path, so MSW rejects the fetch
    // outright rather than answering. That is a stronger statement than a 404:
    // the route is not there to be called.
    await expect(fetch("/v1/catalogs/warehouses", { headers: H(OWNER) })).rejects.toBeTruthy();
    const reused = await post("/v1/warehouses", OWNER, { name: "bodega principal" });
    expect(reused.status).toBe(200); // 200, never 201: found or created, same answer.
    expect(reused.body.id).toBe(MAIN_STORE);

    // And the two product pickers are guarded by products.*, NOT catalogs.*,
    // which is what puts them behind the same door as the module they belong
    // to. The weigher reads crop types and may not read storage units.
    expect((await get("/v1/catalogs/crop-types", WEIGHER)).status).toBe(200);
    expect((await get("/v1/catalogs/storage-units", WEIGHER)).status).toBe(403);
    expect((await get("/v1/warehouses", WEIGHER)).status).toBe(403);

    // A storage unit is required; a category is not.
    expect((await post("/v1/products", OWNER, { name: "Sin unidad" })).status).toBe(400);
    const noCategory = await post("/v1/products", OWNER, {
      name: "Costales vacíos",
      storageUnitId: UNIT_BULTO,
    });
    expect(noCategory.status).toBe(201);
    expect(noCategory.body.category).toBeNull();
  });

  it("takes a product out of the catalogue without touching its movements", async () => {
    const before = (await get(`/v1/stock/moves?productId=${ABONO}`, OWNER)).body.items.length;
    expect((await del(`/v1/products/${ABONO}`, OWNER)).status).toBe(204);

    const live = await get("/v1/products", OWNER);
    expect(live.body.items.some((p: { id: string }) => p.id === ABONO)).toBe(false);
    const inactive = await get("/v1/products?status=inactive", OWNER);
    expect(inactive.body.items.map((p: { id: string }) => p.id)).toContain(ABONO);

    // The facts stay exactly where they are: taking a product out of service
    // does not un-harvest last week's coffee.
    expect((await get(`/v1/stock/moves?productId=${ABONO}`, OWNER)).body.items).toHaveLength(before);
    expect((await get(`/v1/products/${ABONO}`, OWNER)).body.stock).toBe(16);

    // ux_products_name is partial on deleted_at IS NULL, so the name frees up.
    expect((await post("/v1/products", OWNER, {
      name: "Abono compuesto",
      storageUnitId: UNIT_BULTO,
      categoryId: CATEGORY_RAW,
    })).status).toBe(201);
  });

  it("answers 200 from every picker, whether it found the row or made it", async () => {
    // The caller does not need to know which; only that this is the row that
    // name means on this farm. That is what makes the button safe to press
    // twice — and it is why customers are a 200 and products are a 201.
    const made = await post("/v1/customers", OWNER, { name: "Trilladora del Valle" });
    expect(made.status).toBe(200);
    const found = await post("/v1/customers", OWNER, { name: "trilladora del valle" });
    expect(found.status).toBe(200);
    expect(found.body.id).toBe(made.body.id);
    expect((await get("/v1/customers", OWNER)).body.items).toHaveLength(2);
  });

  it("is idempotent by id on every write, so a retry is not a second sale", async () => {
    const body = {
      id: "0192f3a0-0014-7000-8000-0000000000aa",
      productId: PERGAMINO,
      warehouseId: MAIN_STORE,
      qty: 2,
      amountCents: 240_000_00,
    };
    const first = await post("/v1/sales", OWNER, body);
    expect(first.status).toBe(201);
    const retry = await post("/v1/sales", OWNER, body);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    // One sale, one movement: 28 − 2 and not 28 − 4.
    expect((await get(`/v1/products/${PERGAMINO}`, OWNER)).body.stock).toBe(26);
  });

  /* -- the weigher -------------------------------------------------- */

  it("keeps the weigher off all four surfaces", async () => {
    // docs/modelo-datos.md §790: ventas, gastos and stock_moves sit outside the
    // weigher's projection with the same shape as the ledger. The movements go
    // with the money because a movement names the plot and the crop it came
    // out of, which makes the list of them a yield report.
    for (const path of [
      "/v1/products",
      `/v1/products/${PERGAMINO}`,
      "/v1/stock",
      "/v1/stock/moves",
      `/v1/products/${PERGAMINO}/stock`,
      "/v1/sales",
      `/v1/sales/${SALE}`,
      "/v1/customers",
      "/v1/expenses",
      "/v1/warehouses",
      "/v1/catalogs/storage-units",
      "/v1/catalogs/product-categories",
    ]) {
      const res = await get(path, WEIGHER);
      expect([path, res.status]).toEqual([path, 403]);
      expect(res.body.error.code).toBe("FORBIDDEN");
    }
    expect((await post("/v1/stock/moves", WEIGHER, move({ qty: 1, reason: "compra" }))).status).toBe(403);
    expect((await post("/v1/expenses", WEIGHER, { concept: "x", amountCents: 100, activityId: GUADANADA })).status).toBe(403);
    // DELETE, and on its own action (`sales.void`) — same roles today, its own
    // row in the table so they can stop being the same later.
    expect((await del(`/v1/sales/${SALE}`, WEIGHER)).status).toBe(403);
  });
});
