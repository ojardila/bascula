/**
 * `docs/sincronizacion.md` §3, spoken to the change feed that now exists.
 *
 * `restTransport.ts` was written to be replaced by this file, and its own
 * header says so: «El día que `/v1/sync/*` ships, a second implementation of
 * that interface replaces this one and nothing else moves.» This is that
 * second implementation. The engine, the outbox, the conflicts, the balance
 * checksum and every screen are unchanged; what changes is that the cursor is
 * now a real per-farm sequence with a commit horizon behind it, instead of a
 * timestamp window this client invented.
 *
 * What that buys, in the order it matters:
 *
 *  1. **The cursor can no longer step over a change.** §3.4's horizon holds a
 *     change back until its transaction has committed, so a row written in the
 *     same second as a pull appears in the next one, in its place. The REST
 *     shim could only close that hole by periodically re-reading everything.
 *  2. **`opId` is a real idempotency key.** `sync_ops` records the answer to an
 *     envelope, so a resend gets the recorded result back LITERALLY without
 *     executing anything. That is what finally covers the operations a
 *     client-generated uuid cannot — voiding and reversing, whose second
 *     attempt has a different answer from the first (§4.2).
 *  3. **One request per batch instead of one per envelope.** A lote of two
 *     hundred weighings is one round trip, and each envelope still lands or
 *     fails on its own `SAVEPOINT`.
 *  4. **`behind` is a number.** The chip can say how far behind the phone is
 *     rather than only whether it is trying.
 *
 * ## What is still not carried, said plainly
 *
 *  - **`plot` changes are dropped.** The phone has no `plots` table: a lote IS
 *    a `crop` row there, carrying the plot's name (`composeCrop` sends it as
 *    `name`). So a plot RENAMED on the web reaches the phone only when
 *    something about its crop also changes. The name is a label on a button
 *    and nothing is derived from it, which is why this is a wart and not a
 *    bug; it goes away with §8 fase 9, when the phone learns plots properly.
 *  - **`farmConfig` changes are dropped.** The two fields the phone acts on —
 *    the timezone and the currency — come down the handshake on every run, and
 *    the handshake is the only place `adoptTimezone` is allowed to be called
 *    from (§1.5b).
 *  - **A `reverso` cannot travel on the feed.** `/v1/sync/push` refuses any
 *    kind but pago, anticipo, deduccion and ajuste, because a `devengo` is the
 *    server's to write. A reversal is a different act on a different route, so
 *    it goes through `POST /v1/ledger/{id}/reverse` — the one place this file
 *    steps outside the feed, and it does so because the alternative is a
 *    reversal that sits in the outbox for ever.
 */

import { ApiError, type HttpClient } from "./http.ts";
import type {
  Handshake,
  PullChange,
  PullResult,
  PushResult,
  OpResult,
  SyncOp,
  SyncTransport,
  WireLedgerEntry,
  WireSettlement,
} from "./protocol.ts";

// ---- What the three routes answer --------------------------------------

interface HandshakeResponse {
  farmId: string;
  timezone: string;
  currency: string;
  minorUnit: number;
  serverTime: string;
  cursor: number;
  behind: number;
  role: "owner" | "admin" | "weigher";
  capabilities: {
    settleOffline: boolean;
    writePlots: boolean;
    writeWeekPrices: boolean;
  };
}

interface PushResponse {
  cursor: number;
  results: {
    opId: string;
    status: "applied" | "duplicate" | "rejected";
    id?: string;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  }[];
}

/** `SyncChange`. The body is composed at pull time from the real table. */
interface FeedChange {
  seq: number;
  entity:
    | "farmConfig"
    | "worker"
    | "plot"
    | "crop"
    | "weekPrice"
    | "workRecord"
    | "settlement"
    | "ledgerEntry";
  op: "upsert" | "append";
  row: Record<string, unknown> | null;
}

interface PullResponse {
  changes: FeedChange[];
  cursor: number;
  more: boolean;
  balances?: { workerId: string; balanceCents: number }[];
}

export interface FeedTransportOptions {
  http: HttpClient;
  now?: () => Date;
  /** The phone's local `user_version`. Below 6 the handshake answers 409. */
  schemaVersion?: number;
}

export class FeedTransport implements SyncTransport {
  private readonly http: HttpClient;
  private readonly now: () => Date;
  /** Filled by the handshake; the pull needs it to explain an empty money half. */
  private role: HandshakeResponse["role"] = "weigher";

  constructor(opts: FeedTransportOptions) {
    this.http = opts.http;
    this.now = opts.now ?? (() => new Date());
  }

