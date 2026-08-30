/**
 * The season this phone is already holding, packed for the server.
 *
 * `docs/sincronizacion.md` §8 fase 3 and fase 4. The farm has been running on
 * this handset for months; the server has never seen a row of it. Until it
 * has, the liquidación cannot move there, and §8's whole safety argument —
 * "until fase 7 the phone keeps its SQLite complete and correct, and nothing
 * that is done to it modifies it destructively" — rests on this file
 * being a **read**.
 *
 * Three properties, and they are the brief:
 *
 * 1. **Idempotente.** Every row travels under the uuid the v6 migration
 *    already minted for it (`migrateToV6.ts`), so the server keys on an id the
 *    phone chose before the network existed. An import that dies halfway and
 *    is started again offers the same ids, and §4.1's `(farm_id, id)` makes
 *    the second offer a no-op. Nothing here invents an identity at send time.
 *
 * 2. **With a balance check.** The value carries the phone's OWN derived
 *    balance per worker, which `POST /v1/import/season` requires and compares
 *    against its own derivation inside the transaction: one centavo of
 *    disagreement is a 409 and nothing is written. Half a payroll imported is
 *    worse than none. Kilos per week and the count of live settlement lines
 *    are derived here too — the contract has the server work those out for
 *    itself, so they never go on the wire, but they are what the local check
 *    below compares against.
 *
 * 3. **Without touching the original.** There is not one INSERT, UPDATE or DELETE in
 *    this file. It cannot fire an outbox trigger, it cannot move a business
 *    date, it cannot renumber a row. If the import fails at any point the
 *    phone is bit for bit what it was before somebody pressed the button.
 *
 * What is deliberately NOT here: the network, the retry loop, and the record
 * of what happened. Those are `seasonImport.ts`. This file builds a value and
 * checks it, and both of those are pure enough to test without a server.
 */

import type { LedgerKind, PayMethod } from "../../../../packages/shared/src/enums.ts";
import type { SettlementStatus } from "../../../../packages/shared/src/enums.ts";
import type { SqlDatabase } from "../data/sqliteRepository.ts";

// ---- What travels -------------------------------------------------------

/** `people` → `employees`. The uuid is the one the phone has always had. */
export interface ExportWorker {
  id: string;
  name: string;
  lastName: string | null;
  documentType: string | null;
  docId: string | null;
  tag: string | null;
  createdAt: string | null;
  deletedAt: string | null;
}

/**
 * `crops` → a `plot` plus the `plot_crop` that hangs off it.
 *
 * §8 fase 3: «crops -> plots (a new uuid) + plot_crops (INHERITS the crop's
 * uuid)». `plotCropId` is the phone's own crop uuid, because that is what
 * every weighing points at and what `settlement_items.payable_id` has to keep
 * resolving against.
 *
 * There is no `plotId`, and that is the decision: the parcela is a row that
 * has never existed on this phone, so the phone has no honest id for it. The
 * server mints it, keyed by `plotCropId` — which makes a retry find the plot
 * it made last time instead of making a second one. Minting a uuid here would
 * have been a new random value on every attempt, which is exactly the way an
 * idempotent import grows a duplicate parcela per retry.
 */
export interface ExportPlot {
  plotCropId: string;
  /** The name the person at the scale has in their head: the lote's. */
  name: string;
  cropType: string | null;
  variety: string | null;
  areaHa: number | null;
  createdAt: string | null;
  deletedAt: string | null;
}

/** `cost_overrides` → `week_prices`. Integer cents, never the REAL column. */
export interface ExportWeekPrice {
  id: string;
  weekStart: string;
  priceCents: number;
}

/**
 * `pickups` → `work_records`, seeded activity "Recolección",
 * `rate_source = 'weekly_price'`, `unit = kg`, `started_at = pickups.date`,
 * `quantity = weight` (§8 fase 3). Those four are the server's business and
 * are not repeated in every row; what the phone owes is the fact.
 *
 * A tombstoned weighing travels WITH its tombstone. Leaving it out would make
 * the server's count disagree with the phone's for a reason nobody could
 * reconstruct, and the row would come back down on the first pull.
 */
