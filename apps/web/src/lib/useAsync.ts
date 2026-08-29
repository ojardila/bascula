import { useCallback, useEffect, useRef, useState } from "react";
import { messageFor } from "../api/errors";
import { ApiError } from "../api/errors";

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
  return { data, error, denied, loading: data === null && !error && !denied, reload };
}
