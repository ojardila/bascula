/**
 * Handing the season over: `POST /v1/import/season`, §8 fase 3 and fase 4.
 *
 * `seasonExport.ts` reads the season out of the phone and checks it. This file
 * is the wire — the shape `services/api/openapi.yaml` fixes, the projection
 * from the phone's value onto it, and the small orchestrator the screen drives.
 *
 * ## The contract, and what the phone gets from it
 *
 * One request. The whole season, in dependency order, in one transaction, with
 * `balances` as a REQUIRED field that the server compares against its own
 * derivation before committing. One centavo of disagreement is a 409
 * `IMPORT_MISMATCH` naming every worker, and a 4xx never commits — so a
 * refused import leaves the server exactly as it was, and the phone, which was
 * never touched, is still the whole truth.
 *
 * Three properties follow, and they are the brief:
 *
 *  1. **Idempotente.** Every insert on the far side is
 *     `ON CONFLICT (id) DO NOTHING`, and every id is the uuid this phone
 *     minted in the v6 migration. The report splits `written` from `skipped`,
 *     so "did the retry do anything" has a number and not an opinion. An
 *     import that dies after the server committed but before the answer
 *     arrives is retried, and the retry writes nothing.
 *  2. **With a balance check.** `balances` is not optional here either:
 *     `toImportInput` always fills it, and the local check refuses to send a
 *     payload whose balances disagree with its own ledger.
 *  3. **Without touching the original.** The only local write in this file is the row
 *     in `import_runs`, which is not a synced table and fires no outbox
 *     trigger. Everything else is a read and an HTTP call.
 *
 * ## The one thing to know about the request
 *
 * A season is a few megabytes of JSON in a single body — the server raised its
 * cap to 64 MB for exactly this route. That is a big request over a farm's
 * uplink and it is the contract's shape, not a choice available here: the
 * import is one transaction, and there is no staging area to deliver it into.
 * What makes it survivable is that it costs nothing to repeat.
 */

import { ApiError } from "./http.ts";
import {
  SeasonExportError,
  seasonImportId,
  verifySeasonExport,
  type SeasonExport,
  type SeasonTotals,
} from "./seasonExport.ts";
import type { Repository } from "../data/repository.ts";

// ---- The wire, exactly as `openapi.yaml` fixes it ----------------------
//
// Field for field, because the handler decodes with `DisallowUnknownFields`:
// one extra property — a `localDay` the trigger computes, a `weekStart` the
// server derives — and the whole season comes back as a 400. These types are
// the contract and nothing else belongs in them.

export interface ImportWorkerInput {
  id: string;
  name: string;
  lastName: string | null;
  documentType: string | null;
  docId: string | null;
  tag: string | null;
  createdAt: string | null;
  deletedAt: string | null;
}

/** The crop, and the plot the server invents around it. §8 fase 3. */
export interface ImportPlotInput {
  cropId: string;
  name: string;
  cropType: string;
  variety: string | null;
  areaHa: number | null;
  deletedAt: string | null;
}

export interface ImportWeekPriceInput {
  weekStart: string;
  priceCents: number;
}

export interface ImportWorkRecordInput {
  id: string;
  workerId: string;
  cropId: string | null;
  quantity: number;
  occurredAt: string;
  note: string | null;
  deviceId: string | null;
  deletedAt: string | null;
}

export interface ImportSettlementItemInput {
  id: string;
  /** The weighing's own uuid. The money is not remapped. */
  payableId: string;
  weekStart: string;
  quantity: number;
  priceCents: number;
  amountCents: number;
  voidedAt: string | null;
}

export interface ImportSettlementInput {
  id: string;
  workerId: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  status: "open" | "void";
  note: string | null;
  createdAt: string | null;
  voidedAt: string | null;
  items: ImportSettlementItemInput[];
}

export interface ImportLedgerInput {
  id: string;
  workerId: string;
  kind: string;
  /** With the ledger's own sign: a `pago` is negative and stays negative. */
  amountCents: number;
  date: string;
  method: string | null;
  note: string | null;
  settlementId: string | null;
  reversesId: string | null;
  createdAt: string | null;
}

export interface ImportBalanceInput {
  workerId: string;
  balanceCents: number;
}

export interface SeasonImportInput {
  deviceId: string;
  workers: ImportWorkerInput[];
  plots: ImportPlotInput[];
  weekPrices: ImportWeekPriceInput[];
  workRecords: ImportWorkRecordInput[];
  settlements: ImportSettlementInput[];
  ledger: ImportLedgerInput[];
  /** Required. The reconciliation, and the reason this can be trusted. */
  balances: ImportBalanceInput[];
}