export interface ExportWorkRecord {
  id: string;
  workerId: string;
  /** The `plot_crop`, which is the phone's `crops.uuid`. Null if unassigned. */
  plotCropId: string | null;
  quantity: number;
  /** The instant. `started_at` on the server. */
  occurredAt: string;
  /** The FARM's day and week, as v7 materialised them. */
  localDay: string | null;
  weekStart: string | null;
  deletedAt: string | null;
}

export interface ExportSettlementItem {
  id: string;
  /** The weighing's uuid — the same value at both ends. §1.4. */
  payableId: string;
  weekStart: string;
  quantity: number;
  priceCents: number;
  amountCents: number;
  voidedAt: string | null;
}

/** A settlement travels whole, with its lines. Never a header alone. */
export interface ExportSettlement {
  id: string;
  workerId: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  status: SettlementStatus;
  note: string | null;
  createdAt: string;
  voidedAt: string | null;
  items: ExportSettlementItem[];
}

/** `ledger` → `ledger`, in `id` order, pointers resolved by uuid (§8). */
export interface ExportLedgerEntry {
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
  localDay: string | null;
}

// ---- The three reconciliation queries, from this side --------------------

export interface ExportBalance {
  workerId: string;
  /** Straight `SUM(amountCents)` over this worker's ledger. Nothing derived. */
  balanceCents: number;
}

/**
 * §8 fase 3's three queries, as the phone answers them.
 *
 * Only `balances` travels: `SeasonImportInput` asks for that and derives the
 * other two itself (`store/import.go`, `reconcileImport`). The other two are
 * still computed, because `verifySeasonExport` compares them against the rows
 * that are about to be sent, and that comparison catches a class of bug the
 * server structurally cannot — see the note on that function.
 */
export interface SeasonReconciliation {
  /** Query 1. Every worker the phone has a uuid for, balance included when 0. */
  balances: ExportBalance[];
  /**
   * Query 2. Kilos per week, over LIVE weighings only, rounded to three
   * decimals so two float summations in different orders still compare equal.
   */
  weeks: { weekStart: string; quantity: number }[];
  /** Query 3. The lock: how many settlement lines are alive. */
  liveSettlementItems: number;
}

/** What the screen shows before anybody presses anything. */
export interface SeasonTotals {
  workers: number;
  plots: number;
  weekPrices: number;
  workRecords: number;
  /** Of the above, how many are tombstoned. They travel; they do not count. */
  deletedWorkRecords: number;
  settlements: number;
  settlementItems: number;
  ledgerEntries: number;
  /** Live kilos. */
  kg: number;
  earnedCents: number;
  paidCents: number;
  /** The farm's whole position: `SUM(amountCents)` over the ledger. */
  balanceCents: number;
  firstDay: string | null;
  lastDay: string | null;
}

export interface SeasonExport {
  /** Stable across retries, and local: the wire has no import id. */
  importId: string;
  farmId: string | null;
  deviceId: string;
  schemaVersion: number;
  timezone: string;
  generatedAt: string;
  workers: ExportWorker[];
  plots: ExportPlot[];
  weekPrices: ExportWeekPrice[];
  workRecords: ExportWorkRecord[];
  settlements: ExportSettlement[];
  ledger: ExportLedgerEntry[];
  reconciliation: SeasonReconciliation;
  totals: SeasonTotals;
}

/**
 * Why an export refused to be built or to be sent.
 *
 * It is an error and not a warning on purpose: every condition below means the
 * payload would have described a season that is not the one on the phone, and
 * a server that accepted it would end up holding a nómina nobody can
 * reconcile against the handset it came from.
 */
export class SeasonExportError extends Error {
  code: string;
  problems: string[];

  constructor(code: string, problems: string[]) {
    super(`${code}: ${problems.join("; ")}`);
    this.name = "SeasonExportError";
    this.code = code;
    this.problems = problems;
  }
}

// ---- Building it --------------------------------------------------------

