/**
 * The one place the server's vocabulary becomes the screens' vocabulary.
 *
 * Sprint 2 pointed the web at the real `services/api` and found the two halves
 * disagreeing in about thirty places. The disagreements are not arbitrary and
 * mostly the server is right — `docId` really is what the column is called,
 * `unidad_trabajo` really is the farm's word — so the fix was never to rename
 * things server-side. It was to admit there are two vocabularies and to write
 * the translation down once, here, instead of scattering `?? ""` through
 * twenty components.
 *
 * Three kinds of difference live in this file:
 *
 * 1. **Renames and spellings.** `docId` -> `documentNumber`, `admin` ->
 *    `administrator`, `unidad_trabajo` -> `work_unit`. Mechanical.
 *
 * 2. **Absence.** The server has no `status` column on anything: a worker who
 *    left has a `deletedAt` and an activity taken out of use has an
 *    `archivedAt`. It also has no receipt numbers, no worker notes and no farm
 *    trial counter — the mock invented all three. Where the view model asks
 *    for something that does not exist, this file supplies the honest answer
 *    (a `null`, an empty list) and says so in a comment, rather than inventing
 *    a plausible one. A plausible invented value is how a screen ends up
 *    trusted for a figure nobody computes.
 *
 * 3. **Joins.** This is the big one. The server sends ids and no names: a work
 *    record carries `workerId`, `activityId`, `unitId` and `plotIds`, and not
 *    one human-readable string. The mock denormalised everything, so the
 *    tables in `WorkRecordsPage` were reading `record.activityName` off the
 *    wire. That field does not exist and never will — denormalising it would
 *    put the same name in two places and let them drift. So the client joins,
 *    against the reference data (`refs.ts`) it already has to load for its own
 *    pickers. An id with no match resolves to a visible placeholder rather
 *    than an empty cell, because a blank column reads as "no plots" and a "—"
 *    reads as "something is missing", which is the truth.
 *
 * Everything here is a pure function of its inputs. The caching and the
 * fetching live in `refs.ts` and `endpoints.ts`; keeping this file pure is
 * what lets the adapters be unit-tested without a server or a mock.
 */
import type {
  Activity,
  AdminFarm,
  Balance,
  CatalogItem,
  Customer,
  Expense,
  FarmSummary,
  FarmUser,
  FarmUserStatus,
  LabelBatch,
  LedgerEntry,
  MeUser,
  PayableLine,
  Payables,
  PayMode,
  Plot,
  PlotCrop,
  Product,
  RateSource,
  Role,
  Sale,
  StockLevel,
  StockMove,
  WeekPrice,
  Worker,
  WorkerNote,
  WorkRecord,
} from "./types";
import type {
  WireActivity,
  WireAdminFarm,
  WireBalance,
  WireCatalogItem,
  WireEmployee,
  WireFarm,
  WireFarmUser,
  WireLedgerEntry,
  WireMe,
  WireNote,
  WirePayable,
  WirePayables,
  WirePayScheme,
  WireCustomer,
  WireExpense,
  WireLabelBatch,
  WirePlot,
  WirePlotCrop,
  WireProduct,
  WireRateSource,
  WireRole,
  WireSale,
  WireStockLevel,
  WireStockMove,
  WireWeekPrice,
  WireWorkerPublic,
  WireWorkRecord,
} from "./wire";

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/**
 * An instant -> the business day it names.
 *
 * The server sends Postgres `date` columns through Go's `time.Time`, so a
 * plain day arrives as `2026-08-27T00:00:00Z`. Slicing the first ten
 * characters is correct precisely BECAUSE the value is already midnight UTC:
 * it is a date that was never an instant. Parsing it into a `Date` and
 * formatting it back would push it a day earlier for anybody west of
 * Greenwich, which is every user this product has.
 *
 * `lib/dates.ts` has the same rule stated from the other side and explains
 * what it costs when it is got wrong.
 */
