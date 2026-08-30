/**
 * What the screens need from the data layer, stated once and without SQLite.
 *
 * Every screen used to import `People`, `Crops`, `Pickups`, `Payments`… out of
 * `db.ts`, which meant every screen imported `expo-sqlite` transitively and
 * the only possible source of a number was the phone's own file. This file is
 * the seam: it names the operations, and `sqliteRepository.ts` is one
 * implementation of them. A sync-backed implementation can be dropped in
 * behind the same interface without opening a single screen.
 *
 * Types live here rather than next to the implementation for the same reason:
 * a `Person` is a person whether it came from SQLite or from the API.
 */

import type {
  LedgerKind,
  PayMethod,
  SettlementStatus,
} from "../../../../packages/shared/src/enums.ts";
import type { PullChange } from "../sync/protocol.ts";
import type { SeasonExport } from "../sync/seasonExport.ts";
import type { ImportRun, ImportRunInput } from "../sync/seasonImport.ts";

export type { LedgerKind, PayMethod, SettlementStatus };

// ---- Entities -----------------------------------------------------------

/**
 * What every row that will one day travel carries, on top of what it always
 * had. The integer `id` stays the local primary key — it is in every join and
 * every screen — and `uuid` is the name the server knows the row by.
 *
 * Both are optional in the type only because rows written before
 * `user_version = 6` existed without them for a season, and the compiler
 * should keep reminding the next reader of that rather than let a `!` hide it.
 */
export interface Synced {
  /** UUIDv7, minted on the device. Its first 48 bits are when the row happened. */
  uuid?: string;
  /** ISO instant of the last change to this row's content. */
  updatedAt?: string;
}

export interface Person extends Synced {
  id: number;
  name: string;
  lastName: string;
  documentType: string;
  docId: string;
  tag: string;
  image: string;
  createdAt: string;
  deletedAt?: string | null;
}

export interface Crop extends Synced {
  id: number;
  name: string;
  type: string;
  variety: string;
  dimension: number;
  createdAt: string;
  deletedAt?: string | null;
}

export interface Pickup extends Synced {
  id: number;
  personId: number;
  cropId: number;
  weight: number;
  date: string;
  createdAt: string;
  /**
   * Logical delete. A weighing removed for real would come back on the next
   * pull, because the server still has it and nothing here would say it was
   * cancelled (§1.5a). Every read goes through the `pickups_live` view, so a
   * tombstoned row is invisible to every screen and every total.
   */
  deletedAt?: string | null;
  /** The farm's calendar day of `date`, decided once at write time. */
  localDay?: string;
  /** The Monday of `localDay`. What decides the price and the settlement. */
  week?: string;
}

export interface CropConfig {
  cropType: string;
  label: string;
  unit: string; // "kg", "racimo", ...
  yieldUnit: string; // "kg por recolector"
  costPerUnit: number; // general cost per unit
}

export type AppLang = "es" | "en" | "pt";

export interface CostOverride extends Synced {
  id: number;
  /** Monday of the week, YYYY-MM-DD — the same key `byWeek()` labels rows with. */
  week: string;
  /** Pesos, for display. Derived from the cents below, never the source. */
  costPerUnit: number;
  /** Integer cents. What the server stores and what decides an amount. */
  costPerUnitCents?: number;
}

export interface LedgerEntry extends Synced {
  id: number;
  personId: number;
  kind: LedgerKind;
  amountCents: number;
  date: string;
  settlementId: number | null;
  method: PayMethod | null;
  note: string | null;
  reversesId: number | null;
  createdAt: string;
}

export interface Settlement extends Synced {
  id: number;
  personId: number;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  status: SettlementStatus;
  note: string | null;
  createdAt: string;
  voidedAt: string | null;
}

export interface SettlementItem extends Synced {
  id: number;
  settlementId: number;
  pickupId: number;
  week: string;
  weight: number;
  costPerUnitCents: number;
  amountCents: number;
  voidedAt?: string | null;
}

export interface Balance {
  personId: number;
  earnedCents: number;
  paidCents: number;
  deductedCents: number;
  balanceCents: number;
  lastMovementAt: string | null;
}

