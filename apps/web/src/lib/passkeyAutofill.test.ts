import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPasskeyAutofill } from "./passkeyAutofill";

/** A request that waits until resolved by hand or aborted. */
function pendingRequests() {
  const calls: { signal: AbortSignal; resolve: (v: string) => void }[] = [];
  const request = (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ signal, resolve });
      signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  return { calls, request };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startPasskeyAutofill", () => {
  it("renews the request before the challenge lapses", async () => {
    const { calls, request } = pendingRequests();
    const stop = startPasskeyAutofill({
      request,
      onAnswer: vi.fn(),
      renewMs: 1000,
    });
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].signal.aborted).toBe(false);
    stop();
    expect(calls[1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(2);
  });

  it("hands over the pick and listens again", async () => {
    const { calls, request } = pendingRequests();
    const onAnswer = vi.fn(async () => {
      throw new Error("sign-in failed");
    });
    const stop = startPasskeyAutofill({ request, onAnswer, renewMs: 1000 });
    calls[0].resolve("answer");
    await vi.advanceTimersByTimeAsync(0);
    expect(onAnswer).toHaveBeenCalledWith("answer");
    expect(calls).toHaveLength(2);
    stop();
  });

  it("gives up quietly when the browser refuses", async () => {
    const request = vi.fn(async () => {
      throw new DOMException("no", "NotSupportedError");
    });
    const stop = startPasskeyAutofill({
      request,
      onAnswer: vi.fn(),
      renewMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not sign in after being stopped", async () => {
    const onAnswer = vi.fn(async () => {});
    let resolve!: (v: string) => void;
    const slow = (signal: AbortSignal) => {
      void signal;
      return new Promise<string>((r) => (resolve = r));
    };
    const stop = startPasskeyAutofill({ request: slow, onAnswer });
    stop();
    resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