export interface SeasonExportInput {
  importId: string;
  farmId: string | null;
  deviceId: string;
  schemaVersion: number;
  timezone: string;
  generatedAt: string;
}

/** Three decimals, applied identically on both sides of every kg comparison. */
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Read the whole season out of the phone.
 *
 * Ordered as §8 fase 3 orders it — parents first — so a server that applies
 * the arrays in the order they arrive never has to hold a row whose parent has
 * not been written. Every list is sorted by uuid, which for a v7 is
 * chronological order, so two builds of the same database produce the same
 * bytes — which is what makes a retry after a lost answer offer the server the
 * very same rows under the very same ids.
 */
export function buildSeasonExport(
  db: SqlDatabase,
  input: SeasonExportInput,
): SeasonExport {
  requireNamedRows(db);
  requirePositiveWeekPrices(db);

  const workers = db.getAllSync<ExportWorker>(
    `SELECT uuid AS id, name, lastName, documentType, docId, tag, createdAt, deletedAt
       FROM people WHERE uuid IS NOT NULL ORDER BY uuid`,
    [],
  );

  const plots = db.getAllSync<ExportPlot>(
    `SELECT uuid AS plotCropId, name, type AS cropType, variety,
            dimension AS areaHa, createdAt, deletedAt
       FROM crops WHERE uuid IS NOT NULL ORDER BY uuid`,
    [],
  );

  // COALESCE because a database that reached v7 has the cents column filled by
  // `backfillPriceCents`, and one that somehow did not must still export a
  // price rather than a null the server would read as "free".
  //
  // And rows that name NO price are left out entirely rather than exported as
  // a null. `backfillPriceCents` no longer turns those into a zero -- an
  // override with nothing in it is not an override of nothing -- so the null
  // reaches here now, and a null the server reads as "free" is the very claim
  // this whole rule exists to stop. A week with no price is a week the farm
  // has not overridden; sending nothing says exactly that.
  const weekPrices = db.getAllSync<ExportWeekPrice>(
    `SELECT uuid AS id, week AS weekStart,
            COALESCE(costPerUnitCents, CAST(ROUND(costPerUnit * 100) AS INTEGER)) AS priceCents
       FROM cost_overrides
      WHERE uuid IS NOT NULL
        AND (costPerUnitCents IS NOT NULL OR costPerUnit IS NOT NULL)
      ORDER BY weekStart`,
    [],
  );

  const workRecords = db.getAllSync<ExportWorkRecord>(
    `SELECT pk.uuid AS id, pe.uuid AS workerId, cr.uuid AS plotCropId,
            pk.weight AS quantity, COALESCE(pk.date, pk.createdAt) AS occurredAt,
            pk.localDay AS localDay, pk.week AS weekStart, pk.deletedAt AS deletedAt
       FROM pickups pk
       LEFT JOIN people pe ON pe.id = pk.personId
       LEFT JOIN crops  cr ON cr.id = pk.cropId
      WHERE pk.uuid IS NOT NULL
      ORDER BY pk.uuid`,
    [],
  );

  const settlements = readSettlements(db);

  // §8: «ledger, in id order, with settlement_id and reverses_id resolved by
  // uuid». By `id` rather than by uuid because a reversal has to arrive after
  // the movement it cancels, and `id` is the order the rows were written —
  // which is the order that actually happened, even when a correction carries
  // a back-dated `date`.
  const ledger = db.getAllSync<ExportLedgerEntry>(
    `SELECT l.uuid AS id, pe.uuid AS workerId, l.kind AS kind,
            l.amountCents AS amountCents, l.date AS date,
            s.uuid AS settlementId, l.method AS method, l.note AS note,
            rev.uuid AS reversesId, l.createdAt AS createdAt, l.localDay AS localDay
       FROM ledger l
       LEFT JOIN people pe ON pe.id = l.personId
       LEFT JOIN settlements s ON s.id = l.settlementId
       LEFT JOIN ledger rev ON rev.id = l.reversesId
      WHERE l.uuid IS NOT NULL
      ORDER BY l.id`,
    [],
  );

  const reconciliation = readReconciliation(db);
  const totals = readTotals(db, {
    workers: workers.length,
    plots: plots.length,
    weekPrices: weekPrices.length,
    workRecords: workRecords.length,
    settlements: settlements.length,
    settlementItems: settlements.reduce((n, s) => n + s.items.length, 0),
    ledgerEntries: ledger.length,
  });

  return {
    importId: input.importId,
    farmId: input.farmId,
    deviceId: input.deviceId,
    schemaVersion: input.schemaVersion,
    timezone: input.timezone,
    generatedAt: input.generatedAt,
    workers,
    plots,
    weekPrices,
    workRecords,
    settlements,
    ledger,
    reconciliation,
    totals,
  };
}

