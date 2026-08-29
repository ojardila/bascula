/**
 * The §3 protocol, spoken to the API that exists today.
 *
 * ## This is no longer the transport the app runs
 *
 * When it was written the API had 99 routes and not one of them was a change
 * feed, so this file assembled §3's three verbs out of ordinary REST. The feed
 * exists now — `feedTransport.ts` speaks `/v1/sync/handshake`, `/v1/sync/push`
 * and `/v1/sync/pull`, and `SyncProvider` builds the engine on that. The swap
 * was one new file, which is the property `protocol.ts` was split out to have.
 *
 * It stays here for two reasons and neither is sentiment. A deployment that
 * has not caught up is still a deployment and this is what it can talk to; and
 * `RestTransport` also carries `POST /v1/import/season`, which is a plain REST
 * route and not part of the feed — the whole of §8 fase 4 goes through this
 * class.
 *
 * What follows is the original reasoning, kept because it is an honest account
 * of what a shim can and cannot promise.
 *
 * The choice it made, and not a different one:
 *
 *  - **The phone is not held back until the feed is written.** It registers,
 *    it pushes, it receives, and the farm gets the thing it is waiting for.
 *  - **Nothing here is invented on the money side.** Idempotency by
 *    `(farm_id, id)` is real on every write today — §4.1, the layer that
 *    actually stops a retry becoming a second payment — so the guarantee the
 *    outbox depends on holds.
 *  - **The whole shim is one file.** The engine, the outbox, the conflicts and
 *    every screen speak `SyncTransport`. The day `/v1/sync/*` ships, a second
 *    implementation of that interface replaces this one and nothing else moves.
 *
 * What is genuinely weaker than §3, stated plainly rather than buried:
 *
 *  1. **The cursor is not a sequence.** There is no server-assigned order, so
 *     it is a timestamp this client writes and reads and the server never sees.
 *     A change made between two pulls in the same second can be missed by the
 *     window and picked up by the next full sweep. Correctness does not rest
 *     on it: every apply is an upsert by uuid, so a change seen twice is a
 *     no-op and a change seen late is still applied. What is lost is the §3.4
 *     guarantee that the cursor can never step over a change — which is why
 *     the sweep below is periodically unwindowed rather than always
 *     incremental.
 *  2. **A pull is several requests, not one transaction.** A settlement and
 *     its lines arrive together (they are one response), but a settlement and
 *     the ledger entry that pays it are two. The engine applies each batch in
 *     one SQLite transaction, so the phone is never left holding half a
 *     document; it can be left holding an earlier consistent state.
 *  3. **There is no `sync_ops`.** §4.2's second layer is absent, so an
 *     operation that is not an insert-by-uuid — voiding, reversing — is
 *     protected only by its own "already done" error code. Those codes exist
 *     (`ALREADY_REVERSED`, `SETTLEMENT_ALREADY_VOID`) and §4.3 already treats
 *     them as success, so the hole is narrower than it sounds, but it is a hole.
 */

import { mondayOf, parseDay, addDays } from "../../../../packages/shared/src/time.ts";
import { ApiError, type HttpClient } from "./http.ts";
import type {
  SeasonImportInput,
  SeasonImportReport,
  SeasonImportTransport,
} from "./seasonImport.ts";
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

// ---- What the routes actually answer -----------------------------------

interface MeResponse {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "weigher";
  superadmin: boolean;
  farm: { id: string; name: string; timezone: string; currency: string };
}

interface WorkerRow {
  id: string;
  name: string;
  lastName: string | null;
  documentType: string | null;
  docId: string | null;
  tag: string | null;
  createdAt: string;
  deletedAt: string | null;
}

interface PlotCropRow {
  id: string;
  plotId: string;
  cropType: string | null;
  variety: string | null;
  areaHa: number | null;
  deletedAt: string | null;
}

interface PlotRow {
  id: string;
  name: string;
  areaHa: number | null;
  deletedAt: string | null;
  crops: PlotCropRow[];
}

interface WorkRecordRow {
  id: string;
  workerId: string;
  /** A decimal STRING, not a number — the API sends it that way on purpose. */
  quantity: string | number;
  startedAt: string;
  dateFrom: string;
  note: string | null;
  deletedAt: string | null;
  plotCropIds: string[];
  settled: boolean;
}

