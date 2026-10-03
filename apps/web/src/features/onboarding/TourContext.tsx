/**
 * THE TOUR'S STATE: which tour is running, on which step, and what was saved.
 *
 * Progress lives on the server (`/v1/me/tours`, per user and farm) so a tour
 * started on the phone resumes on the computer, with localStorage as the copy
 * that survives a bad connection. This module is light on purpose: it is in
 * every authenticated page, and React Joyride itself is only loaded by
 * TourHost when a spotlight step actually has to be drawn.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../api/endpoints";
import type { WireTourProgress, WireTourStatus } from "../../api/wire";
import { OWNER_DONE, autoStartAt, resumeIndex, stepOf, type TourName, type TourStepDef } from "./steps";

export interface SavedTour {
  step: number;
  status: WireTourStatus;
}

export interface TourSummary {
  owners: number;
  people: number;
  plot: string | null;
  priceCents: number | null;
}

type ActionFn = () => boolean | Promise<boolean>;

export interface TourContextValue {
  /** The running tour, or null. */
  current: { tour: TourName; n: number; def: TourStepDef } | null;
  /** True while a dialog the tour opened is in the person's hands. */
  paused: boolean;
  saved: Partial<Record<TourName, SavedTour>>;
  loaded: boolean;
  /** Which tour «Ayuda y recorrido» starts for this person, if any. */
  available: TourName | null;
  summary: TourSummary;
  start: (tour: TourName, n?: number) => void;
  resume: (tour: TourName) => void;
  goTo: (n: number) => void;
  pause: () => void;
  /** «Saltar»: stop now, keep the place, offer it again on Cosecha. */
  later: () => void;
  /** The × on the resume card: do not offer it again. */
  dismiss: (tour: TourName) => void;
  finish: () => void;
  isAt: (tour: TourName, n: number) => boolean;
  registerAction: (name: string, fn: ActionFn) => () => void;
  runAction: (name: string) => Promise<boolean>;
  note: (patch: Partial<TourSummary> | ((s: TourSummary) => Partial<TourSummary>)) => void;
}

export const TourContext = createContext<TourContextValue | null>(null);

const EMPTY_SUMMARY: TourSummary = { owners: 0, people: 0, plot: null, priceCents: null };

/**
 * How long to wait before asking the server again when the saved progress
 * could not be loaded: about a minute in all, the time a deploy takes to
 * bring the API back.
 */
export const TOUR_LOAD_RETRY_MS: readonly number[] = [1000, 2000, 4000, 8000, 15000, 30000];

function storageKey(userId: string, farm: string) {
  return `bascula.tours.${userId}.${farm}`;
}

function readLocal(key: string): Partial<Record<TourName, SavedTour>> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<Record<TourName, SavedTour>>) : {};
  } catch {
    return {};
  }
}

