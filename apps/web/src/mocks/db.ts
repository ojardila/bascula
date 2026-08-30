/**
 * A whole coffee farm, in memory, in the SERVER's own shapes.
 *
 * Sprint 1 seeded this file from `docs/arquitectura-api.md`. Sprint 2 re-seeded
 * it from `services/api` itself: every row below is now a value of a type in
 * `src/api/wire.ts`, which was hand-transcribed from the Go structs. The point
 * is not tidiness. If the mock keeps emitting the old invented shapes, then
 * every mocked test exercises a translation that never runs in production, and
 * the adapter the real API needs is the one nothing tests.
 *
 * The figures are unchanged and they are load-bearing. They agree with the
 * wireframes in `docs/diagramas/web.md` §8 to the peso: 38,5 kg x $800 =
 * $30.800; María's pending total is $153.600; her derived balance is $184.500.
 * If you change a seed number and those stop matching, the seed is wrong, not
 * the wireframe.
 *
 * Money is in integer cents throughout: $800 is 80000.
 *
 * Three disciplines are copied from the server rather than approximated:
 *
 *   1. **Nothing derived is stored.** A balance is summed from the ledger on
 *      every read (`balanceOf`, the port of `balanceSQL` in
 *      `internal/store/money.go`); `settled` on a work record is an EXISTS
 *      against live settlement items, not a boolean anybody sets. A mock that
 *      returns a stored total teaches the UI to trust one.
 *
 *   2. **Rows are per-farm.** Everything a farm owns lives in a `Tenant`, and
 *      a request only ever reads the tenant its token names. That is what RLS
 *      does on the real server, and it is why signing up here produces an
 *      empty farm rather than somebody else's workers.
 *
 *   3. **There is no `status` column anywhere.** A worker who left has a
 *      `deletedAt`, an activity taken out of service has an `archivedAt`, and
 *      a plot out of use has a `deletedAt`. The old mock's `status: "active"`
 *      does not exist on the wire.
 */
import { mondayOf } from "../lib/dates";
import type {
  WireActivity,
  WireActivityRate,
  WireBalance,
  WireCatalogItem,
  WireCustomer,
  WireEmployee,
  WireExpense,
  WireLabelBatch,
  WireLedgerEntry,
  WireNote,
  WirePayable,
  WirePlot,
  WireProduct,
  WireRole,
  WireSale,
  WireSettlement,
  WireStockLevel,
  WireStockMove,
  WireWeekPrice,
  WireWorkRecord,
  WireWorkUnit,
} from "../api/wire";

/* -- dates ----------------------------------------------------------- */

/**
 * Postgres `date` columns arrive in Go as a `time.Time` and leave as a full
 * RFC 3339 instant at midnight UTC. `wire.ts` says so explicitly ("the server
 * sends these for dates that are really `date` columns too, so adapters slice,
 * never parse"), so the mock must send the same thing — otherwise every
 * adapter that slices would be tested against a string that never needs it.
 */
export const dayInstant = (day: string): string => `${day.slice(0, 10)}T00:00:00Z`;

/**
 * `InstantForLocalDay` deliberately puts a work record's `startedAt` at MIDDAY
 * in the farm's timezone, never midnight: midnight plus a daylight-saving
 * shift is exactly how a day's work ends up filed on the day before. Bogotá is
 * UTC-5 all year, so midday there is 17:00 UTC.
 */
export const noonInstant = (day: string): string => `${day.slice(0, 10)}T17:00:00Z`;

/** The other direction: an instant back to the business day it belongs to. */
export const dayOf = (instant: string): string => instant.slice(0, 10);

/* -- money ----------------------------------------------------------- */

/**
 * The one money rule, in all three pay schemes: `amount = round(quantity *
 * rate)`. The Go twin is `domain.AmountMinor`, which does it over `big.Rat`
 * and rounds half away from zero to match `round(numeric)` in Postgres.
 *
 * This does it in BigInt over the decimal DIGITS rather than in floating
 * point. The quantity crosses the wire as a bare JSON number, so it arrives
 * here as a `number` — but the column is `numeric(12,3)`, so its shortest
 * decimal form round-trips exactly, and multiplying those digits by an integer
 * rate keeps 38,5 kg out of a float on the way to money.
 */
export function amountCents(quantity: number | string, rateCents: number): number {
  const trimmed = String(quantity).trim();
  const negative = trimmed.startsWith("-");
  const [whole, fraction = ""] = trimmed.replace(/^[+-]/, "").split(".");
  const scale = 10n ** BigInt(fraction.length);
  const product = BigInt(`${whole || "0"}${fraction}`) * BigInt(Math.trunc(rateCents));
  const quotient = product / scale;
  const remainder = product % scale;
  const rounded = remainder * 2n >= scale ? quotient + 1n : quotient;
  return Number(negative ? -rounded : rounded);
}

/** `quantity must be a positive number` — the check in handlers_work_records.go. */
export function isPositiveQuantity(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0;
}

/* -- the platform, outside any farm ---------------------------------- */

export const FARM_ID = "0192f3a0-0000-7000-8000-000000000001";

/**
 * The `farms` row plus `farm_config.price_minor`. `priceCents` is `omitempty`
 * on the Go side and is DROPPED ENTIRELY from the weigher's projection — that
 * is the standing price of a kilo. A missing key means "you may not see this",
 * not "it is free", which is why the server sends nothing rather than 0.
 */
export interface MockFarm {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  minorUnit: number;
  phone: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  areaHa: number | null;
  suspendedAt: string | null;
  createdAt: string;
  /** The farm's standing price per kilo. `WeekPrice` falls back to it. */
  priceCents: number;
}

export interface MockUser {
  id: string;
  email: string;
  /** Plain text on purpose: an argon2 hash in a mock proves nothing. */
  password: string;
  name: string;
  superadmin: boolean;
  emailVerified: boolean;
  /**
   * The role of the membership this user was seeded with. `memberships` below
   * is the authority — a user may own a second farm with a different role —
   * but tests that just want "the weigher" read this.
   */
  role: WireRole;
}

export interface MockMembership {
  farmId: string;
  userId: string;
  role: WireRole;
}

/**
 * Refresh tokens rotate, exactly as `handleRefresh` does. Presenting one that
 * already has a `rotatedAt` kills the whole family, because a replayed refresh
 * token is either a bug or a theft and neither deserves a working session.
 */
export interface MockRefreshToken {
  token: string;
  familyId: string;
  userId: string;
  farmId: string;
  expiresAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
}

export interface MockEmailVerification {
  token: string;
  userId: string;
  farmId: string;
  consumedAt: number | null;
}

/* -- what a farm owns ------------------------------------------------ */

/**
 * An activity keeps its whole rate history, and the wire projection picks the
 * one in force on the requested day (`RateInForce`). `WireActivity.rate` is a
 * single rate or no key at all, so it cannot be the storage shape.
 */
export type MockActivity = Omit<WireActivity, "rate"> & { rates: WireActivityRate[] };

/**
 * `settled` is `EXISTS (SELECT 1 FROM settlement_items ... voided_at IS NULL)`
 * on the server, so it is not stored here either: `projectWorkRecord` derives
 * it from the tenant's settlements.
 */
export type MockWorkRecord = Omit<WireWorkRecord, "settled" | "quantity"> & { quantity: number };

/** One claimed payable. The `voidedAt` is what releases it again. */
export interface MockSettlementItem {
  payableId: string;
  weekStart: string;
  quantity: number;
  rateCents: number;
  amountCents: number;
  voidedAt: string | null;
}

export type MockSettlement = Omit<WireSettlement, "items"> & { items: MockSettlementItem[] };

/* -- products, warehouses, sales and expenses ------------------------ */

/**
 * WHAT IS NOT ON THESE ROWS IS THE POINT.
 *
 * Every one of them is `Omit<Wire…, the joins and the sums>`. The wire shape
 * carries `product`, `warehouse`, `category`, `storageUnit` and `stock`
 * because the server's `SELECT` joins them on the way out; storing them here
 * would let the seed hold a name that no longer matches the catalogue row it
 * came from, and — far worse for `stock` — would let a screen be built against
 * a total nobody recomputes.
 *
 * `stock` is the one that has to be said out loud, because it is the whole
 * decision of migration 00009: THERE IS NO STOCK COLUMN. `products.go` reads
 * it as `coalesce((SELECT sum(m.qty) FROM stock_moves m WHERE m.product_id =
 * p.id), 0)`, on every read, and `projectProduct` below does the same over
 * `t.stockMoves`. If you find yourself wanting to add a number here so a
 * handler can be quicker, that is the bug the schema was shaped to prevent.
 */
export type MockProduct = Omit<WireProduct, "category" | "storageUnit" | "stock">;

