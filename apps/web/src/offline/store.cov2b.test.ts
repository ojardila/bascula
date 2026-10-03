// SPDX-License-Identifier: MIT
/**
 * A save the browser's database turns down reaches the caller as a rejection,
 * with the browser's own error when it gives one and a plain one when it does
 * not. A fake IndexedDB stands in, because fake-indexeddb never fails a put.
 */
import { afterEach, describe, expect, it } from "vitest";
import { putCache, resetStoreForTests } from "./store";

function failingIndexedDB(error: DOMException | null): IDBFactory {
  const request = () => {
    const r: Record<string, unknown> = { error };
    setTimeout(() => (r.onerror as () => void)(), 0);
    return r;
  };
  const db = {
    transaction: () => ({ objectStore: () => ({ put: request }) }),
  };
  return {
    open: () => {
      const r: Record<string, unknown> = { result: db };
      setTimeout(() => (r.onsuccess as () => void)(), 0);
      return r;
    },
  } as unknown as IDBFactory;
}

afterEach(() => resetStoreForTests());

describe("a refused write", () => {
  it("rejects with the browser's error", async () => {
    resetStoreForTests();
    const quota = new DOMException("full", "QuotaExceededError");
    globalThis.indexedDB = failingIndexedDB(quota);
    await expect(putCache("k", 1)).rejects.toBe(quota);
  });

  it("rejects with a plain error when the browser gives none", async () => {
    resetStoreForTests();
    globalThis.indexedDB = failingIndexedDB(null);
    await expect(putCache("k", 1)).rejects.toThrow("IndexedDB request failed");
  });
});