export type PendingItem = Omit<SettlementItem, "id" | "settlementId">;

export interface SettlementPreview {
  personId: number;
  periodStart: string;
  periodEnd: string;
  items: PendingItem[];
  grossCents: number;
  pickupCount: number;
  kg: number;
}

export interface WorkerPerf {
  personId: number;
  name: string;
  kg: number;
  days: number;
  kgPerDay: number;
  /** 1.00 = exactly the crew average on the same plot and day. */
  irl: number | null;
  comparableDays: number;
  /** Ratio of recent IRL to earlier IRL; below 0.85 means they are slipping. */
  trend: number | null;
}

export interface Anomaly {
  pickupId: number;
  personId: number;
  person: string;
  crop: string;
  date: string;
  weight: number;
  rule: "impossible" | "duplicate" | "digit" | "outlier" | "future";
  reference: number;
}

// ---- Read models --------------------------------------------------------

export interface WriteResult {
  lastInsertRowId: number;
  changes: number;
}

export interface RecentPickup {
  id: number;
  weight: number;
  date: string;
  person: string;
  crop: string;
}

export interface FarmTotals {
  pickups: number;
  kg: number;
  people: number;
  crops: number;
}

export interface PeriodTotals {
  kg: number;
  count: number;
}

export interface LabelledKg {
  label: string;
  kg: number;
}

export interface ValuedGroup extends LabelledKg {
  id: number;
  value: number;
  /**
   * 1 while this worker or lote is still on the farm's active list.
   *
   * The server's `ListBalances` settled the same argument and this is its
   * word: the rule is "people with a position, not people who are active", and
   * `active` is what lets the caller render the difference instead of guessing
   * at an absence. A removed picker's kilos stay in the ranking — they were
   * harvested, and taking them out stops the list adding up to the farm total
   * shown beside it — and the row says so.
   */
  active: number;
}

export interface WorkerStats {
  kg: number;
  pickups: number;
  days: number;
  firstDate: string;
  lastDate: string;
}

export interface WorkerPickup {
  id: number;
  weight: number;
  date: string;
  crop: string;
}

export interface WeekCropRow {
  week: string;
  crop: string;
  kg: number;
  /** 1 while the lote is still on the farm's active list. See `ValuedGroup`. */
  active: number;
}

export interface BalanceRow extends Balance {
  name: string;
  /** 1 when the worker is soft-deleted. Money is never hidden, only marked. */
  inactive: number;
}

/**
 * A worker's balance as decision 7 says to SHOW it: the whole of it, even when
 * this phone can only break down part.
 *
 * §2.2 is the rule and it is short: the web registers jornales and contracts,
 * the pull does not bring them down, and so `BALANCE_SQL` here sums only the
 * weighings. «Un saldo que cuenta la mitad del trabajo es un saldo que miente,
 * y quien lo lee no tiene forma de saberlo.» So the screen shows the figure
 * that came down the feed, marked with when it arrived, and falls back to the
 * derived one — labelled «provisional» — while this phone still owes the
 * server movements it has not sent.
 *
 * Nothing that decides an amount reads this. `settle`, `pay` and `runPayroll`
 * all still go through `payments.balance`, which is `BALANCE_SQL` over the
 * ledger. This is what a person is shown; that is what a person is handed.
 * Whether those two should be the same number is a question for the owner and
 * not for this file: paying out the full figure would mean handing over cash
 * for work whose breakdown the phone cannot print on the receipt.
 */
export interface FullBalance {
  /** What this phone can derive AND break down, from its own ledger. */
  itemisedCents: number;
  /** The whole of it, as the server last said. Null on a phone that never heard. */
  serverCents: number | null;
  /** When that figure arrived. Null with it. */
  serverAt: string | null;
  /** The one to put on the screen, chosen by the rule in §2.2. */
  balanceCents: number;
  /**
   * True while this phone still owes the server movements. §7.4: the figure
   * shown is then the phone's own and it has to say so — «provisional, faltan
   * 4 movimientos por enviar».
   */
  provisional: boolean;
  /**
   * Cents inside `serverCents` that this phone cannot itemise — the jornales
   * and the contracts. Zero when the phone has heard nothing, which is not the
   * same as knowing there is nothing.
   */
  notItemisableCents: number;
}

