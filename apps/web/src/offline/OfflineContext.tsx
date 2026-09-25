/**
 * What the whole app knows about signal and about weighings still on the phone.
 *
 * It uploads on its own: when the app opens, when the connection comes back,
 * when the tab comes back to the front, and every 30 seconds while something
 * is waiting. Nobody has to remember to press a button, which is the point —
 * the person at the scale has other things to remember.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { useAuth } from "../auth/AuthContext";
import { enqueue as enqueueStored, flushPending, type FlushResult } from "./queue";
import { deletePending, listPending, storageAvailable, type PendingWeighing } from "./store";

interface OfflineValue {
  online: boolean;
  /** This farm's weighings on this device that have not reached the server. */
  pending: PendingWeighing[];
  syncing: boolean;
  /** False where the browser gives us no IndexedDB (private mode in some browsers). */
  canQueue: boolean;
  enqueue: (p: Omit<PendingWeighing, "createdAt" | "error" | "farmId">) => Promise<void>;
  remove: (id: string) => Promise<void>;
  flush: () => Promise<FlushResult | null>;
}

const OfflineContext = createContext<OfflineValue | null>(null);

const RETRY_MS = 30_000;

export function OfflineProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const farmId = user?.farm?.id ?? null;
  const canQueue = storageAvailable();
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  const [pending, setPending] = useState<PendingWeighing[]>([]);
  const [syncing, setSyncing] = useState(false);
  const flushing = useRef(false);

  const refresh = useCallback(async () => {
    if (!farmId || !canQueue) return;
    try {
      setPending(await listPending(farmId));
    } catch {
      // Storage the browser will not open is the same as nothing stored.
    }
  }, [farmId, canQueue]);

  const flush = useCallback(async (): Promise<FlushResult | null> => {
    if (!farmId || !canQueue || flushing.current) return null;
    flushing.current = true;
    setSyncing(true);
    try {
      const r = await flushPending(farmId);
      if (r.sent > 0) setOnline(true);
      return r;
    } catch {
      return null;
    } finally {
      flushing.current = false;
      setSyncing(false);
      await refresh();
    }
  }, [farmId, canQueue, refresh]);

  const enqueue = useCallback<OfflineValue["enqueue"]>(
    async (p) => {
      if (!farmId) throw new Error("Sin finca");
      await enqueueStored({ ...p, farmId });
      await refresh();
    },
    [farmId, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await deletePending(id);
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    void refresh().then(() => flush());
  }, [refresh, flush]);

  useEffect(() => {
    const up = () => {
      setOnline(true);
      void flush();
    };
    const down = () => setOnline(false);
    const visible = () => {
      if (document.visibilityState === "visible") void flush();
    };
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [flush]);

  const waiting = pending.filter((p) => !p.error).length;
  useEffect(() => {
    if (waiting === 0) return;
    const t = window.setInterval(() => void flush(), RETRY_MS);
    return () => window.clearInterval(t);
  }, [waiting, flush]);

  const value = useMemo(
    () => ({ online, pending, syncing, canQueue, enqueue, remove, flush }),
    [online, pending, syncing, canQueue, enqueue, remove, flush],
  );
  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

const NOOP: OfflineValue = {
  online: true,
  pending: [],
  syncing: false,
  canQueue: false,
  enqueue: async () => {
    throw new Error("Sin almacenamiento en este dispositivo");
  },
  remove: async () => {},
  flush: async () => null,
};

/** Outside the provider (a screen rendered on its own in a test) it is a no-op. */
export function useOffline(): OfflineValue {
  return useContext(OfflineContext) ?? NOOP;
}
