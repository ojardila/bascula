/**
 * What the sync engine is allowed to do to the phone's database.
 *
 * Everything here is idempotent by uuid, because that is the only property
 * that makes a pull safe to repeat — and a pull that is cut in half by a lost
 * signal is repeated, every time, for ever (§3.3).
 *
 * Two rules run through the whole file:
 *
 * 1. **A row the server sent is not a row the phone owes back.** Every apply
 *    runs with `sync_apply` held, which is the flag the outbox triggers read.
 *    Without it a pull re-queues everything it just wrote, the next push sends
 *    it all back, and the farm has a loop that burns a data plan and never
 *    empties.
 * 2. **A local change that has not been sent is never overwritten.** If the
 *    entity still has an outbox entry, the incoming row is skipped and
 *    reported. The phone's unsent correction is the thing nobody else has a
 *    copy of; the server's version can be fetched again on the next pull.
 */

import { toCents } from "../../../../packages/shared/src/money.ts";
import {
  dayInZone,
  weekInZone,
} from "../../../../packages/shared/src/time.ts";
import type { SqlDatabase } from "./sqliteRepository.ts";
import type {
  Conflict,
  ConflictInput,
  SyncState,
  SyncStatePatch,
  AppliedCounts,
} from "./repository.ts";
import type {
  PullChange,
  WireLedgerEntry,
  WirePlotCrop,
  WireSettlement,
  WireWorker,
  WireWorkRecord,
} from "../sync/protocol.ts";

export interface SyncStoreDeps {
  now: () => string;
  timezone: () => string;
  newUuid: () => string;
  deviceId: () => string;
}

export interface SyncStore {
  state(): SyncState;
  saveState(patch: SyncStatePatch): void;

  conflicts(includeResolved?: boolean): Conflict[];
  openConflictCount(): number;
  raiseConflict(c: ConflictInput): void;
  resolveConflict(id: number, resolution: string): void;

  /**
   * Apply a whole pull batch in ONE transaction, in `seq` order, and only then
   * let the caller advance its cursor. §3.3: a cut halfway leaves the cursor
   * where it was and the batch is repeated, which is a no-op.
   */
  applyPull(changes: readonly PullChange[]): AppliedCounts;

  /** Every worker's uuid and balance, for the §3.3 checksum comparison. */
  balanceChecksums(): { uuid: string; personId: number; name: string; balanceCents: number }[];

  /** Decision 7 and §2.2: keep what the server said, and what we derived then. */
  recordServerBalances(
    rows: readonly { workerId: string; balanceCents: number }[],
    at: string,
  ): void;

  /** The received figure for one worker, by local id. Null if none arrived. */
  serverBalanceOf(
    personId: number,
  ): { balanceCents: number; derivedCents: number; at: string } | null;

  wireRow(entity: string, uuid: string): Record<string, unknown> | null;
  personByUuid(
    uuid: string,
  ): { id: number; name: string; deletedAt: string | null } | null;

  /** Decision 8's record: who was put back on the books, and what did it. */
  reactivations(personId?: number): {
    id: number;
    personId: number;
    causeEntity: string;
    causeUuid: string;
    deviceId: string | null;
    at: string;
  }[];
}