export function day(instant: string | null | undefined): string {
  return instant ? instant.slice(0, 10) : "";
}

export function dayOrNull(instant: string | null | undefined): string | null {
  return instant ? instant.slice(0, 10) : null;
}

/**
 * A decimal string -> a number, for display only.
 *
 * Quantities cross the wire as strings (`json.Number`) so that 38.5 kg is not
 * rounded by a float on the way to a peso figure. The moment it is only being
 * printed, a number is fine. It must never make the return trip: see
 * `quantityToWire`.
 */
export function quantityFromWire(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A quantity on its way to the server.
 *
 * It goes as a JSON NUMBER, not a string. The Go request struct types it as
 * `json.Number` and `decode` runs with `UseNumber()`, and unmarshalling a
 * quoted string into a `json.Number` is an error — so `quantity: "38.5"` is a
 * 400 "malformed request body" with no clue as to which field caused it.
 *
 * The rounding is not cosmetic: `0.1 + 0.2` stringifies as
 * `0.30000000000000004`, and the quantity is one of the two factors in
 * `round(quantity x rate)`, which is the farm's money.
 */
export function quantityToWire(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(6));
}

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

/**
 * The server says `admin`; every screen, every route guard and the whole
 * `permissions.ts` matrix say `administrator`. Renaming forty call sites to
 * save this two-line function would be the wrong trade.
 */
export function roleFromWire(role: WireRole): Role {
  return role === "admin" ? "administrator" : role;
}

export function roleToWire(role: Role): WireRole {
  return role === "administrator" ? "admin" : role;
}

const PAY_MODE: Record<WirePayScheme, PayMode> = {
  contrato: "contract",
  tiempo: "time_unit",
  unidad_trabajo: "work_unit",
};

const PAY_SCHEME: Record<PayMode, WirePayScheme> = {
  contract: "contrato",
  time_unit: "tiempo",
  work_unit: "unidad_trabajo",
};

export const payModeFromWire = (s: WirePayScheme): PayMode => PAY_MODE[s] ?? "work_unit";
export const payModeToWire = (m: PayMode): WirePayScheme => PAY_SCHEME[m] ?? "unidad_trabajo";

/**
 * The server has three rate sources and the interface has two, and that is
 * correct rather than lossy.
 *
 * `explicit` and `activity_dated` differ in WHERE the frozen number came from,
 * which matters to the server and to nobody looking at a screen: both mean
 * "this price is already decided". `weekly_price` is the one the user has to
 * know about, because it means the figure on screen is provisional until the
 * week is priced. So the interface collapses the first two into "fixed" and
 * keeps the distinction that changes what a person should believe.
 */
export function rateSourceFromWire(s: WireRateSource): RateSource {
  return s === "weekly_price" ? "weekly_price" : "fixed";
}

export function rateSourceToWire(s: RateSource): WireRateSource {
  return s === "weekly_price" ? "weekly_price" : "activity_dated";
}

/** No `status` column exists server-side; absence of a tombstone is the status. */
const statusOf = (deletedAt: string | null | undefined) =>
  deletedAt ? ("inactive" as const) : ("active" as const);

/* ------------------------------------------------------------------ */
/* Reference data for the joins                                        */
/* ------------------------------------------------------------------ */

/**
 * The lookup tables the joins need. `refs.ts` builds and caches one of these;
 * the adapters below only read it, which is what keeps them pure.
 *
 * Every map is allowed to be empty. A weigher, for instance, may not read
 * activity rates, and an unauthenticated caller has no reference data at all;
 * in both cases the adapters must still produce a renderable row.
 */
export interface Refs {
  /** worker id -> "Nombre Apellido" */
  workers: Map<string, string>;
  /** activity id -> the bits a work-record row needs to render */
  activities: Map<string, { name: string; category: string; payMode: PayMode }>;
  /** work-unit id -> "kg" */
  units: Map<string, string>;
  /** plot id -> "Lote 3" */
  plots: Map<string, string>;
  /** plot-crop id -> "Café · Castillo" */
  crops: Map<string, string>;
}

