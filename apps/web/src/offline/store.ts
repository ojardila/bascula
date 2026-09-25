/**
 * The device's own storage for the one thing that works without signal:
 * weighings waiting to go up, and the lists (people, lotes) the weighing
 * screen needs to open with no network.
 *
 * IndexedDB and not localStorage: a harvest day with no signal can be a few
 * hundred weighings, localStorage is synchronous and small, and IndexedDB
 * survives a browser restart just the same. No library: two object stores and
 * five operations do not justify one.
 *
 * Every row carries the farm id. A phone can be signed into more than one
 * farm over its life, and a weighing must go up to the farm it was taken on.
 */
import type { WorkRecordInput } from "../api/types";

export interface PendingWeighing {
  /** The work record id, minted on the phone. Re-sending it is a no-op on the server. */
  id: string;
  farmId: string;
  input: WorkRecordInput;
  /** What the screen shows about it without asking the server. */
  who: string;
  plot: string;
  kg: number;
  day: string;
  createdAt: string;
  /** Set when the server refused it for good (not for lack of signal). */
  error: string | null;
}

const DB_NAME = "bascula";
const DB_VERSION = 1;
const PENDING = "pesadas";
const CACHE = "cache";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PENDING)) {
        db.createObjectStore(PENDING, { keyPath: "id" }).createIndex("farmId", "farmId");
      }
      if (!db.objectStoreNames.contains(CACHE)) db.createObjectStore(CACHE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opening = null;
      reject(req.error);
    };
  });
  return opening;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const storageAvailable = (): boolean => typeof indexedDB !== "undefined";

export async function putPending(p: PendingWeighing): Promise<void> {
  await done((await store(PENDING, "readwrite")).put(p));
}

export async function listPending(farmId: string): Promise<PendingWeighing[]> {
  const rows = await done((await store(PENDING, "readonly")).index("farmId").getAll(farmId));
  return (rows as PendingWeighing[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deletePending(id: string): Promise<void> {
  await done((await store(PENDING, "readwrite")).delete(id));
}

export async function putCache<T>(key: string, value: T): Promise<void> {
  await done((await store(CACHE, "readwrite")).put({ key, value, savedAt: new Date().toISOString() }));
}

export async function getCache<T>(key: string): Promise<{ value: T; savedAt: string } | null> {
  const row = await done((await store(CACHE, "readonly")).get(key));
  return (row as { value: T; savedAt: string } | undefined) ?? null;
}

/** Tests only: forget the connection so a fresh fake database is opened. */
export function resetStoreForTests(): void {
  opening = null;
}
