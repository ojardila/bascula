/**
 * `useAsync` is load-on-mount with one deliberate re-fetch door — `reload()`
 * — that until this change was only reachable from the hook's own return. Two
 * more doors are added: a cross-tab broadcast, so a write in another tab makes
 * this one re-read; and `visibilitychange`, so a tab that was hidden long
 * enough to miss broadcasts picks up what moved as soon as it comes back.
 *
 * The tests mount through `renderHook` and watch what the fetcher saw: a
 * counter the fetcher increments is the honest witness. Mocks of the fetcher
 * itself would prove that the hook was wired to a mock, not that it re-reads.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAsync } from "./useAsync";
import { broadcastMutation } from "./crossTab";

async function flushMessages(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** jsdom defaults to visible; some tests move it and leave it. */
function resetVisibility(): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
}

afterEach(resetVisibility);

describe("useAsync — cross-tab mutation", () => {
  it("re-reads when another tab broadcasts a mutation", async () => {
    let count = 0;
    const { result } = renderHook(() =>
      useAsync(() => Promise.resolve(++count), []),
    );
    await waitFor(() => expect(result.current.data).toBe(1));

    act(() => {
      broadcastMutation();
    });
    await flushMessages();

    await waitFor(() => expect(result.current.data).toBe(2));
  });

  it("stops re-reading after the hook unmounts", async () => {
    let count = 0;
    const { result, unmount } = renderHook(() =>
      useAsync(() => Promise.resolve(++count), []),
    );
    await waitFor(() => expect(result.current.data).toBe(1));

    unmount();

    act(() => {
      broadcastMutation();
    });
    await flushMessages();
    // The hook is gone; the fetcher must not run again.
    expect(count).toBe(1);
  });
});

describe("useAsync — visibility", () => {
  it("re-reads when the tab becomes visible after being hidden", async () => {
    let count = 0;
    const { result } = renderHook(() =>
      useAsync(() => Promise.resolve(++count), []),
    );
    await waitFor(() => expect(result.current.data).toBe(1));

    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(result.current.data).toBe(2));
  });

  it("does not re-read when the tab is hidden", async () => {
    let count = 0;
    const { result } = renderHook(() =>
      useAsync(() => Promise.resolve(++count), []),
    );
    await waitFor(() => expect(result.current.data).toBe(1));

    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Give the effect a chance; count must stay put.
    await flushMessages();
    expect(count).toBe(1);
  });
});