/**
 * §1.3's `missing = 0`, enforced at the border.
 *
 * A row without a uuid is a row the server can never be told about, and an
 * import that skipped it quietly would hand the farm a server whose totals are
 * short by exactly the rows nobody looked at. Fase 1's exit criterion says
 * this is zero; if it is not, the phone refuses to start rather than export a
 * season with a hole in it.
 */
function requireNamedRows(db: SqlDatabase): void {
  const problems: string[] = [];
  for (const table of [
    "people",
    "crops",
    "cost_overrides",
    "pickups",
    "settlements",
    "settlement_items",
    "ledger",
  ]) {
    const n =
      db.getFirstSync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE uuid IS NULL`,
        [],
      )?.n ?? 0;
    if (n > 0) problems.push(`${table}: ${n} filas sin uuid`);
  }
  if (problems.length) throw new SeasonExportError("MISSING_UUIDS", problems);
}

/**
 * A week price of zero cannot cross to the server, and must not cross quietly.
 *
 * The server refuses one outright — measured, `POST /v1/import/season` answers
 * 400 «a week price must be positive: 2026-08-24» — and the import is
 * all-or-nothing, so one such week takes the whole farm's season down. The
 * message names a week and not a cause, which is the worst place to find out.
 *
 * Dropping the row instead would be worse than failing: with no override for
 * that week the server falls back to the farm's general price, so the money
 * silently CHANGES, and the balances reconciliation — a single cent aborts
 * everything — would refuse it anyway, further from the cause.
 *
 * The app cannot create such a row: `addOverride` refuses a zero, and v8
 * repairs the ones v7's backfill invented. What is left is old or corrupted
 * data, and it needs a person, not a default.
 */
function requirePositiveWeekPrices(db: SqlDatabase): void {
  const rows = db.getAllSync<{ week: string }>(
    `SELECT week FROM cost_overrides
      WHERE uuid IS NOT NULL
        AND COALESCE(costPerUnitCents, CAST(ROUND(costPerUnit * 100) AS INTEGER)) <= 0
      ORDER BY week`,
    [],
  );
  if (rows.length)
    throw new SeasonExportError(
      "NON_POSITIVE_WEEK_PRICE",
      rows.map((r) => `semana ${r.week}: el precio es cero o negativo`),
    );
}

/**
 * The documents, with their lines.
 *
 * A line whose weighing has no uuid is not dropped and not sent with a null:
 * it aborts the export. `settlement_items.payable_id` is the column the anti
 * double-pay lock lives on at both ends, and a line that reaches the server
 * without one is a payment the server cannot attach to any work — which is
 * both a hole in the lock and money that has been paid twice waiting to
 * happen.
 */
function readSettlements(db: SqlDatabase): ExportSettlement[] {
  const heads = db.getAllSync<Omit<ExportSettlement, "items"> & { localId: number }>(
    `SELECT s.id AS localId, s.uuid AS id, pe.uuid AS workerId,
            s.periodStart, s.periodEnd, s.grossCents, s.status, s.note,
            s.createdAt, s.voidedAt
       FROM settlements s
       LEFT JOIN people pe ON pe.id = s.personId
      WHERE s.uuid IS NOT NULL
      ORDER BY s.uuid`,
    [],
  );

  const lines = db.getAllSync<ExportSettlementItem & { settlementLocalId: number }>(
    `SELECT si.settlementId AS settlementLocalId, si.uuid AS id,
            pk.uuid AS payableId, si.week AS weekStart, si.weight AS quantity,
            si.costPerUnitCents AS priceCents, si.amountCents AS amountCents,
            si.voidedAt AS voidedAt
       FROM settlement_items si
       LEFT JOIN pickups pk ON pk.id = si.pickupId
      WHERE si.uuid IS NOT NULL
      ORDER BY si.uuid`,
    [],
  );

  const orphans = lines.filter((l) => !l.payableId);
  if (orphans.length)
    throw new SeasonExportError("ORPHAN_SETTLEMENT_ITEM", [
      `${orphans.length} líneas de liquidación apuntan a una pesada que ya no existe`,
    ]);

  const byHead = new Map<number, ExportSettlementItem[]>();
  for (const l of lines) {
    const bucket = byHead.get(l.settlementLocalId);
    const item: ExportSettlementItem = {
      id: l.id,
      payableId: l.payableId,
      weekStart: l.weekStart,
      quantity: l.quantity,
      priceCents: l.priceCents,
      amountCents: l.amountCents,
      voidedAt: l.voidedAt,
    };
    if (bucket) bucket.push(item);
    else byHead.set(l.settlementLocalId, [item]);
  }

  return heads.map(({ localId, ...head }) => ({
    ...head,
    items: byHead.get(localId) ?? [],
  }));
}

function readReconciliation(db: SqlDatabase): SeasonReconciliation {
  const balances = db.getAllSync<ExportBalance>(
    `SELECT pe.uuid AS workerId, COALESCE(SUM(l.amountCents), 0) AS balanceCents
       FROM people pe LEFT JOIN ledger l ON l.personId = pe.id
      WHERE pe.uuid IS NOT NULL
      GROUP BY pe.id
      ORDER BY pe.uuid`,
    [],
  );

  const weeks = db
    .getAllSync<{ weekStart: string | null; quantity: number }>(
      `SELECT week AS weekStart, SUM(weight) AS quantity
         FROM pickups
        WHERE deletedAt IS NULL AND uuid IS NOT NULL
        GROUP BY week ORDER BY week`,
      [],
    )
    .map((w) => ({ weekStart: w.weekStart ?? "", quantity: round3(w.quantity) }));

  const liveSettlementItems =
    db.getFirstSync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM settlement_items WHERE voidedAt IS NULL",
      [],
    )?.n ?? 0;

  return { balances, weeks, liveSettlementItems };
}

function readTotals(
  db: SqlDatabase,
  counts: {
    workers: number;
    plots: number;
    weekPrices: number;
    workRecords: number;
    settlements: number;
    settlementItems: number;
    ledgerEntries: number;
  },
): SeasonTotals {
  const kg =
    db.getFirstSync<{ kg: number | null }>(
      "SELECT SUM(weight) AS kg FROM pickups WHERE deletedAt IS NULL",
      [],
    )?.kg ?? 0;

  const deleted =
    db.getFirstSync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pickups WHERE deletedAt IS NOT NULL",
      [],
    )?.n ?? 0;

  // The same CASE arithmetic `BALANCE_SQL` uses, one worker at a time, applied
  // to the whole farm. Reversals are told apart by sign, exactly as they are
  // on the worker's own screen, so the figure on this screen and the figure on
  // theirs cannot drift.
  const money = db.getFirstSync<{
    earnedCents: number;
    paidCents: number;
    balanceCents: number;
  }>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'devengo' THEN amountCents
                              WHEN kind = 'reverso' AND amountCents < 0 THEN amountCents END),0)
              AS earnedCents,
            COALESCE(-SUM(CASE WHEN kind IN ('pago','anticipo') THEN amountCents
                               WHEN kind = 'reverso' AND amountCents > 0 THEN amountCents END),0)
              AS paidCents,
            COALESCE(SUM(amountCents),0) AS balanceCents
       FROM ledger`,
    [],
  ) ?? { earnedCents: 0, paidCents: 0, balanceCents: 0 };

  const span = db.getFirstSync<{ firstDay: string | null; lastDay: string | null }>(
    `SELECT MIN(localDay) AS firstDay, MAX(localDay) AS lastDay
       FROM pickups WHERE deletedAt IS NULL`,
    [],
  );

  return {
    ...counts,
    deletedWorkRecords: deleted,
    kg: round3(kg ?? 0),
    earnedCents: money.earnedCents,
    paidCents: money.paidCents,
    balanceCents: money.balanceCents,
    firstDay: span?.firstDay ?? null,
    lastDay: span?.lastDay ?? null,
  };
}

