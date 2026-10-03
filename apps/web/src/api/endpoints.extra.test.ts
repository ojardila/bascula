/**
 * endpoints.ts, the branches neither `endpoints.test.ts` nor
 * `endpoints.more.test.ts` reach: the activity categories, a settlement whose
 * worker cannot be read, partial updates that blank a field, a login error
 * that names no farms, and a session whose owner cannot be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { api } from "./endpoints";
import { getTokens, setTokens } from "./client";
import { invalidateRefs } from "./refs";
import { server } from "../mocks/node";
import * as db from "../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";
const SETTLEMENT = "0192f3a0-000b-7000-8000-000000000001";

function signIn() {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
}

/** The JSON body of the first request matching `method` and `path`. */
function capture(method: string, path: RegExp) {
  const box: { body: Record<string, unknown> | null } = { body: null };
  server.events.on("request:start", async ({ request }) => {
    if (
      box.body === null &&
      request.method === method &&
      path.test(new URL(request.url).pathname)
    ) {
      box.body = (await request.clone().json()) as Record<string, unknown>;
    }
  });
  return box;
}

const workerGone = () =>
  server.use(
    http.get("*/v1/workers/:id", () =>
      HttpResponse.json(
        { error: { code: "NOT_FOUND", message: "gone" } },
        { status: 404 },
      ),
    ),
  );

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signIn();
});

afterEach(() => {
  server.events.removeAllListeners();
  vi.restoreAllMocks();
});

describe("catalogues", () => {
  it("reads the activity categories", async () => {
    server.use(
      http.get("*/v1/catalogs/activity-categories", () =>
        HttpResponse.json({ items: [{ id: "c1", name: "Cosecha" }] }),
      ),
    );
    const cats = await api.activityCategories();
    expect(cats).toHaveLength(1);
    expect(cats[0].name).toBe("Cosecha");
  });
});

describe("a settlement whose worker cannot be read", () => {
  it("is still shown, headed by a dash", async () => {
    workerGone();
    const s = await api.getSettlement(SETTLEMENT);
    expect(s.workerName).toBe("—");
  });

  it("is still voided, headed by a dash", async () => {
    workerGone();
    const s = await api.voidSettlement(SETTLEMENT);
    expect(s.workerName).toBe("—");
  });
});

describe("partial updates", () => {
  it("sends only the note when only the note changed", async () => {
    const record = db
      .tenantOf(db.FARM_ID)!
      .workRecords.find((r) => r.deletedAt === null && r.amountCents === null)!;
    const sent = capture("PATCH", /\/v1\/work-records\//);
    await api
      .updateWorkRecord(record.id, { note: "Revisado" })
      .catch(() => undefined);
    await vi.waitFor(() => expect(sent.body).not.toBeNull());
    expect(sent.body).toEqual({ note: "Revisado" });
  });

  it("sends a blanked document type, tag and country as null", async () => {
    const sent = capture("PATCH", /\/v1\/workers\//);
    await api
      .updateWorker(MARIA, { documentType: "" as never, tag: "", country: "" })
      .catch(() => undefined);
    await vi.waitFor(() => expect(sent.body).not.toBeNull());
    expect(sent.body).toMatchObject({
      documentType: null,
      tag: null,
      country: null,
    });
  });
});

describe("signing in", () => {
  it("passes on a 400 that names no farms", async () => {
    setTokens(null);
    server.use(
      http.post("*/v1/auth/login", () =>
        HttpResponse.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "bad",
              details: { farms: [] },
            },
          },
          { status: 400 },
        ),
      ),
    );
    await expect(
      api.login({ email: "a@b.co", password: "x" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("maps an «admin» membership to an administrator", async () => {
    setTokens(null);
    server.use(
      http.post("*/v1/auth/login", () =>
        HttpResponse.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "choose",
              details: { farms: [{ id: "f1", name: "Uno", role: "admin" }] },
            },
          },
          { status: 400 },
        ),
      ),
    );
    const res = await api.login({ email: "a@b.co", password: "x" });
    expect(res).toMatchObject({
      choose: true,
      memberships: [{ farmId: "f1", role: "administrator", slug: "" }],
    });
  });

  it("drops a session whose owner cannot be read", async () => {
    setTokens(null);
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    await expect(
      api.login({ email: "oscar@laesperanza.co", password: "esperanza" }),
    ).rejects.toBeTruthy();
    expect(getTokens()).toBeNull();
  });

  it("still names the device in a private window that refuses storage", async () => {
    setTokens(null);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const sent = capture("POST", /\/v1\/auth\/login$/);
    await api
      .login({ email: "oscar@laesperanza.co", password: "esperanza" })
      .catch(() => undefined);
    await vi.waitFor(() => expect(sent.body).not.toBeNull());
    expect(String(sent.body!.deviceId)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
