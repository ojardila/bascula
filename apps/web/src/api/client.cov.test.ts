/**
 * The edges of `request()` the happy-path suites never reach: a refresh that
 * succeeds and replays, a refresh shared by two parallel 401s, the network
 * dropping mid-refresh or mid-replay, an aborted request, error bodies that
 * are not JSON, and tokens kept from an earlier visit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http as mswHttp, HttpResponse } from "msw";
import { server } from "../mocks/node";
import { ApiError } from "./errors";
import { authEvents, getTokens, http, request, setTokens } from "./client";

const OLD = { accessToken: "old-access", refreshToken: "old-refresh" };
const NEW = { accessToken: "new-access", refreshToken: "new-refresh" };

/** 401 for the old token, 200 for the new one. */
function protectedThing() {
  return mswHttp.get("*/v1/cov/thing", ({ request: req }) => {
    if (req.headers.get("Authorization") === `Bearer ${NEW.accessToken}`) {
      return HttpResponse.json({ ok: true });
    }
    return HttpResponse.json({ error: { code: "UNAUTHORIZED", message: "x" } }, { status: 401 });
  });
}

describe("http client — refresh and replay", () => {
  beforeEach(() => setTokens({ ...OLD }));
  afterEach(() => setTokens(null));

  it("refreshes once on a 401 and replays the request with the new token", async () => {
    let refreshes = 0;
    server.use(
      protectedThing(),
      mswHttp.post("*/v1/auth/refresh", () => {
        refreshes += 1;
        return HttpResponse.json(NEW);
      }),
    );
    await expect(http.get("/v1/cov/thing")).resolves.toEqual({ ok: true });
    expect(refreshes).toBe(1);
    expect(getTokens()).toEqual(NEW);
  });

  it("shares one refresh between two requests that hit a 401 together", async () => {
    let refreshes = 0;
    server.use(
      protectedThing(),
      mswHttp.post("*/v1/auth/refresh", async () => {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 30));
        return HttpResponse.json(NEW);
      }),
    );
    const [a, b] = await Promise.all([http.get("/v1/cov/thing"), http.get("/v1/cov/thing")]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(refreshes).toBe(1);
  });

  it("keeps the original 401 when the refresh itself cannot reach the server", async () => {
    const logout = vi.fn();
    authEvents.addEventListener("logout", logout);
    server.use(
      protectedThing(),
      mswHttp.post("*/v1/auth/refresh", () => HttpResponse.error()),
    );
    const err = await http.get("/v1/cov/thing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    // The 401 that survives logs the user out.
    expect(logout).toHaveBeenCalledTimes(1);
    expect(getTokens()).toBeNull();
    authEvents.removeEventListener("logout", logout);
  });

  it("logs out when the refresh is refused", async () => {
    const logout = vi.fn();
    authEvents.addEventListener("logout", logout);
    server.use(
      protectedThing(),
      mswHttp.post("*/v1/auth/refresh", () =>
        HttpResponse.json({ error: { code: "UNAUTHORIZED", message: "x" } }, { status: 401 }),
      ),
    );
    await expect(http.get("/v1/cov/thing")).rejects.toMatchObject({ status: 401 });
    expect(logout).toHaveBeenCalled();
    authEvents.removeEventListener("logout", logout);
  });

  it("reports a network error when the replay after a refresh fails", async () => {
    let calls = 0;
    server.use(
      mswHttp.get("*/v1/cov/thing", () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({ error: { code: "UNAUTHORIZED", message: "x" } }, { status: 401 });
        }
        return HttpResponse.error();
      }),
      mswHttp.post("*/v1/auth/refresh", () => HttpResponse.json(NEW)),
    );
    const err = (await http.get("/v1/cov/thing").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe("NETWORK");
  });

  it("does not try to refresh an anonymous request", async () => {
    const refresh = vi.fn(() => HttpResponse.json(NEW));
    server.use(protectedThing(), mswHttp.post("*/v1/auth/refresh", refresh));
    await expect(http.get("/v1/cov/thing", { anonymous: true })).rejects.toMatchObject({
      status: 401,
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("http client — responses and failures", () => {
  afterEach(() => setTokens(null));

  it("turns an error with a non-JSON body into an ApiError with no body", async () => {
    server.use(
      mswHttp.get("*/v1/cov/plain", () => new HttpResponse("upstream down", { status: 502 })),
    );
    const err = (await http.get("/v1/cov/plain").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe("HTTP 502");
  });

  it("returns undefined for a successful write with an empty body", async () => {
    server.use(mswHttp.put("*/v1/cov/empty", () => new HttpResponse("", { status: 200 })));
    await expect(http.put("/v1/cov/empty", { a: 1 })).resolves.toBeUndefined();
  });

  it("returns undefined for a 204", async () => {
    server.use(mswHttp.patch("*/v1/cov/none", () => new HttpResponse(null, { status: 204 })));
    await expect(http.patch("/v1/cov/none", { a: 1 })).resolves.toBeUndefined();
  });

  it("sends extra headers and drops empty query values", async () => {
    let seen = "";
    let ticket = "";
    server.use(
      mswHttp.delete("*/v1/cov/q", ({ request: req }) => {
        seen = new URL(req.url).search;
        ticket = req.headers.get("X-Ticket") ?? "";
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await http.del("/v1/cov/q", {
      query: { a: 1, b: "", c: null, d: undefined, e: true },
      headers: { "X-Ticket": "t1" },
    });
    expect(seen).toBe("?a=1&e=true");
    expect(ticket).toBe("t1");
  });

  it("leaves the query string off when every value is empty", async () => {
    let url = "";
    server.use(
      mswHttp.get("*/v1/cov/q", ({ request: req }) => {
        url = req.url;
        return HttpResponse.json({});
      }),
    );
    await http.get("/v1/cov/q", { query: { a: "" } });
    expect(url.endsWith("/v1/cov/q")).toBe(true);
  });

  it("rethrows an abort as is, not as a network error", async () => {
    // The browser's fetch rejects an aborted request with an AbortError.
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new DOMException("The operation was aborted.", "AbortError"),
    );
    const err = await request("GET", "/v1/cov/slow").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as DOMException).name).toBe("AbortError");
    vi.restoreAllMocks();
  });

  it("treats any other DOMException from fetch as a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new DOMException("blocked", "NetworkError"),
    );
    await expect(request("GET", "/v1/cov/slow")).rejects.toMatchObject({
      status: 0,
      code: "NETWORK",
    });
    vi.restoreAllMocks();
  });

  it("reports a network failure as an ApiError with status 0", async () => {
    server.use(mswHttp.get("*/v1/cov/down", () => HttpResponse.error()));
    await expect(http.get("/v1/cov/down")).rejects.toMatchObject({ status: 0 });
  });

  it("does not throw when storage refuses to save the tokens", () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const own = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => setTokens({ ...OLD })).not.toThrow();
    expect(getTokens()).toEqual(OLD);
    set.mockRestore();
    own.mockRestore();
  });
});

describe("http client — tokens from an earlier visit", () => {
  afterEach(() => {
    localStorage.removeItem("bascula.tokens");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("starts signed in with the tokens kept in storage", async () => {
    localStorage.setItem("bascula.tokens", JSON.stringify(OLD));
    vi.resetModules();
    const mod = await import("./client");
    expect(mod.getTokens()).toEqual(OLD);
  });

  it("starts signed out when storage cannot be read", async () => {
    // Blocked site data: touching `localStorage` at all throws.
    const own = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    try {
      vi.resetModules();
      const mod = await import("./client");
      expect(mod.getTokens()).toBeNull();
    } finally {
      if (own) Object.defineProperty(globalThis, "localStorage", own);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});