/** Per table: what this call wrote, and what was already there. */
export interface ImportCounts {
  written: number;
  skipped: number;
}

export interface SeasonImportReport {
  workers: ImportCounts;
  plots: ImportCounts;
  crops: ImportCounts;
  weekPrices: ImportCounts;
  workRecords: ImportCounts;
  settlements: ImportCounts;
  settlementItems: ImportCounts;
  ledger: ImportCounts;
  balancesChecked: number;
  liveItems: number;
}

/**
 * The port. One method, because the contract is one request.
 *
 * `restTransport.ts` implements it against the real route; a test implements
 * it against a server it can make misbehave. Nothing above this line knows
 * about HTTP, which is the same seam `SyncTransport` has.
 */
export interface SeasonImportTransport {
  importSeason(input: SeasonImportInput): Promise<SeasonImportReport>;
}

/**
 * How long the phone waits for `POST /v1/import/season` before giving up.
 *
 * Twenty-five minutes, and the arithmetic is the reason. A real season off the
 * handset in production is 11,7 MB of JSON in a single body — that is the
 * contract's shape, not a choice (§8 fase 3: one request, one transaction).
 * The uplink it goes over is a farm's, which on a bad afternoon settles at
 * something like 100 kbit/s, or ~13 kB/s.
 *
 * Fifteen minutes was the first answer and it was wrong by exactly nothing,
 * which is the worst way to be wrong. 11,7 MB / 13 kB/s = 900 s = 15 min 0 s.
 * The deadline and the upload were the same number, so the margin was zero and
 * a link 1 % slower than the assumption aborted the mudanza. Two things make
 * that a bad place to stand:
 *
 *   - 11,7 MB is what the season weighs TODAY, measured, mid-harvest
 *     (18,000 weighings → 48,022 rows → 11,7 MB, `seasonImport.test.ts`). It
 *     grows every day until the cut, and the cut is the point of it.
 *   - 13 kB/s is an estimate of a bad afternoon, not a floor. Nobody measured
 *     the farm's worst.
 *
 * Twenty-five minutes covers ~19,5 MB on that same link, which is the measured
 * season plus two thirds again — room for the harvest to keep going and for
 * the link to be worse than we guessed. It stays well under the half hour that
 * `SEASON_IMPORT_TIMEOUT_MS <= 30 min` pins, so it is still a deadline.
 *
 * `HttpClient`'s default of 25 s is right for a sync batch and absurd here:
 * it aborts a perfectly healthy upload after 300 kB, every time, and the
 * mudanza is a one-shot operation done with the owner standing there. Aborting
 * loses nothing — a 4xx never commits and every id is the phone's own uuid, so
 * the retry writes nothing twice — but it costs the whole climb, and on that
 * link the retry will lose the same race.
 *
 * The number is deliberately not "no deadline". A socket with no deadline on a
 * phone is a screen that says «enviando» until somebody force-quits the app,
 * and §8's whole promise is that the person watching always knows where they
 * stand. Fifteen minutes is long enough for the upload and short enough to
 * have an end the screen can name.
 */
export const SEASON_IMPORT_TIMEOUT_MS = 25 * 60 * 1000;

// ---- Phone value → contract --------------------------------------------

/**
 * An instant the server will accept, or null.
 *
 * Every timestamp on the far side is a `*time.Time` and parses RFC3339. A
 * `createdAt` that some older writer left in another format would refuse the
 * whole season for one row, and the field is nullable everywhere it appears —
 * so a date that is not a date is dropped rather than allowed to take a
 * farm's import down with it. `occurredAt` is the exception: it is required,
 * and `verifySeasonExport` refuses the export before it gets this far.
 */
