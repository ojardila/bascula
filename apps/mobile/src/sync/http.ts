/**
 * The one place that knows about the network.
 *
 * Everything above it — the transport, the engine, the screens — sees either a
 * parsed body or an `ApiError` whose `code` is a string from the server's own
 * enum. Nothing above it sees a `Response`, a status number, or the difference
 * between a socket that closed and a DNS lookup that failed, because none of
 * those change what the phone does: §4.3 puts every one of them in the same
 * row, "retry with backoff, no limit".
 *
 * Two properties this file exists to guarantee:
 *
 *  1. **Every request has a deadline.** `fetch` on a phone that has a bar of
 *     signal and no route does not fail; it hangs. A push that hangs holds the
 *     outbox lock and the status chip says "sending" until the app is killed.
 *  2. **A 401 is retried exactly once, after a refresh.** Access tokens live
 *     fifteen minutes and a sync in a lote can easily start on one side of
 *     that boundary and finish on the other. Retrying more than once against a
 *     refresh that is not working is how a client locks an account out.
 */

/**
 * An error with a code from the server's enum, or one of the two this client
 * adds for the conditions the server never sees.
 */
export class ApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /**
   * Whether this is the network rather than the server. The distinction the
   * user cares about — "sin señal" is not "algo salió mal" — and the only one
   * the status chip renders differently.
   */
  get offline(): boolean {
    return this.code === "NETWORK" || this.code === "TIMEOUT";
  }
}

/** No network, or a name that would not resolve. Not a server answer. */
export const CODE_NETWORK = "NETWORK";
/** The deadline passed. Also not a server answer. */
export const CODE_TIMEOUT = "TIMEOUT";

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which the access token stops being accepted. */
  expiresAt: number;
  farmId: string;
  role: string;
}

/**
 * Where the tokens live and how they are refreshed. The engine is handed one
 * of these rather than reading storage itself, so a test can drive a session
 * that expires mid-push without a clock or a keychain.
 */
export interface Session {
  current(): Credentials | null;
  /** Exchange the refresh token for a new pair. Throws `ApiError` on failure. */
  refresh(): Promise<Credentials>;
  /** Forget everything. Called on a refresh that the server rejects. */
  clear(): void;
}

export interface HttpClientOptions {
  baseUrl: string;
  session: Session;
  /** Injected so tests do not need a server, and so does the timeout clock. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Skip the Authorization header. Only login and refresh do this. */
  anonymous?: boolean;
  /** Do not retry after refreshing. Set internally on the second attempt. */
  noRetry?: boolean;
}

/** 25s. Long enough for a farm's uplink, short enough that a hang is noticed
 *  before the pesador gives up and force-quits the app. */
export const DEFAULT_TIMEOUT_MS = 25_000;

export class HttpClient {
  private readonly baseUrl: string;
  private readonly session: Session;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.session = opts.session;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.baseUrl + path + queryString(opts.query);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    if (!opts.anonymous) {
      const creds = this.session.current();
      if (!creds) throw new ApiError("UNAUTHORIZED", "no session", 401);
      // Refreshed BEFORE the request when it is about to expire, not after a
      // 401 came back. A push carrying two hundred weighings should not have
      // to be thrown away and repeated because the token aged out mid-flight.
      const fresh =
        creds.expiresAt - this.now() < 30_000
          ? await this.session.refresh()
          : creds;
      headers.Authorization = `Bearer ${fresh.accessToken}`;
    }

    const res = await this.send(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    if (res.status === 401 && !opts.anonymous && !opts.noRetry) {
      // Exactly once. A loop of refresh-and-retry against a revoked family is
      // how a device gets its whole token family killed for reuse.
      try {
        await this.session.refresh();
      } catch (e) {
        this.session.clear();
        throw e;
      }
      return this.request<T>(path, { ...opts, noRetry: true });
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const parsed = text ? safeJson(text) : null;

    if (!res.ok) {
      const err = (parsed as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)
        ?.error;
      throw new ApiError(
        err?.code ?? httpFallbackCode(res.status),
        err?.message ?? `HTTP ${res.status}`,
        res.status,
        err?.details,
      );
    }
    return parsed as T;
  }

  /**
   * `fetch` with a deadline, and with every way it can fail flattened into the
   * two codes above. `AbortController` rather than `Promise.race`, so the
   * socket is actually released instead of left running behind a promise
   * nobody is waiting on any more.
   */
  private async send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (e) {
      const aborted =
        (e as { name?: string })?.name === "AbortError" || controller.signal.aborted;
      throw new ApiError(
        aborted ? CODE_TIMEOUT : CODE_NETWORK,
        aborted ? "la petición tardó demasiado" : "sin conexión",
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function queryString(q: RequestOptions["query"]): string {
  if (!q) return "";
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * A body that is not JSON is a proxy's error page, a captive portal, or a
 * gateway timeout in HTML — all of which happen on the network this runs on.
 * None of them should throw a `SyntaxError` out of the sync engine.
 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function httpFallbackCode(status: number): string {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "INTERNAL";
  return "BAD_REQUEST";
}