  // ---- §3.1 -----------------------------------------------------------

  /**
   * `POST /v1/sync/handshake`.
   *
   * The cursor goes up as an integer and comes back as one; `sync_state.cursor`
   * is TEXT and the phone treats it as opaque, which is exactly the property
   * that let it hold the REST shim's JSON window yesterday and hold a sequence
   * today without a migration.
   *
   * `capabilities.money` is not on the wire — it follows from the role, and the
   * server enforces it with RLS whatever this says. The field exists so the
   * phone can grey out a screen rather than let a pesador walk into a 403.
   */
  async handshake(input: {
    deviceId: string;
    schemaVersion: number;
    cursor: string | null;
  }): Promise<Handshake> {
    const hs = await this.http.request<HandshakeResponse>("/v1/sync/handshake", {
      method: "POST",
      body: {
        deviceId: input.deviceId,
        schemaVersion: input.schemaVersion,
        cursor: seqOf(input.cursor),
      },
    });
    this.role = hs.role;
    return {
      farmId: hs.farmId,
      // The feed does not carry it; the session learned it at login.
      farmName: null,
      timezone: hs.timezone,
      currency: hs.currency,
      role: hs.role,
      capabilities: {
        settleOffline: hs.capabilities?.settleOffline ?? false,
        writePlots: hs.capabilities?.writePlots ?? false,
        writeWeekPrices: hs.capabilities?.writeWeekPrices ?? false,
        money: hs.role === "owner" || hs.role === "admin",
      },
      cursor: String(hs.cursor ?? 0),
      behind: hs.behind ?? 0,
      serverTime: hs.serverTime ?? this.now().toISOString(),
    };
  }

  // ---- §3.2 -----------------------------------------------------------

  /**
   * `POST /v1/sync/push`. One request for the whole batch.
   *
   * It always answers 200: the state of each envelope is in its own row,
   * because a batch of two hundred weighings where one names a worker the web
   * deleted has to land the other hundred and ninety-nine. A 400 here is the
   * BATCH being malformed, and it is reported against every envelope so the
   * engine's disposition table decides once rather than leaving the batch in
   * limbo.
   */
  async push(input: { deviceId: string; ops: SyncOp[] }): Promise<PushResult> {
    const results: OpResult[] = [];
    const sendable: SyncOp[] = [];

    for (const op of input.ops) {
      const refusal = this.refuse(op);
      if (refusal) {
        results.push(refusal);
        continue;
      }
      sendable.push(op);
    }

    // Reversals are not part of the feed's vocabulary. They go one at a time,
    // through the route that owns the act, and `ALREADY_REVERSED` is already a
    // success in §4.3's table.
    const feedOps: SyncOp[] = [];
    for (const op of sendable) {
      if (op.entity === "ledgerEntry" && op.payload.kind === "reverso") {
        results.push(await this.pushReversal(op));
        continue;
      }
      feedOps.push(op);
    }

    if (feedOps.length === 0) return { results, cursor: null };

    try {
      const res = await this.http.request<PushResponse>("/v1/sync/push", {
        method: "POST",
        body: {
          deviceId: input.deviceId,
          ops: feedOps.map((op) => ({
            // `sync_ops.op_id` is a `uuid PRIMARY KEY`, so the readable key
            // the engine composes cannot go on the wire as it is. `opUuid`
            // hashes it into one, which keeps the property that matters: the
            // SAME envelope resent carries the SAME key, and a correction to
            // the same row carries a different one.
            opId: opUuid(op.opId),
            entity: wireEntity(op.entity),
            op: op.op,
            payload: payloadFor(op),
          })),
        },
      });

      const byUuid = new Map(
        feedOps.map((op) => [opUuid(op.opId), op]),
      );
      for (const r of res.results ?? []) {
        const op = byUuid.get(r.opId);
        if (!op) continue;
        results.push({
          // Back to the engine's own key, which is what its ack matches on.
          opId: op.opId,
          status: r.status,
          id: r.id ?? op.id,
          error: r.error,
        });
      }
      // An envelope the server answered nothing about is left queued rather
      // than assumed. Silence is not an ack.
      for (const op of feedOps)
        if (!results.some((r) => r.opId === op.opId))
          results.push({
            opId: op.opId,
            status: "rejected",
            id: op.id,
            error: { code: "NO_RESULT", message: "el servidor no respondió por este envío" },
          });

      return { results, cursor: res.cursor === undefined ? null : String(res.cursor) };
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      // A malformed BATCH, or the network. Every envelope carries the same
      // answer, and §4.3 decides what that means once: a 400 is a bug in this
      // client and raises cards, a timeout is retried for ever.
      for (const op of feedOps)
        results.push({
          opId: op.opId,
          status: "rejected",
          id: op.id,
          error: { code: e.code, message: e.message, details: e.details },
        });
      return { results, cursor: null };
    }
  }

