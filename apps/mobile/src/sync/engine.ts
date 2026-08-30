/**
 * The sync engine: push, then pull, then check the arithmetic.
 *
 * ## Why that order, and never the other
 *
 * Push first. A pull that lands before a push overwrites the phone's unsent
 * corrections with the server's older copy, and the correction is the one
 * thing nobody else has. (`syncStore` refuses to overwrite a pending row as a
 * second line of defence, but the order is the first.)
 *
 * Then pull, then compare balances. The comparison has to come last because it
 * only means anything when both halves are done: a mismatch while the outbox
 * still has rows in it is not a bug, it is an outbox.
 *
 * ## What this does NOT do
 *
 * It does not decide any conflict that touches money. §5 either has a written
 * rule — and then this applies it — or a person decides, and then this raises
 * a card and stops. There is no branch in this file that resolves a money
 * conflict by picking a side, and adding one would need a change to §5 first.
 */

import { EPOCH_START } from "../../../../packages/shared/src/time.ts";
import { ApiError } from "./http.ts";
import {
  MAX_OPS_PER_PUSH,
  backoffMs,
  dispositionOf,
  type Disposition,
  type Handshake,
  type OpResult,
  type PullChange,
  type SyncOp,
  type SyncTransport,
  type WireEntity,
} from "./protocol.ts";
import type { AppliedCounts, OutboxEntry, Repository } from "../data/repository.ts";

/** What one run of `sync()` did. Everything the status screen shows. */
export interface SyncReport {
  ok: boolean;
  pushed: number;
  /** Envelopes the server refused or the phone would not send. */
  conflicts: number;
  /** Envelopes left queued for the next attempt. */
  retrying: number;
  applied: AppliedCounts | null;
  /** Workers whose balance the phone and the server do not agree on. */
  mismatched: number;
  /**
   * True when the pull stopped with the server still holding changes.
   *
   * `maxPages` is a courtesy bound, not a correctness one — the cursor only
   * advances over what was applied — but a phone that stopped early is NOT
   * level with the server, and §6.1 makes being level the condition for
   * settling. Recorded so nothing downstream has to infer it from a page
   * count it cannot see.
   */
  stillBehind: boolean;
  /**
   * How many changes the server said this phone was missing, at handshake
   * time. §3.1: «lo que convierte el chip de estado de un spinner en un
   * número». Zero from a transport that cannot know.
   */
  behind: number;
  skipped: { what: string; reason: string }[];
  /**
   * The cursor had fallen off the feed and the phone read the farm from the
   * beginning. §3.4's retention is 180 days, so this is a handset that was out
   * of signal for half a year, and the next handshake's `behind` will be the
   * whole season rather than the eleven changes it was before. Carried up so
   * the screen can say that in a sentence.
   */
  bootstrapped: boolean;
  error: { code: string; message: string } | null;
  handshake: Handshake | null;
}

export interface SyncEngineOptions {
  repo: Repository;
  transport: SyncTransport;
  now?: () => Date;
  random?: () => number;
  /** How many changes a pull asks for at a time. */
  pullLimit?: number;
  /**
   * How many pull pages one run will take before stopping.
   *
   * Not a correctness bound — the cursor only advances over what was applied,
   * so a run that stops early resumes exactly where it left off. It is a
   * courtesy bound: a phone that has been out of signal for a fortnight should
   * not hold the UI while it drains a fortnight in one go.
   */
  maxPages?: number;
}

const SCHEMA_VERSION = 7;

export class SyncEngine {
  private readonly repo: Repository;
  private readonly transport: SyncTransport;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly pullLimit: number;
  private readonly maxPages: number;
  /** One run at a time. Two concurrent drains would push the same rows twice. */
  private running: Promise<SyncReport> | null = null;
  /** Why the last envelope was left queued, for the status screen. */
  private lastRetryError: string | null = null;

  constructor(opts: SyncEngineOptions) {
    this.repo = opts.repo;
    this.transport = opts.transport;
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? Math.random;
    this.pullLimit = opts.pullLimit ?? 500;
    this.maxPages = opts.maxPages ?? 20;
  }

  /**
   * Whether a run may start now.
   *
   * §4.3's backoff lives here rather than in a timer, because the phone is
   * asleep most of the time and a timer that fires in a suspended process is
   * not a schedule. Every entry point asks this question instead.
   */
  canRun(): boolean {
    const s = this.repo.sync.state();
    if (!s.retryAt) return true;
    return Date.parse(s.retryAt) <= this.now().getTime();
  }