export interface PendingWorker {
  personId: number;
  name: string;
  kg: number;
  amountCents: number;
}

export interface SettleResult {
  settlementId: number;
  ledgerId: number;
  grossCents: number;
}

/**
 * What one run of the crew's payroll did, and everything needed to take it
 * back.
 *
 * `settlementIds` carries EVERY document the run created, including the ones
 * for workers who ended up with nothing to collect because an advance had
 * already eaten the week. That is the whole point of the field: the screen
 * used to record a settlement only after the payment succeeded, so a settled
 * worker with a zero balance produced a real, committed document that
 * «Deshacer» could not reach — and the only way back was the ledger by hand
 * (`docs/diagramas/movil.md` §9.13).
 */
export interface PayrollRun {
  /** Workers who were settled and handed cash. */
  paid: number;
  /** Settled, but the balance was zero or negative. Nothing to hand over. */
  noCash: number;
  /** Workers whose settle or pay threw. The rest of the crew went on. */
  failed: number;
  /** Every settlement created, in order. Undoable whether or not it was paid. */
  settlementIds: number[];
  /** Every payment created, in order. */
  paymentIds: number[];
  /** Cents actually handed over across the whole run. */
  paidCents: number;
}

export interface PlotPerf {
  cropId: number;
  name: string;
  ha: number;
  kg: number;
  kgPerHa: number | null;
  pickers: number;
}

export interface PriceResponseRow {
  week: string;
  kgPerDay: number;
  pickers: number;
  kg: number;
  price: number;
}

export interface RealCost {
  kg: number;
  listed: number;
  real: number;
  budget: number;
}

export interface CropStats {
  kg: number;
  pickups: number;
  pickers: number;
  days: number;
  firstDate: string;
  lastDate: string;
}

export interface CropWeek {
  week: string;
  kg: number;
  pickers: number;
}

export interface CropWorker {
  personId: number;
  name: string;
  kg: number;
  days: number;
  irl: number | null;
  comparableDays: number;
}

export interface CropPickup {
  id: number;
  weight: number;
  date: string;
  person: string;
}

export interface WeekDay {
  day: string;
  kg: number;
  pickers: number;
  plots: number;
}

export interface WeekWorker {
  personId: number;
  name: string;
  kg: number;
  days: number;
}

export interface WeekGridCell {
  personId: number;
  name: string;
  cropId: number;
  crop: string;
  kg: number;
}

export interface WeekDayCell {
  personId: number;
  name: string;
  day: string;
  kg: number;
}

export interface WeekPlot {
  cropId: number;
  crop: string;
  kg: number;
}

export type Grouping = "week" | "worker" | "crop";

/** How far back the review screen looks, and how many findings it will show. */
export interface AnomalyWindow {
  sinceDays: number;
  limit: number;
}


// ---- Sync: identity now, protocol later ---------------------------------

/** A table whose rows travel. The outbox names them with these strings. */
export type SyncEntity =
  | "config"
  | "people"
  | "crops"
  | "cost_overrides"
  | "pickups"
  | "settlements"
  | "settlement_items"
  | "ledger";

/** One thing this phone still owes the server. */
export interface OutboxEntry {
  /** This device's own counter. Ascending is the order the server should apply. */
  seq: number;
  entity: SyncEntity;
  entityUuid: string;
  /**
   * `delete` is not a tidy-up. A hard-deleted pickup leaves no row to compare
   * timestamps against, so this queue entry is the only thing that will ever
   * tell the server the weighing was cancelled.
   */
  op: "upsert" | "delete";
  /** Where to read the current content. Null for a delete: there is nothing left. */
  localId: number | null;
  /** How many times this entity changed while it sat in the queue. */
  revision: number;
  queuedAt: string;
}

