/**
 * The wire, as `docs/sincronizacion.md` §3 and §4 describe it.
 *
 * Nothing in this file knows about HTTP, about the phone's SQLite, or about
 * which routes exist. It is the shape of the conversation: a handshake, a
 * batch of envelopes going up, a batch of changes coming down, and a table
 * saying what the client does with each answer.
 *
 * It is separate from any particular transport on purpose, and the separation
 * has now paid for itself twice over. When this was written the server had no
 * feed at all, and `restTransport.ts` assembled the three verbs out of ordinary
 * REST routes so the farm did not have to wait for one. `/v1/sync/handshake`,
 * `/v1/sync/push` and `/v1/sync/pull` exist today, `feedTransport.ts` speaks
 * them, and the swap cost exactly what this split was supposed to make it
 * cost: one new file. The engine, the outbox, the conflicts, the balance
 * checksum and every screen did not change by a line.
 *
 * `restTransport.ts` stays in the tree because a deployment that has not caught
 * up is still a deployment, and because its own header is an honest account of
 * what a shim can and cannot promise.
 */

import type { LedgerKind, PayMethod } from "../../../../packages/shared/src/enums.ts";

// ---- The handshake, §3.1 ------------------------------------------------

/** What the phone can do, as the server decides it. §3.1. */
export interface Capabilities {
  /**
   * False, always, under decision 5. Kept as a field rather than a constant
   * because it is what turns the settle button off without shipping a build,
   * and because §10.1 is the owner's to change.
   */
  settleOffline: boolean;
  /** Lotes are administered on the web. Decision 6. */
  writePlots: boolean;
  /** The weekly price is the owner's, on the web. Decision 6. */
  writeWeekPrices: boolean;
  /** Whether this token may read and write money at all. A weigher may not. */
  money: boolean;
}

export type FarmRole = "owner" | "admin" | "weigher";

export interface Handshake {
  farmId: string;
  /**
   * Null on the feed, which does not carry it: the name the screens show comes
   * from the session (`session.ts`), which learned it at login. Kept on the
   * type because the REST shim does have one and the report shows it.
   */
  farmName: string | null;
  /** The zone that decides every business date. §1.5b. */
  timezone: string;
  currency: string;
  role: FarmRole;
  capabilities: Capabilities;
  /** Where the server is now. Opaque: the phone stores it and hands it back. */
  cursor: string | null;
  /**
   * How many changes this phone has still to receive.
   *
   * §3.1: «lo que convierte el chip de estado de un spinner en un número». A
   * transport that cannot know it says zero, which reads as "nothing pending"
   * — the honest answer for a server with no feed to be behind.
   */
  behind: number;
  serverTime: string;
}

// ---- The push, §3.2 ----------------------------------------------------

/** The tables that travel, named as the wire names them. */
export type WireEntity =
  | "worker"
  | "plot"
  | "plotCrop"
  | "workRecord"
  | "weekPrice"
  | "settlement"
  | "ledgerEntry"
  | "config";

/**
 * One envelope. `opId` is the idempotency key of §4.2 — the same envelope
 * resent carries the same `opId`, so a server with a `sync_ops` table can
 * replay its answer without re-executing anything.
 *
 * There is no `op: "delete"`. §3.2: a deletion is an upsert carrying a
 * tombstone, in both directions, because a physical delete leaves nothing to
 * compare and resurrects on the next pull.
 */
export interface SyncOp {
  opId: string;
  entity: WireEntity;
  op: "upsert" | "append";
  /** The row's own UUIDv7, minted on this phone before the network existed. */
  id: string;
  payload: Record<string, unknown>;
  /** The outbox row this came from, so an ack can find it again. */
  origin: { seq: number; revision: number };
}

