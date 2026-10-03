// SPDX-License-Identifier: MIT
/**
 * The upgrade handler over a database that already has both stores: the day
 * DB_VERSION goes up, a phone with weighings still waiting must keep them.
 */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { getCache, listPending, resetStoreForTests, type PendingWeighing } from "./store";

const FARM = "farm-c3w";

const c3wRow: PendingWeighing = {
  id: "wr-c3w-1",
  farmId: FARM,
  input: {} as PendingWeighing["input"],
  who: "Ana",
  plot: "La Loma",
  kg: 12,
  day: "2026-09-01",
  createdAt: "2026-09-01T10:00:00Z",
  error: null,
};

/** A "bascula" database at version 1 with both stores and one row in each. */
function c3wSeed(factory: IDBFactory): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.open("bascula", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("pesadas", { keyPath: "id" }).createIndex("farmId", "farmId");
      db.createObjectStore("cache", { keyPath: "key" });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["pesadas", "cache"], "readwrite");
      tx.objectStore("pesadas").put(c3wRow);
      tx.objectStore("cache").put({ key: "refs", value: { n: 1 }, savedAt: "2026-09-01T10:00:00Z" });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe("offline store upgrade", () => {
  it("keeps the stores and their rows when it upgrades a database that has them", async () => {
    const real = new IDBFactory();
    await c3wSeed(real);
    // The app asks for version 1; asking one higher makes the browser run
    // the upgrade handler over the existing stores, as a release would.
    const bumped = {
      open: (name: string, version?: number) => real.open(name, (version ?? 1) + 1),
    } as unknown as IDBFactory;
    globalThis.indexedDB = bumped;
    resetStoreForTests();

    const rows = await listPending(FARM);
    expect(rows).toHaveLength(1);
    expect(rows[0].who).toBe("Ana");
    expect(await getCache<{ n: number }>("refs")).toMatchObject({
      value: { n: 1 },
      savedAt: "2026-09-01T10:00:00Z",
    });
  });
});
