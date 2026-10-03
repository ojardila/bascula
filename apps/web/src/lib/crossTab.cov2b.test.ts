// SPDX-License-Identifier: MIT
/**
 * A browser without BroadcastChannel: subscribing still works (and never
 * fires), and broadcasting is a quiet no-op.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("crossTab without BroadcastChannel", () => {
  it("subscribes and broadcasts without throwing", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const { broadcastMutation, subscribeMutations } = await import("./crossTab");
    const fn = vi.fn();
    const off = subscribeMutations(fn);
    expect(() => broadcastMutation()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(fn).not.toHaveBeenCalled();
    off();
  });
});