interface LedgerRow {
  id: string;
  workerId: string;
  kind: WireLedgerEntry["kind"];
  amountCents: number;
  date: string;
  settlementId: string | null;
  method: WireLedgerEntry["method"];
  note: string | null;
  reversesId: string | null;
  createdAt: string;
}

interface SettlementRow {
  id: string;
  workerId: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  status: "open" | "void";
  note: string | null;
  createdAt: string;
  voidedAt: string | null;
  items: {
    payableId: string;
    weekStart: string;
    quantity: string | number;
    rateCents: number;
    amountCents: number;
    voided?: boolean;
  }[];
}

interface BalanceRow {
  workerId: string;
  balanceCents: number;
}

/** The cursor this transport writes. Opaque to everything above. */
interface RestCursor {
  /** When the last pull finished. The window's lower bound, minus slack. */
  at: string;
  /** How many incremental pulls since the last unwindowed sweep. */
  since: number;
}

/**
 * How often the window is dropped and everything is re-read.
 *
 * Every twelfth pull. The window can miss a change written in the same second
 * a pull started — there is no sequence to make that impossible — so something
 * has to close over it, and re-reading a small farm's tables is cheap. Twelve
 * pulls is about three hours at the fifteen-minute cadence of §3.5.
 */
const FULL_SWEEP_EVERY = 12;

/**
 * How far back the window reaches beyond the cursor.
 *
 * Ten minutes, and it is not caution for its own sake: `createdAt` comes from
 * the SERVER's clock and the cursor is compared against it here, so any skew
 * between the two machines eats into the window directly. Ten minutes of slack
 * costs a few rows re-upserted and buys immunity to a clock a few minutes out.
 */
const WINDOW_SLACK_MS = 10 * 60 * 1000;

export interface RestTransportOptions {
  http: HttpClient;
  now?: () => Date;
  /**
   * How far back the first pull reaches for weighings, in days. A farm that
   * has been running two seasons on the web does not need all of it on a
   * phone whose screens only look back one; and §5.3 means a weighing that
   * arrives later still settles correctly, at its own week's price.
   */
  firstPullDays?: number;
}

export class RestTransport implements SyncTransport, SeasonImportTransport {
  private readonly http: HttpClient;
  private readonly now: () => Date;
  private readonly firstPullDays: number;
  /** Filled by the handshake; the pull needs to know what it may read. */
  private role: MeResponse["role"] = "weigher";

  constructor(opts: RestTransportOptions) {
    this.http = opts.http;
    this.now = opts.now ?? (() => new Date());
    this.firstPullDays = opts.firstPullDays ?? 180;
  }

  // ---- §3.1 -----------------------------------------------------------

  /**
   * `/v1/me` stands in for the handshake. It carries the two things the phone
   * cannot work without — the farm id and the farm's TIMEZONE — plus the role,
   * which is what the capabilities are derived from.
   *
   * What it does not carry is `cursor`, `behind`, or a schema check. A server
   * with no feed has no position to report, and one that has never heard of
   * `schemaVersion` cannot answer `SCHEMA_TOO_OLD`; the phone sends its
   * version anyway so that the day the check exists, old handsets already
   * declare themselves.
   */
  async handshake(input: {
    deviceId: string;
    schemaVersion: number;
    cursor: string | null;
  }): Promise<Handshake> {
    const me = await this.http.request<MeResponse>("/v1/me");
    this.role = me.role;
    const money = me.role === "owner" || me.role === "admin";
    return {
      farmId: me.farm.id,
      farmName: me.farm.name,
      timezone: me.farm.timezone,
      currency: me.farm.currency,
      role: me.role,
      capabilities: {
        // Decision 5, and not negotiable from here: the server owns the lock.
        settleOffline: false,
        // Decision 6. Both are the owner's, on the web.
        writePlots: false,
        writeWeekPrices: false,
        money,
      },
      cursor: input.cursor,
      // No feed, nothing to be behind. The honest answer, and the reason
      // `behind` is a number rather than an optional: a transport that cannot
      // know says zero out loud instead of leaving the chip guessing.
      behind: 0,
      serverTime: this.now().toISOString(),
    };
  }

  // ---- §3.2 -----------------------------------------------------------