export function TourProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { user, principal, readOnly } = useAuth();
  const [saved, setSaved] = useState<Partial<Record<TourName, SavedTour>>>({});
  const [loaded, setLoaded] = useState(false);
  const [current, setCurrent] = useState<{ tour: TourName; n: number } | null>(null);
  const [paused, setPaused] = useState(false);
  const [summary, setSummary] = useState<TourSummary>(EMPTY_SUMMARY);
  const actions = useRef(new Map<string, ActionFn>());
  const currentRef = useRef(current);
  currentRef.current = current;
  /** What this page load has saved itself, newest first over the server's copy. */
  const written = useRef<Partial<Record<TourName, SavedTour>>>({});

  const role = principal.role;
  const available: TourName | null =
    role === "owner" ? "owner" : role === "weigher" ? "weigher" : null;
  const key = user ? storageKey(user.id, user.farm.name) : null;

  const persist = useCallback(
    (tour: TourName, step: number, status: WireTourStatus) => {
      written.current = { ...written.current, [tour]: { step, status } };
      setSaved((prev) => {
        const next = { ...prev, [tour]: { step, status } };
        if (key) {
          try {
            localStorage.setItem(key, JSON.stringify(next));
          } catch {
            /* private mode: the server copy is enough */
          }
        }
        return next;
      });
      api.saveTour(tour, step, status).catch(() => {
        /* offline: localStorage keeps the place until the next save */
      });
    },
    [key],
  );

  // Load the saved progress, then decide whether a tour starts by itself.
  //
  // Only the server's answer can start a tour. A deploy restarts the API
  // (one replica, Recreate) at the same moment the service worker reloads
  // every open page onto the new build, so the first `/v1/me/tours` of that
  // page load often fails. That failure used to fall back to this device's
  // localStorage — empty on a new device or on a farm's own address — and an
  // empty answer read as "never seen": the tour came back after every
  // deploy. Now a failed load is retried for about a minute, and while the
  // server has not answered, nothing starts by itself.
  useEffect(() => {
    if (!user || !key) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    written.current = {};
    setLoaded(false);

    const attempt = async (n: number) => {
      let items: WireTourProgress[];
      try {
        items = await api.listTours();
      } catch {
        if (cancelled) return;
        if (n === 0) {
          // Enough for the resume card; not enough to start anything.
          setSaved({ ...readLocal(key), ...written.current });
          setLoaded(true);
        }
        if (n < TOUR_LOAD_RETRY_MS.length) {
          timer = setTimeout(() => void attempt(n + 1), TOUR_LOAD_RETRY_MS[n]);
        }
        return;
      }
      if (cancelled) return;
      const rows: Partial<Record<TourName, SavedTour>> = {};
      for (const it of items) {
        if (it.tour === "owner" || it.tour === "weigher") rows[it.tour] = { step: it.step, status: it.status };
      }
      // A save that never reached the server is still the newest fact: keep
      // it, and hand it to the server now so the next device knows too.
      const local = readLocal(key);
      for (const t of ["owner", "weigher"] as TourName[]) {
        const l = local[t];
        if (!rows[t] && l) {
          rows[t] = l;
          api.saveTour(t, l.step, l.status).catch(() => {
            /* still offline: try again on the next load */
          });
        }
      }
      // Whatever this page already wrote (a tour started by hand while the
      // load was retrying) is newer than what the server just said.
      setSaved({ ...rows, ...written.current });
      setLoaded(true);

      if (user.isSuperAdmin || readOnly || !available) return;
      if (currentRef.current || written.current[available]) return;
      const at = autoStartAt(available, rows[available]);
      if (at === null) return;
      setCurrent({ tour: available, n: at });
      // Mark it as shown the moment it shows: closing the page, a reload or
      // the next deploy must not bring it back by itself.
      persist(available, at, "active");
    };
    void attempt(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, key, available]);

  const start = useCallback(
    (tour: TourName, n?: number) => {
      const first = tour === "owner" ? 0 : 1;
      const at = n ?? first;
      setPaused(false);
      setCurrent({ tour, n: at });
      if (tour === "owner" && at === 0) setSummary(EMPTY_SUMMARY);
      persist(tour, at, "active");
    },
    [persist],
  );

  const resume = useCallback(
    (tour: TourName) => {
      const s = saved[tour];
      start(tour, resumeIndex(tour, s ? s.step : tour === "owner" ? 0 : 1));
    },
    [saved, start],
  );

  const goTo = useCallback(
    (n: number) => {
      const c = currentRef.current;
      if (!c) return;
      setPaused(false);
      setCurrent({ tour: c.tour, n });
      persist(c.tour, n, "active");
    },
    [persist],
  );

  const pause = useCallback(() => setPaused(true), []);

  const later = useCallback(() => {
    const c = currentRef.current;
    if (c) persist(c.tour, c.n, "later");
    setCurrent(null);
    setPaused(false);
  }, [persist]);

  const dismiss = useCallback(
    (tour: TourName) => {
      persist(tour, saved[tour]?.step ?? 0, "dismissed");
    },
    [persist, saved],
  );

  const finish = useCallback(() => {
    const c = currentRef.current;
    if (c) persist(c.tour, c.tour === "owner" ? OWNER_DONE : 2, "done");
    setCurrent(null);
    setPaused(false);
  }, [persist]);

  const isAt = useCallback(
    (tour: TourName, n: number) => !!current && !paused && current.tour === tour && current.n === n,
    [current, paused],
  );

  const registerAction = useCallback((name: string, fn: ActionFn) => {
    actions.current.set(name, fn);
    return () => {
      if (actions.current.get(name) === fn) actions.current.delete(name);
    };
  }, []);

  const runAction = useCallback(async (name: string) => {
    const fn = actions.current.get(name);
    if (!fn) return true;
    return fn();
  }, []);

  const note = useCallback(
    (patch: Partial<TourSummary> | ((s: TourSummary) => Partial<TourSummary>)) =>
      setSummary((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) })),
    [],
  );

  const value = useMemo<TourContextValue>(() => {
    const def = current ? stepOf(current.tour, current.n) : undefined;
    return {
      current: current && def ? { ...current, def } : null,
      paused,
      saved,
      loaded,
      available,
      summary,
      start,
      resume,
      goTo,
      pause,
      later,
      dismiss,
      finish,
      isAt,
      registerAction,
      runAction,
      note,
    };
  }, [current, paused, saved, loaded, available, summary, start, resume, goTo, pause, later, dismiss, finish, isAt, registerAction, runAction, note]);

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

const NOOP: TourContextValue = {
  current: null,
  paused: false,
  saved: {},
  loaded: false,
  available: null,
  summary: EMPTY_SUMMARY,
  start: () => {},
  resume: () => {},
  goTo: () => {},
  pause: () => {},
  later: () => {},
  dismiss: () => {},
  finish: () => {},
  isAt: () => false,
  registerAction: () => () => {},
  runAction: async () => true,
  note: () => {},
};

/** Outside a TourProvider (unit tests, the public pages) every call is a no-op. */
export function useTour(): TourContextValue {
  return useContext(TourContext) ?? NOOP;
}

/** Registers a page action for the tour's primary buttons while the page is mounted. */
export function useTourAction(name: string, fn: ActionFn) {
  const { registerAction } = useTour();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => registerAction(name, () => ref.current()), [name, registerAction]);
}
