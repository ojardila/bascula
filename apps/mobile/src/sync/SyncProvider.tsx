/**
 * The engine, wired to the app, and the one hook every screen asks.
 *
 * §3.5 decides when this runs: at launch, on returning to the foreground,
 * every fifteen minutes with signal, when the chip is tapped, and always
 * before a money screen opens. No websockets, no push notifications — a
 * persistent connection over a farm's network is a battery spent on a latency
 * nobody cares about, and the signal is in the house at night, not in the lote.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";

import { repository, rawDb } from "../db";
import { HttpClient } from "./http.ts";
import { FarmSession, sqliteSecretStore, type StoredSession } from "./session.ts";
import { RestTransport } from "./restTransport.ts";
import { SyncEngine, type SyncReport } from "./engine.ts";

/** Every fifteen minutes, per §3.5. */
const POLL_MS = 15 * 60 * 1000;

/**
 * Where the API is.
 *
 * From the environment at build time, because a farm cannot be asked to type a
 * URL and a text box for one is a text box somebody eventually points at the
 * wrong farm.
 */
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8099";

/** The four states of the chip in §7.1, and only this one is red. */
export type SyncTone = "ok" | "pending" | "offline" | "conflict";

export interface SyncStatus {
  registered: boolean;
  farmName: string | null;
  role: string | null;
  /** How many things are still owed. The number a dueño checks before leaving. */
  pending: number;
  conflicts: number;
  lastPullAt: string | null;
  lastError: string | null;
  /** True while a run is in flight. Never the ONLY thing the chip shows. */
  busy: boolean;
  tone: SyncTone;
  /** Everything the last run could not read, e.g. a weigher's money routes. */
  skipped: { what: string; reason: string }[];
}

interface SyncContextValue {
  status: SyncStatus;
  /** Register this phone against a farm. Returns the farm's name. */
  register(email: string, password: string): Promise<StoredSession>;
  /** Run now. Ignores the backoff, because a person asked. */
  syncNow(): Promise<SyncReport | null>;
  /**
   * Make sure the phone is level with the server before a money screen opens.
   * Returns whether it is — §6.1 reads this to decide if settling is allowed.
   */
  ensureFresh(): Promise<boolean>;
  refresh(): void;
  signOut(): void;
}

const noop = async () => null;

const SyncContext = createContext<SyncContextValue>({
  status: {
    registered: false,
    farmName: null,
    role: null,
    pending: 0,
    conflicts: 0,
    lastPullAt: null,
    lastError: null,
    busy: false,
    tone: "ok",
    skipped: [],
  },
  register: async () => {
    throw new Error("no provider");
  },
  syncNow: noop,
  ensureFresh: async () => false,
  refresh: () => {},
  signOut: () => {},
});

export const useSync = () => useContext(SyncContext);

/**
 * Whether the phone is level enough with the server to settle. §6.1: a pull
 * completed IN THIS SESSION and the outbox empty for that worker.
 *
 * "This session" is read as "since the app was launched", which is what the
 * document means and what a person means: a pull from last Tuesday is not a
 * reason to believe today's week is complete.
 */
export function canSettle(status: SyncStatus, startedAt: number): boolean {
  if (!status.registered) return false;
  if (status.pending > 0) return false;
  if (!status.lastPullAt) return false;
  return Date.parse(status.lastPullAt) >= startedAt;
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const sessionRef = useRef<FarmSession | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  /** When this launch happened, for §6.1's "in the current session". */
  const startedAt = useRef(Date.now()).current;

  const [skipped, setSkipped] = useState<{ what: string; reason: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // Built lazily and once. The secret store needs the database open, which
  // `App` guarantees before this tree mounts.
  const session = useMemo(() => {
    if (!sessionRef.current)
      sessionRef.current = new FarmSession({
        baseUrl: API_BASE_URL,
        store: sqliteSecretStore(rawDb),
      });
    return sessionRef.current;
  }, []);

  const engineFor = useCallback(() => {
    if (!engineRef.current) {
      const http = new HttpClient({ baseUrl: API_BASE_URL, session });
      engineRef.current = new SyncEngine({
        repo: repository,
        transport: new RestTransport({ http }),
      });
    }
    return engineRef.current;
  }, [session]);

  const status: SyncStatus = useMemo(() => {
    void tick;
    const held = session.current();
    const state = repository.sync.state();
    const pending = repository.sync.pendingCount();
    const conflicts = repository.sync.openConflictCount();
    const offline = !!state.lastError && /NETWORK|TIMEOUT|PARTIAL/.test(state.lastError);

    // Only the conflict state is red. §7.1 is explicit about that: a colour
    // that means "look at me" stops meaning anything the moment two different
    // things wear it.
    const tone: SyncTone =
      conflicts > 0
        ? "conflict"
        : offline && pending > 0
          ? "offline"
          : pending > 0
            ? "pending"
            : "ok";

    return {
      registered: held !== null,
      farmName: held?.farmName ?? null,
      role: held?.role ?? null,
      pending,
      conflicts,
      lastPullAt: state.pulledAt,
      lastError: state.lastError,
      busy,
      tone,
      skipped,
    };
  }, [session, busy, skipped, tick]);

  const run = useCallback(
    async (force: boolean): Promise<SyncReport | null> => {
      if (!session.current()) return null;
      setBusy(true);
      try {
        const report = await engineFor().sync({ force });
        setSkipped(report.skipped);
        return report;
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [engineFor, refresh, session],
  );

  const register = useCallback(
    async (email: string, password: string) => {
      const held = await session.login(
        email.trim(),
        password,
        repository.sync.identity().deviceId,
      );
      // The farm id goes on the config row through the repository's own guard,
      // never straight into the column: a phone already carrying another
      // farm's season refuses, and that refusal is the thing standing between
      // one farm's payroll and another's.
      repository.sync.claimFarm(held.farmId);
      await run(true);
      return held;
    },
    [run, session],
  );

  const ensureFresh = useCallback(async () => {
    if (canSettle(status, startedAt)) return true;
    await run(true);
    // Re-read rather than trusting the report: `canSettle` asks two questions
    // and the outbox may still have something a rejected envelope left behind.
    const state = repository.sync.state();
    return (
      repository.sync.pendingCount() === 0 &&
      !!state.pulledAt &&
      Date.parse(state.pulledAt) >= startedAt
    );
  }, [run, startedAt, status]);

  // §3.5: at launch, on returning to the foreground, and every fifteen
  // minutes. `AppState` rather than a bare interval, because an interval in a
  // suspended process is not a schedule — the phone spends the day in a
  // pocket.
  useEffect(() => {
    if (!session.current()) return;
    void run(false);
    const timer = setInterval(() => void run(false), POLL_MS);
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void run(false);
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [run, session]);

  const signOut = useCallback(() => {
    session.clear();
    engineRef.current = null;
    refresh();
  }, [refresh, session]);

  const value = useMemo(
    () => ({
      status,
      register,
      syncNow: () => run(true),
      ensureFresh,
      refresh,
      signOut,
    }),
    [ensureFresh, refresh, register, run, signOut, status],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
