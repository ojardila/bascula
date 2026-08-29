/**
 * Registering the phone against a farm, and holding what that gets you.
 *
 * ## What is stored, and what is deliberately not
 *
 * **The password is never stored.** Not encrypted, not obfuscated, not once.
 * The owner types it on the registration screen, it is exchanged for a token
 * pair, and it is gone. That is the whole of the security story here that
 * actually matters: a stolen handset cannot be used to reset the farm's
 * account, only to hold a refresh token that the owner can revoke by logging
 * out everywhere.
 *
 * **The refresh token is stored in the app's own database.** Not in a keychain
 * — `expo-secure-store` is not in this app's dependencies, and adding a native
 * module means a rebuild, which is not a thing to do to a farm mid-harvest for
 * a change that buys less than it looks like it does. The refresh token sits
 * in the same sandboxed file as the season's payroll: anyone who can read one
 * can read the other, and the payroll is the more valuable of the two. When
 * the app is next rebuilt for other reasons, `SecretStore` below is the seam
 * to move it behind a keychain, and nothing else changes.
 *
 * The token IS single-use and rotating (the server kills the whole family on
 * reuse), so a copy lifted off a stolen phone stops working the moment the
 * real phone syncs — which is a stronger property than encryption at rest.
 */

import { ApiError, HttpClient, type Credentials, type Session } from "./http.ts";

/**
 * Where a secret lives. Two implementations: the phone's config row, and
 * whatever a future build puts behind a keychain.
 */
export interface SecretStore {
  read(key: string): string | null;
  write(key: string, value: string | null): void;
}

const KEY = "sync.session";

/** What `/v1/auth/login` and `/v1/auth/refresh` both answer. */
interface WireSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  farmId: string;
  farmName: string;
  role: string;
}

export interface StoredSession extends Credentials {
  farmName: string;
  email: string;
}

export interface FarmSessionOptions {
  baseUrl: string;
  store: SecretStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * The session, and the two operations that create one.
 *
 * It implements `Session` so an `HttpClient` can be built on it, and it uses
 * an `HttpClient` of its own for login and refresh — which are the only two
 * calls that are not themselves authenticated, and therefore the only two that
 * cannot recurse through it.
 */
export class FarmSession implements Session {
  private readonly store: SecretStore;
  private readonly anon: HttpClient;
  private readonly now: () => number;
  private cached: StoredSession | null | undefined;
  /**
   * The refresh in flight, if there is one.
   *
   * A push and a pull can both discover an expired token in the same tick. Two
   * refreshes with the same token is exactly the reuse the server treats as a
   * stolen token, and it revokes the whole family — logging the farm out in
   * the middle of a sync. Sharing one promise is what stops that.
   */
  private inFlight: Promise<Credentials> | null = null;

  constructor(opts: FarmSessionOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.anon = new HttpClient({
      baseUrl: opts.baseUrl,
      // Login and refresh never read a session, so this one is unused by them.
      session: { current: () => null, refresh: async () => { throw new ApiError("UNAUTHORIZED", "no session", 401); }, clear: () => {} },
      fetchImpl: opts.fetchImpl,
      now: opts.now,
      timeoutMs: opts.timeoutMs,
    });
  }

  current(): StoredSession | null {
    if (this.cached === undefined) {
      const raw = this.store.read(KEY);
      this.cached = raw ? (safeParse(raw) as StoredSession | null) : null;
    }
    return this.cached;
  }

  /** True once the phone has been registered against a farm. */
  get registered(): boolean {
    return this.current() !== null;
  }

  /**
   * Register this phone against a farm, with the owner's own credentials.
   *
   * Returns the farm id, which the caller writes onto the config row through
   * `sync.claimFarm` — deliberately not done here, because claiming a farm is
   * a database decision with its own guard (a phone already carrying another
   * farm's season refuses), and this class must not be able to bypass it.
   */
  async login(email: string, password: string, deviceId: string): Promise<StoredSession> {
    const body = await this.anon.request<WireSession>("/v1/auth/login", {
      method: "POST",
      anonymous: true,
      body: { email, password, deviceId },
    });
    return this.store_(body, email);
  }

  async refresh(): Promise<Credentials> {
    if (this.inFlight) return this.inFlight;
    const held = this.current();
    if (!held) throw new ApiError("UNAUTHORIZED", "no session", 401);

    this.inFlight = (async () => {
      try {
        const body = await this.anon.request<WireSession>("/v1/auth/refresh", {
          method: "POST",
          anonymous: true,
          body: { refreshToken: held.refreshToken },
        });
        return this.store_(body, held.email);
      } catch (e) {
        // A network failure is not a bad token. Clearing the session here
        // would log a farm out of its own app because a lote has no signal,
        // and the owner would have to remember a password to weigh coffee.
        if (e instanceof ApiError && !e.offline) this.clear();
        throw e;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  clear(): void {
    this.cached = null;
    this.store.write(KEY, null);
  }

  private store_(body: WireSession, email: string): StoredSession {
    const s: StoredSession = {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      // A minute of slack. Clocks on these handsets are set by hand and drift,
      // and a token believed valid one second past its expiry costs a round
      // trip; one believed expired a minute early costs nothing.
      expiresAt: this.now() + Math.max(0, body.expiresIn - 60) * 1000,
      farmId: body.farmId,
      farmName: body.farmName,
      role: body.role,
      email,
    };
    this.cached = s;
    this.store.write(KEY, JSON.stringify(s));
    return s;
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The default store: one row of the phone's own config table.
 *
 * A `secrets` table rather than a column on `config`, because `config` is a
 * synced entity — every column on it is queued into the outbox by a trigger
 * and would be pushed to the server. Putting a refresh token there would mail
 * it back to the machine that issued it, in a payload the phone's own outbox
 * keeps a copy of.
 */
export const SECRETS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS secrets (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`;

/**
 * The slice of a connection this store needs.
 *
 * The bind type is the loosest one both `expo-sqlite` and `node:sqlite`
 * satisfy: the values written here are two strings and nothing else, so
 * narrowing it further would only make the real `SQLiteDatabase` fail to fit a
 * port it already implements.
 */
export type SecretBind = string | number | null;

export interface SecretDb {
  getFirstSync<T>(sql: string, params: SecretBind[]): T | null;
  runSync(sql: string, params: SecretBind[]): unknown;
  execSync(sql: string): void;
}

export function sqliteSecretStore(db: SecretDb): SecretStore {
  db.execSync(SECRETS_SCHEMA);
  return {
    read: (key) =>
      db.getFirstSync<{ value: string | null }>(
        "SELECT value FROM secrets WHERE key = ?",
        [key],
      )?.value ?? null,
    write: (key, value) => {
      if (value === null) db.runSync("DELETE FROM secrets WHERE key = ?", [key]);
      else
        db.runSync(
          `INSERT INTO secrets (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [key, value],
        );
    },
  };
}

/** For tests, and for the day a keychain arrives. */
export function memorySecretStore(seed: Record<string, string> = {}): SecretStore {
  const map = new Map(Object.entries(seed));
  return {
    read: (k) => map.get(k) ?? null,
    write: (k, v) => {
      if (v === null) map.delete(k);
      else map.set(k, v);
    },
  };
}