/**
 * One fact about the warehouse. APPEND-ONLY: `stock_moves_is_append_only()` is
 * a trigger and `REVOKE UPDATE, DELETE ON stock_moves` is the belt to it, so
 * nothing in `handlers.ts` may mutate one of these after it is pushed. The way
 * back is `reversesId`, once.
 *
 * `reversedById` and `labelBatchId` are correlated sub-selects on the server
 * (`stockMoveCols`), so they are derived here too — a movement does not know
 * it has been undone, the undoing knows what it undid.
 */
export type MockStockMove = Omit<
  WireStockMove,
  "product" | "warehouse" | "plot" | "reversedById" | "labelBatchId"
>;

/** `stockMoveId` and `reversalMoveId` are sub-selects over the movements. */
export type MockSale = Omit<
  WireSale,
  "product" | "storageUnit" | "customer" | "warehouse" | "stockMoveId" | "reversalMoveId"
>;

/**
 * `target` is DERIVED on the way out — `scanExpense` sets it from which column
 * is populated, and never from anything a caller sent. A client that could
 * name the target independently of the ids could send a row that says
 * "activity" with only a plot on it, and every breakdown built on `target`
 * would be wrong in a way no constraint could catch.
 */
export type MockExpense = Omit<WireExpense, "activity" | "plot" | "crop" | "target">;

/** The labels themselves are rendered from the movement on every read. */
export type MockLabelBatch = Omit<WireLabelBatch, "labels">;

export interface Tenant {
  farmId: string;
  workUnits: WireWorkUnit[];
  activityCategories: WireCatalogItem[];
  cropTypes: WireCatalogItem[];
  varieties: WireCatalogItem[];
  workers: WireEmployee[];
  plots: WirePlot[];
  activities: MockActivity[];
  workRecords: MockWorkRecord[];
  weekPrices: WireWeekPrice[];
  ledger: WireLedgerEntry[];
  settlements: MockSettlement[];
  notes: WireNote[];
  /* -- RSP-018 … RSP-033 -- */
  productCategories: WireCatalogItem[];
  storageUnits: WireCatalogItem[];
  warehouses: WireCatalogItem[];
  products: MockProduct[];
  /** Append-only. Nothing removes from this array and nothing edits it. */
  stockMoves: MockStockMove[];
  customers: WireCustomer[];
  sales: MockSale[];
  expenses: MockExpense[];
  labelBatches: MockLabelBatch[];
}

/* -- the store ------------------------------------------------------- */

export const farms: MockFarm[] = [];
export const users: MockUser[] = [];
export const memberships: MockMembership[] = [];
export const refreshTokens: MockRefreshToken[] = [];
export const verifications: MockEmailVerification[] = [];
export const tenants = new Map<string, Tenant>();

/**
 * Every access token this mock has minted is valid until its own expiry. This
 * moves the whole set into the past in one call, so a test can drive the
 * client's transparent-refresh path without waiting fifteen minutes for it.
 */
let accessTokenEpoch = 0;

export function expireAccessTokens(): void {
  // One millisecond ahead, so a token minted in this very millisecond is
  // caught too. Anything issued afterwards is fresh again, which is what makes
  // the client's replay-after-refresh actually succeed.
  accessTokenEpoch = Date.now() + 1;
}

export function accessTokenEpochMs(): number {
  return accessTokenEpoch;
}

export function tenantOf(farmId: string): Tenant | undefined {
  return tenants.get(farmId);
}

export function farmOf(farmId: string): MockFarm | undefined {
  return farms.find((f) => f.id === farmId);
}

export function membershipsOf(userId: string): MockMembership[] {
  return memberships.filter((m) => m.userId === userId);
}

export function membershipFor(farmId: string, userId: string): MockMembership | undefined {
  return memberships.find((m) => m.farmId === farmId && m.userId === userId);
}

/**
 * `seedFarm` in handlers_auth.go: the minimum a farm needs to weigh coffee on
 * day one. The three seeded categories, a kilo, and a "Recoleccion" activity
 * priced from the weekly price table — which is exactly what the phone has.
 */
export function emptyTenant(farmId: string, priceCents: number, id: () => string): Tenant {
  const categories: WireCatalogItem[] = ["siembra", "mantenimiento", "cosecha"].map((name) => ({
    id: id(),
    name,
  }));
  const kg: WireWorkUnit = { id: id(), code: "kg", label: "Kilo", kgFactor: 1 };
  const harvest = categories[2];
  const lastYear = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return {
    farmId,
    workUnits: [kg],
    activityCategories: categories,
    cropTypes: [],
    varieties: [],
    workers: [],
    plots: [],
    activities: [
      {
        id: id(),
        name: "Recoleccion",
        categoryId: harvest.id,
        category: harvest.name,
        payScheme: "unidad_trabajo",
        rateSource: "weekly_price",
        unitId: kg.id,
        archivedAt: null,
        rates: [
          {
            validFrom: dayInstant(lastYear),
            rateCents: priceCents,
            timeUnit: null,
            customQty: null,
            customUnit: null,
          },
        ],
      },
    ],
    workRecords: [],
    weekPrices: [],
    ledger: [],
    settlements: [],
    notes: [],
    // A NEW FARM HAS NO WAREHOUSE, no storage unit and no product category,
    // because `SeedCatalogs` seeds the three activity categories and nothing
    // else. That is not an oversight to paper over here: the first product a
    // farm registers creates its storage unit through `resolveCatalog`'s
    // "either an id or a name", and the first movement creates its warehouse
    // the same way. A mock that handed out a "Bodega principal" nobody asked
    // for would hide the one path every real farm walks on its first day.
    productCategories: [],
    storageUnits: [],
    warehouses: [],
    products: [],
    stockMoves: [],
    customers: [],
    sales: [],
    expenses: [],
    labelBatches: [],
  };
}

/* -- derived reads, ported from the server --------------------------- */

/**
 * `balanceSQL`, line for line. Positive means the farm owes the worker.
 * Reversals are told apart by sign: reversing an earning is negative, reversing
 * a payment positive. There is no stored total to read instead.
 */
export function balanceOf(t: Tenant, workerId: string): WireBalance {
  const rows = t.ledger.filter((l) => l.workerId === workerId);
  const sum = (pred: (l: WireLedgerEntry) => boolean) =>
    rows.filter(pred).reduce((a, l) => a + l.amountCents, 0);
  const days = rows.map((l) => l.date).sort();
  return {
    workerId,
    earnedCents: sum((l) => l.kind === "devengo" || (l.kind === "reverso" && l.amountCents < 0)),
    paidCents: -sum(
      (l) =>
        l.kind === "pago" || l.kind === "anticipo" || (l.kind === "reverso" && l.amountCents > 0),
    ),
    deductedCents: -sum((l) => l.kind === "deduccion"),
    balanceCents: rows.reduce((a, l) => a + l.amountCents, 0),
    lastMovementOn: days.length ? days[days.length - 1] : null,
    // False for somebody off the payroll. They stay in `/v1/balances` while
    // they still have movements: a debt that disappears with the employee is
    // a debt nobody pays.
    active: !t.workers.find((w) => w.id === workerId)?.deletedAt,
  };
}

/**
 * `Debts`: what the worker owes the farm and what the farm has already
 * advanced — the "Lista de deudas" half of the RSP-008 screen.
 *
 * Two things it deliberately is not. It is not expenses: an expense is the
 * farm's own accounting and never touches anybody's ledger. And it is not a
 * second subtraction — every row here is ALREADY inside the derived balance,
 * so a caller that subtracts these from the balance charges the worker twice.
 *
 * The amounts keep the ledger's own sign, negative, rather than being flipped
 * to a friendlier positive: the sign convention is load-bearing across the
 * whole module and re-signing it in one endpoint is how a convention rots.
 */