// ---- Checking it before it leaves ---------------------------------------

/**
 * The same three questions the server will ask, asked here first.
 *
 * This is not belt and braces on top of the server's check — it catches a
 * different failure. The server compares what it derived from the rows it
 * RECEIVED against the balances the phone SENT; that catches a lost or
 * duplicated row in flight. This compares the balances against the rows the
 * phone is ABOUT TO SEND, which catches a bug in the queries above: a join
 * that dropped a ledger entry, a settlement whose lines went missing, a
 * pointer that resolved to null. Without it, an exporter with a hole in it
 * would produce a payload that is internally consistent with its own wrong
 * totals and sail through the server's comparison.
 *
 * Returns the problems, so the caller can put them on a screen. An empty array
 * is the only thing that may be sent.
 */
export function verifySeasonExport(x: SeasonExport): string[] {
  const problems: string[] = [];

  const workerIds = new Set(x.workers.map((w) => w.id));
  const plotCropIds = new Set(x.plots.map((p) => p.plotCropId));
  const recordIds = new Set(x.workRecords.map((r) => r.id));
  const settlementIds = new Set(x.settlements.map((s) => s.id));
  const ledgerIds = new Set(x.ledger.map((e) => e.id));

  // 1. Nothing points at a parent that is not in this payload. A row that
  //    lands with a dangling pointer is a row the server has to either refuse
  //    or store broken, and both of those are worse than not starting.
  for (const r of x.workRecords) {
    if (!workerIds.has(r.workerId))
      problems.push(`pesada ${r.id}: su recolector no viaja en este envío`);
    if (r.plotCropId && !plotCropIds.has(r.plotCropId))
      problems.push(`pesada ${r.id}: su lote no viaja en este envío`);
  }
  for (const s of x.settlements) {
    if (!workerIds.has(s.workerId))
      problems.push(`liquidación ${s.id}: su recolector no viaja en este envío`);
    for (const i of s.items)
      if (!recordIds.has(i.payableId))
        problems.push(`línea ${i.id}: su pesada no viaja en este envío`);
  }
  for (const e of x.ledger) {
    if (!workerIds.has(e.workerId))
      problems.push(`movimiento ${e.id}: su recolector no viaja en este envío`);
    if (e.settlementId && !settlementIds.has(e.settlementId))
      problems.push(`movimiento ${e.id}: su liquidación no viaja en este envío`);
    if (e.reversesId && !ledgerIds.has(e.reversesId))
      problems.push(`movimiento ${e.id}: el movimiento que anula no viaja`);
  }

  // 2. No id is offered twice. The server would dedupe by uuid and the count
  //    would come back short, which is a very confusing way to find out.
  duplicates(x.workers.map((w) => w.id)).forEach((id) =>
    problems.push(`recolector ${id} va dos veces`),
  );
  duplicates(x.workRecords.map((r) => r.id)).forEach((id) =>
    problems.push(`pesada ${id} va dos veces`),
  );
  duplicates(x.ledger.map((e) => e.id)).forEach((id) =>
    problems.push(`movimiento ${id} va dos veces`),
  );
  duplicates(x.settlements.flatMap((s) => s.items.map((i) => i.id))).forEach((id) =>
    problems.push(`línea de liquidación ${id} va dos veces`),
  );

  // 3. §8 query 1, on the payload itself: the balances offered are exactly
  //    what the ledger being offered adds up to. If these two disagree, the
  //    server's own check would compare its (correct) derivation against a
  //    figure this phone never actually held.
  const derived = new Map<string, number>();
  for (const id of workerIds) derived.set(id, 0);
  for (const e of x.ledger)
    derived.set(e.workerId, (derived.get(e.workerId) ?? 0) + e.amountCents);

  const declared = new Map(x.reconciliation.balances.map((b) => [b.workerId, b.balanceCents]));
  for (const [id, cents] of derived) {
    if (!declared.has(id)) {
      problems.push(`saldo de ${id}: no viaja en la verificación`);
      continue;
    }
    if (declared.get(id) !== cents)
      problems.push(
        `saldo de ${id}: la verificación dice ${declared.get(id)} y los movimientos suman ${cents}`,
      );
  }
  for (const id of declared.keys())
    if (!derived.has(id)) problems.push(`saldo de ${id}: ese recolector no viaja`);

  // 4. §8 query 2, on the payload itself. Live weighings only, on both sides.
  const kgByWeek = new Map<string, number>();
  for (const r of x.workRecords) {
    if (r.deletedAt) continue;
    const week = r.weekStart ?? "";
    kgByWeek.set(week, (kgByWeek.get(week) ?? 0) + r.quantity);
  }
  const declaredWeeks = new Map(
    x.reconciliation.weeks.map((w) => [w.weekStart, w.quantity]),
  );
  for (const [week, kg] of kgByWeek) {
    const said = declaredWeeks.get(week);
    if (said === undefined) {
      problems.push(`semana ${week || "sin semana"}: no viaja en la verificación`);
      continue;
    }
    if (round3(kg) !== round3(said))
      problems.push(
        `semana ${week || "sin semana"}: la verificación dice ${said} kg y las pesadas suman ${round3(kg)}`,
      );
  }
  for (const week of declaredWeeks.keys())
    if (!kgByWeek.has(week))
      problems.push(`semana ${week || "sin semana"}: no hay pesadas que la respalden`);

  // 5. §8 query 3. The lock: as many live lines as the phone says, not one more.
  const live = x.settlements.reduce(
    (n, s) => n + s.items.filter((i) => i.voidedAt === null).length,
    0,
  );
  if (live !== x.reconciliation.liveSettlementItems)
    problems.push(
      `líneas vivas: la verificación dice ${x.reconciliation.liveSettlementItems} y hay ${live}`,
    );

  // 6. Every instant the contract types as a `time.Time` actually parses.
  //    `occurredAt` is required and NOT nullable on the server, so a weighing
  //    carrying a date some pre-v5 writer left in another format would be a
  //    400 naming one row out of eighteen thousand, discovered after the
  //    upload. It is a cheap question to ask here instead.
  for (const r of x.workRecords)
    if (!Number.isFinite(Date.parse(r.occurredAt)))
      problems.push(`pesada ${r.id}: su fecha (${r.occurredAt}) no es una fecha`);

  // 7. The lock again, from the other side: one live line per weighing. This
  //    is `ux_items_pickup_live` restated on the wire, and it is the single
  //    property that stops the same work being paid twice.
  const claimed = new Set<string>();
  for (const s of x.settlements)
    for (const i of s.items) {
      if (i.voidedAt !== null) continue;
      if (claimed.has(i.payableId))
        problems.push(`la pesada ${i.payableId} está reclamada por dos liquidaciones vivas`);
      claimed.add(i.payableId);
    }

  return problems;
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) twice.add(id);
    seen.add(id);
  }
  return [...twice];
}

/**
 * The name this import answers to, for as long as it takes.
 *
 * Derived rather than minted, and that is the point: the phone can be killed,
 * reinstalled or restarted between two attempts and the second attempt still
 * carries the same key, so the server recognises it as the same import instead
 * of starting a second one alongside it. A farm imports its season once, from
 * the handset that holds it.
 */
export const seasonImportId = (farmId: string, deviceId: string) =>
  `season:${farmId}:${deviceId}`;
