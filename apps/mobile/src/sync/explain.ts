/**
 * Turning what went wrong into what to do about it.
 *
 * `sync_state.lastError` is stored as `CODE: message`, which is the right
 * thing to keep — a support call needs the code — and the wrong thing to show.
 * «FARM_SUSPENDED: farm is suspended» on the screen of a pesador standing in a
 * lote is a string that tells them nothing and worries them anyway.
 *
 * This lives outside `SyncStatus.tsx` for one reason: the screen has no tests
 * and this table is the part that has to be complete. §7.1's whole argument is
 * that a status is a sentence and never a spinner; a code the table has not
 * met falls through to the raw string, which is a spinner made of letters.
 * `explain.test.ts` walks every code `protocol.ts` names and fails when one of
 * them has no sentence — so the table cannot silently fall behind the protocol
 * the way it had.
 *
 * The wording splits on what the person can DO, not on what the server meant:
 *
 *  - **the network** — wait, it will retry by itself, nothing is lost;
 *  - **the session** — reconnect, and that is a button on this screen;
 *  - **the farm's account** — nobody on this phone can fix it; call whoever
 *    owns the farm;
 *  - **this build of the app** — update it;
 *  - **a bug** — the raw code, on purpose, because somebody has to read it.
 */

/** The keys `strings.ts` has to carry for every branch below. */
export type SyncErrorKey =
  | "sync.errNoSignal"
  | "sync.errPartial"
  | "sync.errAuth"
  | "sync.errSuspended"
  | "sync.errRateLimited"
  | "sync.errServer"
  | "sync.errAppOld"
  | "sync.errBackoff"
  | "sync.errBug";

export interface SyncErrorExplanation {
  key: SyncErrorKey;
  /** Whether trying again by hand can help. A suspended farm cannot. */
  retryable: boolean;
  /** The code, kept for the line underneath. Somebody has to be able to read it. */
  code: string;
}

/**
 * The code out of a `CODE: message` string, or the whole thing when it has no
 * shape this recognises — an `INTERNAL` from a thrown `Error` carries a
 * message with colons of its own.
 */
export function codeOf(lastError: string): string {
  const m = /^([A-Z_][A-Z0-9_]*)\b/.exec(lastError.trim());
  return m ? m[1] : "";
}

/**
 * What this failure is, as one of the five things a person can act on.
 *
 * Deliberately a lookup on the code and not a regular expression over the
 * whole string: the previous version matched `/UNAUTHORIZED|FORBIDDEN|TOKEN/`
 * anywhere in the text, so a server message that happened to contain the word
 * "token" turned a network hiccup into "vuelve a conectar el teléfono".
 */
export function explainSyncError(lastError: string): SyncErrorExplanation {
  const code = codeOf(lastError);
  const at = (key: SyncErrorKey, retryable = true): SyncErrorExplanation => ({
    key,
    retryable,
    code: code || lastError,
  });

  switch (code) {
    // The network. §4.3 retries these for ever and the rows do not expire, so
    // the honest sentence is "no hay señal", not "algo salió mal".
    case "NETWORK":
    case "TIMEOUT":
      return at("sync.errNoSignal");

    // The run worked; some envelopes came back with a code §4.3 says to
    // retry. Not a failure, and saying so would be crying wolf — but the
    // number of things not sent is real and belongs on the screen.
    case "PARTIAL":
      return at("sync.errPartial");

    // Waiting out the backoff. Never stored today, and covered anyway: a
    // status the screen cannot name is exactly what this file exists to stop.
    case "BACKOFF":
      return at("sync.errBackoff");

    // The session. There IS a button for this on the status screen.
    case "UNAUTHORIZED":
    case "FORBIDDEN":
    case "TOKEN_EXPIRED":
    case "TOKEN_REUSED":
      return at("sync.errAuth");

    // The farm's account, which nobody holding this phone can fix. Separated
    // from the session on purpose: telling somebody to reconnect when
    // reconnecting cannot work is how an afternoon gets spent on a login
    // screen.
    case "FARM_SUSPENDED":
      return at("sync.errSuspended", false);

    case "RATE_LIMITED":
      return at("sync.errRateLimited");

    case "INTERNAL":
    case "BAD_GATEWAY":
    case "SERVICE_UNAVAILABLE":
      return at("sync.errServer");

    // This build of the app is older than the server will talk to. Retrying
    // is the one thing that cannot work.
    case "SCHEMA_TOO_OLD":
      return at("sync.errAppOld", false);

    // A cursor older than the feed still retains. `feedTransport` handles it
    // by re-reading from zero and it should never reach here; if it does, the
    // next run fixes it and the person needs to know they are not up to date.
    case "CURSOR_TOO_OLD":
      return at("sync.errPartial");

    // A bug in this client: a 400, a body the server would not decode, a
    // parent that never arrived. The code goes on the screen because
    // somebody is going to have to read it out over the phone.
    default:
      return at("sync.errBug", false);
  }
}
