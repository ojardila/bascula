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
import { codeOf, explainSyncError } from "./explain.ts";
import { HttpClient } from "./http.ts";
import { FarmSession, sqliteSecretStore, type StoredSession } from "./session.ts";
import { RestTransport } from "./restTransport.ts";
import { FeedTransport } from "./feedTransport.ts";
import { SyncEngine, type SyncReport } from "./engine.ts";
import { SeasonImporter } from "./seasonImport.ts";

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

/** The four states of the chip in §7.1, and only the last one is red. */
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
  /**
   * The pull stopped with the server still holding changes.
   *
   * Not an error: `maxPages` is a courtesy bound and the cursor moved over
   * everything that was applied. It IS the difference between "al día" and
   * "todavía bajando", and §6.1 makes it the difference between the settle
   * button being live and not.
   */
  stillBehind: boolean;
  /** How far behind the server said this phone was, at the last handshake. §3.1. */
  behind: number;
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
  /**
   * §8 fase 3 and 4: hand the season this phone is holding to the server.
   *
   * Null until the phone is registered, because the import needs a farm to
   * import into, and a button that is there before there is one is a button
   * that fails for a reason nobody can act on.
   */
  seasonImporter: SeasonImporter | null;
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
    stillBehind: false,
    behind: 0,
  },
  register: async () => {
    throw new Error("no provider");
  },
  syncNow: noop,
  ensureFresh: async () => false,
  seasonImporter: null,
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
  const httpRef = useRef<HttpClient | null>(null);
  const transportRef = useRef<RestTransport | null>(null);
  const importerRef = useRef<SeasonImporter | null>(null);
  /** When this launch happened, for §6.1's "in the current session". */
  const startedAt = useRef(Date.now()).current;

  const [skipped, setSkipped] = useState<{ what: string; reason: string }[]>([]);
  // From the last run's report rather than from a column: `behind` is the
  // server's answer at handshake time and goes stale the moment the pull
  // starts, so persisting it would be storing a number that lies after a
  // restart.
  const [behind, setBehind] = useState({ stillBehind: false, count: 0 });
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

  // One HTTP client for every conversation. Two would mean two refreshes
  // racing on one refresh token — the reuse the server treats as a stolen
  // credential and answers by killing the whole family (`session.ts`).
  const httpFor = useCallback(() => {
    if (!httpRef.current)
      httpRef.current = new HttpClient({ baseUrl: API_BASE_URL, session });
    return httpRef.current;
  }, [session]);

  /**
   * The season import, which is a REST route and not part of the feed.
   * `RestTransport` implements both interfaces; only this half of it is used.
   */
  const transportFor = useCallback(() => {
    if (!transportRef.current)
      transportRef.current = new RestTransport({ http: httpFor() });
    return transportRef.current;
  }, [httpFor]);

  /**
   * §3, over the real feed.
   *
   * `restTransport.ts` was the shim for a server that had no `/v1/sync/*`, and
   * it stays in the tree because that is still true of any deployment that has
   * not caught up. What the app runs is the feed: a real per-farm sequence
   * with a commit horizon, `sync_ops` behind `opId`, and one request per batch
   * instead of one per envelope. The engine, the outbox, the conflicts and
   * every screen did not change by a line — which is the property `protocol.ts`
   * was split out to have.
   */
  const engineFor = useCallback(() => {
    if (!engineRef.current)
      engineRef.current = new SyncEngine({
        repo: repository,
        transport: new FeedTransport({ http: httpFor() }),
      });
    return engineRef.current;
  }, [httpFor]);

  const status: SyncStatus = useMemo(() => {
    void tick;
    const held = session.current();
    const state = repository.sync.state();
    const pending = repository.sync.pendingCount();
    const conflicts = repository.sync.openConflictCount();
    // The code at the START of the string, not a match anywhere in it: a
    // server message that merely mentioned a token used to turn a network
    // hiccup into "vuelve a conectar el teléfono".
    const offline =
      !!state.lastError &&
      ["NETWORK", "TIMEOUT", "PARTIAL"].includes(codeOf(state.lastError));
    // A failure that retrying cannot fix — a revoked token, a suspended farm,
    // a build the server refuses. It used to be invisible whenever the outbox
    // happened to be empty, which is precisely when nothing else on this
    // screen would have hinted at it.
    const stuck = !!state.lastError && !explainSyncError(state.lastError).retryable;

    // Only the conflict state is red. §7.1 is explicit about that: a colour
    // that means "look at me" stops meaning anything the moment two different
    // things wear it. A phone that is stuck wears the amber of "offline",
    // because what a person does about it is the same — go and find somebody
    // — and it is never silently green.
    const tone: SyncTone =
      conflicts > 0
        ? "conflict"
        : stuck || (offline && pending > 0)
          ? "offline"
          : pending > 0 || behind.stillBehind
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
      stillBehind: behind.stillBehind,
      behind: behind.count,
    };
  }, [session, busy, skipped, tick, behind]);

  const run = useCallback(
    async (force: boolean): Promise<SyncReport | null> => {
      if (!session.current()) return null;
      setBusy(true);
      try {
        const report = await engineFor().sync({ force });
        setSkipped(report.skipped);
        setBehind({ stillBehind: report.stillBehind, count: report.behind });
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
    httpRef.current = null;
    transportRef.current = null;
    importerRef.current = null;
    refresh();
  }, [refresh, session]);

  // Kept across renders so the "one import at a time" guard inside it means
  // something: a new importer on every render would let two taps start two.
  const seasonImporter = useMemo(() => {
    if (!status.registered) return null;
    if (!importerRef.current)
      importerRef.current = new SeasonImporter({
        repo: repository,
        transport: transportFor(),
      });
    return importerRef.current;
  }, [status.registered, transportFor]);

  const value = useMemo(
    () => ({
      status,
      register,
      syncNow: () => run(true),
      ensureFresh,
      seasonImporter,
      refresh,
      signOut,
    }),
    [ensureFresh, refresh, register, run, seasonImporter, signOut, status],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