export type OpStatus =
  /** The server wrote it. */
  | "applied"
  /** The server already had it. §4.1: indistinguishable from success. */
  | "duplicate"
  /** The server refused it, and `error` says why. */
  | "rejected"
  /**
   * The phone refused to send it. Not a server answer: the entity is read-only
   * in this direction (§2.1) or is one only the server may create (§2). It
   * still needs a decision, so it raises a card.
   */
  | "unsendable";

export interface WireError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface OpResult {
  opId: string;
  status: OpStatus;
  /** The id the server knows the row by. Always the phone's own uuid. */
  id?: string;
  error?: WireError;
}

export interface PushResult {
  results: OpResult[];
  cursor: string | null;
}

/**
 * §3.2: at most 200 envelopes or 1 MB per batch. On a farm's network a big
 * batch is a batch that never finishes, and the phone would rather send eight
 * small ones that each land than one large one that times out for a week.
 */
export const MAX_OPS_PER_PUSH = 200;

// ---- The pull, §3.3 ----------------------------------------------------

export interface WireWorker {
  id: string;
  name: string;
  lastName: string | null;
  documentType: string | null;
  docId: string | null;
  tag: string | null;
  deletedAt: string | null;
}

export interface WirePlotCrop {
  id: string;
  plotId: string;
  /** The name the phone shows for a lote: the plot's, not the crop type's. */
  plotName: string;
  cropType: string | null;
  variety: string | null;
  areaHa: number | null;
  deletedAt: string | null;
}

export interface WireWorkRecord {
  id: string;
  workerId: string;
  /** A `plot_crop` id. The phone calls it a `cropId`. */
  cropId: string | null;
  quantity: number;
  /** The INSTANT, with its offset. Never a bare day. §3.2. */
  occurredAt: string;
  note: string | null;
  deletedAt: string | null;
}

export interface WireWeekPrice {
  weekStart: string;
  priceCents: number;
}

export interface WireSettlementItem {
  id: string;
  payableId: string;
  weekStart: string;
  quantity: number;
  priceCents: number;
  amountCents: number;
  voidedAt: string | null;
}

export interface WireSettlement {
  id: string;
  workerId: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  status: "open" | "void";
  note: string | null;
  createdAt: string;
  voidedAt: string | null;
  /** §3.3: a settlement travels whole. Never a header without its lines. */
  items: WireSettlementItem[];
}

export interface WireLedgerEntry {
  id: string;
  workerId: string;
  kind: LedgerKind;
  amountCents: number;
  date: string;
  settlementId: string | null;
  method: PayMethod | null;
  note: string | null;
  reversesId: string | null;
  createdAt: string;
}

/** One change from the feed. `seq` orders them; the phone applies in order. */
export type PullChange =
  | { seq: number; entity: "worker"; row: WireWorker }
  | { seq: number; entity: "plotCrop"; row: WirePlotCrop }
  | { seq: number; entity: "workRecord"; row: WireWorkRecord }
  | { seq: number; entity: "weekPrice"; row: WireWeekPrice }
  | { seq: number; entity: "settlement"; row: WireSettlement }
  | { seq: number; entity: "ledgerEntry"; row: WireLedgerEntry };

/**
 * §3.3. `balances` is a CHECKSUM, not a value: it arrives only in the last
 * page and the phone compares it against its own `BALANCE_SQL`. A total that
 * comes down the wire and gets stored is the materialised balance this whole
 * design spent three documents refusing.
 */
export interface PullResult {
  changes: PullChange[];
  cursor: string | null;
  more: boolean;
  balances?: { workerId: string; balanceCents: number }[];
  /**
   * What this pull could not read, and why. A weigher's token is refused the
   * money routes by RLS, so their pull legitimately comes back without
   * settlements or ledger — and the status screen has to be able to say so
   * rather than quietly claim the phone is up to date.
   */
  skipped?: { what: string; reason: string }[];
}

// ---- What the client does with each answer, §4.3 -----------------------

/**
 * The disposition of a push result. Four outcomes and no ambiguous cell —
 * which is the property §4.3's table was written to have.
 */