  /**
   * The entities §2 says never travel up, refused here rather than by the
   * server.
   *
   * Not to save a round trip: `unsendable` is a different disposition from
   * `rejected` in §4.3, and it is the one that raises a "se administra en la
   * web" card instead of a generic refusal with a server's English message on
   * it. The server refuses these too, with its own reason; this is the phone
   * saying the same thing in the words §7.3 asks for.
   */
  private refuse(op: SyncOp): OpResult | null {
    if (op.entity === "worker" || op.entity === "workRecord") return null;
    if (op.entity === "ledgerEntry") {
      const kind = op.payload.kind;
      if (kind === "devengo")
        return {
          opId: op.opId,
          status: "unsendable",
          id: op.id,
          error: {
            code: "SERVER_OWNED",
            message: "un devengo lo produce el servidor al liquidar",
          },
        };
      return null;
    }
    return {
      opId: op.opId,
      status: "unsendable",
      id: op.id,
      error: {
        code: "READ_ONLY_ON_PHONE",
        message: `${op.entity} se administra en la web`,
      },
    };
  }

  /** `POST /v1/ledger/{id}/reverse` — see the note at the top of the file. */
  private async pushReversal(op: SyncOp): Promise<OpResult> {
    const reverses = op.payload.reversesId as string | undefined;
    if (!reverses)
      return {
        opId: op.opId,
        status: "unsendable",
        id: op.id,
        error: {
          code: "BAD_REQUEST",
          message: "un reverso sin el movimiento que anula",
        },
      };
    try {
      await this.http.request(`/v1/ledger/${reverses}/reverse`, {
        method: "POST",
        body: { id: op.id, note: op.payload.note ?? null },
      });
      return { opId: op.opId, status: "applied", id: op.id };
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      return {
        opId: op.opId,
        status: "rejected",
        id: op.id,
        error: { code: e.code, message: e.message, details: e.details },
      };
    }
  }

  // ---- §3.3 -----------------------------------------------------------

  /**
   * `GET /v1/sync/pull?cursor=&limit=`. One page of the feed, in `seq` order.
   *
   * `CURSOR_TOO_OLD` is handled here and not by the engine, because the answer
   * to it is a property of the feed rather than a decision anybody makes: the
   * cursor is older than what is retained, so the feed can no longer say what
   * was missed, and the only correct move is to read from 0 again. Every apply
   * is an upsert by uuid, so re-reading the whole farm is expensive and
   * harmless — which is exactly why skipping the gap in silence would not be.
   */
  async pull(input: { cursor: string | null; limit: number }): Promise<PullResult> {
    const from = seqOf(input.cursor);
    let res: PullResponse;
    let bootstrapped = false;
    try {
      res = await this.http.request<PullResponse>("/v1/sync/pull", {
        query: { cursor: from, limit: Math.min(500, input.limit) },
      });
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "CURSOR_TOO_OLD") throw e;
      // Handled here, and now SAID. The re-read is not a decision anybody
      // makes, but a farm whose phone is about to download its whole season
      // deserves the sentence rather than a `behind` counter that leaps from
      // eleven to forty thousand between one run and the next.
      bootstrapped = true;
      res = await this.http.request<PullResponse>("/v1/sync/pull", {
        query: { cursor: 0, limit: Math.min(500, input.limit) },
      });
    }

    const changes: PullChange[] = [];
    const dropped = new Set<string>();

    for (const c of res.changes ?? []) {
      // A body the server composed as null — the row was deleted outright, or
      // this token may not see it. The seq is still consumed, which is the
      // point of §3.3's rule that a weigher's cursor keeps moving.
      if (!c.row) continue;
      const mapped = toPullChange(c);
      if (mapped) changes.push(mapped);
      else dropped.add(c.entity);
    }

    const skipped: { what: string; reason: string }[] = [];
    if (this.role === "weigher")
      skipped.push({
        what: "liquidaciones y movimientos",
        reason: "el pesador no lee dinero",
      });
    if (dropped.has("plot"))
      skipped.push({
        what: "el nombre de un lote",
        reason: "el teléfono guarda el lote junto al cultivo",
      });

    return {
      changes,
      cursor: res.cursor === undefined ? input.cursor : String(res.cursor),
      more: !!res.more,
      balances: res.balances,
      skipped,
      bootstrapped,
    };
  }
}

// ---- Plumbing ----------------------------------------------------------