export const EMPTY_REFS: Refs = {
  workers: new Map(),
  activities: new Map(),
  units: new Map(),
  plots: new Map(),
  crops: new Map(),
};

/**
 * What to show for an id whose name we could not resolve.
 *
 * Deliberately not the empty string. A blank cell in the "Lotes" column reads
 * as "this labour was not tied to a plot", which is a different and
 * comfortable fact; "—" reads as "the name is missing", which is what actually
 * happened and what somebody should investigate.
 */
const UNRESOLVED = "—";

const namesFor = (ids: string[] | null | undefined, table: Map<string, string>): string[] =>
  (ids ?? []).map((id) => table.get(id) ?? UNRESOLVED);

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

/**
 * `/v1/me` -> the user the shell renders.
 *
 * Three fields of the view model have no server counterpart:
 *
 *   `farm.status`        There is no farm lifecycle on the wire. A farm the
 *                        caller can log into is a farm they may use, so this
 *                        is "active". Suspension is real — the server answers
 *                        403 FARM_SUSPENDED at login and at refresh — but it
 *                        is never a state `/v1/me` reports, because a
 *                        suspended member cannot hold a live token.
 *   `farm.trialDaysLeft` Invented by the mock. There is no trial in the API.
 *   `memberships`        `/v1/me` describes the CURRENT farm only. The list of
 *                        farms exists exactly once, in the 400 the login
 *                        returns when the address belongs to several, and it
 *                        is not readable afterwards.
 */
/**
 * A membership row -> the users screen.
 *
 * Read defensively on purpose. `WireFarmUser` is the one wire type in this
 * codebase transcribed from a design note instead of from a running handler
 * (see its comment), so the route may land with `state` where this expects
 * `status`, or with no `lastLoginAt` at all. Every one of those becomes a
 * visible absence — `"unknown"`, `null` — and never a plausible default:
 * defaulting an unreadable membership to `"active"` would tell an owner that
 * somebody can log in when nobody here knows whether they can.
 */
export function toFarmUser(w: WireFarmUser): FarmUser {
  const status = String(w.status ?? "").toLowerCase();
  return {
    id: w.id,
    email: w.email ?? "",
    name: w.name ?? "",
    role: roleFromWire(w.role),
    status:
      status === "invited" || status === "active" || status === "revoked"
        ? (status as FarmUserStatus)
        : "unknown",
    lastLoginAt: w.lastLoginAt ?? null,
    createdAt: w.createdAt ?? null,
  };
}

export function toMeUser(w: WireMe): MeUser {
  return {
    id: w.id,
    email: w.email,
    name: w.name,
    role: roleFromWire(w.role),
    isSuperAdmin: w.superadmin,
    farm: {
      id: w.farm.id,
      name: w.farm.name,
      timezone: w.farm.timezone,
      currency: w.farm.currency,
      status: "active",
      trialDaysLeft: null,
    },
    memberships: [],
  };
}

/* ------------------------------------------------------------------ */
/* Workers                                                             */
/* ------------------------------------------------------------------ */

/**
 * The weigher's four-field row is not a broken worker; it is a different one,
 * and it is told apart by a key being ABSENT rather than null.
 *
 * `WireEmployee` is a structural superset of `WireWorkerPublic`, so a `w is`
 * type predicate collapses the union to `never` in the else branch. Hence the
 * cast: the narrowing is a runtime fact about which projection the server
 * chose, which the type system cannot see from the shapes alone.
 */
function isNarrowWorker(w: WireEmployee | WireWorkerPublic): boolean {
  return !("docId" in w);
}