  /**
   * One request per envelope, and the batch keeps going after a rejection.
   *
   * That is §3.2's "each op in its own SAVEPOINT" with the only tool this API
   * gives: separate requests. A lote of two hundred weighings where one points
   * at a worker the web deleted has to land the other hundred and ninety-nine,
   * and it does — the failure is recorded against its own envelope and the
   * loop continues.
   *
   * Sequential rather than parallel, deliberately. The order is causal (the
   * outbox hands them over in `rowid` order, parents first), and firing them
   * at once would let a weighing reach the server before the worker it names.
   */
  async push(input: { deviceId: string; ops: SyncOp[] }): Promise<PushResult> {
    const results: OpResult[] = [];
    for (const op of input.ops) {
      results.push(await this.pushOne(op, input.deviceId));
    }
    return { results, cursor: null };
  }

  private async pushOne(op: SyncOp, deviceId: string): Promise<OpResult> {
    try {
      switch (op.entity) {
        case "worker":
          return await this.pushWorker(op);
        case "workRecord":
          return await this.pushWorkRecord(op, deviceId);
        case "ledgerEntry":
          return await this.pushLedgerEntry(op);
        default:
          // Everything else is ↓ only under §2. Reaching here means a row was
          // queued for a table this phone does not own, which is a decision
          // for a person and not something to drop quietly.
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
    } catch (e) {
      if (e instanceof ApiError)
        return {
          opId: op.opId,
          status: "rejected",
          id: op.id,
          error: { code: e.code, message: e.message, details: e.details },
        };
      throw e;
    }
  }

  /**
   * A worker. `POST` is idempotent by id, so a retry after a lost response
   * returns the row that already exists rather than creating a second one.
   *
   * The `IDEMPOTENCY_KEY_REUSED` branch is the interesting one: it means this
   * id exists on the server carrying DIFFERENT data, which is what happens
   * when the phone edited a worker it had already pushed. The write becomes a
   * PATCH, and — §2 — it carries only the fields the phone's own screen edits,
   * so a photo or an address entered on the web is not blanked by a handset
   * that has never had a box to type one in.
   */
  private async pushWorker(op: SyncOp): Promise<OpResult> {
    const p = op.payload;
    const body = {
      id: op.id,
      name: p.name,
      lastName: p.lastName,
      documentType: p.documentType,
      docId: p.docId,
      tag: p.tag,
    };
    try {
      await this.http.request("/v1/workers", { method: "POST", body });
      return { opId: op.opId, status: "applied", id: op.id };
    } catch (e) {
      if (e instanceof ApiError && e.code === "IDEMPOTENCY_KEY_REUSED") {
        await this.http.request(`/v1/workers/${op.id}`, {
          method: "PATCH",
          body: {
            name: p.name,
            lastName: p.lastName,
            documentType: p.documentType,
            docId: p.docId,
            tag: p.tag,
            // Decision 8 lives here. A worker the web took off the books who
            // turns up with new work is put back on, and `reactivations` on
            // the phone records which weighing did it and from which device.
            status: p.deletedAt ? "inactive" : "active",
          },
        });
        return { opId: op.opId, status: "applied", id: op.id };
      }
      throw e;
    }
  }

  /**
   * A weighing, through the `/v1/pickups` facade.
   *
   * The facade translates `cropId → plot_crop` and defaults the activity to
   * the farm's seeded "Recolección". That translation is 1:1 only while a lote
   * has one crop — §8 phase 9 is the deadline, not a preference — and this is
   * the call that stops working on the day it breaks.
   *
   * A tombstoned row becomes a DELETE, which is the facade's logical delete.
   * §3.2 has no delete operation on the wire and this does not introduce one:
   * the phone still holds its row with `deletedAt` set, and the server still
   * holds its own with `deleted_at` set. Nothing is physically removed at
   * either end.
   */
  private async pushWorkRecord(op: SyncOp, deviceId: string): Promise<OpResult> {
    const p = op.payload;
    if (p.deletedAt) {
      try {
        await this.http.request(`/v1/pickups/${op.id}`, { method: "DELETE" });
      } catch (e) {
        // Deleting something the server never received is not a failure: the
        // outcome the phone wanted — the server does not have this weighing —
        // is the outcome it has.
        if (!(e instanceof ApiError && e.code === "NOT_FOUND")) throw e;
      }
      return { opId: op.opId, status: "applied", id: op.id };
    }

    try {
      await this.http.request("/v1/pickups", {
        method: "POST",
        body: {
          id: op.id,
          workerId: p.workerId,
          cropId: p.cropId,
          quantity: p.quantity,
          // A bare day, because that is what the facade takes. The instant is
          // what §3.2 asks for and what `/v1/work-records` would accept; the
          // day here is the FARM's day, already derived from the farm's zone
          // by `pickups.add`, so the server's own trigger lands on the same
          // one it would have derived itself.
          date: p.date,
          note: p.note ?? null,
          deviceId,
        },
      });
      return { opId: op.opId, status: "applied", id: op.id };
    } catch (e) {
      if (e instanceof ApiError && e.code === "IDEMPOTENCY_KEY_REUSED") {
        // The weight was corrected after this weighing had already been sent.
        // PATCH is admin-only and refuses a settled record with
        // `WORK_RECORD_SETTLED`, which §5.7a says is the server's to win.
        await this.http.request(`/v1/work-records/${op.id}`, {
          method: "PATCH",
          body: { quantity: p.quantity, note: p.note ?? null },
        });
        return { opId: op.opId, status: "applied", id: op.id };
      }
      throw e;
    }
  }

  /**
   * A movement of money. §2.3: a `pago`, an `anticipo`, a `deduccion` and an
   * `ajuste` are facts — somebody handed over cash — and the server accepts
   * them without checking the balance.
   *
   * `allowOverpayment: true` is that sentence in one field. The API's default
   * is a 409 `AMOUNT_EXCEEDS_BALANCE`, which is the right guard against a
   * typo on the web's payment screen and the wrong one here: golden case 07
   * fixes that a payment larger than the balance goes through and the excess
   * behaves as an advance. Refusing it at the border would not un-hand the
   * cash; it would only make the database lie about it.
   *
   * `devengo` and `reverso` are not sent. The first is produced by
   * `POST /v1/settlements` and the phone cannot write one (§2); the second is
   * `POST /v1/ledger/{id}/reverse`, which is a different route and, on a row
   * the server has never seen, a different conversation.
   */
  private async pushLedgerEntry(op: SyncOp): Promise<OpResult> {
    const p = op.payload as {
      workerId: string;
      kind: WireLedgerEntry["kind"];
      amountCents: number;
      date: string;
      method: string | null;
      note: string | null;
      reversesId: string | null;
    };

    const route: Record<string, string | null> = {
      pago: "/v1/payments",
      anticipo: "/v1/advances",
      deduccion: "/v1/deductions",
      ajuste: "/v1/adjustments",
      devengo: null,
      reverso: null,
    };

    if (p.kind === "reverso" && p.reversesId) {
      await this.http.request(`/v1/ledger/${p.reversesId}/reverse`, {
        method: "POST",
        body: { id: op.id, note: p.note },
      });
      return { opId: op.opId, status: "applied", id: op.id };
    }

    const path = route[p.kind];
    if (!path)
      return {
        opId: op.opId,
        status: "unsendable",
        id: op.id,
        error: {
          code: "SERVER_OWNED",
          message: `un ${p.kind} lo produce el servidor`,
        },
      };

    await this.http.request(path, {
      method: "POST",
      body: {
        id: op.id,
        workerId: p.workerId,
        // The wire takes a magnitude and applies the sign itself, exactly as
        // the phone's own writers do. Sending the stored negative would be
        // refused by the database's CHECK at the far end.
        amountCents: Math.abs(p.amountCents),
        method: p.method ?? undefined,
        note: p.note ?? undefined,
        date: p.date,
        ...(p.kind === "pago" ? { allowOverpayment: true } : {}),
      },
    });
    return { opId: op.opId, status: "applied", id: op.id };
  }

  // ---- §3.3 -----------------------------------------------------------

  /**
   * Everything the web changed, assembled from six routes.
   *
   * The order is the order §3.3 requires and for the same reason: a parent
   * before anything that references it. Workers and lotes first, then the
   * weighings that name them, then the prices, then the settlements, then the
   * ledger entries that point at those settlements. The engine applies the
   * whole list inside one transaction, so this ordering is what stops a line
   * arriving without its document.
   *
   * `more` is always false: this is not a paginated feed and every call
   * returns everything the window covers. The engine's contract is unchanged —
   * "keep pulling until `more` is false" terminates immediately here and will
   * loop properly against a real feed.
   */
  async pull(input: { cursor: string | null; limit: number }): Promise<PullResult> {
    const prev = parseCursor(input.cursor);
    const sweep = prev === null || prev.since + 1 >= FULL_SWEEP_EVERY;
    const since = sweep
      ? null
      : new Date(Date.parse(prev!.at) - WINDOW_SLACK_MS).toISOString();

    const changes: PullChange[] = [];
    const skipped: { what: string; reason: string }[] = [];
    let seq = 0;
    const next = () => ++seq;

    // 1. Workers. Always in full: the list is small, and `status=all` is the
    //    only way to learn that somebody was taken off the books — which is
    //    §5.6's whole subject and cannot be inferred from an absence.
    const workers = await this.http.request<{ items: WorkerRow[] }>("/v1/workers", {
      query: { status: "all" },
    });
    for (const w of workers.items)
      changes.push({
        seq: next(),
        entity: "worker",
        row: {
          id: w.id,
          name: w.name,
          lastName: w.lastName,
          documentType: w.documentType,
          docId: w.docId,
          tag: w.tag,
          deletedAt: w.deletedAt,
        },
      });

    // 2. Lotes. The phone's `crops` row is a plot_crop, because that is what
    //    a weighing points at; its NAME is the plot's, because that is the
    //    word the person at the scale has in their head.
    const plots = await this.http.request<{ items: PlotRow[] }>("/v1/plots", {
      query: { status: "all" },
    });
    for (const plot of plots.items)
      for (const crop of plot.crops ?? [])
        changes.push({
          seq: next(),
          entity: "plotCrop",
          row: {
            id: crop.id,
            plotId: plot.id,
            plotName: plot.name,
            cropType: crop.cropType,
            variety: crop.variety,
            areaHa: crop.areaHa ?? plot.areaHa,
            // A lote is gone for the phone if either half of it is gone.
            deletedAt: crop.deletedAt ?? plot.deletedAt,
          },
        });

    // 3. Weighings the web registered. Filtered to work paid by the unit of
    //    work by the facade itself — §2.2, the phone has no screen that can
    //    show a jornal and one that only knows kilos would show it wrong.
    const from = sweep
      ? isoDay(addDays(this.now(), -this.firstPullDays))
      : isoDay(parseDay(since!.slice(0, 10)));
    const pickups = await this.http.request<{ items: WorkRecordRow[] }>("/v1/pickups", {
      query: { status: "all", from, to: isoDay(addDays(this.now(), 1)) },
    });
    for (const r of pickups.items)
      changes.push({
        seq: next(),
        entity: "workRecord",
        row: {
          id: r.id,
          workerId: r.workerId,
          cropId: r.plotCropIds?.[0] ?? null,
          quantity: Number(r.quantity),
          occurredAt: r.startedAt ?? r.dateFrom,
          note: r.note,
          deletedAt: r.deletedAt,
        },
      });

    // 4. The weeks those weighings fall in, priced. One request per week
    //    because there is no list route; the set is the weeks the phone has
    //    just seen, so it is bounded by the window and not by the season.
    if (this.role === "weigher") {
      skipped.push({ what: "precios", reason: "el pesador no lee precios" });
    } else {
      for (const monday of weeksOf(pickups.items)) {
        try {
          const wp = await this.http.request<{ weekStart: string; priceCents: number }>(
            `/v1/prices/weeks/${monday}`,
          );
          changes.push({
            seq: next(),
            entity: "weekPrice",
            row: { weekStart: monday, priceCents: wp.priceCents },
          });
        } catch (e) {
          // A week with no price set is not an error: it falls back to the
          // farm's general rate, which is exactly what the phone already does.
          if (!(e instanceof ApiError && e.code === "NOT_FOUND")) throw e;
        }
      }
    }

    // 5 and 6. The money. A weigher's token is refused these by RLS, and that
    //    is correct — so the pull reports what it could not read instead of
    //    letting the phone believe it is up to date.
    if (this.role === "weigher") {
      skipped.push({
        what: "liquidaciones y movimientos",
        reason: "el pesador no lee dinero",
      });
      return { changes, cursor: makeCursor(this.now(), sweep ? 0 : prev!.since + 1), more: false, skipped };
    }

    // One request per worker, read once and held. Reading each ledger twice —
    // once to learn which settlements to fetch and once to emit the entries —
    // would double the number of round trips on the network this runs over,
    // for a list that fits in memory many times over.
    const entries: { workerId: string; row: LedgerRow }[] = [];
    const settlementsToFetch = new Set<string>();
    const seen = new Set<string>();
    for (const w of workers.items) {
      const ledger = await this.http.request<{ items: LedgerRow[] }>(
        `/v1/workers/${w.id}/ledger`,
        { query: { limit: 500 } },
      );
      for (const e of ledger.items) {
        // A movement can be reachable from more than one worker's history
        // only through a bug, but a duplicate here would become a duplicate
        // apply, and the ledger is the one table where that costs money.
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        entries.push({ workerId: e.workerId ?? w.id, row: e });
        if (e.settlementId) settlementsToFetch.add(e.settlementId);
      }
    }

    // Settlements BEFORE the ledger entries that reference them, so a
    // `devengo` never lands pointing at a document the phone does not hold.
    for (const id of settlementsToFetch) {
      try {
        const s = await this.http.request<SettlementRow>(`/v1/settlements/${id}`);
        changes.push({ seq: next(), entity: "settlement", row: toWireSettlement(s) });
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "NOT_FOUND")) throw e;
      }
    }