/** The cursor as the feed wants it. Anything unreadable means "from the start". */
function seqOf(raw: string | null): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  // A cursor left behind by the REST shim, which wrote a JSON window. It means
  // nothing to the feed, and 0 is the only safe reading of a position this
  // server never issued: read everything, upsert by uuid, lose nothing.
  return 0;
}

/** The engine's entity names, in the enum the feed declares. */
function wireEntity(entity: SyncOp["entity"]): string {
  if (entity === "plotCrop") return "crop";
  if (entity === "config") return "farmConfig";
  return entity;
}

/**
 * The payload, with the row's id inside it and nothing the handler does not
 * declare.
 *
 * `decodePayload` uses `DisallowUnknownFields` per entity, so one extra
 * property refuses that envelope with a 400 — and §4.3 turns a 400 into a card
 * rather than a retry, which means a stray field would take a weighing out of
 * the queue and put it in front of a person for no reason.
 */
function payloadFor(op: SyncOp): Record<string, unknown> {
  const p = op.payload;
  if (op.entity === "worker")
    return {
      id: op.id,
      name: p.name ?? "",
      lastName: nullable(p.lastName),
      documentType: nullable(p.documentType),
      docId: nullable(p.docId),
      tag: nullable(p.tag),
      deletedAt: nullable(p.deletedAt),
    };

  if (op.entity === "workRecord")
    return {
      id: op.id,
      workerId: p.workerId ?? null,
      cropId: p.cropId ?? null,
      quantity: p.quantity ?? 0,
      // The INSTANT, never the farm's day. §3.2 and the handler both refuse a
      // bare day here: the server's trigger derives `local_day` from the
      // farm's own timezone, and Go never computes it. That division is what
      // makes golden case 04 — the Sunday-evening weighing — land in the same
      // week at both ends.
      occurredAt: p.occurredAt ?? null,
      note: nullable(p.note),
      deletedAt: nullable(p.deletedAt),
    };

  // ledgerEntry. The stored SIGN travels: the handler normalises pago,
  // anticipo and deduccion to negative itself and leaves an `ajuste` exactly as
  // it arrives, which is the one kind whose sign is the phone's to decide.
  const kind = p.kind as string;
  return {
    id: op.id,
    workerId: p.workerId ?? null,
    kind,
    amountCents: p.amountCents ?? 0,
    date: String(p.date ?? "").slice(0, 10),
    // A deduction has no payment method and the handler refuses one.
    method: kind === "deduccion" ? null : nullable(p.method),
    note: nullable(p.note),
  };
}

const nullable = (v: unknown): unknown => (v === undefined || v === "" ? null : v);

/**
 * A uuid for the envelope, derived from the engine's own key.
 *
 * `sync_ops.op_id` is a `uuid PRIMARY KEY`, and the engine's key —
 * `entity:uuid:revision` — is readable and is not a uuid. This hashes that
 * string into 128 deterministic bits and stamps the version and variant
 * nibbles on, so what goes on the wire is a valid uuid that means exactly what
 * the engine meant: the SAME envelope resent produces the SAME key, and a
 * correction to the same row, carrying a higher revision, produces a different
 * one. That is the whole of §4.2's first requirement.
 *
 * A hash rather than an arithmetic tweak of the row's own uuid, and the
 * difference is not cosmetic: bumping the last digits of a uuid by a small
 * revision collides with the id of any row whose uuid happens to sit that few
 * counts away, and inside one millisecond this generator hands out ids that
 * ARE adjacent (`packages/shared/src/uuid.ts` puts its counter in `rand_a`).
 * A collision here is two different acts sharing one idempotency key, which is
 * one of them silently getting the other's recorded answer back. Hashing the
 * whole key spreads across the full 122 usable bits instead.
 *
 * Not cryptographic and not pretending to be: nothing here defends against a
 * forged key. It has to be deterministic, well spread, and computable on a
 * handset with no crypto module in reach.
 */
export function opUuid(opId: string): string {
  const [a, b, c, d] = hash128(opId);
  const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  const raw = hex8(a) + hex8(b) + hex8(c) + hex8(d);
  return (
    raw.slice(0, 8) +
    "-" +
    raw.slice(8, 12) +
    // Version 7, so the id says what it is even though its bits are a hash and
    // not a clock. Nothing reads a timestamp out of an opId.
    "-7" +
    raw.slice(13, 16) +
    "-" +
    // Variant `10`.
    ((parseInt(raw.slice(16, 17), 16) & 0x3) | 0x8).toString(16) +
    raw.slice(17, 20) +
    "-" +
    raw.slice(20, 32)
  );
}