/** The farm's and the device's identity, as far as the server is concerned. */
export interface SyncIdentity {
  /**
   * Null until the farm is registered on the server.
   *
   * It lives on the single `config` row and nowhere else. One phone is one
   * farm — `config` is `CHECK (id = 1)` and there is one wipe button — so a
   * copy on all eighteen thousand pickups would carry no information the
   * config row does not. It would also have to be written into every one of
   * those rows the moment the owner signs up, which is a second full-table
   * migration triggered by a button press on a phone in a field. And the
   * server must not trust a farm id a device sends anyway: `sync-and-roles.md`
   * puts tenant isolation in Postgres row-level security, derived from the
   * authenticated token, precisely so that a wrong or forged value on the wire
   * cannot cross farms.
   */
  farmId: string | null;
  /**
   * This installation. Minted once, never changes, survives a wipe.
   * `sync-and-roles.md` orders concurrent events by a per-device counter, and
   * a counter needs a device to belong to; `outbox.seq` is that counter.
   */
  deviceId: string;
  /** When a push last succeeded. Null forever until there is a protocol. */
  syncedAt: string | null;
}

/** Where the phone is with the server. One row, `sync_state`. */
export interface SyncState {
  /**
   * Opaque. The phone stores what the server hands back and hands it in again;
   * it never parses it. That is what lets today's timestamp-window transport
   * and tomorrow's `sync_log` sequence share one column.
   */
  cursor: string | null;
  /** When a pull last COMPLETED — everything applied, nothing more to come. */
  pulledAt: string | null;
  pushedAt: string | null;
  lastError: string | null;
  /** When §4.3's backoff allows the next attempt. */
  retryAt: string | null;
  attempts: number;
}

export type SyncStatePatch = Partial<SyncState>;

/**
 * A conflict of §5 waiting for a person.
 *
 * `payload` carries what the card shows, composed when the conflict was
 * detected. §7.3 demands every card names a person, a date, and an amount or a
 * quantity; by the time somebody reads it the rows behind it may have moved,
 * so the card holds its own copy of the three.
 */
export interface Conflict {
  id: number;
  kind: string;
  entity: string;
  entityUuid: string;
  personId: number | null;
  payload: Record<string, unknown>;
  detectedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

export type ConflictInput = Omit<
  Conflict,
  "id" | "detectedAt" | "resolvedAt" | "resolution"
>;

/** What one applied pull batch actually did. Shown on the status screen. */
export interface AppliedCounts {
  workers: number;
  crops: number;
  pickups: number;
  prices: number;
  settlements: number;
  ledger: number;
  /** Rows whose parent this phone does not hold yet. Kept, not dropped. */
  orphans: number;
  /** Weighings inside a live settlement, which a pull never edits (§5.3). */
  frozen: number;
  /** Rows skipped because this phone still owes the server a change to them. */
  skippedPending: number;
  reactivated: number;
}

/**
 * What the phone knows about syncing.
 *
 * The identity half — farm id, device id, the outbox — predates the protocol
 * and is unchanged. What is new is everything the engine needs to be
 * restartable: where the cursor is, when the last pull finished, what is
 * waiting for a person, and the writers that apply what came down without
 * queueing it straight back up.
 */
export interface SyncRepo {
  identity(): SyncIdentity;
  /** Record the farm the server assigned. Idempotent; refuses to change it. */
  claimFarm(farmId: string): void;
  /** Oldest change first. This is the push order. */
  pending(limit?: number): OutboxEntry[];
  pendingCount(): number;
  /**
   * Forget the queued changes the server has confirmed.
   *
   * Takes the entries that were sent, not their seqs, because `revision` is
   * the guard: if the row changed again while the push was in flight the
   * revision moved and the entry stays queued. Acking by seq alone would drop
   * a correction the server never received. Returns how many were dropped.
   */
  ack(sent: readonly Pick<OutboxEntry, "seq" | "revision">[]): number;

  // ---- The protocol's own state ---------------------------------------

  state(): SyncState;
  saveState(patch: SyncStatePatch): void;

  /**
   * Record the farm's timezone, and restamp the weighings if it is not the one
   * they were written under.
   *
   * Called once, right after registration. It is the only place a business
   * date is ever rewritten, and it is safe exactly there: the phone has not
   * yet sent or settled anything under the wrong zone. Returns how many rows
   * moved, which is zero on a farm whose zone was right all along.
   */
  adoptTimezone(timezone: string): number;

