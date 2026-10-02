/**
 * The tab-to-tab mutation channel.
 *
 * The browser does not deliver a BroadcastChannel message to the channel
 * instance that posted it, but it does deliver to other instances in the same
 * tab — which is why these tests can simulate "another tab" by subscribing
 * through the module while posting through a separate temporary channel, both
 * in the same process.
 */
import { describe, expect, it, vi } from "vitest";
import { broadcastMutation, subscribeMutations } from "./crossTab";

/**
 * `BroadcastChannel` dispatches on a task, not synchronously, so every
 * assertion that follows a post has to let the event loop breathe.
 */
async function flushMessages(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("crossTab mutations", () => {
  it("notifies every subscriber when another tab writes", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeMutations(a);
    const unsubB = subscribeMutations(b);
    broadcastMutation();
    await flushMessages();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });

  it("stops notifying after unsubscribe", async () => {
    const fn = vi.fn();
    const unsub = subscribeMutations(fn);
    unsub();
    broadcastMutation();
    await flushMessages();
    expect(fn).not.toHaveBeenCalled();
  });
});