    for (const { workerId, row: e } of entries)
      changes.push({
        seq: next(),
        entity: "ledgerEntry",
        row: {
          id: e.id,
          workerId,
          kind: e.kind,
          amountCents: e.amountCents,
          date: e.date.slice(0, 10),
          settlementId: e.settlementId,
          method: e.method,
          note: e.note,
          reversesId: e.reversesId,
          createdAt: e.createdAt,
        },
      });

    // §3.3: the checksum, and only in the last page. It is compared against
    // the phone's own BALANCE_SQL and thrown away — never stored.
    const balances = await this.http.request<{ items: BalanceRow[] }>("/v1/balances");

    return {
      changes,
      cursor: makeCursor(this.now(), sweep ? 0 : prev!.since + 1),
      more: false,
      balances: balances.items.map((b) => ({
        workerId: b.workerId,
        balanceCents: b.balanceCents,
      })),
      skipped,
    };
  }

  // ---- §8 fase 3 and 4: the season that is already on the phone --------

  /**
   * `POST /v1/import/season`. One request, one transaction, one answer.
   *
   * This is the whole of the import from the phone's side, and it is short
   * because the contract put the hard parts on the server: the reconciliation
   * runs inside the transaction, and a 4xx never commits. What arrives here is
   * either a report saying what was written and what was already there, or an
   * `ApiError` — 409 `IMPORT_MISMATCH` carrying `details.balances`, which
   * `SeasonImporter` turns into named cards.
   *
   * `HttpClient`'s 25-second deadline is the one thing worth knowing about:
   * a season is a few megabytes in a single body, and on a farm's uplink that
   * request can outlive it. A timeout here is not a lost import — it is an
   * answer nobody read — and the retry is free precisely because every row is
   * keyed by the uuid the phone already gave it.
   */
  async importSeason(input: SeasonImportInput): Promise<SeasonImportReport> {
    return this.http.request<SeasonImportReport>("/v1/import/season", {
      method: "POST",
      body: input,
    });
  }
}