export function createSyncStore(db: SqlDatabase, deps: SyncStoreDeps): SyncStore {
  const { now, timezone, deviceId } = deps;

  // ---- State ----------------------------------------------------------

  function state(): SyncState {
    const r = db.getFirstSync<SyncState>(
      "SELECT cursor, pulledAt, pushedAt, lastError, retryAt, attempts FROM sync_state WHERE id = 1",
      [],
    );
    return (
      r ?? {
        cursor: null,
        pulledAt: null,
        pushedAt: null,
        lastError: null,
        retryAt: null,
        attempts: 0,
      }
    );
  }

  function saveState(patch: SyncStatePatch): void {
    const keys = Object.keys(patch) as (keyof SyncStatePatch)[];
    if (keys.length === 0) return;
    db.runSync(
      `UPDATE sync_state SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = 1`,
      keys.map((k) => (patch[k] ?? null) as never),
    );
  }

  // ---- Conflicts ------------------------------------------------------

  const conflicts = (includeResolved = false): Conflict[] =>
    db
      .getAllSync<Conflict & { payload: string }>(
        `SELECT id, kind, entity, entityUuid, personId, payload, detectedAt,
                resolvedAt, resolution
           FROM conflicts
          ${includeResolved ? "" : "WHERE resolvedAt IS NULL"}
          ORDER BY detectedAt DESC, id DESC`,
        [],
      )
      .map((r) => ({ ...r, payload: safeParse(r.payload) }));

  const openConflictCount = () =>
    db.getFirstSync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM conflicts WHERE resolvedAt IS NULL",
      [],
    )?.n ?? 0;

  /**
   * One card per problem, not one per attempt.
   *
   * `UNIQUE(kind, entity, entityUuid)` plus `DO UPDATE` means a push that
   * retries nine times against a settled weighing raises one card and keeps
   * its ORIGINAL `detectedAt` — because "since when" is one of the three
   * things §7.3 says a card has to be able to say, and resetting it every
   * fifteen minutes would make every conflict look like it happened just now.
   *
   * A card that was resolved and whose problem comes back is REOPENED. The
   * alternative — leaving it closed — is a conflict that a person decided
   * about, that then recurred, and that nothing tells them about.
   */
  function raiseConflict(c: ConflictInput): void {
    db.runSync(
      `INSERT INTO conflicts (kind, entity, entityUuid, personId, payload, detectedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, entity, entityUuid) DO UPDATE SET
         payload = excluded.payload,
         personId = excluded.personId,
         resolvedAt = NULL,
         resolution = NULL`,
      [
        c.kind,
        c.entity,
        c.entityUuid,
        c.personId ?? null,
        JSON.stringify(c.payload ?? {}),
        now(),
      ],
    );
  }

  const resolveConflict = (id: number, resolution: string) => {
    db.runSync(
      "UPDATE conflicts SET resolvedAt = ?, resolution = ? WHERE id = ? AND resolvedAt IS NULL",
      [now(), resolution, id],
    );
  };

  // ---- Applying what came down ----------------------------------------

  /** The local integer id of a row the server named by uuid, or null. */
  const localIdOf = (table: string, uuid: string): number | null =>
    db.getFirstSync<{ id: number }>(`SELECT id FROM ${table} WHERE uuid = ?`, [uuid])
      ?.id ?? null;

  /**
   * Whether this phone still owes the server a change to this row.
   *
   * If it does, the incoming version is not applied. The unsent local change
   * is the only copy of itself in the world; the server's row can be fetched
   * again in fifteen minutes. This is the rule that makes "sync ran while the
   * pesador was still typing" cost nothing.
   */
  const isPending = (entity: string, uuid: string): boolean =>
    !!db.getFirstSync<{ seq: number }>(
      "SELECT seq FROM outbox WHERE entity = ? AND entityUuid = ?",
      [entity, uuid],
    );

  function applyWorker(w: WireWorker, counts: AppliedCounts): void {
    if (isPending("people", w.id)) {
      counts.skippedPending++;
      return;
    }
    const existing = localIdOf("people", w.id);
    if (existing === null) {
      db.runSync(
        `INSERT INTO people (name,lastName,documentType,docId,tag,image,createdAt,uuid,updatedAt,deletedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          w.name,
          w.lastName ?? "",
          w.documentType ?? "",
          w.docId ?? "",
          w.tag ?? "",
          // §9: photos do not sync in this version. An employee without a
          // photo is an employee.
          "",
          now(),
          w.id,
          now(),
          w.deletedAt,
        ],
      );
      counts.workers++;
      return;
    }
    db.runSync(
      `UPDATE people SET name = ?, lastName = ?, documentType = ?, docId = ?,
                         tag = ?, deletedAt = ?, updatedAt = ?
        WHERE id = ?`,
      [
        w.name,
        w.lastName ?? "",
        w.documentType ?? "",
        w.docId ?? "",
        w.tag ?? "",
        w.deletedAt,
        now(),
        existing,
      ],
    );
    counts.workers++;
  }

  /**
   * A lote. The phone's `crops` row IS a `plot_crop` — that is what a weighing
   * points at, and what `POST /v1/pickups` translates `cropId` into — but the
   * NAME it shows is the plot's, because "La Cuchilla" is the word the person
   * at the scale has in their head and "Caturra" is not.
   */
  function applyPlotCrop(c: WirePlotCrop, counts: AppliedCounts): void {
    if (isPending("crops", c.id)) {
      counts.skippedPending++;
      return;
    }
    const existing = localIdOf("crops", c.id);
    if (existing === null) {
      db.runSync(
        `INSERT INTO crops (name,type,variety,dimension,createdAt,uuid,updatedAt,deletedAt)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          c.plotName,
          c.cropType ?? "",
          c.variety ?? "",
          c.areaHa ?? 0,
          now(),
          c.id,
          now(),
          c.deletedAt,
        ],
      );
      counts.crops++;
      return;
    }
    db.runSync(
      `UPDATE crops SET name = ?, type = ?, variety = ?, dimension = ?,
                        deletedAt = ?, updatedAt = ? WHERE id = ?`,
      [
        c.plotName,
        c.cropType ?? "",
        c.variety ?? "",
        c.areaHa ?? 0,
        c.deletedAt,
        now(),
        existing,
      ],
    );
    counts.crops++;
  }

  /**
   * A weighing the web registered.
   *
   * Its worker or its lote may be one this phone has never seen — a jornalero
   * hired at the office, a lote opened this morning. The row is NOT dropped
   * for that: it is applied with a null pointer and reported, because a
   * weighing that exists is money somebody is owed, and losing it to a foreign
   * key would be the worst possible way to be tidy. The next full sweep pulls
   * the parent and the pointer resolves.
   */
  function applyWorkRecord(r: WireWorkRecord, counts: AppliedCounts): void {
    if (isPending("pickups", r.id)) {
      counts.skippedPending++;
      return;
    }
    const personId = localIdOf("people", r.workerId);
    const cropId = r.cropId ? localIdOf("crops", r.cropId) : null;
    if (personId === null) counts.orphans++;

    const localDay = dayInZone(r.occurredAt, timezone());
    const week = weekInZone(r.occurredAt, timezone());
    const existing = localIdOf("pickups", r.id);

    if (existing === null) {
      db.runSync(
        `INSERT INTO pickups (personId,cropId,weight,date,createdAt,uuid,updatedAt,localDay,week,deletedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [personId, cropId, r.quantity, r.occurredAt, now(), r.id, now(), localDay, week, r.deletedAt],
      );
      counts.pickups++;
      return;
    }

    // A weighing already inside a live settlement is not edited by a pull.
    // Its price is frozen, its money moved, and §5.3 is explicit that a closed
    // document is never reopened, recalculated or corrected.
    const settled = db.getFirstSync<{ id: number }>(
      "SELECT id FROM settlement_items WHERE pickupId = ? AND voidedAt IS NULL",
      [existing],
    );
    if (settled) {
      counts.frozen++;
      return;
    }

    db.runSync(
      `UPDATE pickups SET personId = ?, cropId = ?, weight = ?, date = ?,
                          localDay = ?, week = ?, deletedAt = ?, updatedAt = ?
        WHERE id = ?`,
      [personId, cropId, r.quantity, r.occurredAt, localDay, week, r.deletedAt, now(), existing],
    );
    counts.pickups++;
  }

  /**
   * The week's price, in the integer cents the server keeps it in.
   *
   * Read-only on the phone from here on (decision 6). It goes straight into
   * `costPerUnitCents`; the pesos column is derived from it for the screens
   * that still show one, never the other way round.
   */
  function applyWeekPrice(
    w: { weekStart: string; priceCents: number },
    counts: AppliedCounts,
  ): void {
    db.runSync(
      `INSERT INTO cost_overrides (week, costPerUnit, costPerUnitCents, uuid, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(week) DO UPDATE SET
         costPerUnit = excluded.costPerUnit,
         costPerUnitCents = excluded.costPerUnitCents,
         updatedAt = excluded.updatedAt`,
      [
        w.weekStart,
        w.priceCents / 100,
        w.priceCents,
        deps.newUuid(),
        now(),
      ],
    );
    counts.prices++;
  }

  /**
   * A settlement, whole, with its lines — §3.3 never sends a header alone, and
   * this never writes one alone.
   *
   * The lines carry `payableId`, which is the weighing's uuid: the same value
   * `settlement_items.payable_id` holds on the server and the same one
   * `pickupId` resolves to here. That is the correspondence table in §1.4, and
   * it is why the anti double-pay lock means the same thing at both ends.
   *
   * A line whose weighing this phone does not hold is DROPPED, not written
   * with a null: `ux_items_pickup_live` is a unique index on `pickupId`, and
   * two such lines would collide on NULL... or worse, not collide, and let the
   * same work be claimed twice. The settlement's own `grossCents` is the
   * server's figure and is stored unchanged, so the document still says what
   * the worker was paid even when the phone cannot itemise all of it.
   */
  function applySettlement(s: WireSettlement, counts: AppliedCounts): void {
    const personId = localIdOf("people", s.workerId);
    if (personId === null) {
      counts.orphans++;
      return;
    }
    const existing = localIdOf("settlements", s.id);
    let settlementId: number;

    if (existing === null) {
      settlementId = db.runSync(
        `INSERT INTO settlements (personId,periodStart,periodEnd,grossCents,status,note,createdAt,uuid,updatedAt,voidedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          personId,
          s.periodStart,
          s.periodEnd,
          s.grossCents,
          s.status,
          s.note,
          s.createdAt,
          s.id,
          now(),
          s.voidedAt,
        ],
      ).lastInsertRowId;
    } else {
      settlementId = existing;
      // §5.4: annulment always wins, and there is nothing to ask. It releases
      // the lock, and the payment that was already made against it stays
      // exactly where it is — which is what leaves the worker owing it back,
      // which is golden case 05 and is correct.
      db.runSync(
        `UPDATE settlements SET status = ?, voidedAt = ?, grossCents = ?,
                                periodStart = ?, periodEnd = ?, updatedAt = ?
          WHERE id = ?`,
        [s.status, s.voidedAt, s.grossCents, s.periodStart, s.periodEnd, now(), settlementId],
      );
    }

    for (const item of s.items) {
      const pickupId = localIdOf("pickups", item.payableId);
      if (pickupId === null) {
        counts.orphans++;
        continue;
      }
      const line = db.getFirstSync<{ id: number }>(
        "SELECT id FROM settlement_items WHERE uuid = ?",
        [item.id],
      );
      const voidedAt = item.voidedAt ?? s.voidedAt;
      if (line) {
        db.runSync(
          "UPDATE settlement_items SET voidedAt = ?, amountCents = ?, costPerUnitCents = ?, updatedAt = ? WHERE id = ?",
          [voidedAt, item.amountCents, item.priceCents, now(), line.id],
        );
        continue;
      }
      db.runSync(
        `INSERT INTO settlement_items (settlementId,pickupId,week,weight,costPerUnitCents,amountCents,uuid,updatedAt,voidedAt)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          settlementId,
          pickupId,
          item.weekStart,
          item.quantity,
          item.priceCents,
          item.amountCents,
          item.id,
          now(),
          voidedAt,
        ],
      );
    }
    counts.settlements++;
  }

  /**
   * A movement of money. Append-only in both directions: a row that is already
   * here is left exactly as it is, because a ledger entry does not change —
   * a mistake is cancelled by its opposite, never edited (§9).
   */
  function applyLedgerEntry(e: WireLedgerEntry, counts: AppliedCounts): void {
    if (localIdOf("ledger", e.id) !== null) return;
    const personId = localIdOf("people", e.workerId);
    if (personId === null) {
      counts.orphans++;
      return;
    }
    const settlementId = e.settlementId ? localIdOf("settlements", e.settlementId) : null;
    const reversesId = e.reversesId ? localIdOf("ledger", e.reversesId) : null;

    db.runSync(
      `INSERT INTO ledger (personId,kind,amountCents,date,settlementId,method,note,reversesId,createdAt,uuid,updatedAt,localDay)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        personId,
        e.kind,
        e.amountCents,
        e.date,
        settlementId,
        e.method,
        e.note,
        reversesId,
        e.createdAt,
        e.id,
        now(),
        e.date.slice(0, 10),
      ],
    );
    counts.ledger++;
  }

  function applyPull(changes: readonly PullChange[]): AppliedCounts {
    const counts: AppliedCounts = {
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

    db.withTransactionSync(() => {
      // The flag the outbox triggers read. Held for the whole batch, released
      // by the same transaction that took it — including on a rollback, which
      // is what stops a crash mid-apply from leaving the phone permanently
      // unable to queue a weighing.
      db.runSync("INSERT OR IGNORE INTO sync_apply (id) VALUES (1)", []);
      try {
        for (const change of [...changes].sort((a, b) => a.seq - b.seq)) {
          switch (change.entity) {
            case "worker":
              applyWorker(change.row, counts);
              break;
            case "plotCrop":
              applyPlotCrop(change.row, counts);
              break;
            case "workRecord":
              applyWorkRecord(change.row, counts);
              break;
            case "weekPrice":
              applyWeekPrice(change.row, counts);
              break;
            case "settlement":
              applySettlement(change.row, counts);
              break;
            case "ledgerEntry":
              applyLedgerEntry(change.row, counts);
              break;
          }
        }
      } finally {
        db.runSync("DELETE FROM sync_apply", []);
      }
    });

    return counts;
  }

  /**
   * A row as the wire needs it. One query per travelling table, and the joins
   * are the whole point: `personId` becomes `workerId`, `cropId` becomes the
   * plot_crop's uuid, `reversesId` becomes the uuid of the movement being
   * cancelled. Nothing above this line ever sees a local integer.
   */
  function wireRow(entity: string, uuid: string): Record<string, unknown> | null {
    switch (entity) {
      case "people":
        return db.getFirstSync<Record<string, unknown>>(
          `SELECT name, lastName, documentType, docId, tag, deletedAt
             FROM people WHERE uuid = ?`,
          [uuid],
        );

      // Two dates, and both are needed. `date` is the FARM's day, which is
      // what the `/v1/pickups` facade takes; `occurredAt` is the instant,
      // which is what `/v1/sync/push` requires and refuses a bare day for —
      // the server's own trigger derives the day from the farm's timezone, and
      // that agreement is what makes golden case 04 come out the same at both
      // ends. Each transport picks the one its route speaks.
      case "pickups":
        return db.getFirstSync<Record<string, unknown>>(
          `SELECT pe.uuid AS workerId, cr.uuid AS cropId, pk.weight AS quantity,
                  pk.localDay AS date, pk.date AS occurredAt,
                  pk.deletedAt AS deletedAt
             FROM pickups pk
             LEFT JOIN people pe ON pe.id = pk.personId
             LEFT JOIN crops  cr ON cr.id = pk.cropId
            WHERE pk.uuid = ?`,
          [uuid],
        );

      case "ledger":
        return db.getFirstSync<Record<string, unknown>>(
          `SELECT pe.uuid AS workerId, l.kind AS kind, l.amountCents AS amountCents,
                  l.date AS date, l.method AS method, l.note AS note,
                  rev.uuid AS reversesId, s.uuid AS settlementId
             FROM ledger l
             LEFT JOIN people pe ON pe.id = l.personId
             LEFT JOIN ledger rev ON rev.id = l.reversesId
             LEFT JOIN settlements s ON s.id = l.settlementId
            WHERE l.uuid = ?`,
          [uuid],
        );

      // Everything else is ↓ only under §2. Nothing to project, because
      // nothing goes up.
      default:
        return null;
    }
  }

  const personByUuid = (uuid: string) =>
    db.getFirstSync<{ id: number; name: string; deletedAt: string | null }>(
      `SELECT id, TRIM(COALESCE(name, '') || ' ' || COALESCE(lastName, '')) AS name,
              deletedAt
         FROM people WHERE uuid = ?`,
      [uuid],
    );

  const balanceChecksums = () =>
    db.getAllSync<{
      uuid: string;
      personId: number;
      name: string;
      balanceCents: number;
    }>(
      `SELECT pe.uuid AS uuid, pe.id AS personId,
              COALESCE(pe.name || ' ' || pe.lastName, '?') AS name,
              COALESCE(SUM(l.amountCents), 0) AS balanceCents
         FROM people pe LEFT JOIN ledger l ON l.personId = pe.id
        WHERE pe.uuid IS NOT NULL
        GROUP BY pe.id`,
      [],
    );

  /**
   * Decision 7 and §2.2.
   *
   * `derivedCents` is written from the SAME pass as the server's figure, not
   * read back later, because the gap between the two is the whole meaning of
   * the row: it is the jornales and the contracts the pull filters out, and it
   * is only that if both halves describe the same instant.
   *
   * A worker the server named and this phone does not hold is still recorded,
   * keyed by uuid: their row may arrive on the next page, and a balance
   * thrown away for arriving first is a balance nobody ever sees.
   */
  function recordServerBalances(
    rows: readonly { workerId: string; balanceCents: number }[],
    at: string,
  ): void {
    if (!rows.length) return;
    const derived = new Map(balanceChecksums().map((r) => [r.uuid, r.balanceCents]));
    db.withTransactionSync(() => {
      for (const r of rows) {
        db.runSync(
          `INSERT INTO server_balances (workerUuid, balanceCents, derivedCents, at)
           VALUES (?,?,?,?)
           ON CONFLICT(workerUuid) DO UPDATE SET
             balanceCents = excluded.balanceCents,
             derivedCents = excluded.derivedCents,
             at = excluded.at`,
          [r.workerId, r.balanceCents, derived.get(r.workerId) ?? 0, at],
        );
      }
    });
  }

  const serverBalanceOf = (personId: number) =>
    db.getFirstSync<{ balanceCents: number; derivedCents: number; at: string }>(
      `SELECT sb.balanceCents, sb.derivedCents, sb.at
         FROM server_balances sb
         JOIN people pe ON pe.uuid = sb.workerUuid
        WHERE pe.id = ?`,
      [personId],
    );

  const reactivations = (personId?: number) =>
    db.getAllSync<{
      id: number;
      personId: number;
      causeEntity: string;
      causeUuid: string;
      deviceId: string | null;
      at: string;
    }>(
      `SELECT id, personId, causeEntity, causeUuid, deviceId, at
         FROM reactivations
        ${personId === undefined ? "" : "WHERE personId = ?"}
        ORDER BY at DESC, id DESC`,
      personId === undefined ? [] : [personId],
    );

  return {
    state,
    saveState,
    conflicts,
    openConflictCount,
    raiseConflict,
    resolveConflict,
    applyPull,
    balanceChecksums,
    recordServerBalances,
    serverBalanceOf,
    wireRow,
    personByUuid,
    reactivations,
  };
}

/**
 * Decision 8, and the condition the owner attached to it.
 *
 * The owner overruled the team here. The team's recommendation was to leave a
 * removed worker removed and raise a card, because a person decided that
 * removal; the owner's answer is that somebody who is working is somebody who
 * is on the farm. The condition attached to accepting that is this function:
 * the reactivation is a ROW, naming the weighing that caused it and the device
 * that recorded it, so whoever signed the removal can see it was undone and by
 * what. Undoing a person's decision in silence is the one thing that cannot
 * happen.
 *
 * Exported separately because the repository's own writers call it too: a
 * weighing registered on THIS phone for somebody the web took off the books
 * reactivates them just the same, and that is the common case in a lote.
 */
export function reactivateWorker(
  db: SqlDatabase,
  opts: {
    personId: number;
    causeEntity: string;
    causeUuid: string;
    deviceId: string | null;
    at: string;
  },
): boolean {
  const person = db.getFirstSync<{ deletedAt: string | null; uuid: string | null }>(
    "SELECT deletedAt, uuid FROM people WHERE id = ?",
    [opts.personId],
  );
  if (!person || person.deletedAt === null) return false;

  db.runSync("UPDATE people SET deletedAt = NULL, updatedAt = ? WHERE id = ?", [
    opts.at,
    opts.personId,
  ]);
  db.runSync(
    `INSERT INTO reactivations (personId, personUuid, causeEntity, causeUuid, deviceId, deletedAt, at)
     VALUES (?,?,?,?,?,?,?)`,
    [
      opts.personId,
      person.uuid,
      opts.causeEntity,
      opts.causeUuid,
      opts.deviceId,
      // What the removal said, kept so the card can name the date somebody
      // took them off the books rather than only the date they came back.
      person.deletedAt,
      opts.at,
    ],
  );
  return true;
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
