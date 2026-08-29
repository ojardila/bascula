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
    const settle = await post("/v1/settlements", OWNER, {
      id: crypto.randomUUID(), workerId: MARIA, from: "2026-08-01", to: "2026-08-31",
    });
    expect(settle.status).toBe(201);
    expect(settle.body.grossCents).toBe(15360000);
    // One devengo, and the balance moved by exactly the gross.
    const after = await get(`/v1/workers/${MARIA}/balance`, OWNER);
    expect(after.body.balanceCents).toBe(18450000 + 15360000);
    // Nothing left pending, and re-settling is a 409.
    const again = await post("/v1/settlements", OWNER, {
      id: crypto.randomUUID(), workerId: MARIA, from: "2026-08-01", to: "2026-08-31",
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

  it("stores a boundary as GeoJSON", async () => {
    const drawn = await get("/v1/plots/0192f3a0-0004-7000-8000-000000000003", OWNER);
    expect(drawn.body.boundary.type).toBe("Polygon");
    expect(drawn.body.computedAreaHa).toBe(5.71);
    const empty = await fetch("/v1/plots/0192f3a0-0004-7000-8000-000000000001/boundary", {
      method: "PUT", headers: H(OWNER), body: JSON.stringify({}) });
    expect(empty.status).toBe(400);
    const put = await fetch("/v1/plots/0192f3a0-0004-7000-8000-000000000001/boundary", {
      method: "PUT", headers: H(OWNER),
      body: JSON.stringify({ boundary: { type: "Polygon", coordinates: [] } }) });
    expect(put.status).toBe(200);
    const body = await put.json();
    expect(body.plot.boundary.type).toBe("Polygon");
    expect(body.overlaps).toEqual([]);
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
