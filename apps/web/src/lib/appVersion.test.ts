// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_BUILD,
  applyUpdate,
  clearUpdateAttempts,
  fetchServerVersion,
  isOutdated,
} from "./appVersion";

const KEY = "bascula.updateAttempts";

describe("APP_BUILD", () => {
  it("is a non-empty string", () => {
    expect(typeof APP_BUILD).toBe("string");
    expect(APP_BUILD.length).toBeGreaterThan(0);
  });
});

describe("fetchServerVersion", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (init: { ok?: boolean; body?: unknown; throws?: boolean }) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (init.throws) throw new Error("offline");
        return {
          ok: init.ok ?? true,
          json: async () => init.body,
        } as Response;
      }),
    );

  it("returns the release and build", async () => {
    respond({ body: { version: "v1.2.3", build: "abc" } });
    await expect(fetchServerVersion()).resolves.toEqual({
      version: "v1.2.3",
      build: "abc",
    });
  });

  it("treats a missing or empty build as null", async () => {
    respond({ body: { version: "v1", build: "" } });
    await expect(fetchServerVersion()).resolves.toEqual({
      version: "v1",
      build: null,
    });
    respond({ body: { version: "v1", build: 7 } });
    await expect(fetchServerVersion()).resolves.toEqual({
      version: "v1",
      build: null,
    });
  });

  it("returns null on a non-OK answer", async () => {
    respond({ ok: false, body: {} });
    await expect(fetchServerVersion()).resolves.toBeNull();
  });

  it("returns null when the version is not a usable string", async () => {
    respond({ body: { version: 3 } });
    await expect(fetchServerVersion()).resolves.toBeNull();
    respond({ body: { version: "" } });
    await expect(fetchServerVersion()).resolves.toBeNull();
  });

  it("returns null when the request fails", async () => {
    respond({ throws: true });
    await expect(fetchServerVersion()).resolves.toBeNull();
  });
});

describe("isOutdated", () => {
  it("is only true for two different real builds", () => {
    expect(isOutdated("a", "b")).toBe(true);
    expect(isOutdated("a", "a")).toBe(false);
    expect(isOutdated("dev", "b")).toBe(false);
    expect(isOutdated("a", null)).toBe(false);
    expect(isOutdated("a", "dev")).toBe(false);
  });
});

describe("applyUpdate", () => {
  const reload = vi.fn();
  const originalLocation = window.location;
  const originalSw = Object.getOwnPropertyDescriptor(
    navigator,
    "serviceWorker",
  );

  beforeEach(() => {
    sessionStorage.clear();
    reload.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
    if (originalSw)
      Object.defineProperty(navigator, "serviceWorker", originalSw);
    else delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const setSw = (sw: unknown) =>
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: sw,
    });

  it("just reloads when there is no service worker", async () => {
    setSw(undefined);
    await applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(KEY)).toBe("1");
  });

  it("reloads when there is no registration", async () => {
    setSw({ getRegistration: vi.fn(async () => undefined) });
    await applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("asks a waiting worker to take over, then reloads on controllerchange", async () => {
    const postMessage = vi.fn();
    const listeners: Record<string, () => void> = {};
    const sw = {
      getRegistration: vi.fn(async () => ({
        update: vi.fn(async () => {
          throw new Error("no network");
        }),
        waiting: { postMessage },
        installing: null,
      })),
      addEventListener: vi.fn((type: string, cb: () => void) => {
        listeners[type] = cb;
        queueMicrotask(cb);
      }),
    };
    setSw(sw);
    await applyUpdate();
    expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(sw.addEventListener).toHaveBeenCalledWith(
      "controllerchange",
      expect.any(Function),
      {
        once: true,
      },
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("falls back to a timeout when the new worker never takes control", async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    setSw({
      getRegistration: vi.fn(async () => ({
        update: vi.fn(async () => undefined),
        waiting: null,
        installing: { postMessage },
      })),
      addEventListener: vi.fn(),
    });
    const done = applyUpdate();
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(postMessage).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads without waiting when nothing new is installing", async () => {
    setSw({
      getRegistration: vi.fn(async () => ({
        update: vi.fn(async () => undefined),
        waiting: null,
        installing: null,
      })),
    });
    await applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("drops the workers and caches on the second attempt", async () => {
    sessionStorage.setItem(KEY, "1");
    const unregister = vi.fn(async () => true);
    setSw({
      getRegistrations: vi.fn(async () => [{ unregister }, { unregister }]),
    });
    const del = vi.fn(async () => true);
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => ["a", "b", "c"]),
      delete: del,
    });
    await applyUpdate();
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledTimes(3);
    expect(sessionStorage.getItem(KEY)).toBe("2");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still reloads when the service worker API throws", async () => {
    setSw({
      getRegistration: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("clearUpdateAttempts", () => {
  it("forgets earlier attempts", () => {
    sessionStorage.setItem(KEY, "3");
    clearUpdateAttempts();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});