  // ---- What came down --------------------------------------------------

  /** Apply a pull batch in one transaction, in `seq` order. */
  applyPull(changes: readonly PullChange[]): AppliedCounts;

  /**
   * The phone's own balance per worker, for the §3.3 checksum.
   *
   * Compared against what the server sent and then THROWN AWAY. A total that
   * arrives on the wire and is stored is the materialised balance this design
   * has refused three times; if the two disagree that is a bug between two
   * implementations of the same money, and it raises a card.
   *
   * `unitemisableCents` is what tells that bug apart from §2.2. It is the
   * money in this worker's live settlements that the phone holds no LINE for:
   * the document's own `grossCents` minus the lines it managed to store. A
   * settlement written here always has the two equal; one that came down the
   * feed for a week the worker also spent on a jornal does not, because the
   * header travels whole and the work records behind the jornal lines are
   * filtered out. Measured, from documents the server issued — not inferred
   * from whether the phone's balance happened to be zero.
   */
  balanceChecksums(): {
    uuid: string;
    personId: number;
    name: string;
    balanceCents: number;
    unitemisableCents: number;
  }[];

  /**
   * Keep what the server said each worker's balance was, and what this phone
   * derived at the same instant.
   *
   * Called only when the phone is level with the server on both sides — an
   * empty outbox and a pull that finished — because a figure recorded while
   * either was still moving would be a figure about a moment that never
   * existed. See `SERVER_BALANCES_SCHEMA` for why storing it at all does not
   * make it a materialised balance.
   */
  recordServerBalances(
    rows: readonly { workerId: string; balanceCents: number }[],
    at: string,
  ): void;

  // ---- Conflicts, §5 and §7.3 -----------------------------------------

  conflicts(includeResolved?: boolean): Conflict[];
  openConflictCount(): number;
  raiseConflict(c: ConflictInput): void;
  resolveConflict(id: number, resolution: string): void;

  /**
   * Decision 8: put a worker back on the books, and record what did it.
   *
   * Returns false when they were already active, so a caller can tell a real
   * reactivation from a no-op without reading the row first.
   */
  reactivate(opts: {
    personId: number;
    causeEntity: string;
    causeUuid: string;
  }): boolean;

  /**
   * The uuid-shaped projection of one row: every local integer pointer
   * translated into the name the server knows it by.
   *
   * It exists because the wire format is not the storage format —
   * `pickups.personId` is an integer here and a uuid there — and that
   * translation belongs to the data layer, not to whatever is holding the
   * socket. Returns null for a row that is gone or for a table that does not
   * travel upwards.
   */
  wireRow(entity: SyncEntity, uuid: string): Record<string, unknown> | null;

  /** A worker by the name the server knows them by. */
  personByUuid(
    uuid: string,
  ): { id: number; name: string; deletedAt: string | null } | null;

  // ---- The mudanza, §8 fase 3 and 4 -----------------------------------

  /**
   * The whole season this phone is holding, packed for the server.
   *
   * A READ, and the interface says so by returning a value and taking no
   * callback: §8's safety argument is that nothing the migration does to the
   * phone is destructive, and an operation that cannot write cannot break it.
   * Everything travels under the uuid the v6 migration minted, so the same
   * export offered twice is the same rows offered twice.
   */
  seasonExport(importId: string, generatedAt: string): SeasonExport;

  /**
   * Record an attempt at the import, successful or not.
   *
   * `import_runs` is not a synced table and this write does not queue
   * anything: an import that never reached the server must not leave behind a
   * row the next push tries to send to it.
   */
  recordImportRun(run: ImportRunInput): void;

  /** The attempts, newest first. What the screen shows when it opens. */
  importRuns(limit?: number): ImportRun[];