// ---- Plumbing ----------------------------------------------------------

function toWireSettlement(s: SettlementRow): WireSettlement {
  return {
    id: s.id,
    workerId: s.workerId,
    periodStart: s.periodStart.slice(0, 10),
    periodEnd: s.periodEnd.slice(0, 10),
    grossCents: s.grossCents,
    status: s.status,
    note: s.note,
    createdAt: s.createdAt,
    voidedAt: s.voidedAt,
    items: (s.items ?? []).map((i) => ({
      // The line's own id is not exposed by this route; the payable is what
      // identifies it for the phone anyway, because that is the column the
      // anti double-pay lock lives on at both ends.
      id: `${s.id}:${i.payableId}`,
      payableId: i.payableId,
      weekStart: i.weekStart.slice(0, 10),
      quantity: Number(i.quantity),
      priceCents: i.rateCents,
      amountCents: i.amountCents,
      voidedAt: i.voided ? s.voidedAt ?? s.createdAt : null,
    })),
  };
}

/** The distinct Mondays a batch of weighings falls in. */
function weeksOf(rows: WorkRecordRow[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const day = (r.startedAt ?? r.dateFrom ?? "").slice(0, 10);
    if (day) out.add(mondayOf(day));
  }
  return [...out].sort();
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function parseCursor(raw: string | null): RestCursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as RestCursor;
    return typeof c?.at === "string" ? { at: c.at, since: Number(c.since) || 0 } : null;
  } catch {
    return null;
  }
}

const makeCursor = (at: Date, since: number) =>
  JSON.stringify({ at: at.toISOString(), since } satisfies RestCursor);