export function toWorker(input: WireEmployee | WireWorkerPublic): Worker {
  if (isNarrowWorker(input)) {
    const w = input as WireWorkerPublic;
    // Everything the weigher is not allowed to see comes back empty rather
    // than absent, so the table renders one shape and the *server* stays the
    // thing that decides what a weigher may know.
    return {
      id: w.id,
      name: w.name,
      lastName: w.lastName ?? "",
      documentType: "CC",
      documentNumber: "",
      phone: null,
      address: null,
      city: null,
      country: null,
      photoUrl: null,
      startedAt: null,
      status: "active",
      tag: w.tag,
    };
  }
  const w = input as WireEmployee;
  return {
    id: w.id,
    name: w.name,
    lastName: w.lastName ?? "",
    // The column is a free-text `document_type`, not an enum. The view type
    // narrows it for the picker; anything unexpected falls back to CC rather
    // than blanking the field.
    documentType: (w.documentType as Worker["documentType"]) ?? "CC",
    documentNumber: w.docId ?? "",
    phone: w.phone,
    address: w.address,
    city: w.city ?? w.municipality,
    country: w.country,
    // `photoId` points into a media store that does not exist yet, so there is
    // no URL to build. Not a placeholder image: the avatar falls back to the
    // initial, which is honest about there being no photo.
    photoUrl: null,
    // The server records when the ROW was created, which is not when the
    // person started working. Reporting one as the other would put a wrong
    // date on a profile, so this stays null until the API has the field.
    startedAt: null,
    status: statusOf(w.deletedAt),
    tag: w.tag,
  };
}