export type Disposition =
  /** Drop it from the outbox. The server has it, or never needs it. */
  | "done"
  /** Leave it queued. The next batch tries again. */
  | "retry"
  /** Drop it from the outbox and raise a card. A person decides. */
  | "conflict"
  /** Stop the whole sync. Credentials, or a schema the server refuses. */
  | "halt";

/**
 * §4.3, as code. Every branch here is a line of that table, and the ones that
 * look surprising are the ones the document argues hardest for:
 *
 * - `PAYABLE_ALREADY_CLAIMED` is a **success**. The second attempt to take a
 *   lock that can only be taken once means the lock is taken, which is what
 *   was wanted. Treating it as an error is how a client ends up retrying
 *   against a settled payable for ever.
 * - `BAD_REQUEST` is never retried. A loop against a 400 is how an app eats a
 *   battery and a data plan in a place with neither to spare.
 * - `429`, `5xx`, timeouts and no-network retry without any limit. The phone
 *   has all the time in the world and the rows do not expire.
 */
export function dispositionOf(result: OpResult): Disposition {
  if (result.status === "applied" || result.status === "duplicate") return "done";
  if (result.status === "unsendable") return "conflict";

  const code = result.error?.code ?? "INTERNAL";
  switch (code) {
    // Locks that can only be taken once. A second attempt means it is done.
    case "PAYABLE_ALREADY_CLAIMED":
    case "ALREADY_REVERSED":
    case "SETTLEMENT_ALREADY_VOID":
    case "SALE_ALREADY_VOID":
      return "done";

    // The same id already carries different data. Somebody edited a row the
    // server had already accepted under that id; this is not a retry, it is a
    // divergence, and a person has to look at it.
    case "IDEMPOTENCY_KEY_REUSED":
      return "conflict";

    // The server owns the lock and it is taken. §5.7a and §5.7b: the phone
    // keeps its change, shows it, and does not apply it.
    case "WORK_RECORD_SETTLED":
      return "conflict";

    // A parent that has not arrived yet. One more batch, and if the parent is
    // still missing it is a real hole rather than an ordering accident.
    case "NOT_FOUND":
      return "retry";

    // A bug in this client. Retrying cannot fix it and will not stop.
    case "BAD_REQUEST":
    case "UNSUPPORTED_MEDIA_TYPE":
    case "EXPENSE_TARGET_INVALID":
      return "conflict";

    case "UNAUTHORIZED":
    case "FORBIDDEN":
    case "TOKEN_EXPIRED":
    case "TOKEN_REUSED":
    case "FARM_SUSPENDED":
      return "halt";

    // 429, 5xx, timeout, no network — and anything this table has not met.
    // Retry is the safe default because the alternative is dropping a
    // weighing on a code nobody anticipated.
    default:
      return "retry";
  }
}

/**
 * §4.3's backoff: 2s, 4s, 8s … capped at 15 minutes, with jitter.
 *
 * The jitter is not decoration. Two phones that lose signal in the same lote
 * come back at the same moment and retry in lockstep for ever; a spread stops
 * them beating on a farm's single uplink together.
 */
export const RETRY_BASE_MS = 2000;
export const RETRY_CAP_MS = 15 * 60 * 1000;

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  // Full jitter over the lower half, so the delay never collapses to zero and
  // never exceeds the cap.
  return Math.round(raw * (0.5 + 0.5 * random()));
}

// ---- The port ----------------------------------------------------------

/**
 * Everything the engine needs from a server. Three methods, because §3 has
 * three verbs; anything a particular server cannot do it reports through
 * `PullResult.skipped` rather than by throwing, so a weigher's restricted
 * token degrades instead of failing.
 */
export interface SyncTransport {
  handshake(input: { deviceId: string; schemaVersion: number; cursor: string | null }): Promise<Handshake>;
  push(input: { deviceId: string; ops: SyncOp[] }): Promise<PushResult>;
  pull(input: { cursor: string | null; limit: number }): Promise<PullResult>;
}