  /** The one entry point. Re-entrant callers share the run in flight. */
  sync(opts: { force?: boolean } = {}): Promise<SyncReport> {
    if (this.running) return this.running;
    if (!opts.force && !this.canRun())
      return Promise.resolve(this.idleReport("BACKOFF", "esperando para reintentar"));
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  private idleReport(code: string, message: string): SyncReport {
    return {
      ok: false,
      pushed: 0,
      conflicts: 0,
      retrying: this.repo.sync.pendingCount(),
      applied: null,
      mismatched: 0,
      stillBehind: false,
      behind: 0,
      skipped: [],
      bootstrapped: false,
      error: { code, message },
      handshake: null,
    };
  }

  private async run(): Promise<SyncReport> {
    const report: SyncReport = {
      ok: false,
      pushed: 0,
      conflicts: 0,
      retrying: 0,
      applied: null,
      mismatched: 0,
      stillBehind: false,
      behind: 0,
      skipped: [],
      bootstrapped: false,
      error: null,
      handshake: null,
    };

    try {
      const state = this.repo.sync.state();
      const identity = this.repo.sync.identity();

      const hs = await this.transport.handshake({
        deviceId: identity.deviceId,
        schemaVersion: SCHEMA_VERSION,
        cursor: state.cursor,
      });
      report.handshake = hs;
      report.behind = hs.behind;

      // The farm's zone, adopted before anything is derived from it. A run
      // that pulled weighings and stamped them under the wrong zone would put
      // them in the wrong week, at the wrong price, in the wrong settlement —
      // which is the entire subject of §1.5b.
      this.repo.sync.adoptTimezone(hs.timezone);

      // §3.2. Push until the queue stops shrinking: an entry left for retry
      // must not spin the loop for ever, so the loop ends when a batch drops
      // nothing.
      report.pushed = await this.drainOutbox(report);

      // §3.3.
      const applied = await this.drainPull(report);
      report.applied = applied;

      // §3.3 and §7.4. The checksum, last, and only when the phone is level
      // with the server on BOTH sides — nothing left to send and nothing left
      // to receive. Otherwise a difference is expected and saying so would be
      // crying wolf: a red card per worker on a phone whose only problem is
      // that it has not finished downloading.
      if (this.repo.sync.pendingCount() === 0 && !report.stillBehind)
        report.mismatched = this.checkBalances(report);

      report.retrying = this.repo.sync.pendingCount();

      // `pulledAt` records that the PULL FINISHED — and only then.
      //
      // §6.1 reads it as one of the two conditions for settling. A run that
      // stopped at `maxPages` with `more` still true has applied everything it
      // received and moved its cursor, so nothing is lost and the next run
      // resumes exactly there; but it has NOT caught up, and stamping it as if
      // it had is what let a phone two weeks out of signal open the settle
      // button over a week whose weighings were still on the server.
      //
      // The other condition — an empty outbox — is checked separately, so
      // recording it here cannot let anybody settle against work that has not
      // been sent either.
      if (!report.stillBehind)
        this.repo.sync.saveState({ pulledAt: this.now().toISOString() });

      if (report.retrying > 0) {
        // Some envelopes came back with a code §4.3 says to retry — a
        // timeout, a 5xx, a socket that closed. The pull still succeeded, so
        // this is not a failed run; but reporting it as a clean one would
        // reset the backoff and have the phone hammering a server that is
        // having a bad afternoon, and would tell the pesador everything is
        // sent when eleven weighings are not.
        const attempts = this.repo.sync.state().attempts + 1;
        this.repo.sync.saveState({
          attempts,
          lastError: this.lastRetryError ?? "quedaron cambios sin enviar",
          retryAt: new Date(
            this.now().getTime() + backoffMs(attempts, this.random),
          ).toISOString(),
        });
        report.ok = false;
        report.error = { code: "PARTIAL", message: "quedaron cambios sin enviar" };
        return report;
      }

      this.repo.sync.saveState({ lastError: null, retryAt: null, attempts: 0 });
      report.ok = true;
      return report;
    } catch (e) {
      const err =
        e instanceof ApiError
          ? { code: e.code, message: e.message }
          : { code: "INTERNAL", message: String((e as Error)?.message ?? e) };
      report.error = err;
      report.retrying = this.repo.sync.pendingCount();

      // §4.3: everything that is not a credential problem retries, without a
      // limit, with an exponentially longer wait. The rows do not expire and
      // the phone has all the time in the world.
      const attempts = this.repo.sync.state().attempts + 1;
      this.repo.sync.saveState({
        lastError: `${err.code}: ${err.message}`,
        attempts,
        retryAt: new Date(
          this.now().getTime() + backoffMs(attempts, this.random),
        ).toISOString(),
      });
      return report;
    }
  }

  // ---- Push ------------------------------------------------------------

  private async drainOutbox(report: SyncReport): Promise<number> {
    const identity = this.repo.sync.identity();
    let pushed = 0;

    for (;;) {
      const queued = this.repo.sync.pending(MAX_OPS_PER_PUSH);
      if (queued.length === 0) break;

      const ops = queued
        .map((entry) => this.envelope(entry))
        .filter((o): o is SyncOp => o !== null);

      // Entries whose entity has no envelope — a `config` row, which never
      // travels up (§2) — are dropped here rather than sent. They would
      // otherwise sit in the queue for ever, and the status chip would show a
      // number that never goes down, which is the one thing §7.1 says that
      // number must never do.
      const unmappable = queued.filter((e) => !ops.some((o) => o.origin.seq === e.seq));
      if (unmappable.length) this.repo.sync.ack(unmappable);

      if (ops.length === 0) continue;

      const { results } = await this.transport.push({
        deviceId: identity.deviceId,
        ops,
      });

      const byOpId = new Map(ops.map((o) => [o.opId, o]));
      const done: OutboxEntry[] = [];
      let progressed = false;

      for (const result of results) {
        const op = byOpId.get(result.opId);
        if (!op) continue;
        const entry = queued.find((q) => q.seq === op.origin.seq);
        if (!entry) continue;

        const disposition = dispositionOf(result);
        if (disposition === "halt") {
          // The ack for whatever DID land still happens, below, before the
          // throw: a credential failure halfway through a batch must not
          // resend the hundred envelopes the server already accepted.
          this.repo.sync.ack(done);
          throw new ApiError(
            result.error?.code ?? "UNAUTHORIZED",
            result.error?.message ?? "sin autorización",
            401,
            result.error?.details,
          );
        }

        if (disposition === "done") {
          done.push(entry);
          pushed++;
          progressed = true;
          continue;
        }

        if (disposition === "conflict") {
          this.raise(op, entry, result);
          // Dropped from the outbox because it will never succeed by being
          // sent again, and a queue that keeps a permanent failure in it is a
          // queue whose count stops meaning "how much work is at risk".
          // The change itself is NOT lost: the row is still on the phone and
          // the card names it.
          done.push(entry);
          report.conflicts++;
          progressed = true;
          continue;
        }

        // retry: left queued, deliberately. The reason is kept so the status
        // screen can say "sin señal" rather than a spinner that never ends.
        this.lastRetryError = `${result.error?.code ?? "RETRY"}: ${
          result.error?.message ?? ""
        }`.trim();
      }

      this.repo.sync.ack(done);
      // A batch that dropped nothing is a batch that will drop nothing next
      // time either. Stop, and let the backoff decide when to come back.
      if (!progressed) break;
    }

    if (pushed > 0) this.repo.sync.saveState({ pushedAt: this.now().toISOString() });
    return pushed;
  }

  /**
   * One outbox row, read live, as an envelope.
   *
   * Live rather than from a stored payload: §schema's outbox has no payload
   * column on purpose, so what goes on the wire is the row as it is NOW, not a
   * snapshot that could be stale before it is sent. Returns null for a table
   * that does not travel upwards.
   */
  private envelope(entry: OutboxEntry): SyncOp | null {
    const origin = { seq: entry.seq, revision: entry.revision };
    // The idempotency key of §4.2. Derived from the row and its revision
    // rather than random, so the SAME envelope retried carries the SAME opId
    // — which is the whole point of the key — while a later correction to the
    // same row carries a different one.
    const opId = `${entry.entity}:${entry.entityUuid}:${entry.revision}`;

    switch (entry.entity) {
      case "people": {
        // Only the fields the phone's own screen edits. §2: a photo, a phone
        // number or an address typed on the web is not blanked by a handset
        // that has never had a box to type one in.
        const row = this.repo.sync.wireRow("people", entry.entityUuid);
        if (!row) return null;
        return { opId, entity: "worker", op: "upsert", id: entry.entityUuid, payload: row, origin };
      }

      case "pickups": {
        // `wireRow` has already turned every local integer into the name the
        // server knows: `personId` into `workerId`, `cropId` into the
        // plot_crop's uuid. `date` is the FARM's day, derived once at write
        // time — the facade takes a day, and the day it takes has to be the
        // one the server's own trigger would derive, or the weighing lands in
        // a different week at a different price.
        const row = this.repo.sync.wireRow("pickups", entry.entityUuid);
        if (!row) return null;
        return {
          opId,
          entity: "workRecord",
          op: "upsert",
          id: entry.entityUuid,
          payload: row,
          origin,
        };
      }

      case "ledger": {
        const row = this.repo.sync.wireRow("ledger", entry.entityUuid);
        if (!row) return null;
        return {
          opId,
          entity: "ledgerEntry",
          op: "append",
          id: entry.entityUuid,
          payload: row,
          origin,
        };
      }

      // §2: lotes, weekly prices and settlements are the server's to write.
      // They are still enveloped rather than silently dropped, because a farm
      // that created a lote on the phone before this rule existed has rows
      // queued and deserves to be told, not to have them vanish.
      case "crops":
        return this.readOnlyEnvelope(opId, "plotCrop", entry, origin);
      case "cost_overrides":
        return this.readOnlyEnvelope(opId, "weekPrice", entry, origin);
      case "settlements":
        return this.readOnlyEnvelope(opId, "settlement", entry, origin);
      case "settlement_items":
        return this.readOnlyEnvelope(opId, "settlement", entry, origin);

      // The farm's own config row never travels up (§2). Nothing to send and
      // nothing to tell anybody about.
      case "config":
        return null;

      default:
        return null;
    }
  }

  private readOnlyEnvelope(
    opId: string,
    entity: WireEntity,
    entry: OutboxEntry,
    origin: { seq: number; revision: number },
  ): SyncOp {
    return {
      opId,
      entity,
      op: "upsert",
      id: entry.entityUuid,
      payload: { localTable: entry.entity, localId: entry.localId },
      origin,
    };
  }

  /**
   * Turn a refused envelope into a card a person can act on.
   *
   * Every branch below is a case §5 actually names. There is no default that
   * quietly resolves something: an error this table has not met becomes a card
   * with its code on it, which is worse to look at and better than a phone
   * deciding on its own what to do about somebody's pay.
   */
  private raise(op: SyncOp, entry: OutboxEntry, result: OpResult): void {
    const code = result.error?.code ?? "UNKNOWN";
    const person = this.personOf(op);

    if (code === "WORK_RECORD_SETTLED") {
      // §5.7a and §5.7b. The server owns the lock and it is taken. The phone
      // KEEPS its change and SHOWS it — it does not discard it and does not
      // apply it. Voiding the settlement is not a button on this card: §7.3
      // allows two, and undoing a payment is the owner's decision on a screen
      // that shows what it costs.
      this.repo.sync.raiseConflict({
        kind: "pickup-already-settled",
        entity: entry.entity,
        entityUuid: entry.entityUuid,
        personId: person?.id ?? null,
        payload: {
          person: person?.name ?? null,
          date: op.payload.date ?? null,
          quantity: op.payload.quantity ?? null,
          settlementId: result.error?.details?.settlementId ?? null,
          message: result.error?.message ?? null,
        },
      });
      return;
    }

    if (code === "READ_ONLY_ON_PHONE" || code === "SERVER_OWNED") {
      // Decision 6, and what it costs, said out loud on a card rather than
      // discovered by a lote that never appears on the web.
      this.repo.sync.raiseConflict({
        kind: "read-only-on-phone",
        entity: entry.entity,
        entityUuid: entry.entityUuid,
        personId: null,
        payload: {
          table: entry.entity,
          message: result.error?.message ?? "se administra en la web",
        },
      });
      return;
    }

    if (code === "EMPLOYEE_EXISTS_DELETED") {
      // §5.6. Somebody with this document is already on the farm, deactivated.
      // The card names the person as THIS phone typed them and says where the
      // fix is, because it is not here: restoring the existing file is a
      // button on the web, and joining the two by hand from a handset would be
      // merging a ledger nobody on this screen can see.
      const details = result.error?.details ?? {};
      this.repo.sync.raiseConflict({
        kind: "worker-exists-deleted",
        entity: entry.entity,
        entityUuid: entry.entityUuid,
        personId: person?.id ?? null,
        payload: {
          person: person?.name ?? null,
          // Who the server says already holds the document, so the two names
          // can be compared before anybody decides they are one person.
          serverName:
            [details.name, details.lastName].filter(Boolean).join(" ") || null,
          serverWorkerId: details.employeeId ?? null,
          deletedAt: details.deletedAt ?? null,
        },
      });
      return;
    }

    if (code === "GROSS_CHANGED") {
      // §5.5. The figure moved between the preview somebody approved and the
      // moment it reached the server; nothing was written. `details` says what
      // moved, and the two lists are only meaningful when this client named
      // the set it saw — `payableIdsProvided` is the server's own way of
      // saying "we were not told what you were shown", which is not the same
      // as "nothing moved" and must not be shown as if it were.
      const details = result.error?.details ?? {};
      this.repo.sync.raiseConflict({
        kind: "gross-changed",
        entity: entry.entity,
        entityUuid: entry.entityUuid,
        personId: person?.id ?? null,
        payload: {
          person: person?.name ?? null,
          expectedCents: details.expectedCents ?? null,
          actualCents: details.actualCents ?? null,
          addedCount: Array.isArray(details.addedPayableIds)
            ? details.addedPayableIds.length
            : 0,
          removedCount: Array.isArray(details.removedPayableIds)
            ? details.removedPayableIds.length
            : 0,
          explained: details.payableIdsProvided === true,
        },
      });
      return;
    }

    if (code === "IDEMPOTENCY_KEY_REUSED") {
      this.repo.sync.raiseConflict({
        kind: "diverged",
        entity: entry.entity,
        entityUuid: entry.entityUuid,
        personId: person?.id ?? null,
        payload: {
          person: person?.name ?? null,
          existing: result.error?.details?.existing ?? null,
        },
      });
      return;
    }

    this.repo.sync.raiseConflict({
      kind: "rejected",
      entity: entry.entity,
      entityUuid: entry.entityUuid,
      personId: person?.id ?? null,
      payload: {
        person: person?.name ?? null,
        code,
        message: result.error?.message ?? null,
      },
    });
  }

  /** Whose card this is. §7.3: a card without a name is not a card. */
  private personOf(op: SyncOp): { id: number; name: string } | null {
    const uuid =
      op.entity === "worker" ? op.id : (op.payload.workerId as string | undefined);
    return uuid ? this.repo.sync.personByUuid(uuid) : null;
  }

  // ---- Pull ------------------------------------------------------------

  private async drainPull(report: SyncReport): Promise<AppliedCounts> {
    const total: AppliedCounts = {
      workers: 0,
      crops: 0,
      pickups: 0,
      prices: 0,
      settlements: 0,
      ledger: 0,
      orphans: 0,
      frozen: 0,
      skippedPending: 0,
      reactivated: 0,
    };

    let cursor = this.repo.sync.state().cursor;
    let balances: { workerId: string; balanceCents: number }[] | undefined;
    // Assume the worst until a page says `more: false`. A `maxPages` of zero,
    // or a loop that never runs, is a pull that did not catch up either.
    report.stillBehind = true;

    for (let page = 0; page < this.maxPages; page++) {
      const res = await this.transport.pull({ cursor, limit: this.pullLimit });
      if (res.skipped?.length) report.skipped = res.skipped;
      if (res.bootstrapped) report.bootstrapped = true;

      const counts = this.repo.sync.applyPull(res.changes);
      counts.reactivated += this.reactivateFromPull(res.changes);
      addCounts(total, counts);

      // Only now. §3.3: a cut halfway leaves the cursor where it was and the
      // batch repeats, which is a no-op because every apply is keyed by uuid.
      cursor = res.cursor;
      this.repo.sync.saveState({ cursor });

      if (res.balances) balances = res.balances;
      if (!res.more) {
        report.stillBehind = false;
        break;
      }
    }

    this.lastBalances = balances ?? null;
    return total;
  }

  private lastBalances: { workerId: string; balanceCents: number }[] | null = null;

  /**
   * Decision 8, applied to work that arrived from the web.
   *
   * A weighing pulled down for somebody this phone has marked as removed puts
   * them back on the books, with the same record attached. It runs AFTER the
   * batch rather than inside it because the batch holds `sync_apply` — and a
   * reactivation IS a change the phone owes the server, since the phone is the
   * side that decided it.
   */
  private reactivateFromPull(changes: readonly PullChange[]): number {
    let n = 0;
    for (const c of changes) {
      if (c.entity !== "workRecord" || c.row.deletedAt) continue;
      const person = this.repo.sync.personByUuid(c.row.workerId);
      if (!person || person.deletedAt === null) continue;
      if (
        this.repo.sync.reactivate({
          personId: person.id,
          causeEntity: "pickups",
          causeUuid: c.row.id,
        })
      )
        n++;
    }
    return n;
  }

  // ---- The checksum ----------------------------------------------------

  /**
   * §3.3 and §7.4.
   *
   * The server's balance is a CHECKSUM. It is compared against what the phone
   * derives with its own `BALANCE_SQL` and then discarded. When they differ,
   * the number is NOT copied — that would be the materialised total this
   * design has refused three times, and it would hide the bug rather than
   * report it. A card goes up with both figures on it.
   *
   * One exception, and it is decision 7's: a worker the phone has never seen
   * do anything, whose server balance is not zero, is a worker with jornales
   * or contracts the phone cannot itemise (§2.2). That is not a mismatch, it
   * is the phone knowing less; the owner decided the phone shows the FULL
   * balance anyway rather than a number that counts half the work. Those are
   * recorded as `serverOnly` so the worker's card can show the server's figure
   * with the note that the phone cannot break it down.
   */
  private checkBalances(report: SyncReport): number {
    const server = this.lastBalances;
    if (!server) return 0;
    const local = new Map(
      this.repo.sync.balanceChecksums().map((r) => [r.uuid, r]),
    );
    let mismatched = 0;

    // Decision 7, and the half of it that was missing.
    //
    // The figures were compared and then thrown away, which satisfied §7.4
    // (never copy a total to paper over a mismatch) and quietly failed §2.2:
    // the phone went on showing a `BALANCE_SQL` that counts only weighings,
    // so a worker who also did jornales had half a balance on the screen and
    // nothing said so. Keeping the figure is what lets the worker's card show
    // the whole of it; NOTHING downstream derives an amount from it, and the
    // pay screens still read `payments.balance`.
    //
    // Recorded here rather than in `drainPull` because this is the only place
    // that runs when the phone is level on both sides — an empty outbox and a
    // pull that finished. A figure stored while either was still moving would
    // describe a moment that never existed.
    this.repo.sync.recordServerBalances(server, this.now().toISOString());

    for (const s of server) {
      const mine = local.get(s.workerId);
      if (!mine) continue;
      if (mine.balanceCents === s.balanceCents) continue;

      // The mixed case, closed — and closed by measuring instead of guessing.
      //
      // It used to read `mine.balanceCents === 0`: a phone with no movements
      // at all was "knowing less", anything else was "the two implementations
      // disagree". That put the worker who did BOTH weighings and jornales in
      // the second bucket and reported somebody's ordinary payroll as a
      // calculation bug, because two totals cannot tell those apart.
      //
      // They can now, and the evidence was already on the phone rather than
      // needing a new field on the wire. The feed sends a settlement WHOLE —
      // header and every line — while filtering the work records behind the
      // lines that are not paid by the unit of work (§2.2). So a document
      // whose `grossCents` exceeds the lines this phone could store is a
      // document with jornal money in it, and the excess is exactly how much.
      //
      // The test is EXACT and not "some of it": when the gap is, to the cent,
      // the money this phone holds a document for and no lines for, the phone
      // is behind on detail and not wrong on arithmetic. A peso either way and
      // it stays a mismatch, because the part that is not accounted for is the
      // part that matters, and a rule that swallowed it would be the burying
      // half of the choice §2.2 refused to make.
      //
      // It is reachable and it is not rare: a settlement and the `devengo` it
      // posts are two rows of the feed, and §3.4's horizon can let the first
      // through while holding the second for the next poll. In that window the
      // phone is short by exactly the document it cannot break down.
      const gap = s.balanceCents - mine.balanceCents;
      const partial = mine.unitemisableCents > 0 && gap === mine.unitemisableCents;

      mismatched++;
      this.repo.sync.raiseConflict({
        kind: partial ? "balance-not-itemisable" : "balance-mismatch",
        entity: "people",
        entityUuid: s.workerId,
        personId: mine.personId,
        payload: {
          person: mine.name,
          localCents: mine.balanceCents,
          serverCents: s.balanceCents,
          // What of the difference this phone can account for, so the card
          // says «de los cuales X son jornales» rather than only a total.
          unitemisableCents: mine.unitemisableCents,
          at: this.now().toISOString(),
        },
      });
    }
    void report;
    return mismatched;
  }
}

function addCounts(into: AppliedCounts, from: AppliedCounts): void {
  for (const k of Object.keys(into) as (keyof AppliedCounts)[]) into[k] += from[k];
}

/** Kept so a settle range and a sync run cannot drift apart on their epoch. */
export { EPOCH_START };

/** Re-exported so callers do not have to import from two files. */
export type { Disposition };