  /** The record decision 8 is conditional on. */
  reactivations(personId?: number): {
    id: number;
    personId: number;
    causeEntity: string;
    causeUuid: string;
    deviceId: string | null;
    at: string;
  }[];
}

// ---- The interface ------------------------------------------------------

export interface PeopleRepo {
  all(): Person[];
  byId(id: number): Person | null;
  /**
   * The worker's card number. `movil.md` §9.14 lists this as dead, but it is
   * not: `PeopleAdd` uses it to warn that a tag is already carried by someone
   * else, which is the one place a duplicate card can still be caught.
   */
  byTag(tag: string): Person | null;
  add(p: Omit<Person, "id" | "createdAt" | keyof Synced>): WriteResult;
  remove(id: number): WriteResult;
}

export interface CropsRepo {
  all(): Crop[];
  byId(id: number): Crop | null;
  add(c: Omit<Crop, "id" | "createdAt" | keyof Synced>): WriteResult;
  remove(id: number): WriteResult;
}

export interface PickupsRepo {
  isSettled(id: number): boolean;
  setWeight(id: number, weight: number): void;
  remove(id: number): void;
  add(p: Omit<Pickup, "id" | "createdAt" | keyof Synced>): WriteResult;
  recent(): RecentPickup[];
}

export interface ReportsRepo {
  totals(): FarmTotals | null;
  today(): PeriodTotals | null;
  thisWeek(): PeriodTotals | null;
  byWeek(): LabelledKg[];
  byWorker(general: number): ValuedGroup[];
  byCrop(general: number): ValuedGroup[];
}

export interface WorkerReportsRepo {
  stats(personId: number): WorkerStats | null;
  byWeek(personId: number): LabelledKg[];
  byCrop(personId: number): LabelledKg[];
  recent(personId: number): WorkerPickup[];
  payout(personId: number, general: number): number;
}

export interface ConfigRepo {
  get(): CropConfig | null;
  save(c: CropConfig): WriteResult;
}

export interface PrefsRepo {
  getLang(): AppLang;
  setLang(l: AppLang): WriteResult;
}

export interface OverridesRepo {
  all(): CostOverride[];
  set(week: string, costPerUnit: number): WriteResult;
  /**
   * The same price, in the integer cents the server speaks. This is what a
   * pulled `week_prices.price_minor` goes through: converting it to pesos and
   * back would put a float between the owner's decision and a farm's payroll.
   */
  setCents(week: string, costPerUnitCents: number): WriteResult;
  remove(id: number): WriteResult;
}

export interface DemoRepo {
  /**
   * Wipes the farm. Both of these are guarded: they throw
   * `ConfirmationRequired` unless handed the farm's own name, because `seed`
   * begins by wiping too and guarding only the scarier-looking button would
   * leave the hole exactly where it was.
   */
  clear(confirmation?: string): void;
  seed(confirmation?: string): void;
  /** What `clear` and `seed` demand before they do anything. */
  clearToken(): string;
}

export interface PaymentsRepo {
  preview(
    personId: number,
    from: string,
    to: string,
    general: number,
  ): SettlementPreview;
  settle(
    personId: number,
    from: string,
    to: string,
    general: number,
    note?: string,
  ): SettleResult | null;
  voidSettlement(settlementId: number, note?: string): void;
  /**
   * Settle and pay a whole crew — the payroll button, minus the presentation.
   *
   * It lives here and not in `PaymentsPanel` because the sequence *settle →
   * re-read the balance → pay what the ledger says* is a business rule, and a
   * business rule inside a React component is a business rule nothing can
   * test (`movil.md` §9.13). What the screen keeps is the sheet, the ticks and
   * the snackbar.
   *
   * Each worker is independent: one failure must not take the rest of the
   * payroll down. Each worker is NOT a transaction of its own either — settle
   * commits before pay is attempted, deliberately, because a settlement that
   * exists is a settlement that can be undone, and one that vanished with a
   * failed payment would have taken the released payables with it.
   */
  runPayroll(
    personIds: readonly number[],
    from: string,
    to: string,
    general: number,
    opts?: { method?: PayMethod; note?: string },
  ): PayrollRun;
  pay(
    personId: number,
    amountCents: number,
    opts?: {
      method?: PayMethod;
      date?: string;
      note?: string;
      settlementId?: number | null;
    },
  ): number;
  advance(personId: number, amountCents: number, note?: string): number;
  deduct(personId: number, amountCents: number, note: string): number;
  adjust(personId: number, signedCents: number, note: string): number;
  reverse(ledgerId: number, note: string): number;
  undoRun(paymentIds: number[], settlementIds: number[], note: string): void;
  balance(personId: number): Balance;
  balances(): BalanceRow[];
  /**
   * The balance to SHOW, which is not always the balance to pay. Decision 7
   * and §2.2 — see `FullBalance`.
   */
  fullBalance(personId: number): FullBalance;
  history(personId: number, limit?: number): LedgerEntry[];
  /**
   * Cents handed over against one settlement, for its receipt.
   *
   * Lives here rather than in each screen because both `Account` and the
   * payroll sheet needed it and each had written its own filter
   * (`movil.md` §9.3, and §9.12 on what happens when two screens own the same
   * rule). It is also the only place that knows about the pre-link payments
   * still out there.
   */
  paidAgainst(settlementId: number): number;
  /**
   * Cash handed over per worker between two days, inclusive — the payroll
   * sheet's own figure, in one query and without a row limit.
   *
   * It replaces a loop that asked for each worker's last fifty movements and
   * filtered them by date in JavaScript: past the fiftieth movement of a
   * season, this week's payment simply was not in the window and the worker
   * printed as unpaid on a sheet they were about to sign.
   */
  paidInRange(from: string, to: string): { personId: number; cents: number }[];
  settlements(personId: number): Settlement[];
  itemsOf(settlementId: number): SettlementItem[];
  pendingAll(general: number, upTo?: string): PendingWorker[];
}

export interface PerformanceRepo {
  crew(sinceDays?: number): WorkerPerf[];
  plots(sinceDays?: number): PlotPerf[];
  priceResponse(general: number, weeks?: number): PriceResponseRow[];
  realCost(general: number): RealCost;
}

export interface AnomaliesRepo {
  all(maxWeight?: number, window?: Partial<AnomalyWindow>): Anomaly[];
}

export interface CropReportsRepo {
  stats(cropId: number): CropStats | null;
  byWeek(cropId: number): CropWeek[];
  byWorker(cropId: number, sinceDays?: number): CropWorker[];
  recent(cropId: number): CropPickup[];
  value(cropId: number, general: number): number;
}

export interface ExportRepo {
  pickups(): Record<string, unknown>[];
  ledger(): Record<string, unknown>[];
  balances(): Record<string, unknown>[];
}

export interface WeekReportsRepo {
  byDay(monday: string): WeekDay[];
  byWorker(monday: string): WeekWorker[];
  grid(monday: string): WeekGridCell[];
  gridByDay(monday: string): WeekDayCell[];
  plots(monday: string): WeekPlot[];
}

/**
 * The whole data layer, as the screens see it. Adding a method here is a
 * promise every implementation has to keep, which is the point.
 */
export interface Repository {
  /** Create the schema and run pending migrations. Idempotent. */
  init(): void;

  people: PeopleRepo;
  crops: CropsRepo;
  pickups: PickupsRepo;
  reports: ReportsRepo;
  workerReports: WorkerReportsRepo;
  cropReports: CropReportsRepo;
  weekReports: WeekReportsRepo;
  config: ConfigRepo;
  prefs: PrefsRepo;
  overrides: OverridesRepo;
  demo: DemoRepo;
  payments: PaymentsRepo;
  performance: PerformanceRepo;
  anomalies: AnomaliesRepo;
  export: ExportRepo;
  sync: SyncRepo;

  weekCrops(): WeekCropRow[];
  reportBy(g: Grouping, general: number): LabelledKg[] | ValuedGroup[];
  /** The week's price in pesos, for display. Derived from the cents below. */
  costForWeek(week: string, general: number): number;
  /**
   * The week's price in integer cents. Every amount this farm pays is derived
   * through here; nothing on a money path reads the REAL column any more.
   */
  costCentsForWeek(week: string, generalCents: number): number;
  totalPayout(general: number): number;
}
