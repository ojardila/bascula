// SPDX-License-Identifier: MIT
/**
 * The second update attempt on a browser that has no Cache Storage at all:
 * the workers are still dropped and the page still reloads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate } from "./appVersion";

const KEY = "bascula.updateAttempts";

describe("applyUpdate without Cache Storage", () => {
  const originalLocation = window.location;
  const originalSw = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  const reload = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    if (originalSw) Object.defineProperty(navigator, "serviceWorker", originalSw);
    else delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    reload.mockReset();
  });

  it("unregisters the workers and reloads when there are no caches to clear", async () => {
    expect("caches" in window).toBe(false);
    sessionStorage.setItem(KEY, "1");
    const unregister = vi.fn(async () => true);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistrations: vi.fn(async () => [{ unregister }]) },
    });
    await applyUpdate();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(KEY)).toBe("2");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