export function debtsOf(t: Tenant, workerId: string): WireLedgerEntry[] {
  return t.ledger
    .filter(
      (l) =>
        l.workerId === workerId &&
        (l.kind === "deduccion" || l.kind === "anticipo") &&
        !t.ledger.some((r) => r.reversesId === l.id),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

/** Live claims on a payable: what makes `settled` true and re-settling a 409. */
export function liveClaim(
  t: Tenant,
  payableId: string,
): { settlement: MockSettlement; item: MockSettlementItem } | null {
  for (const s of t.settlements) {
    for (const item of s.items) {
      if (item.payableId === payableId && item.voidedAt === null) return { settlement: s, item };
    }
  }
  return null;
}

export function isSettled(t: Tenant, payableId: string): boolean {
  return liveClaim(t, payableId) !== null;
}

/**
 * The wire projection of a work record: `settled` is derived, never stored.
 *
 * AND SO IS THE MONEY, for the rows the week still prices. `estimatedAmountCents`
 * is documented as "what it is worth TODAY", and `pending()` twenty lines below
 * recomputes it from `weekPriceOf` on every read — but this projection was
 * echoing the number the row was seeded with. So the moment the owner changed a
 * week's price, `/v1/workers/{id}/payables` moved and `/v1/work-records` did
 * not, and the console had two answers for one week's picking again: the
 * employee's profile one figure, the list of labores another.
 *
 * That is not mock-only cosmetics. The screens that read the list — the
 * dashboard, `/labores`, the employee list — are exactly the ones this sprint
 * made agree with each other, and a mock that cannot change a price without
 * splitting them cannot be used to check that they agree.
 *
 * The rule is the one `pending()` uses, unchanged: a record whose price is
 * frozen (settled, or written with an explicit rate) keeps it; a `weekly_price`
 * record that no live settlement claims is worth quantity x this week's price.
 */
export function projectWorkRecord(t: Tenant, r: MockWorkRecord): WireWorkRecord {
  const settled = isSettled(t, r.id);
  const stillOnTheWeek = !settled && r.rateSource === "weekly_price" && r.rateCents === null;
  if (!stillOnTheWeek) return { ...r, settled };
  const rateCents = weekPriceOf(t, dayOf(r.weekStart));
  return {
    ...r,
    settled,
    estimatedAmountCents: amountCents(Number(r.quantity), rateCents),
    amountIsEstimate: true,
  };
}

/**
 * `WeekPrice`: the owner's override for that week if there is one, otherwise
 * the farm's standing price. Note what it is NOT — the old mock fell back to
 * "the last price we happen to know", which quietly invents money for a week
 * nobody priced.
 */
export function weekPriceOf(t: Tenant, weekStart: string): number {
  const override = t.weekPrices.find((p) => p.weekStart === weekStart);
  if (override) return override.priceCents;
  return farmOf(t.farmId)?.priceCents ?? 0;
}

/**
 * `pendingSQL` plus the price resolution that follows it. Payables in range
 * that no live settlement has claimed, each already priced. Two freezing
 * moments meet here: a `weekly_price` record takes the week's price NOW, and
 * everything else reads back the price frozen when it was written.
 *
 * Deliberately scheme-agnostic: a picker who also cleared brush the same week
 * must receive ONE settlement, so pending is never filtered by pay scheme.
 */
export function pending(
  t: Tenant,
  workerId: string,
  from: string,
  to: string,
  // `WirePayable.quantity` is typed loosely because the server echoes whatever
  // text the column held; what the mock produces is always the number.
): (WirePayable & { quantity: number })[] {
  return t.workRecords
    .filter(
      (r) =>
        r.workerId === workerId &&
        r.deletedAt === null &&
        dayOf(r.dateFrom) >= from &&
        dayOf(r.dateFrom) <= to &&
        !isSettled(t, r.id),
    )
    .sort((a, b) => dayOf(a.dateFrom).localeCompare(dayOf(b.dateFrom)) || a.id.localeCompare(b.id))
    .map((r) => {
      const activity = t.activities.find((a) => a.id === r.activityId);
      const weekStart = dayOf(r.weekStart);
      const rateCents =
        r.rateSource === "weekly_price" ? weekPriceOf(t, weekStart) : (r.rateCents ?? 0);
      return {
        payableId: r.id,
        activityId: r.activityId,
        activity: activity?.name ?? "",
        payScheme: r.payScheme,
        rateSource: r.rateSource,
        quantity: r.quantity,
        unitId: r.unitId,
        date: r.dateFrom,
        weekStart: r.weekStart,
        rateCents,
        amountCents:
          r.rateSource === "weekly_price"
            ? amountCents(r.quantity, rateCents)
            : (r.amountCents ?? 0),
        voided: false,
      };
    });
}

/** `RateInForce`: the newest rate whose validFrom is on or before that day. */
export function rateInForce(a: MockActivity, on: string): WireActivityRate | null {
  const eligible = a.rates
    .filter((r) => dayOf(r.validFrom) <= on)
    .sort((x, y) => x.validFrom.localeCompare(y.validFrom));
  return eligible.length ? eligible[eligible.length - 1] : null;
}

/* -- existencias, derived, exactly as the view derives them ---------- */

/**
 * `productCols`'s sub-select: `sum(m.qty)` over every movement of this
 * product, across every warehouse.
 *
 * No filter on `deleted_at`, deliberately — the Go query has none either. A
 * product taken out of the catalogue keeps whatever is physically on the
 * shelf, because RSP-021 removes it from the pickers and does not un-harvest
 * last week's coffee.
 */
export function productStock(t: Tenant, productId: string): number {
  return round3(
    t.stockMoves.filter((m) => m.productId === productId).reduce((a, m) => a + m.qty, 0),
  );
}

/**
 * The `stock_levels` VIEW, including the part everybody forgets:
 *
 *     HAVING SUM(qty) <> 0
 *
 * A product that came in and went out again does NOT appear as a zero row. The
 * screen showing existencias is a list of what is there, and a page of zeroes
 * for everything the farm ever touched is a page nobody reads.
 */
export function stockLevels(t: Tenant, productId?: string, warehouseId?: string): WireStockLevel[] {
  const byPair = new Map<string, number>();
  for (const m of t.stockMoves) {
    if (productId && m.productId !== productId) continue;
    if (warehouseId && m.warehouseId !== warehouseId) continue;
    const key = `${m.productId}|${m.warehouseId}`;
    byPair.set(key, (byPair.get(key) ?? 0) + m.qty);
  }
  const out: WireStockLevel[] = [];
  for (const [key, qty] of byPair) {
    if (round3(qty) === 0) continue;
    const [pid, wid] = key.split("|");
    const product = t.products.find((p) => p.id === pid);
    const unit = t.storageUnits.find((u) => u.id === product?.storageUnitId);
    out.push({
      productId: pid,
      product: product?.name ?? "",
      storageUnit: unit?.name ?? "",
      warehouseId: wid,
      warehouse: t.warehouses.find((w) => w.id === wid)?.name ?? "",
      qty: round3(qty),
    });
  }
  return out.sort(
    (a, b) => a.product.localeCompare(b.product, "es") || a.warehouse.localeCompare(b.warehouse, "es"),
  );
}

/** `StockOnHand`: the same sum, asked for the one pair a write is about. */
export function stockOnHand(t: Tenant, productId: string, warehouseId: string): number {
  return round3(
    t.stockMoves
      .filter((m) => m.productId === productId && m.warehouseId === warehouseId)
      .reduce((a, m) => a + m.qty, 0),
  );
}

/**
 * `round3` in `stock.go`. The column is `numeric(14,3)`, so a total that came
 * out of floating-point addition as 59.999999999999996 has to land on 60
 * before anybody reads it — a warehouse count is compared against a shelf.
 */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/* -- the seed -------------------------------------------------------- */

/**
 * Rebuilds La Esperanza from nothing. It runs once at import and again from
 * `resetDb()`, so a test that pays somebody does not leave the next test with
 * a different balance. Ids are stable across resets on purpose: the wireframes,
 * the demo and several tests navigate straight to them by URL.
 */
export function resetDb(): void {
  farms.length = 0;
  users.length = 0;
  memberships.length = 0;
  refreshTokens.length = 0;
  verifications.length = 0;
  tenants.clear();
  accessTokenEpoch = 0;

  farms.push(
    {
      id: FARM_ID,
      name: "La Esperanza",
      timezone: "America/Bogota",
      currency: "COP",
      minorUnit: 2,
      phone: "3205550101",
      country: "CO",
      city: "Chinchiná",
      address: "Vereda La Floresta, km 4",
      areaHa: 14.45,
      suspendedAt: null,
      createdAt: "2026-01-12T13:00:00Z",
      priceCents: 80000,
    },
    // Three more farms with nobody's membership on them. They exist so the
    // super-admin console has a list; the console reads columns of `farms` and
    // nothing else, and that projection IS the enforcement — it cannot reach
    // an employee, a work record or a peso of anybody's money.
    {
      id: "0192f3a0-0000-7000-8000-000000000002",
      name: "El Mirador",
      timezone: "America/Bogota",
      currency: "COP",
      minorUnit: 2,
      phone: null,
      country: "CO",
      city: "Salamina",
      address: null,
      areaHa: 22,
      suspendedAt: null,
      createdAt: "2026-05-02T14:20:00Z",
      priceCents: 82000,
    },
    {
      id: "0192f3a0-0000-7000-8000-000000000003",
      name: "Villa Nueva",
      timezone: "America/Bogota",
      currency: "COP",
      minorUnit: 2,
      phone: null,
      country: "CO",
      city: "Pereira",
      address: null,
      areaHa: 48,
      suspendedAt: null,
      createdAt: "2026-03-11T16:45:00Z",
      priceCents: 79000,
    },
    {
      id: "0192f3a0-0000-7000-8000-000000000004",
      name: "La Palma",
      timezone: "America/Bogota",
      currency: "COP",
      minorUnit: 2,
      phone: null,
      country: "CO",
      city: "Anserma",
      address: null,
      areaHa: 9,
      // Suspension is not a delete: login and refresh both refuse it, and a
      // token already issued keeps working until it expires.
      suspendedAt: "2026-06-30T21:22:00Z",
      createdAt: "2025-12-01T13:00:00Z",
      priceCents: 75000,
    },
  );

  users.push(
    {
      id: "0192f3a0-0001-7000-8000-000000000001",
      email: "oscar@laesperanza.co",
      password: "esperanza",
      name: "Oscar Jaramillo",
      superadmin: false,
      emailVerified: true,
      role: "owner",
    },
    {
      // `administrator` in the old mock. The server's enum value is `admin`.
      id: "0192f3a0-0001-7000-8000-000000000002",
      email: "admin@laesperanza.co",
      password: "esperanza",
      name: "Gloria Betancur",
      superadmin: false,
      emailVerified: true,
      role: "admin",
    },
    {
      id: "0192f3a0-0001-7000-8000-000000000003",
      email: "pesador@laesperanza.co",
      password: "esperanza",
      name: "Wilmar Grisales",
      superadmin: false,
      emailVerified: true,
      role: "weigher",
    },
    {
      // A super-admin administers farms from the outside. `perm.go` gives the
      // flag two actions and neither of them reads inside a farm.
      id: "0192f3a0-0001-7000-8000-000000000009",
      email: "super@bascula.co",
      password: "bascula",
      name: "Soporte Báscula",
      superadmin: true,
      emailVerified: true,
      role: "owner",
    },
  );
  // Only La Esperanza has members. The other three are somebody else's farms
  // as far as this mock is concerned, which is exactly what the console sees.
  for (const u of users) memberships.push({ farmId: FARM_ID, userId: u.id, role: u.role });

  /* -- catalogues -- */

  const categories: WireCatalogItem[] = [
    { id: "0192f3a0-000c-7000-8000-000000000001", name: "siembra" },
    { id: "0192f3a0-000c-7000-8000-000000000002", name: "mantenimiento" },
    { id: "0192f3a0-000c-7000-8000-000000000003", name: "cosecha" },
  ];

  const workUnits: WireWorkUnit[] = [
    { id: "0192f3a0-000d-7000-8000-000000000001", code: "kg", label: "Kilo", kgFactor: 1 },
    { id: "0192f3a0-000d-7000-8000-000000000002", code: "canasta", label: "Canasta", kgFactor: null },
  ];

  const cropTypes: WireCatalogItem[] = [
    { id: "0192f3a0-0002-7000-8000-000000000001", name: "Café" },
    { id: "0192f3a0-0002-7000-8000-000000000002", name: "Aguacate" },
    { id: "0192f3a0-0002-7000-8000-000000000003", name: "Plátano" },
    { id: "0192f3a0-0002-7000-8000-000000000004", name: "Yuca" },
  ];

  /**
   * Varieties are a FLAT name catalogue on the server: `WireCatalogItem` is
   * `{id, name}` and `catalogs.go` has no crop-type column. The old mock hung
   * a `cropTypeId` on each one and let the UI filter by it; that field does
   * not exist, so the picker has to offer them all.
   */
  const varieties: WireCatalogItem[] = [
    { id: "0192f3a0-0003-7000-8000-000000000001", name: "Castillo" },
    { id: "0192f3a0-0003-7000-8000-000000000002", name: "Colombia" },
    { id: "0192f3a0-0003-7000-8000-000000000003", name: "Caturra" },
    { id: "0192f3a0-0003-7000-8000-000000000004", name: "Cenicafé 1" },
    { id: "0192f3a0-0003-7000-8000-000000000005", name: "Hass" },
    { id: "0192f3a0-0003-7000-8000-000000000006", name: "Lorena" },
    { id: "0192f3a0-0003-7000-8000-000000000007", name: "Dominico hartón" },
  ];

  /* -- plots -- */

  const plots: WirePlot[] = [
    {
      id: "0192f3a0-0004-7000-8000-000000000001",
      name: "El Alto",
      areaHa: 4.2,
      // A second drawn plot, so the map has a NEIGHBOUR to draw behind the one
      // being edited. One polygon in the whole seed made the context layer —
      // the thing that replaces a satellite photo on this screen — impossible
      // to look at without drawing a second lot by hand first.
      computedAreaHa: 4.04,
      department: "Caldas",
      municipality: "Manizales",
      boundary: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-75.61047, 4.98554],
              [-75.60866, 4.98567],
              [-75.60853, 4.98386],
              [-75.61034, 4.98373],
              [-75.61047, 4.98554],
            ],
          ],
        ],
      },
      createdAt: "2026-01-12T14:00:00Z",
      deletedAt: null,
      crops: [
        {
          id: "0192f3a0-0005-7000-8000-000000000001",
          plotId: "0192f3a0-0004-7000-8000-000000000001",
          cropTypeId: cropTypes[0].id,
          cropType: "Café",
          varietyId: varieties[0].id,
          variety: "Castillo",
          areaHa: 2.6,
          plantedOn: dayInstant("2022-04-15"),
          removedOn: null,
          deletedAt: null,
        },
        {
          id: "0192f3a0-0005-7000-8000-000000000002",
          plotId: "0192f3a0-0004-7000-8000-000000000001",
          cropTypeId: cropTypes[0].id,
          cropType: "Café",
          varietyId: varieties[1].id,
          variety: "Colombia",
          areaHa: 1.6,
          plantedOn: dayInstant("2023-09-02"),
          removedOn: null,
          deletedAt: null,
        },
      ],
    },
    {
      id: "0192f3a0-0004-7000-8000-000000000002",
      name: "La Cuchilla",
      areaHa: 2.75,
      computedAreaHa: null,
      department: "Caldas",
      municipality: "Manizales",
      boundary: null,
      createdAt: "2026-01-12T14:05:00Z",
      deletedAt: null,
      crops: [
        {
          id: "0192f3a0-0005-7000-8000-000000000003",
          plotId: "0192f3a0-0004-7000-8000-000000000002",
          cropTypeId: cropTypes[0].id,
          cropType: "Café",
          varietyId: varieties[2].id,
          variety: "Caturra",
          areaHa: 2.75,
          plantedOn: dayInstant("2019-03-10"),
          removedOn: null,
          deletedAt: null,
        },
      ],
    },
    {
      id: "0192f3a0-0004-7000-8000-000000000003",
      name: "Bajo del Río",
      areaHa: 6,
      // The only plot with a drawn polygon in the seed, so the "declared vs
      // computed" row of the wireframe has something to show.
      // Measured off the ring below with the same authalic sum `lib/geo.ts`
      // uses, rather than invented. Sprint 1 wrote 5.71 next to a polygon that
      // actually measures 13.6 ha, which made the seed teach the screen a
      // relationship the server would never produce.
      computedAreaHa: 5.69,
      department: "Caldas",
      municipality: "Chinchiná",
      // A MULTIPOLYGON, because that is what comes back. The column is a
      // MultiPolygon geography and `ST_Multi` promotes whatever is sent, so a
      // client that stores a Polygon reads a MultiPolygon on the next load —
      // verified against the running server, not assumed.
      boundary: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-75.60657, 4.98157],
              [-75.60444, 4.98176],
              [-75.60424, 4.97963],
              [-75.60644, 4.97944],
              [-75.60657, 4.98157],
            ],
          ],
        ],
      },
      createdAt: "2026-01-12T14:10:00Z",
      deletedAt: null,
      crops: [
        {
          id: "0192f3a0-0005-7000-8000-000000000004",
          plotId: "0192f3a0-0004-7000-8000-000000000003",
          cropTypeId: cropTypes[1].id,
          cropType: "Aguacate",
          varietyId: varieties[4].id,
          variety: "Hass",
          areaHa: 6,
          plantedOn: dayInstant("2021-11-20"),
          removedOn: null,
          deletedAt: null,
        },
      ],
    },
    {
      // Out of service. `handleDeletePlot` refuses while anything is still
      // planted, so its yuca was removed first — which is the order the real
      // server forces and therefore the only order the seed may show.
      id: "0192f3a0-0004-7000-8000-000000000004",
      name: "San José",
      areaHa: 1.5,
      computedAreaHa: null,
      department: "Caldas",
      municipality: "Chinchiná",
      boundary: null,
      createdAt: "2026-01-12T14:15:00Z",
      deletedAt: "2026-06-30T15:00:00Z",
      crops: [
        {
          id: "0192f3a0-0005-7000-8000-000000000005",
          plotId: "0192f3a0-0004-7000-8000-000000000004",
          cropTypeId: cropTypes[3].id,
          cropType: "Yuca",
          varietyId: null,
          variety: null,
          areaHa: 1.5,
          plantedOn: null,
          removedOn: dayInstant("2026-06-29"),
          deletedAt: "2026-06-29T15:00:00Z",
        },
      ],
    },
  ];

  /* -- workers -- */

  /**
   * `documentNumber` is `docId` on the wire, and `tag` is new: the number
   * painted on the basket, which is how the weigher finds a person at the
   * scale. His projection is {id, name, lastName, tag} and nothing else, so
   * without a tag his list would be four fields of which one is useful.
   */
  const workers: WireEmployee[] = [
    {
      id: "0192f3a0-0006-7000-8000-000000000001",
      name: "María",
      lastName: "Restrepo Ospina",
      documentType: "CC",
      docId: "1045882331",
      tag: "12",
      phone: "3205551212",
      address: "Vereda La Floresta",
      city: "Chinchiná",
      municipality: "Chinchiná",
      country: "CO",
      photoId: null,
      createdAt: "2025-03-12T13:00:00Z",
      deletedAt: null,
    },
    {
      id: "0192f3a0-0006-7000-8000-000000000002",
      name: "Jhon Fredy",
      lastName: "Cardona Loaiza",
      documentType: "CC",
      docId: "15322109",
      tag: "07",
      phone: "3117778899",
      address: "Barrio El Carmen",
      city: "Manizales",
      municipality: "Manizales",
      country: "CO",
      photoId: null,
      createdAt: "2024-08-01T13:00:00Z",
      deletedAt: null,
    },
    {
      id: "0192f3a0-0006-7000-8000-000000000003",
      name: "Luz Dary",
      lastName: "Ospina Giraldo",
      documentType: "CC",
      docId: "24556887",
      tag: "23",
      phone: "3009991010",
      address: "Vereda El Trébol",
      city: "Chinchiná",
      municipality: "Chinchiná",
      country: "CO",
      photoId: null,
      createdAt: "2026-01-15T13:00:00Z",
      deletedAt: null,
    },
    {
      id: "0192f3a0-0006-7000-8000-000000000004",
      name: "Édinson",
      lastName: "Marín Ríos",
      documentType: "CE",
      docId: "AV884219",
      tag: "31",
      phone: "3145557766",
      address: "Vereda La Floresta",
      city: "Chinchiná",
      municipality: "Chinchiná",
      country: "CO",
      photoId: null,
      createdAt: "2025-11-03T13:00:00Z",
      deletedAt: null,
    },
    {
      // Left the farm. `status: "inactive"` in the old mock; the financial
      // history has to survive her, so it is a deletedAt and not a delete.
      id: "0192f3a0-0006-7000-8000-000000000005",
      name: "Nubia",
      lastName: "Ceballos Arango",
      documentType: "CC",
      docId: "30112443",
      tag: "05",
      phone: "3186664545",
      address: "Corregimiento La Trinidad",
      city: "Chinchiná",
      municipality: "Chinchiná",
      country: "CO",
      photoId: null,
      createdAt: "2023-02-20T13:00:00Z",
      deletedAt: "2026-05-04T16:00:00Z",
    },
  ];

  /* -- activities -- */

  const rate = (
    validFrom: string,
    rateCents: number,
    // Not `string | null`. `contract.assert.ts` caught `wire.ts` widening this
    // to a bare string, and a bare string is exactly what let the server's
    // `personalizado` and the interface's `custom` drift apart with nothing
    // noticing. The seed only ever passes "jornal" and null, so nothing here
    // changes but the type.
    timeUnit: WireActivityRate["timeUnit"] = null,
  ): WireActivityRate => ({
    validFrom: dayInstant(validFrom),
    rateCents,
    timeUnit,
    customQty: null,
    customUnit: null,
  });

  const activities: MockActivity[] = [
    {
      id: "0192f3a0-0007-7000-8000-000000000001",
      name: "Recolección de café",
      categoryId: categories[2].id,
      category: "cosecha",
      payScheme: "unidad_trabajo",
      // The one activity whose price is not frozen on write: it takes the
      // Monday price of its week, at settlement time, like the phone does.
      rateSource: "weekly_price",
      unitId: workUnits[0].id,
      archivedAt: null,
      rates: [rate("2026-01-01", 80000)],
    },
    {
      id: "0192f3a0-0007-7000-8000-000000000002",
      name: "Guadañada",
      categoryId: categories[1].id,
      category: "mantenimiento",
      payScheme: "tiempo",
      rateSource: "activity_dated",
      unitId: null,
      archivedAt: null,
      // Two periods, because a rate is a row with a date on it (decision 4)
      // and "why was I paid this" has to have an answer.
      rates: [rate("2025-01-01", 4000000, "jornal"), rate("2026-01-01", 4500000, "jornal")],
    },
    {
      id: "0192f3a0-0007-7000-8000-000000000003",
      name: "Fertilización",
      categoryId: categories[1].id,
      category: "mantenimiento",
      payScheme: "tiempo",
      rateSource: "activity_dated",
      unitId: null,
      archivedAt: null,
      rates: [rate("2026-01-01", 5000000, "jornal")],
    },
    {
      id: "0192f3a0-0007-7000-8000-000000000004",
      name: "Siembra de colinos",
      categoryId: categories[0].id,
      category: "siembra",
      payScheme: "contrato",
      rateSource: "activity_dated",
      unitId: null,
      archivedAt: null,
      rates: [rate("2026-02-01", 120000000)], // $1.200.000 el contrato completo
    },
    {
      id: "0192f3a0-0007-7000-8000-000000000005",
      name: "Zoqueo",
      categoryId: categories[1].id,
      category: "mantenimiento",
      payScheme: "contrato",
      rateSource: "activity_dated",
      unitId: null,
      // Taken out of service: an `archivedAt`, not a status.
      archivedAt: "2026-04-02T15:00:00Z",
      rates: [rate("2026-01-01", 65000000)],
    },
    {
      id: "0192f3a0-0007-7000-8000-000000000006",
      name: "Recolección de aguacate",
      categoryId: categories[2].id,
      category: "cosecha",
      payScheme: "unidad_trabajo",
      rateSource: "activity_dated",
      unitId: workUnits[1].id,
      archivedAt: null,
      rates: [rate("2026-01-01", 350000)], // $3.500 la canasta
    },
  ];

  /* -- weekly prices -- */

  const weekPrices: WireWeekPrice[] = [
    { weekStart: "2026-08-10", priceCents: 75000 },
    { weekStart: "2026-08-17", priceCents: 78000 },
    { weekStart: "2026-08-24", priceCents: 80000 },
  ];

  /* -- work records -- */

  const OWNER = users[0].id;
  const ADMIN = users[1].id;
  const WEIGHER = users[2].id;

  /**
   * `quantity` is a decimal STRING and the amount is null while the price is
   * still open. A `weekly_price` record therefore carries no rate and no
   * amount at all until a settlement resolves it — the $30.800 the wireframe
   * shows is 38,5 x the week's $800, computed by `pending`, not stored here.
   *
   * The two multi-day records carry `rateSource: "explicit"`, because a record
   * priced by date has to be a single day: a wage from Tuesday to Tuesday has
   * no single validity period and no single week. Naming the rate is what buys
   * the range.
   */
  const record = (
    r: Omit<
      MockWorkRecord,
      | "startedAt"
      | "endedAt"
      | "weekStart"
      | "createdAt"
      | "estimatedAmountCents"
      | "amountIsEstimate"
    > & { createdAt: string },
  ): MockWorkRecord => {
    const monday = mondayOf(dayOf(r.dateFrom));
    // Derived here, exactly as the server derives it, so a seed row cannot
    // state an amount that contradicts its own quantity and price. A settled
    // record is worth what it froze; an unsettled weekly-price one is worth
    // its quantity at that week's price.
    const weekPrice =
      weekPrices.find((p) => p.weekStart === monday)?.priceCents ?? 80000; // La Esperanza's standing price, seeded above
    const settledOrFrozen = r.amountCents;
    return {
      ...r,
      startedAt: noonInstant(dayOf(r.dateFrom)),
      endedAt: r.dateTo === r.dateFrom ? null : noonInstant(dayOf(r.dateTo)),
      weekStart: dayInstant(monday),
      estimatedAmountCents:
        settledOrFrozen ?? Math.round(Number(r.quantity) * weekPrice),
      amountIsEstimate: settledOrFrozen === null,
    };
  };

  const workRecords: MockWorkRecord[] = [
    record({
      id: "0192f3a0-0008-7000-8000-000000000001",
      workerId: workers[0].id,
      activityId: activities[0].id,
      payScheme: "unidad_trabajo",
      rateSource: "weekly_price",
      dateFrom: dayInstant("2026-08-27"),
      dateTo: dayInstant("2026-08-27"),
      quantity: 38.5,
      unitId: workUnits[0].id,
      rateCents: null,
      amountCents: null,
      note: null,
      createdBy: WEIGHER,
      createdAt: "2026-08-27T22:15:00Z",
      deletedAt: null,
      plotIds: [plots[0].id],
      plotCropIds: [plots[0].crops[0].id],
    }),
    record({
      id: "0192f3a0-0008-7000-8000-000000000002",
      workerId: workers[0].id,
      activityId: activities[0].id,
      payScheme: "unidad_trabajo",
      rateSource: "weekly_price",
      dateFrom: dayInstant("2026-08-26"),
      dateTo: dayInstant("2026-08-26"),
      quantity: 41,
      unitId: workUnits[0].id,
      rateCents: null,
      amountCents: null,
      note: null,
      createdBy: WEIGHER,
      createdAt: "2026-08-26T22:20:00Z",
      deletedAt: null,
      plotIds: [plots[0].id],
      plotCropIds: [plots[0].crops[0].id],
    }),
    record({
      id: "0192f3a0-0008-7000-8000-000000000003",
      workerId: workers[0].id,
      activityId: activities[1].id,
      payScheme: "tiempo",
      rateSource: "explicit",
      dateFrom: dayInstant("2026-08-24"),
      dateTo: dayInstant("2026-08-25"),
      quantity: 2,
      unitId: null,
      rateCents: 4500000,
      amountCents: 9000000,
      note: "Guadañada del lote completo.",
      createdBy: ADMIN,
      createdAt: "2026-08-25T23:00:00Z",
      deletedAt: null,
      plotIds: [plots[1].id],
      plotCropIds: [plots[1].crops[0].id],
    }),
    record({
      id: "0192f3a0-0008-7000-8000-000000000004",
      workerId: workers[1].id,
      activityId: activities[0].id,
      payScheme: "unidad_trabajo",
      rateSource: "weekly_price",
      dateFrom: dayInstant("2026-08-27"),
      dateTo: dayInstant("2026-08-27"),
      quantity: 52.3,
      unitId: workUnits[0].id,
      rateCents: null,
      amountCents: null,
      note: null,
      createdBy: WEIGHER,
      createdAt: "2026-08-27T22:18:00Z",
      deletedAt: null,
      plotIds: [plots[0].id],
      plotCropIds: [plots[0].crops[1].id],
    }),
    record({
      id: "0192f3a0-0008-7000-8000-000000000005",
      workerId: workers[2].id,
      activityId: activities[5].id,
      payScheme: "unidad_trabajo",
      rateSource: "activity_dated",
      dateFrom: dayInstant("2026-08-26"),
      dateTo: dayInstant("2026-08-26"),
      quantity: 14,
      unitId: workUnits[1].id,
      rateCents: 350000,
      amountCents: 4900000,
      note: null,
      createdBy: ADMIN,
      createdAt: "2026-08-26T23:05:00Z",
      deletedAt: null,
      plotIds: [plots[2].id],
      plotCropIds: [plots[2].crops[0].id],
    }),
    record({
      // Already inside a live settlement, so `settled` derives true and both
      // deleting it and settling it again are 409s.
      id: "0192f3a0-0008-7000-8000-000000000006",
      workerId: workers[3].id,
      activityId: activities[2].id,
      payScheme: "tiempo",
      rateSource: "explicit",
      dateFrom: dayInstant("2026-08-20"),
      dateTo: dayInstant("2026-08-22"),
      quantity: 3,
      unitId: null,
      rateCents: 5000000,
      amountCents: 15000000,
      note: null,
      createdBy: OWNER,
      createdAt: "2026-08-22T23:30:00Z",
      deletedAt: null,
      plotIds: [plots[1].id, plots[2].id],
      plotCropIds: [plots[1].crops[0].id, plots[2].crops[0].id],
    }),
  ];

  /* -- settlements -- */

  const SETTLEMENT_ID = "0192f3a0-000b-7000-8000-000000000001";
  const settlements: MockSettlement[] = [
    {
      id: SETTLEMENT_ID,
      workerId: workers[3].id,
      // The period starts at the Monday of the earliest payable taken in, not
      // at whatever window the caller asked over.
      periodStart: dayInstant("2026-08-17"),
      periodEnd: dayInstant("2026-08-22"),
      grossCents: 15000000,
      status: "open",
      note: null,
      createdAt: "2026-08-22T23:45:00Z",
      voidedAt: null,
      items: [
        {
          payableId: workRecords[5].id,
          weekStart: dayInstant("2026-08-17"),
          quantity: 3,
          rateCents: 5000000,
          amountCents: 15000000,
          voidedAt: null,
        },
      ],
    },
  ];

  /* -- ledger -- */

  /**
   * Signs follow `balanceSQL`: devengo positive; pago, anticipo and deduccion
   * negative; reverso carries the opposite sign of what it cancels. The
   * balance is SUM(amountCents) and nothing else.
   *
   * María's six rows add up to $184.500, which is the figure in the wireframe.
   *
   * There is no `concept` column and no receipt number on the wire: what a
   * movement means is `kind` plus `note`, and the adapter composes the
   * sentence. The old mock's "Efectivo · recibo #0041" was a field the server
   * has never had.
   */
  const ledger: WireLedgerEntry[] = [
    {
      id: "0192f3a0-0009-7000-8000-000000000001",
      workerId: workers[0].id,
      kind: "devengo",
      amountCents: 25300000,
      date: dayInstant("2026-08-11"),
      // The settlements these two devengos came from are older than the seed
      // window, so there is no row here to point at.
      settlementId: null,
      method: null,
      note: "Liquidación 11–16 ago",
      reversesId: null,
      createdAt: "2026-08-11T23:00:00Z",
    },
    {
      id: "0192f3a0-0009-7000-8000-000000000002",
      workerId: workers[0].id,
      kind: "reverso",
      amountCents: 1200000,
      date: dayInstant("2026-08-18"),
      settlementId: null,
      method: null,
      note: "Corrige pago #0038",
      reversesId: "0192f3a0-0009-7000-8000-0000000000ff",
      createdAt: "2026-08-18T15:00:00Z",
    },
    {
      id: "0192f3a0-0009-7000-8000-000000000003",
      workerId: workers[0].id,
      kind: "anticipo",
      amountCents: -5000000,
      date: dayInstant("2026-08-19"),
      settlementId: null,
      method: "efectivo",
      note: "Anticipo para transporte",
      reversesId: null,
      createdAt: "2026-08-19T15:30:00Z",
    },
    {
      id: "0192f3a0-0009-7000-8000-000000000004",
      workerId: workers[0].id,
      kind: "deduccion",
      amountCents: -4500000,
      date: dayInstant("2026-08-20"),
      settlementId: null,
      method: null,
      note: "Mercado adelantado",
      reversesId: null,
      createdAt: "2026-08-20T15:30:00Z",
    },
    {
      id: "0192f3a0-0009-7000-8000-000000000005",
      workerId: workers[0].id,
      kind: "devengo",
      amountCents: 21450000,
      date: dayInstant("2026-08-23"),
      settlementId: null,
      method: null,
      note: "Liquidación 18–23 ago",
      reversesId: null,
      createdAt: "2026-08-23T23:00:00Z",
    },
    {
      id: "0192f3a0-0009-7000-8000-000000000006",
      workerId: workers[0].id,
      kind: "pago",
      amountCents: -20000000,
      date: dayInstant("2026-08-23"),
      settlementId: null,
      method: "efectivo",
      note: null,
      reversesId: null,
      createdAt: "2026-08-23T23:10:00Z",
    },
    {
      id: "0192f3a0-0009-7000-8000-000000000007",
      workerId: workers[1].id,
      kind: "devengo",
      amountCents: 18700000,
      date: dayInstant("2026-08-23"),
      settlementId: null,
      method: null,
      note: "Liquidación 18–23 ago",
      reversesId: null,
      createdAt: "2026-08-23T23:00:00Z",
    },
    {
      id: "0192f3a0-0009-7000-8000-000000000008",
      workerId: workers[1].id,
      kind: "pago",
      amountCents: -18700000,
      date: dayInstant("2026-08-23"),
      settlementId: null,
      method: "transferencia",
      note: null,
      reversesId: null,
      createdAt: "2026-08-23T23:12:00Z",
    },
    {
      // The one devengo with a settlement behind it in the seed.
      id: "0192f3a0-0009-7000-8000-000000000009",
      workerId: workers[3].id,
      kind: "devengo",
      amountCents: 15000000,
      date: dayInstant("2026-08-22"),
      settlementId: SETTLEMENT_ID,
      method: null,
      note: null,
      reversesId: null,
      createdAt: "2026-08-22T23:45:00Z",
    },
  ];

  /**
   * A person's private file. Append-only by design: there is no PATCH and no
   * DELETE on a note, because one that can be rewritten afterwards is not a
   * record of anything. `text` on the wire, and `date` is the day the note is
   * ABOUT, which is not necessarily when it was written.
   */
  const notes: WireNote[] = [
    {
      id: "0192f3a0-000a-7000-8000-000000000001",
      workerId: workers[0].id,
      date: dayInstant("2026-08-21"),
      text: "Pidió adelanto para transporte. Autorizado.",
      createdBy: ADMIN,
      createdAt: "2026-08-21T16:00:00Z",
    },
    {
      id: "0192f3a0-000a-7000-8000-000000000002",
      workerId: workers[0].id,
      date: dayInstant("2026-07-03"),
      text: "Excelente rendimiento en el lote El Alto.",
      createdBy: OWNER,
      createdAt: "2026-07-03T16:00:00Z",
    },
  ];

  /* -- productos, bodegas e inventario (RSP-018 … RSP-025) -- */

  /**
   * The catalogues RSP-019 puts behind an "add it if it is not there" button.
   *
   * `storage_units` carries a single `name` and NOT the `code`+`label` pair
   * `docs/modelo-datos.md` gave it. Migration 00009 says why in as many words:
   * `work_units` needs two identifiers because it also carries `kg_factor`,
   * and a factor is what makes one farm's "canasta" comparable with another's.
   * A storage unit converts to nothing and is only ever shown in a picker.
   */
  const productCategories: WireCatalogItem[] = [
    { id: "0192f3a0-000e-7000-8000-000000000001", name: "Materia prima" },
    { id: "0192f3a0-000e-7000-8000-000000000002", name: "Producto procesado" },
  ];

  const storageUnits: WireCatalogItem[] = [
    { id: "0192f3a0-000f-7000-8000-000000000001", name: "Bulto" },
    { id: "0192f3a0-000f-7000-8000-000000000002", name: "Kilo" },
    { id: "0192f3a0-000f-7000-8000-000000000003", name: "Caja" },
  ];

  const warehouses: WireCatalogItem[] = [
    { id: "0192f3a0-0010-7000-8000-000000000001", name: "Bodega principal" },
    { id: "0192f3a0-0010-7000-8000-000000000002", name: "Beneficiadero" },
  ];

  /**
   * Not one `stock` field among them. What each product has on the shelf is
   * `productStock()` over the movements below, and the two are only ever equal
   * because there is nothing else for them to be.
   */
  const products: MockProduct[] = [
    {
      id: "0192f3a0-0011-7000-8000-000000000001",
      name: "Café pergamino seco",
      categoryId: productCategories[1].id,
      storageUnitId: storageUnits[0].id,
      note: "Listo para venta a la cooperativa.",
      createdAt: "2026-02-01T14:00:00Z",
      deletedAt: null,
    },
    {
      id: "0192f3a0-0011-7000-8000-000000000002",
      name: "Café cereza",
      categoryId: productCategories[0].id,
      storageUnitId: storageUnits[1].id,
      note: null,
      createdAt: "2026-02-01T14:01:00Z",
      deletedAt: null,
    },
    {
      id: "0192f3a0-0011-7000-8000-000000000003",
      name: "Abono compuesto",
      categoryId: productCategories[0].id,
      storageUnitId: storageUnits[0].id,
      note: null,
      createdAt: "2026-02-01T14:02:00Z",
      deletedAt: null,
    },
    {
      id: "0192f3a0-0011-7000-8000-000000000004",
      name: "Fungicida",
      categoryId: productCategories[0].id,
      storageUnitId: storageUnits[2].id,
      note: null,
      createdAt: "2026-02-01T14:03:00Z",
      deletedAt: null,
    },
    {
      // Out of the catalogue (RSP-021) and therefore out of the pickers. Its
      // movements, if it had any, would stay exactly where they are: taking a
      // product out of service does not un-harvest last week's coffee.
      id: "0192f3a0-0011-7000-8000-000000000005",
      name: "Café pasilla",
      categoryId: productCategories[1].id,
      storageUnitId: storageUnits[0].id,
      note: null,
      createdAt: "2026-02-01T14:04:00Z",
      deletedAt: "2026-07-15T15:00:00Z",
    },
  ];

  const MAIN_STORE = warehouses[0].id;
  const WET_MILL = warehouses[1].id;
  const PERGAMINO = products[0].id;
  const CEREZA = products[1].id;
  const ABONO = products[2].id;
  const FUNGICIDA = products[3].id;

  const SALE_ID = "0192f3a0-0014-7000-8000-000000000001";
  const VOIDED_SALE_ID = "0192f3a0-0014-7000-8000-000000000002";

  /**
   * A fortnight of the warehouse, as facts.
   *
   *   Café cereza     1200 + 860 − 2000  =   60 kg      (Beneficiadero)
   *   Café pergamino     40 − 12 − 5 + 5 =   28 bultos  (Bodega principal)
   *   Abono              25 −  8 − 1     =   16 bultos  (Bodega principal)
   *   Fungicida           6              =    6 cajas   (Bodega principal)
   *
   * Those four totals are not written anywhere. They are what
   * `productStock()` computes from these rows, and the contract test asserts
   * them against this arithmetic rather than against a constant, so that a
   * seventh movement added here cannot leave a stale figure behind.
   *
   * The signs obey `stock_sign` because Postgres would refuse them otherwise:
   * cosecha and compra in, consumo and merma out, ajuste free — which is what
   * lets the reversal of an outgoing movement be positive without lying about
   * why it exists.
   */
  const stockMoves: MockStockMove[] = [
    {
      id: "0192f3a0-0012-7000-8000-000000000001",
      productId: CEREZA,
      warehouseId: WET_MILL,
      plotId: plots[0].id,
      plotCropId: plots[0].crops[0].id,
      qty: 1200,
      reason: "cosecha",
      note: "Pase del 18",
      workRecordId: null,
      saleId: null,
      reversesId: null,
      localDay: dayInstant("2026-08-18"),
      createdBy: ADMIN,
      createdAt: "2026-08-18T23:10:00Z",
    },
    {
      id: "0192f3a0-0012-7000-8000-000000000002",
      productId: CEREZA,
      warehouseId: WET_MILL,
      plotId: plots[1].id,
      plotCropId: plots[1].crops[0].id,
      qty: 860,
      reason: "cosecha",
      note: null,
      workRecordId: null,
      saleId: null,
      reversesId: null,
      localDay: dayInstant("2026-08-20"),
      createdBy: ADMIN,
      createdAt: "2026-08-20T23:05:00Z",
    },
    {
      // Into the dryer. It leaves as cereza and comes back as pergamino, which
      // is two movements and not one "conversion": the pair of facts is what a
      // person can check, and a single row saying "transformed" is not.
      id: "0192f3a0-0012-7000-8000-000000000003",
      productId: CEREZA,
      warehouseId: WET_MILL,
      plotId: null,
      plotCropId: null,
      qty: -2000,
      reason: "consumo",
      note: "Al secado",
      workRecordId: null,
      saleId: null,
      reversesId: null,
      localDay: dayInstant("2026-08-21"),
      createdBy: ADMIN,
      createdAt: "2026-08-21T22:00:00Z",
    },
    {
      id: "0192f3a0-0012-7000-8000-000000000004",
      productId: PERGAMINO,
      warehouseId: MAIN_STORE,
      plotId: null,
      plotCropId: null,
      qty: 40,
      reason: "cosecha",
      note: "Salida del secado",
      workRecordId: null,
      saleId: null,
      reversesId: null,
      localDay: dayInstant("2026-08-22"),
      createdBy: ADMIN,
      createdAt: "2026-08-22T22:30:00Z",
    },
    {
      id: "0192f3a0-0012-7000-8000-000000000005",
      productId: ABONO,
      warehouseId: MAIN_STORE,
      plotId: null,
      plotCropId: null,
      qty: 25,
      reason: "compra",
      note: "Factura 4471",
      workRecordId: null,
      saleId: null,
      reversesId: null,
      localDay: dayInstant("2026-08-10"),
      createdBy: OWNER,
      createdAt: "2026-08-10T15:00:00Z",
    },
    {
      id: "0192f3a0-0012-7000-8000-000000000006",
      productId: ABONO,
      warehouseId: MAIN_STORE,
      plotId: plots[0].id,
      plotCropId: plots[0].crops[0].id,
      qty: -8,
      reason: "consumo",
      note: "Fertilización El Alto",
      workRecordId: null,
      saleId: null,
      reversesId: null,
      localDay: dayInstant("2026-08-14"),
      createdBy: ADMIN,
      createdAt: "2026-08-14T16:00:00Z",
    },
    {
      id: "0192f3a0-0012-7000-8000-000000000007",
      productId: ABONO,
      warehouseId: MAIN_STORE,
      plotId: null,
      plotCropId: null,
      qty: -1,
      reason: "merma",
      note: "Bulto roto en la bodega",
      workRecordId: null,
      saleId: null,
      reversesId: null,
      localDay: dayInstant("2026-08-15"),
      createdBy: ADMIN,
      createdAt: "2026-08-15T16:20:00Z",
    },
    {
      id: "0192f3a0-0012-7000-8000-000000000008",
      productId: FUNGICIDA,
      warehouseId: MAIN_STORE,
      plotId: null,
      plotCropId: null,
      qty: 6,
      reason: "compra",
      note: null,
      workRecordId: null,
      saleId: null,
      reversesId: null,
      localDay: dayInstant("2026-08-05"),
      createdBy: OWNER,
      createdAt: "2026-08-05T15:30:00Z",
    },
    {
      // The shadow of a sale. `stock_venta_has_sale` makes a 'venta' movement
      // without a `saleId` a row Postgres refuses, which is what keeps the
      // sales list and the warehouse from ever disagreeing.
      id: "0192f3a0-0012-7000-8000-000000000009",
      productId: PERGAMINO,
      warehouseId: MAIN_STORE,
      plotId: null,
      plotCropId: null,
      qty: -12,
      reason: "venta",
      note: null,
      workRecordId: null,
      saleId: SALE_ID,
      reversesId: null,
      localDay: dayInstant("2026-08-24"),
      createdBy: OWNER,
      createdAt: "2026-08-24T17:00:00Z",
    },
    {
      id: "0192f3a0-0012-7000-8000-00000000000a",
      productId: PERGAMINO,
      warehouseId: MAIN_STORE,
      plotId: null,
      plotCropId: null,
      qty: -5,
      reason: "venta",
      note: null,
      workRecordId: null,
      saleId: VOIDED_SALE_ID,
      reversesId: null,
      localDay: dayInstant("2026-08-25"),
      createdBy: OWNER,
      createdAt: "2026-08-25T17:00:00Z",
    },
    {
      // The void of that sale. `ajuste` is the reason a correction carries —
      // the only one whose sign is free — and `reversesId` is what says what
      // it really is. Voiding the sale flagged the row AND put the coffee
      // back; flagging alone would have left it sold and gone.
      id: "0192f3a0-0012-7000-8000-00000000000b",
      productId: PERGAMINO,
      warehouseId: MAIN_STORE,
      plotId: null,
      plotCropId: null,
      qty: 5,
      reason: "ajuste",
      note: "void of sale " + VOIDED_SALE_ID,
      workRecordId: null,
      saleId: null,
      reversesId: "0192f3a0-0012-7000-8000-00000000000a",
      localDay: dayInstant("2026-08-26"),
      createdBy: OWNER,
      createdAt: "2026-08-26T14:00:00Z",
    },
  ];

  /** RSP-025: one sticker per bulto, generated and waiting for whatever prints. */
  const labelBatches: MockLabelBatch[] = [
    {
      id: "0192f3a0-0016-7000-8000-000000000001",
      stockMoveId: "0192f3a0-0012-7000-8000-000000000004",
      count: 40,
      printedAt: null,
      createdAt: "2026-08-22T22:31:00Z",
    },
  ];

  /* -- ventas y gastos (RSP-026 … RSP-033) -- */

  const customers: WireCustomer[] = [
    {
      id: "0192f3a0-0013-7000-8000-000000000001",
      name: "Cooperativa de Caficultores de Manizales",
      documentType: "NIT",
      docId: "890801167-3",
      phone: "6068801234",
      createdAt: "2026-02-01T14:10:00Z",
      deletedAt: null,
    },
  ];

  /**
   * $1.200.000 the bulto, twelve bultos: $14.400.000. In cents, because a
   * `double` peso is how you lose a peso per sale and find out in December —
   * migration 00010 refuses RSP-027's "Valor — double" in as many words.
   */
  const sales: MockSale[] = [
    {
      id: SALE_ID,
      productId: PERGAMINO,
      customerId: customers[0].id,
      warehouseId: MAIN_STORE,
      qty: 12,
      amountCents: 1_440_000_00,
      receiptId: null,
      note: "Remisión 1188",
      localDay: dayInstant("2026-08-24"),
      createdBy: OWNER,
      createdAt: "2026-08-24T17:00:00Z",
      voidedAt: null,
    },
    {
      // Recorded against the wrong buyer and voided the next day. A voided
      // sale is never restored and never edited (`sales_void_is_final`): the
      // way back is a new sale, which is why this one is still here.
      id: VOIDED_SALE_ID,
      productId: PERGAMINO,
      customerId: customers[0].id,
      warehouseId: MAIN_STORE,
      qty: 5,
      amountCents: 600_000_00,
      receiptId: null,
      note: "Comprador equivocado",
      localDay: dayInstant("2026-08-25"),
      createdBy: OWNER,
      createdAt: "2026-08-25T17:00:00Z",
      voidedAt: "2026-08-26T14:00:00Z",
    },
  ];

  /**
   * A GASTO IS NOT A DEUDA, and this seed is one of the places that has to
   * keep saying so. Not one of these rows touches `ledger`, and there is no
   * `employeeId` to touch it with: an expense is the farm's own accounting,
   * a debt is a line in one person's file (POST /v1/deductions).
   *
   * Exactly one target each — `expense_target` counts
   * `(activity_id IS NOT NULL) + (COALESCE(plot_id, plot_crop_id) IS NOT NULL)`
   * and demands 1. The live four total $2.200.000.
   */
  const expenses: MockExpense[] = [
    {
      id: "0192f3a0-0015-7000-8000-000000000001",
      concept: "Abono para el lote El Alto",
      amountCents: 1_250_000_00,
      localDay: dayInstant("2026-08-14"),
      activityId: null,
      plotId: plots[0].id,
      plotCropId: plots[0].crops[0].id,
      receiptId: null,
      note: "Ocho bultos del abono comprado el 10",
      createdBy: OWNER,
      createdAt: "2026-08-14T16:05:00Z",
      deletedAt: null,
    },
    {
      id: "0192f3a0-0015-7000-8000-000000000002",
      concept: "Combustible de la guadaña",
      amountCents: 180_000_00,
      localDay: dayInstant("2026-08-12"),
      activityId: activities[1].id,
      plotId: null,
      plotCropId: null,
      receiptId: null,
      note: null,
      createdBy: ADMIN,
      createdAt: "2026-08-12T15:00:00Z",
      deletedAt: null,
    },
    {
      id: "0192f3a0-0015-7000-8000-000000000003",
      concept: "Reparación de la despulpadora",
      amountCents: 420_000_00,
      localDay: dayInstant("2026-08-19"),
      activityId: null,
      plotId: plots[2].id,
      plotCropId: null,
      receiptId: null,
      note: null,
      createdBy: OWNER,
      createdAt: "2026-08-19T18:00:00Z",
      deletedAt: null,
    },
    {
      id: "0192f3a0-0015-7000-8000-000000000004",
      concept: "Análisis de suelos",
      amountCents: 350_000_00,
      localDay: dayInstant("2026-08-08"),
      activityId: activities[2].id,
      plotId: null,
      plotCropId: null,
      receiptId: null,
      note: null,
      createdBy: OWNER,
      createdAt: "2026-08-08T14:00:00Z",
      deletedAt: null,
    },
    {
      // Out of service (RSP-033), so the "Inactivos" filter has something and
      // the total below has one row it must NOT count.
      id: "0192f3a0-0015-7000-8000-000000000005",
      concept: "Alquiler de motobomba",
      amountCents: 95_000_00,
      localDay: dayInstant("2026-07-30"),
      activityId: activities[3].id,
      plotId: null,
      plotCropId: null,
      receiptId: null,
      note: "Registrado dos veces por error",
      createdBy: ADMIN,
      createdAt: "2026-07-30T15:00:00Z",
      deletedAt: "2026-07-31T13:00:00Z",
    },
  ];

  tenants.set(FARM_ID, {
    farmId: FARM_ID,
    workUnits,
    activityCategories: categories,
    cropTypes,
    varieties,
    workers,
    plots,
    activities,
    workRecords,
    weekPrices,
    ledger,
    settlements,
    notes,
    productCategories,
    storageUnits,
    warehouses,
    products,
    stockMoves,
    customers,
    sales,
    expenses,
    labelBatches,
  });
}

resetDb();
