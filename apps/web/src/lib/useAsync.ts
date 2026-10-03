// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, messageFor } from "../api/errors";
import { subscribeMutations } from "./crossTab";

interface AsyncState<T> {
  data: T | null;
  error: string | null;
  /** True when the failure was a 403: the caller has to leave the module. */
  denied: boolean;
  loading: boolean;
  reload: () => void;
}

/**
 * Load-on-mount with the three outcomes every screen has to handle: data, a
 * message, or "you are not allowed in here".
 *
 * Keeping `denied` separate from `error` is deliberate. A 403 is not something
 * the user can retry, and showing it as a red box with a Reintentar button
 * invites them to hammer a door that will never open.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDenied(false);
    setData(null);
    fnRef
      .current()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.isPermissionDenied) setDenied(true);
        else setError(messageFor(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  /**
   * Two more doors into `reload`, both outside the caller's control:
   *
   * - **Another tab wrote.** `subscribeMutations` fires on every write any tab
   *   makes, including this one's own. The extra GET in the writing tab is
   *   benign (any screen with more than the touched resource open can show
   *   something fresher), and the alternative — a separate code path for local
   *   writes — is a bifurcation waiting to rot.
   * - **This tab was hidden and came back.** A page suspended by the browser
   *   can miss broadcasts entirely; checking `visibilityState` on
   *   `visibilitychange` catches that case without a timer.
   */
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const unsubscribe = subscribeMutations(bump);
    const onVisible = () => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { data, error, denied, loading: data === null && !error && !denied, reload };
}
