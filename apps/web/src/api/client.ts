/**
 * The one place this app talks to the network.
 *
 * Two things it does that are easy to get wrong and expensive to get wrong:
 *
 * 1. **Transparent refresh.** The access token lasts 15 minutes and a farm
 *    administrator leaves the payment screen open far longer than that. A 401
 *    triggers exactly one refresh, shared by every request that was in flight
 *    (`refreshInFlight`), and then the original requests are replayed. Without
 *    the single-flight, a screen with four parallel loads fires four refreshes,
 *    three of them with an already-rotated token, and the server's reuse
 *    detection revokes the whole device chain — logging the user out for being
 *    careful.
 *
 * 2. **Errors arrive as `ApiError`, always.** Callers never see a Response.
 *    A network failure and a 500 are the same shape, so no screen has two
 *    error paths.
 */
import { ApiError } from "./errors";
import { API_BASE_URL } from "./mode";
import type { ApiErrorBody } from "./types";

/**
 * Empty by default, and it should stay empty: the Vite dev server proxies
 * `/v1` and `/health` to the API, which is what spares the browser a CORS
 * preflight the server has no middleware to answer. See `vite.config.ts`.
 */
const BASE_URL: string = API_BASE_URL;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

const STORAGE_KEY = "bascula.tokens";

let tokens: Tokens | null = readStoredTokens();
let refreshInFlight: Promise<Tokens | null> | null = null;

/** Fired when refresh fails: the shell listens and sends the user to login. */
export const authEvents = new EventTarget();

function readStoredTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    // Private windows and blocked site data throw on access, not on read.
    return null;
  }
}

export function getTokens(): Tokens | null {
  return tokens;
}

export function setTokens(next: Tokens | null): void {
  tokens = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage is a convenience here; the in-memory copy is the real one.
  }
}

export interface RequestOptions {
  /** Skip the Authorization header. Login, signup and refresh use this. */
  anonymous?: boolean;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | undefined | null>;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = `${BASE_URL}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  return new ApiError(res.status, body, `HTTP ${res.status}`);
}

async function rawRequest(
  method: string,
  path: string,
  body: unknown,
  opts: RequestOptions,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (!opts.anonymous && tokens) {
    headers.Authorization = `Bearer ${tokens.accessToken}`;
  }
  return fetch(buildUrl(path, opts.query), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal,
  });
}

/**
 * Rotate the refresh token. Everyone who hits a 401 at the same time awaits
 * this same promise; see the note at the top of the file.
 */
async function refreshTokens(): Promise<Tokens | null> {
  if (!tokens) return null;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(buildUrl("/v1/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokens?.refreshToken }),
      });
      if (!res.ok) {
        setTokens(null);
        authEvents.dispatchEvent(new Event("logout"));
        return null;
      }
      const next = (await res.json()) as Tokens;
      setTokens(next);
      return next;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  let res: Response;
  try {
    res = await rawRequest(method, path, body, opts);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, { error: { code: "NETWORK", message: "network" } });
  }

  // One retry, and only one: a second 401 after a fresh token is a real 401.
  if (res.status === 401 && !opts.anonymous && tokens) {
    const next = await refreshTokens();
    if (next) {
      try {
        res = await rawRequest(method, path, body, opts);
      } catch {
        throw new ApiError(0, { error: { code: "NETWORK", message: "network" } });
      }
    }
  }

  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const err = await parseError(res);
    if (err.status === 401) {
      setTokens(null);
      authEvents.dispatchEvent(new Event("logout"));
    }
    throw err;
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const http = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("POST", path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("PUT", path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>("PATCH", path, body, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, undefined, opts),
};
