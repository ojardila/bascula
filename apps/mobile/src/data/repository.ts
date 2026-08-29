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
  costPerUnit: number;
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
}

export interface BalanceRow extends Balance {
  name: string;
  /** 1 when the worker is soft-deleted. Money is never hidden, only marked. */
  inactive: number;
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

/**
 * What the phone knows about syncing. Deliberately no `push` and no `pull`:
 * the protocol is being specified in parallel and guessing at it here would
 * produce code written against an imagined server. What is below is true of
 * any protocol worth having — every row has a name, and the phone knows what
 * it still owes.
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
  costForWeek(week: string, general: number): number;
  totalPayout(general: number): number;
}