const asInstant = (raw: string | null): string | null => {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Empty strings out. The phone stores "" where the server means "nothing". */
const orNull = (raw: string | null | undefined): string | null =>
  raw === null || raw === undefined || raw === "" ? null : raw;

/**
 * The projection, and the only place the two shapes meet.
 *
 * It drops what the server derives for itself — `localDay`, `weekStart` on a
 * weighing, the kilos per week, the count of live lines — because the handler
 * decodes with `DisallowUnknownFields` and because a client that sends a
 * derived value is a client asking to disagree with the derivation.
 */
export function toImportInput(x: SeasonExport): SeasonImportInput {
  return {
    deviceId: x.deviceId,
    workers: x.workers.map((w) => ({
      id: w.id,
      name: w.name,
      lastName: orNull(w.lastName),
      documentType: orNull(w.documentType),
      docId: orNull(w.docId),
      tag: orNull(w.tag),
      createdAt: asInstant(w.createdAt),
      deletedAt: asInstant(w.deletedAt),
    })),
    plots: x.plots.map((p) => ({
      // The plot_crop inherits the phone's crop uuid, because that is what the
      // weighings point at; the plot is the server's to mint.
      cropId: p.plotCropId,
      name: p.name,
      cropType: p.cropType ?? "",
      variety: orNull(p.variety),
      areaHa: p.areaHa,
      deletedAt: asInstant(p.deletedAt),
    })),
    weekPrices: x.weekPrices.map((w) => ({
      weekStart: w.weekStart,
      priceCents: w.priceCents,
    })),
    workRecords: x.workRecords.map((r) => ({
      id: r.id,
      workerId: r.workerId,
      cropId: r.plotCropId,
      quantity: r.quantity,
      occurredAt: r.occurredAt,
      note: null,
      deviceId: x.deviceId,
      deletedAt: asInstant(r.deletedAt),
    })),
    settlements: x.settlements.map((s) => ({
      id: s.id,
      workerId: s.workerId,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      grossCents: s.grossCents,
      status: s.status,
      note: orNull(s.note),
      createdAt: asInstant(s.createdAt),
      voidedAt: asInstant(s.voidedAt),
      items: s.items.map((i) => ({
        id: i.id,
        payableId: i.payableId,
        weekStart: i.weekStart,
        quantity: i.quantity,
        priceCents: i.priceCents,
        amountCents: i.amountCents,
        voidedAt: asInstant(i.voidedAt),
      })),
    })),
    ledger: x.ledger.map((e) => ({
      id: e.id,
      workerId: e.workerId,
      kind: e.kind,
      // The stored sign, not a friendly magnitude. §2.3's push sends a
      // magnitude because `/v1/payments` applies the sign itself; this route
      // writes the ledger row directly and refuses a `pago` that is positive.
      amountCents: e.amountCents,
      date: e.date.slice(0, 10),
      method: orNull(e.method),
      note: orNull(e.note),
      settlementId: e.settlementId,
      reversesId: e.reversesId,
      createdAt: asInstant(e.createdAt),
    })),
    balances: x.reconciliation.balances.map((b) => ({
      workerId: b.workerId,
      balanceCents: b.balanceCents,
    })),
  };
}

/**
 * How big the body is, in bytes.
 *
 * The screen needs it: «11,7 MB in a single upload» is what turns a wait nobody
 * can interpret into one that has a reason, and it is the figure that explains
 * why the deadline above is fifteen minutes and not twenty-five seconds.
 *
 * It serialises the payload a second time — `HttpClient` will do it again on
 * its way out — which is a few megabytes of garbage once, on an operation that
 * takes minutes. The alternative is guessing from the row counts and printing
 * a number that is not the one going over the wire.
 */
export const byteLengthOf = (input: SeasonImportInput): number =>
  utf8Length(JSON.stringify(input));

/**
 * UTF-8 bytes of a string, without `TextEncoder` or `Buffer`.
 *
 * Neither is guaranteed under Hermes, and the difference is not cosmetic on
 * this payload: a farm's names are full of `ñ` and `í`, which are one JS
 * character and two bytes, and the size on the screen has to be the size that
 * has to climb the uplink.
 */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      // A surrogate pair is four bytes and two indexes.
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** How many rows one import is, for the screen and the record. */
export const rowsOf = (input: SeasonImportInput): number =>
  input.workers.length +
  input.plots.length +
  input.weekPrices.length +
  input.workRecords.length +
  input.settlements.length +
  input.settlements.reduce((n, s) => n + s.items.length, 0) +
  input.ledger.length;

// ---- What happened, for the screen and for the record -------------------

export interface BalanceMismatch {
  workerId: string;
  /** Filled in from the phone's own people table, for the screen. */
  name?: string | null;
  phoneCents: number;
  serverCents: number;
  differenceCents?: number;
}

export type SeasonImportStatus =
  /** The server wrote it, and every balance agreed. */
  | "imported"
  /** The server already had all of it. Nothing new was written. */
  | "already-imported"
  /** 409: the server derived different figures and wrote nothing. */
  | "rejected"
  /** The phone refused to send: the payload disagreed with itself. */
  | "refused"
  /** The network or the server broke off. A 4xx never commits. */
  | "failed";

export interface SeasonImportOutcome {
  importId: string;
  status: SeasonImportStatus;
  totals: SeasonTotals;
  rows: number;
  /** How many bytes the body was. Zero when it never got as far as building one. */
  bytes: number;
  report: SeasonImportReport | null;
  /** Every worker the server disagreed about, named. Only when `rejected`. */
  mismatches: BalanceMismatch[];
  /** What the phone's own check found. Non-empty only when `refused`. */
  problems: string[];
  error: { code: string; message: string } | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/**
 * Whether the farm's payroll is now on the server.
 *
 * One function, because the screen, the record and the tests all ask it, and a
 * `status !== "imported"` scattered across three files is a place for
 * `already-imported` to be read as a failure — which would tell somebody their
 * import did not happen when it happened last Tuesday.
 */
export const seasonWasImported = (o: SeasonImportOutcome): boolean =>
  o.status === "imported" || o.status === "already-imported";

export interface SeasonImportProgress {
  phase: "building" | "checking" | "sending";
  rows: number;
  /** The body's size in bytes. Zero until the payload has been built. */
  bytes: number;
  /**
   * Epoch ms at which THIS phase began.
   *
   * The screen runs its clock off this rather than off the tap, because
   * building and checking a season of eighteen thousand weighings is itself
   * tens of seconds, and an «llevamos 12 minutos» that counted them would be
   * measuring the wrong thing against the deadline.
   */
  since: number;
}

// ---- The record ---------------------------------------------------------

export interface ImportRunInput {
  importId: string;
  startedAt: string;
  finishedAt: string;
  status: SeasonImportStatus;
  rows: number;
  totals: SeasonTotals | null;
  report: SeasonImportReport | null;
  error: string | null;
}

export interface ImportRun extends ImportRunInput {
  id: number;
}

// ---- The orchestrator ---------------------------------------------------

export interface SeasonImporterOptions {
  repo: Repository;
  transport: SeasonImportTransport;
  now?: () => Date;
}

export class SeasonImporter {
  private readonly repo: Repository;
  private readonly transport: SeasonImportTransport;
  private readonly now: () => Date;
  /** One at a time. Two taps must not become two seasons in flight. */
  private running: Promise<SeasonImportOutcome> | null = null;

  constructor(opts: SeasonImporterOptions) {
    this.repo = opts.repo;
    this.transport = opts.transport;
    this.now = opts.now ?? (() => new Date());
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /**
   * What would be sent, without sending it.
   *
   * The screen calls this before it draws anything, because §8 fase 4 happens
   * with somebody present and that person has to see the size of what they are
   * about to move: how many people, how many weighings, how much money. It is
   * a read, and costs the phone nothing but the queries.
   */
  preview(): SeasonExport {
    const identity = this.repo.sync.identity();
    if (!identity.farmId)
      throw new SeasonExportError("NOT_REGISTERED", [
        "este teléfono todavía no está conectado con una finca",
      ]);
    return this.repo.sync.seasonExport(
      seasonImportId(identity.farmId, identity.deviceId),
      this.now().toISOString(),
    );
  }

  /** The last attempt, whatever it was. Null on a phone that never tried. */
  lastRun(): ImportRun | null {
    return this.repo.sync.importRuns(1)[0] ?? null;
  }

  run(
    opts: { onProgress?: (p: SeasonImportProgress) => void } = {},
  ): Promise<SeasonImportOutcome> {
    if (this.running) return this.running;
    this.running = this.execute(opts.onProgress).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async execute(
    onProgress?: (p: SeasonImportProgress) => void,
  ): Promise<SeasonImportOutcome> {
    const started = this.now();
    const startedAt = started.toISOString();
    let importId = "";
    let totals: SeasonTotals | null = null;
    let rows = 0;
    let bytes = 0;

    const finish = (
      status: SeasonImportStatus,
      report: SeasonImportReport | null,
      mismatches: BalanceMismatch[],
      problems: string[],
      error: { code: string; message: string } | null,
    ): SeasonImportOutcome => {
      const finished = this.now();
      const outcome: SeasonImportOutcome = {
        importId,
        status,
        totals: totals ?? emptyTotals(),
        rows,
        bytes,
        report,
        mismatches,
        problems,
        error,
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
      };
      // The only local write. `import_runs` is not a synced table, so an
      // import that never reached the server cannot leave behind a row the
      // next push tries to send to the server it failed to reach.
      this.repo.sync.recordImportRun({
        importId,
        startedAt,
        finishedAt: outcome.finishedAt,
        status,
        rows,
        totals,
        report,
        error: error ? `${error.code}: ${error.message}` : problems.join("; ") || null,
      });
      return outcome;
    };

    let payload: SeasonExport;
    try {
      onProgress?.({
        phase: "building",
        rows: 0,
        bytes: 0,
        since: started.getTime(),
      });
      payload = this.preview();
      importId = payload.importId;
      totals = payload.totals;
    } catch (e) {
      // A season that cannot be read out is not a season to send. This is
      // `MISSING_UUIDS` and `ORPHAN_SETTLEMENT_ITEM`, both of them fase 1 exit
      // criteria somebody skipped, and neither is fixed by trying again.
      const err = asError(e);
      return finish(
        "refused",
        null,
        [],
        e instanceof SeasonExportError ? e.problems : [err.message],
        err,
      );
    }

    // The phone's own check, before a single byte leaves. It catches a bug in
    // the exporter, which the server's comparison structurally cannot — see
    // `verifySeasonExport`.
    onProgress?.({
      phase: "checking",
      rows: 0,
      bytes: 0,
      since: this.now().getTime(),
    });
    const problems = verifySeasonExport(payload);
    if (problems.length)
      return finish("refused", null, [], problems, {
        code: "EXPORT_INCONSISTENT",
        message: "lo que iba a subirse no cuadra con el propio teléfono",
      });

    const input = toImportInput(payload);
    rows = rowsOf(input);
    bytes = byteLengthOf(input);

    try {
      // `since` is stamped HERE, at the start of the one request that has the
      // fifteen-minute deadline, so the clock on the screen and the clock on
      // the socket are measuring the same thing.
      onProgress?.({ phase: "sending", rows, bytes, since: this.now().getTime() });
      const report = await this.transport.importSeason(input);

      // §8 fase 3 is meant to be run again and again. `written` is how the
      // contract answers "did this one do anything": a season the farm already
      // has comes back entirely skipped, and saying "imported" then would be
      // true but useless, while saying "failed" would be a lie.
      const written = totalWritten(report);
      return finish(
        written === 0 && rows > 0 ? "already-imported" : "imported",
        report,
        [],
        [],
        null,
      );
    } catch (e) {
      const err = asError(e);

      // 409 IMPORT_MISMATCH. Not a failure of the request — the server did
      // exactly what it was asked to do, which was to refuse — and the
      // mismatches are the part worth reading. Nothing was written: a 4xx
      // never commits.
      if (e instanceof ApiError && e.code === "IMPORT_MISMATCH")
        return finish("rejected", null, this.named(mismatchesOf(e)), [], err);

      return finish("failed", null, [], [], err);
    }
  }

  /**
   * Put a name on every mismatched balance.
   *
   * §7.3's rule, applied here too: a card that says `9b1e…-4f2a` disagrees is
   * not something anybody can act on, and the person reading it is standing
   * next to the worker it is about.
   */
  private named(mismatches: BalanceMismatch[]): BalanceMismatch[] {
    return mismatches.map((m) => ({
      ...m,
      name: m.name ?? this.repo.sync.personByUuid(m.workerId)?.name ?? null,
    }));
  }
}

/** `details.balances`, as `reconcileImport` builds it. */
function mismatchesOf(e: ApiError): BalanceMismatch[] {
  const raw = e.details?.balances;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      workerId: String(r.workerId ?? ""),
      phoneCents: Number(r.phoneCents ?? 0),
      serverCents: Number(r.serverCents ?? 0),
      differenceCents: r.differenceCents === undefined ? undefined : Number(r.differenceCents),
    }));
}

const totalWritten = (r: SeasonImportReport): number =>
  r.workers.written +
  r.plots.written +
  r.crops.written +
  r.weekPrices.written +
  r.workRecords.written +
  r.settlements.written +
  r.settlementItems.written +
  r.ledger.written;

function asError(e: unknown): { code: string; message: string } {
  if (e instanceof ApiError) return { code: e.code, message: e.message };
  if (e instanceof SeasonExportError) return { code: e.code, message: e.message };
  return { code: "INTERNAL", message: String((e as Error)?.message ?? e) };
}

function emptyTotals(): SeasonTotals {
  return {
    workers: 0,
    plots: 0,
    weekPrices: 0,
    workRecords: 0,
    deletedWorkRecords: 0,
    settlements: 0,
    settlementItems: 0,
    ledgerEntries: 0,
    kg: 0,
    earnedCents: 0,
    paidCents: 0,
    balanceCents: 0,
    firstDay: null,
    lastDay: null,
  };
}