/**
 * Four 32-bit words from a string, in the shape of cyrb128.
 *
 * Four independently seeded accumulators mixed with `Math.imul`, then
 * avalanched against each other so a one-character difference moves every
 * word. Enough spread that two of a season's envelopes sharing all 128 bits is
 * not a thing that happens.
 */
function hash128(s: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  return [h1 >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/** One feed change, in the shape `syncStore.applyPull` already understands. */
function toPullChange(c: FeedChange): PullChange | null {
  const row = c.row as Record<string, unknown>;
  switch (c.entity) {
    case "worker":
      return {
        seq: c.seq,
        entity: "worker",
        row: {
          id: str(row.id),
          name: str(row.name),
          lastName: orNull(row.lastName),
          // A weigher's feed carries no document: the same projection
          // `/v1/workers` already applies, and it would be odd for the feed to
          // be the way around it. `applyWorker` writes "" for a null, which is
          // what the column held before any of this.
          documentType: orNull(row.documentType),
          docId: orNull(row.docId),
          tag: orNull(row.tag),
          deletedAt: orNull(row.deletedAt),
        },
      };

    case "crop":
      // The phone's `crops` row IS a plot_crop, and the name it shows is the
      // plot's — which is what `composeCrop` already sends as `name`.
      return {
        seq: c.seq,
        entity: "plotCrop",
        row: {
          id: str(row.id),
          plotId: str(row.plotId),
          plotName: str(row.name),
          cropType: orNull(row.cropType),
          variety: orNull(row.variety),
          areaHa: num(row.areaHa),
          deletedAt: orNull(row.deletedAt),
        },
      };

    case "weekPrice":
      return {
        seq: c.seq,
        entity: "weekPrice",
        row: {
          weekStart: str(row.weekStart),
          priceCents: Number(row.priceCents ?? 0),
        },
      };

    case "workRecord":
      return {
        seq: c.seq,
        entity: "workRecord",
        row: {
          id: str(row.id),
          workerId: str(row.workerId),
          cropId: orNull(row.cropId),
          // `quantity` arrives as a decimal STRING: the server sends it that
          // way so a number's binary rounding never touches a kilo on the way
          // through JSON.
          quantity: Number(row.quantity ?? 0),
          occurredAt: str(row.occurredAt),
          note: orNull(row.note),
          deletedAt: orNull(row.deletedAt),
        },
      };

    case "settlement":
      return { seq: c.seq, entity: "settlement", row: toSettlement(row) };

    case "ledgerEntry":
      return {
        seq: c.seq,
        entity: "ledgerEntry",
        row: {
          id: str(row.id),
          workerId: str(row.workerId),
          kind: str(row.kind) as WireLedgerEntry["kind"],
          amountCents: Number(row.amountCents ?? 0),
          date: str(row.date).slice(0, 10),
          settlementId: orNull(row.settlementId),
          method: orNull(row.method) as WireLedgerEntry["method"],
          note: orNull(row.note),
          reversesId: orNull(row.reversesId),
          createdAt: str(row.createdAt),
        },
      };

    // `plot` and `farmConfig`: see the header. Reported, never applied.
    default:
      return null;
  }
}

function toSettlement(row: Record<string, unknown>): WireSettlement {
  const id = str(row.id);
  const voidedAt = orNull(row.voidedAt);
  const items = Array.isArray(row.items) ? (row.items as Record<string, unknown>[]) : [];
  return {
    id,
    workerId: str(row.workerId),
    periodStart: str(row.periodStart).slice(0, 10),
    periodEnd: str(row.periodEnd).slice(0, 10),
    grossCents: Number(row.grossCents ?? 0),
    status: str(row.status) === "void" ? "void" : "open",
    note: orNull(row.note),
    createdAt: str(row.createdAt),
    voidedAt,
    items: items.map((i) => ({
      // A line has no id of its own on the wire — `composeSettlement` sends
      // the payable, which is what identifies it for the phone anyway: it is
      // the column the anti double-pay lock lives on at both ends.
      id: `${id}:${str(i.payableId)}`,
      payableId: str(i.payableId),
      weekStart: str(i.weekStart).slice(0, 10),
      quantity: Number(i.quantity ?? 0),
      priceCents: Number(i.priceCents ?? 0),
      amountCents: Number(i.amountCents ?? 0),
      // The feed says `voided`, a boolean. The phone stores an instant, and
      // the only one it can honestly use is the document's own.
      voidedAt: i.voided ? (voidedAt ?? str(row.createdAt)) : null,
    })),
  };
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const orNull = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v);
const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