export function toBalance(b: WireBalance): Balance {
  return {
    workerId: b.workerId,
    earnedCents: b.earnedCents,
    paidCents: b.paidCents,
    deductedCents: b.deductedCents,
    balanceCents: b.balanceCents,
    // `lastMovementOn` is a day, not an instant — the view model used to call
    // it `lastMovementAt` and type it as one.
    lastMovementOn: dayOrNull(b.lastMovementOn),
  };
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

/**
 * What the movement is called on a payslip.
 *
 * There is no `concept` column. A ledger row is a `kind` and an optional
 * `note`, and the sentence is composed here so that the six kinds read the
 * same way everywhere they appear. The note wins when there is one, because
 * somebody typed it about this specific movement.
 */
const KIND_LABEL: Record<string, string> = {
  devengo: "Liquidación de labores",
  pago: "Pago",
  anticipo: "Anticipo",
  deduccion: "Deducción",
  ajuste: "Ajuste",
  reverso: "Reverso",
};

export function toLedgerEntry(e: WireLedgerEntry): LedgerEntry {
  return {
    id: e.id,
    workerId: e.workerId,
    kind: e.kind,
    concept: e.note?.trim() || KIND_LABEL[e.kind] || e.kind,
    amountCents: e.amountCents,
    date: day(e.date),
    method: e.method,
    // The API issues no receipt numbers. The mock did, and the payment screen
    // printed them as though they meant something to an accountant.
    receiptNumber: null,
    reversesId: e.reversesId,
    settlementId: e.settlementId,
  };
}

/* ------------------------------------------------------------------ */
/* Plots                                                               */
/* ------------------------------------------------------------------ */

export function toPlotCrop(c: WirePlotCrop): PlotCrop {
  return {
    id: c.id,
    cropTypeId: c.cropTypeId,
    cropTypeName: c.cropType,
    varietyId: c.varietyId,
    varietyName: c.variety,
    areaHa: c.areaHa,
    plantedAt: dayOrNull(c.plantedOn),
  };
}

export function toPlot(p: WirePlot): Plot {
  return {
    id: p.id,
    name: p.name,
    department: p.department ?? "",
    municipality: p.municipality ?? "",
    areaHa: p.areaHa ?? 0,
    computedAreaHa: p.computedAreaHa,
    // GeoJSON, straight through. Both hectare figures are kept and both are
    // shown: they always disagree slightly, and picking one for the owner is
    // deciding on their behalf which of them is lying.
    boundary: p.boundary ?? null,
    crops: (p.crops ?? []).filter((c) => !c.deletedAt).map(toPlotCrop),
    status: statusOf(p.deletedAt),
  };
}

/** Names for the plot-crop join, as "Café · Castillo". */
export function cropLabel(c: WirePlotCrop): string {
  return c.variety ? `${c.cropType} · ${c.variety}` : c.cropType;
}

/* ------------------------------------------------------------------ */
/* Activities                                                          */
/* ------------------------------------------------------------------ */

export function toActivity(a: WireActivity, refs: Refs = EMPTY_REFS): Activity {
  const rate = a.rate ?? null;
  return {
    id: a.id,
    name: a.name,
    category: a.category,
    payMode: payModeFromWire(a.payScheme),
    workUnit: a.unitId ? (refs.units.get(a.unitId) ?? null) : null,
    // Time unit, custom quantity and custom period live on the RATE, not on
    // the activity: they are part of what a price means ("$50.000 por jornal"),
    // so they change when the price changes and they are absent from the
    // weigher's projection along with it.
    timeUnit: (rate?.timeUnit as Activity["timeUnit"]) ?? null,
    customQty: rate?.customQty ?? null,
    customPeriod: (rate?.customUnit as Activity["customPeriod"]) ?? null,
    rateSource: rateSourceFromWire(a.rateSource),
    // Left UNDEFINED, not zero, when there is no rate — which happens both for
    // the weigher (never allowed to see one) and for anybody asking about a
    // date before the activity had a price. A zero here would render as "$0",
    // which is a claim about the price rather than an absence of one.
    defaultRateCents: rate ? rate.rateCents : undefined,
    status: statusOf(a.archivedAt),
  };
}

/* ------------------------------------------------------------------ */
/* Work records                                                        */
/* ------------------------------------------------------------------ */

/**
 * The join. Every human-readable string on this row is resolved client-side
 * from `refs`; the server sent five ids and a quantity.
 */
export function toWorkRecord(r: WireWorkRecord, refs: Refs = EMPTY_REFS): WorkRecord {
  const activity = refs.activities.get(r.activityId);
  return {
    id: r.id,
    workerId: r.workerId,
    workerName: refs.workers.get(r.workerId) ?? UNRESOLVED,
    activityId: r.activityId,
    activityName: activity?.name ?? UNRESOLVED,
    category: activity?.category ?? "",
    payMode: payModeFromWire(r.payScheme),
    unitLabel: r.unitId ? (refs.units.get(r.unitId) ?? null) : null,
    plotIds: r.plotIds ?? [],
    plotNames: namesFor(r.plotIds, refs.plots),
    plotCropIds: r.plotCropIds ?? [],
    plotCropNames: namesFor(r.plotCropIds, refs.crops),
    dateFrom: day(r.dateFrom),
    dateTo: day(r.dateTo),
    quantity: quantityFromWire(r.quantity),
    rateCents: r.rateCents,
    // The server now always says what a record is worth: the settled amount
    // when there is one, otherwise the quantity at the price in force for its
    // week. `amountCents` stays null for weekly-price work — that is the row's
    // own truth — and reading it here printed $0 against every harvest record,
    // settled ones included, because that price is not chosen until settlement.
    estimatedAmountCents: r.estimatedAmountCents ?? r.amountCents ?? 0,
    /** False once a settlement froze it. See WorkRecordsPage for the badge. */
    amountIsEstimate: r.amountIsEstimate ?? r.rateCents === null,
    note: r.note,
    settled: r.settled,
    status: statusOf(r.deletedAt),
  };
}

/* ------------------------------------------------------------------ */
/* Money                                                               */
/* ------------------------------------------------------------------ */

/**
 * `/v1/workers/{id}/payables` -> the two tables on the payment screen.
 *
 * The one thing to get right here is that `debts` is for DISPLAY ONLY. An
 * `anticipo` or a `deduccion` is a ledger movement the moment it is written,
 * so it has already moved `balanceCents`. The server says so in as many words
 * and computes `totalCents = balanceCents + grossCents` itself. Subtracting
 * the debts again on this side would charge the worker twice for the same
 * debt — the exact class of bug a derived balance exists to prevent, arrived
 * at by being helpful.
 *
 * `plotNames` is empty because a payable is a row of the settlement, not of
 * the work record: it carries the activity and the money, and no plots. The
 * plot list for a piece of work lives on the work record, which the profile
 * screen shows separately.
 */
/**
 * One `WirePayable` -> one `PayableLine`.
 *
 * Shared by the payment screen, the settlement preview and the settlement's
 * own lines, because all three are the same row read at different moments —
 * and `api/grossChange.ts` compares two of those moments. If they were mapped
 * separately, the comparison would be comparing two shapes rather than two
 * facts, and a field added to one and forgotten in the other would show up as
 * a phantom change on the difference screen.
 *
 * `dateFrom` and `dateTo` are both the payable's single date: a payable is one
 * priced row, not a range. The pair exists so the line renders through the
 * same `formatDateRange` as a work record.
 */
export function toPayableLine(refs: Refs): (p: WirePayable) => PayableLine {
  return (p) => ({
    id: p.payableId,
    activityName: p.activity,
    dateFrom: day(p.date),
    dateTo: day(p.date),
    weekStart: day(p.weekStart),
    plotNames: [],
    quantity: quantityFromWire(p.quantity),
    unitLabel: p.unitId ? (refs.units.get(p.unitId) ?? null) : null,
    rateCents: p.rateCents,
    rateSource: rateSourceFromWire(p.rateSource),
    amountCents: p.amountCents,
  });
}

export function toPayables(w: WirePayables, refs: Refs): Payables {
  return {
    workRecords: (w.tasks ?? []).map(toPayableLine(refs)),
    debts: (w.debts ?? []).map((d) => {
      const e = toLedgerEntry(d);
      return { id: e.id, concept: e.concept, date: e.date, amountCents: e.amountCents };
    }),
    grossCents: w.grossCents,
    balanceCents: w.balanceCents,
    totalCents: w.totalCents,
  };
}

export function toNote(n: WireNote): WorkerNote {
  return {
    id: n.id,
    text: n.text,
    date: day(n.date),
    // The server sends `createdBy` as a user id and no name; resolving it
    // would need a users route that does not exist. Left blank rather than
    // showing a UUID where a person's name belongs.
    authorName: "",
  };
}

/**
 * `GET /v1/farm` -> the farm summary the shell shows.
 *
 * `status` is derived from `suspendedAt`, which is the only lifecycle the API
 * has. There is no trial: `trialDaysLeft` was invented by the mock and is
 * always null, rather than a plausible countdown to a date nobody enforces.
 */
export function toFarmSummary(f: WireFarm): FarmSummary {
  return {
    id: f.id,
    name: f.name,
    timezone: f.timezone,
    currency: f.currency,
    status: f.suspendedAt ? "suspended" : "active",
    trialDaysLeft: null,
    // Absent entirely for a weigher, who may not know what a kilo is worth.
    priceCents: f.priceCents ?? null,
    areaHa: f.areaHa,
    city: f.city,
    country: f.country,
    phone: f.phone,
    address: f.address,
  };
}

export function toAdminFarm(f: WireAdminFarm): AdminFarm {
  return {
    id: f.id,
    name: f.name,
    // The console cannot read a farm's users, so there is no owner address to
    // show and no worker count to show. The mock invented both.
    ownerEmail: "",
    status: f.status,
    createdAt: f.createdAt,
    lastAccessAt: null,
    workerCount: null,
    city: f.city,
    country: f.country,
  };
}

export function toWeekPrice(w: WireWeekPrice): WeekPrice {
  return { monday: day(w.weekStart), costPerUnitCents: w.priceCents };
}

export function toCatalogItem(c: WireCatalogItem): CatalogItem {
  return { id: c.id, name: c.name };
}

/* ------------------------------------------------------------------ */
/* Products, inventory, sales and expenses                             */
/* ------------------------------------------------------------------ */

/**
 * The translations here are thinner than the ones above, because these routes
 * were designed after the vocabulary settled: the server already sends the
 * resolved names beside the ids, so there is no `refs.ts` join to do.
 *
 * What still has to happen is the same three things as everywhere else:
 * `deletedAt` becomes a `status`, `localDay` (an RFC 3339 instant at midnight,
 * because Go marshals a `time.Time`) becomes a plain business day, and a
 * server word becomes an interface word — `voidedAt` becomes `voided`,
 * `qty` becomes `quantity` on a sale, `docId` becomes `documentNumber`.
 */

export function toProduct(p: WireProduct): Product {
  return {
    id: p.id,
    name: p.name,
    categoryId: p.categoryId,
    categoryName: p.category,
    storageUnitId: p.storageUnitId,
    storageUnit: p.storageUnit,
    note: p.note,
    // A SUM over the movements, computed by the server on every read. Passed
    // through and never cached, for the same reason it is not a column.
    stock: p.stock ?? 0,
    status: p.deletedAt ? "inactive" : "active",
  };
}

export function toCustomer(c: WireCustomer): Customer {
  return {
    id: c.id,
    name: c.name,
    documentType: c.documentType,
    documentNumber: c.docId,
    phone: c.phone,
    status: c.deletedAt ? "inactive" : "active",
  };
}

export function toStockMove(m: WireStockMove): StockMove {
  return {
    id: m.id,
    productId: m.productId,
    productName: m.product,
    warehouseId: m.warehouseId,
    warehouseName: m.warehouse,
    plotId: m.plotId,
    plotName: m.plot,
    plotCropId: m.plotCropId,
    qty: m.qty,
    reason: m.reason,
    note: m.note,
    saleId: m.saleId,
    reversesId: m.reversesId,
    reversedById: m.reversedById,
    date: day(m.localDay),
    labelBatchId: m.labelBatchId,
  };
}

export function toStockLevel(l: WireStockLevel): StockLevel {
  return {
    productId: l.productId,
    productName: l.product,
    storageUnit: l.storageUnit,
    warehouseId: l.warehouseId,
    warehouseName: l.warehouse,
    qty: l.qty,
  };
}

export function toLabelBatch(b: WireLabelBatch): LabelBatch {
  return {
    id: b.id,
    stockMoveId: b.stockMoveId,
    count: b.count,
    labels: (b.labels ?? []).map((l) => ({
      code: l.code,
      productName: l.product,
      storageUnit: l.storageUnit,
      qty: l.qty,
      warehouseName: l.warehouse,
      plotName: l.plot,
      date: day(l.localDay),
    })),
  };
}

export function toSale(s: WireSale): Sale {
  return {
    id: s.id,
    productId: s.productId,
    productName: s.product,
    storageUnit: s.storageUnit,
    customerId: s.customerId,
    customerName: s.customer,
    warehouseId: s.warehouseId,
    warehouseName: s.warehouse,
    quantity: s.qty,
    amountCents: s.amountCents,
    note: s.note,
    date: day(s.localDay),
    stockMoveId: s.stockMoveId,
    // A voided sale is still a row, and it still shows: it happened, and then
    // it was undone. Hiding it would leave the warehouse's reversal movement
    // pointing at nothing anybody can see.
    voided: s.voidedAt !== null,
  };
}

export function toExpense(e: WireExpense): Expense {
  return {
    id: e.id,
    concept: e.concept,
    amountCents: e.amountCents,
    date: day(e.localDay),
    // Derived server-side from which column is set. Trusted rather than
    // recomputed: the server is the one that knows which of the two the
    // database accepted.
    target: e.target,
    activityId: e.activityId,
    activityName: e.activity,
    plotId: e.plotId,
    plotName: e.plot,
    plotCropId: e.plotCropId,
    cropName: e.crop,
    note: e.note,
    status: e.deletedAt ? "inactive" : "active",
  };
}
