/**
 * The REAL shapes `services/api` puts on the wire. Nothing here is invented.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `types.ts`
 *
 * Sprint 1 built the web against a mock whose shapes came from
 * `docs/arquitectura-api.md`. The server that actually shipped disagrees with
 * that document in a couple of dozen places — Spanish enum values, `docId`
 * instead of `documentNumber`, no denormalised names anywhere, a settlement
 * step the document folded into the payment. Sprint 2's job was to stop
 * pretending otherwise.
 *
 * So there are now two vocabularies and one translation between them:
 *
 *   wire.ts     what the server says          (this file)
 *   adapters.ts wire -> view, in one place
 *   types.ts    what the screens read         (the view models)
 *
 * The screens never import this file. That is deliberate: when a field is
 * renamed server-side, exactly one adapter changes and twenty screens do not.
 *
 * PROVENANCE. Every type below is transcribed from the Go structs, not from
 * the design document:
 *
 *   WireEmployee     internal/store/employees.go   Employee
 *   WirePlot         internal/store/plots.go       Plot, PlotCrop
 *   WireActivity     internal/store/activities.go  Activity, ActivityRate
 *   WireWorkRecord   internal/store/work_records.go WorkRecord
 *   WirePayable      internal/store/money.go       Payable
 *   WireSettlement   internal/store/money.go       Settlement
 *   WireLedgerEntry  internal/store/money.go       LedgerEntry
 *   WireBalance      internal/domain/money.go      Balance
 *   WireSession      internal/httpapi/handlers_auth.go sessionResponse
 *
 * `openapi.yaml` did not exist in `services/api/` when this was written, so
 * these are hand-transcribed rather than generated. The moment that file
 * lands, run
 *
 *     npx openapi-typescript ../../services/api/openapi.yaml -o src/api/wire.ts
 *
 * and delete this header. The rest of the app does not need to know, which was
 * the entire point of routing every field access through `adapters.ts`.
 */

export type Uuid = string;
/** `YYYY-MM-DD`, a business day in the farm's timezone. */
export type DayISO = string;
/** A full ISO 8601 instant with an offset. The server sends these for dates
 *  that are really `date` columns too, so adapters slice, never parse. */
export type Instant = string;

/* -- enums, in the server's own spelling ----------------------------- */

/** `internal/domain/money.go`. Note `admin`, not `administrator`. */
export type WireRole = "owner" | "admin" | "weigher";

/** Spanish, because the values are the farm's words and the column is an enum. */
export type WirePayScheme = "contrato" | "tiempo" | "unidad_trabajo";

/**
 * When the price freezes.
 *   explicit        the caller named it on the work record
 *   activity_dated  the activity's rate in force on the day of the work
 *   weekly_price    left open; resolved when the settlement runs
 */
export type WireRateSource = "explicit" | "activity_dated" | "weekly_price";

export type WireLedgerKind =
  | "devengo"
  | "pago"
  | "anticipo"
  | "deduccion"
  | "ajuste"
  | "reverso";

export type WirePayMethod = "efectivo" | "transferencia" | "otro";

/* -- envelope -------------------------------------------------------- */

/**
 * Every list route answers `{"items": [...]}`. There is no `total` and no
 * pagination on any route in `routes.go`, which is why `Page<T>` in the old
 * types.ts had a `total` nobody could have filled in.
 */
export interface WireList<T> {
  items: T[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/* -- auth ------------------------------------------------------------ */

export interface WireSignupRequest {
  farm: {
    name: string;
    timezone: string;
    currency: string;
    /**
     * The farm's starting price per kilo, in cents. Mandatory and positive:
     * `seedFarm` uses it to price the "Recoleccion" activity it creates, so a
     * farm cannot exist without one.
     */
    priceCents: number;
  };
  owner: { email: string; name: string; password: string };
}

export interface WireSignupResponse {
  farmId: Uuid;
  userId: Uuid;
  verificationRequired: boolean;
  /**
   * Present ONLY when the server runs with `APP_ENV=development`, which is
   * what `DevEcho` gates. There is no mail sender yet, so in development the
   * token comes back in the response and the app can offer to verify in place.
   * In production this is absent and the owner uses the link in the mail.
   */
  verificationToken?: string;
}

/** `POST /v1/auth/login` and `POST /v1/auth/refresh` both answer this. */
export interface WireSession {
  accessToken: string;
  refreshToken: string;
  /** Seconds. 900 today — the access token is short on purpose. */
  expiresIn: number;
  farmId: Uuid;
  farmName: string;
  role: WireRole;
}

/**
 * `GET /v1/me`. Note what is NOT here: no farm status, no trial counter, no
 * membership list. The old view model had all three and the mock invented
 * values for them.
 */
export interface WireMe {
  id: Uuid;
  email: string;
  name: string;
  role: WireRole;
  farm: { id: Uuid; name: string; timezone: string; currency: string };
  superadmin: boolean;
}

/**
 * A membership of this farm: `GET|POST|PATCH /v1/users`.
 *
 * NOT TRANSCRIBED FROM A RUNNING SERVER, and the only type in this file that
 * is not. `routes.go` has no `/v1/users` and `openapi.yaml` has no `User`
 * schema — `docs/casos-de-uso.md` §8 leaves the use case "pendiente de
 * detallar" and `docs/arquitectura-api.md` §329 answers it with "alta de
 * usuario con rol" over those three verbs. This is that shape, and nothing
 * more than that shape: id, who, what role, what state.
 *
 * Consequences of it being a guess, and how they are contained:
 *
 *   - it is NOT asserted against `schema.ts` in `contract.assert.ts`, because
 *     there is nothing in the spec to assert it against, and an assertion
 *     against an invention is theatre;
 *   - every call that uses it goes through `routeMayBeMissing`, so the screen
 *     says "the server does not have this yet" rather than showing an empty
 *     list of users;
 *   - `toFarmUser` reads every field defensively, so a server that lands with
 *     `state` instead of `status` produces a visible "—" and not a crash.
 *
 * When the route lands, this type is what gets corrected against it, and the
 * assertion belongs in `contract.assert.ts` the same day.
 */
export interface WireFarmUser {
  id: Uuid;
  email: string;
  name: string;
  role: WireRole;
  /** `invited` until the address is confirmed; `revoked` closes the door. */
  status?: string | null;
  /**
   * ABSENT AND NULL ARE DIFFERENT FACTS, and this is the field where the
   * difference cost us. `store.ListFarmUsers` does not select a last login at
   * all — the column is not in the query — so the key never arrives. Null
   * would mean "we know, and they have never been in"; absent means "the
   * server does not report this". Rendering the second as the first told the
   * owner, mid-session, that he had never logged in.
   */
  lastLoginAt?: Instant | null;
  createdAt?: Instant | null;
  /**
   * Returned by `POST /v1/users` ONCE and never again — the row keeps only an
   * argon2id hash. There is no mail sender in the service, so this string is
   * the entire invitation: without it the invited person can never log in.
   */
  temporaryPassword?: string | null;
}

/**
 * A login that matched several farms is a 400 whose `details.farms` carries
 * the choice. It is an error envelope, not a success body — the client has to
 * catch it, which is why `LoginChoice` cannot be a union arm of the response.
 */
export interface WireFarmChoice {
  id: Uuid;
  name: string;
  role: WireRole;
}

/* -- the farm -------------------------------------------------------- */

/**
 * `GET /v1/farm` and `PUT /v1/farm`. There is no `/v1/farms/{id}`: the tenant
 * travels in the token, and a farm id in the path invites somebody to trust it.
 *
 * `priceCents` is `omitempty` on the Go side and is DROPPED ENTIRELY from the
 * weigher's projection — that is the standing price of a kilo, and §6 keeps
 * prices away from the scale. A missing key means "you may not see this", not
 * "it is free", which is exactly why the server sends nothing rather than 0.
 */
export interface WireFarm {
  id: Uuid;
  name: string;
  timezone: string;
  currency: string;
  minorUnit: number;
  phone: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  areaHa: number | null;
  suspendedAt: Instant | null;
  createdAt: Instant;
  priceCents?: number;
}

/**
 * `GET /v1/admin/farms`. Every column here is a column of `farms`: the console
 * can see that a farm exists and suspend it, and cannot read an employee, a
 * work record or a peso of anybody's money. The projection IS the enforcement.
 */
export interface WireAdminFarm {
  id: Uuid;
  name: string;
  timezone: string;
  currency: string;
  country: string | null;
  city: string | null;
  status: "active" | "suspended";
  suspendedAt: Instant | null;
  createdAt: Instant;
}

/* -- catalogues ------------------------------------------------------ */

/** crop-types, varieties, activity-categories all share this row. */
export interface WireCatalogItem {
  id: Uuid;
  name: string;
}

/**
 * Work units are their own table: they carry a code and a conversion factor,
 * which the name catalogues do not.
 */
export interface WireWorkUnit {
  id: Uuid;
  code: string;
  label: string;
  kgFactor: number | null;
}

/* -- workers --------------------------------------------------------- */

/**
 * `internal/store/employees.go`. The weigher gets a four-field subset of this
 * ({id, name, lastName, tag}); everybody else gets the whole row. There is no
 * `status` column — a worker who left has a `deletedAt`.
 */
export interface WireEmployee {
  id: Uuid;
  name: string;
  lastName: string | null;
  documentType: string | null;
  /** The identity document number. Called `documentNumber` in the old mock. */
  docId: string | null;
  /** The number painted on the worker's basket, for the scale. */
  tag: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  municipality: string | null;
  country: string | null;
  /** An id into a media store that does not exist yet. Never a URL. */
  photoId: string | null;
  createdAt?: Instant;
  deletedAt?: Instant | null;
}

/** The weigher's projection. Same route, fewer fields. */
export interface WireWorkerPublic {
  id: Uuid;
  name: string;
  lastName: string | null;
  tag: string | null;
}

/** `GET /v1/workers/{id}/profile`. Note `tasks`, not `workRecords`. */
export interface WireWorkerProfile {
  worker: WireEmployee;
  balance: WireBalance;
  ledger: WireLedgerEntry[];
  tasks: WireWorkRecord[];
  notes: WireNote[];
}

/**
 * A note about a worker. Append-only by design: there is no PATCH and no
 * DELETE on one, because a note that can be rewritten afterwards is not a
 * record of anything.
 *
 * `text` on the wire, `body` in the column; `date` is the day it is ABOUT,
 * which is not necessarily `createdAt`.
 */
export interface WireNote {
  id: Uuid;
  workerId: Uuid;
  date: Instant;
  text: string;
  createdBy: Uuid | null;
  createdAt: Instant;
}

/**
 * `GET /v1/workers/{id}/payables` — the whole payment screen in one call, and
 * with no range it means "everything outstanding", which is the question the
 * owner is actually asking.
 *
 * The arithmetic is spelled out on the server and must not be redone here:
 *
 *   grossCents    the unsettled work in `tasks`
 *   balanceCents  what the ledger already says, advances and deductions INSIDE
 *   totalCents    their sum — what the farm would owe if all of it settled now
 *
 * `debts` is a view of ledger rows that are already inside `balanceCents`. It
 * is there to be SHOWN, never to be subtracted: taking it off again charges
 * the worker twice for the same debt.
 */
export interface WirePayables {
  workerId: Uuid;
  tasks: WirePayable[];
  debts: WireLedgerEntry[];
  balance: WireBalance;
  grossCents: number;
  balanceCents: number;
  totalCents: number;
}

/* -- plots ----------------------------------------------------------- */

export interface WirePlotCrop {
  id: Uuid;
  plotId: Uuid;
  cropTypeId: Uuid;
  /** The resolved name. The server sends both the id and the name. */
  cropType: string;
  varietyId: Uuid | null;
  variety: string | null;
  areaHa: number | null;
  plantedOn: Instant | null;
  removedOn: Instant | null;
  deletedAt: Instant | null;
}

export interface WirePlot {
  id: Uuid;
  name: string;
  /** What the owner declared. Nullable — the old view model made it required. */
  areaHa: number | null;
  /** What PostGIS measured of the drawn polygon. Null until one is drawn. */
  computedAreaHa: number | null;
  department: string | null;
  municipality: string | null;
  /**
   * GeoJSON geometry, or null until one is drawn. GeoJSON in and GeoJSON out
   * is deliberate: no PostGIS type ever crosses the wire, so the web and the
   * phone never learn the storage engine and swapping it stays possible.
   */
  boundary: unknown | null;
  createdAt: Instant;
  deletedAt: Instant | null;
  crops: WirePlotCrop[];
}

/**
 * What `handleSetPlotBoundary` writes: the plot, and the lots it now touches.
 *
 * The plot in here carries no crops — the UPDATE returns the plot's own
 * columns and the handler does not re-join `plot_crops`.
 */
export interface WireBoundaryResult {
  plot: WirePlot;
  overlaps: WireCatalogItem[];
}

/* -- activities ------------------------------------------------------ */

export interface WireActivityRate {
  validFrom: Instant;
  rateCents: number;
  /**
   * NARROWED TO THE CONTRACT'S ENUM, which `contract.assert.ts` found this
   * file had widened to a bare string. Note the last member: the server says
   * `personalizado` and the interface says `custom` — `toActivity` is where
   * the two meet, and typing this as `string` is what let that mapping be
   * wrong without anything noticing.
   */
  timeUnit: "jornal" | "semanal" | "quincenal" | "mensual" | "personalizado" | null;
  customQty: number | null;
  customUnit: string | null;
}

export interface WireActivity {
  id: Uuid;
  name: string;
  categoryId: Uuid;
  /** The resolved category name. Not an enum: it is a per-farm catalogue. */
  category: string;
  payScheme: WirePayScheme;
  rateSource: WireRateSource;
  unitId: Uuid | null;
  archivedAt: Instant | null;
  /**
   * Absent entirely from the weigher's projection, and absent for everybody
   * when no rate is in force on the requested date. Never assume it is there.
   */
  rate?: WireActivityRate | null;
}

/* -- work records ---------------------------------------------------- */

/**
 * `internal/store/work_records.go`. The thing to notice is everything that is
 * NOT here: no worker name, no activity name, no plot names, no unit label.
 * The server sends ids and the client joins. `adapters.ts` does that join
 * against the reference data it already had to load for the pickers.
 */
export interface WireWorkRecord {
  id: Uuid;
  workerId: Uuid;
  activityId: Uuid;
  payScheme: WirePayScheme;
  rateSource: WireRateSource;
  startedAt: Instant;
  endedAt: Instant | null;
  dateFrom: Instant;
  dateTo: Instant;
  weekStart: Instant;
  /**
   * `json.Number` on the Go side, which marshals as a BARE JSON NUMBER — it is
   * the decimal literal verbatim, not a quoted string. Typed loosely here
   * because the server preserves whatever text the column held ("38.5",
   * "38.50"), and `quantityFromWire` accepts either.
   *
   * It matters in the other direction too: `decode` runs with `UseNumber`, and
   * unmarshalling a JSON *string* into a `json.Number` is an error. So a
   * request must send `quantity: 38.5`, never `quantity: "38.5"`. That is one
   * of the two shape bugs that made the first real POST fail.
   */
  quantity: number | string;
  unitId: Uuid | null;
  /** Null while the price is still open (weekly_price, until settlement). */
  rateCents: number | null;
  amountCents: number | null;
  /**
   * What the record is worth, always a number. `amountCents` is the row's own
   * truth and stays null for weekly-price work; rendering that null printed $0
   * against every harvest record the console listed, settled ones included.
   */
  estimatedAmountCents: number;
  /** False once a settlement froze the amount, true while it is still derived. */
  amountIsEstimate: boolean;
  note: string | null;
  createdBy: Uuid | null;
  createdAt: Instant;
  deletedAt: Instant | null;
  plotIds: Uuid[];
  plotCropIds: Uuid[];
  /** True once a live settlement has claimed it. Editing is then refused. */
  settled: boolean;
}

export interface WireWorkRecordRequest {
  id: Uuid;
  activityId: Uuid;
  workerId: Uuid;
  /** A JSON number. See the note on `WireWorkRecord.quantity`. */
  quantity: number;
  rateCents?: number | null;
  dateFrom: DayISO;
  dateTo?: DayISO;
  plotIds?: Uuid[];
  plotCropIds?: Uuid[];
  note?: string | null;
}

/* -- money ----------------------------------------------------------- */

/**
 * One line of what is owed. `payableId` is the work record's id — the two are
 * the same row seen from the settlement's side.
 */
export interface WirePayable {
  payableId: Uuid;
  activityId: Uuid;
  /** JSON key is `activity`, not `activityName`. */
  activity: string;
  payScheme: WirePayScheme;
  rateSource: WireRateSource;
  quantity: number | string;
  unitId: Uuid | null;
  date: Instant;
  weekStart: Instant;
  /** Resolved here even when the record itself has no frozen price. */
  rateCents: number;
  amountCents: number;
  voided: boolean;
}

/** `GET /v1/pending?workerId&from&to`. `from` and `to` are both mandatory. */
export interface WirePending {
  workerId: Uuid;
  from: Instant;
  to: Instant;
  items: WirePayable[];
  totalCents: number;
}

/** `POST /v1/settlements/preview`. Same code path as the real settlement. */
export interface WireSettlementPreview {
  workerId: Uuid;
  from: Instant;
  to: Instant;
  items: WirePayable[];
  grossCents: number;
  balance: WireBalance;
}

export interface WireSettlement {
  id: Uuid;
  workerId: Uuid;
  periodStart: Instant;
  periodEnd: Instant;
  grossCents: number;
  status: string;
  note: string | null;
  createdAt: Instant;
  voidedAt: Instant | null;
  /**
   * ALWAYS EMPTY on `GET /v1/settlements` — the spec says so in as many words
   * — and full only on `GET /v1/settlements/{id}`. Counting this array to get
   * "how many lines" therefore printed LÍNEAS: 0 on every row of the list.
   */
  items: WirePayable[];
  /**
   * How many LIVE lines the settlement has, sent on the list route. It is not
   * `items.length` and it is not the same thing either: a voided settlement
   * keeps its line rows, and this counts the ones that still stand.
   */
  itemCount?: number;
  /**
   * Joined in by the list route so thirty settlements are not thirty more
   * requests. Absent on the detail route.
   */
  workerName?: string;
}

/**
 * `internal/domain/money.go`. Positive means the farm owes the worker.
 * Note `lastMovementOn` (a day) — the old view model called it
 * `lastMovementAt` and typed it as an instant.
 */
export interface WireBalance {
  workerId: Uuid;
  earnedCents: number;
  paidCents: number;
  deductedCents: number;
  /** Derived from the ledger on every read. Never a stored total. */
  balanceCents: number;
  lastMovementOn: Instant | null;
  /**
   * False for somebody no longer on the payroll.
   *
   * They stay on `GET /v1/balances` while they still have movements, which is
   * the point of the field: dropping a deactivated worker who is still owed
   * money would make the debt disappear from the only screen anybody looks at
   * while it sat untouched in the ledger. The spec is explicit that the caller
   * renders the difference rather than guessing at an absence.
   */
  active: boolean;
}

/**
 * A ledger row. There is no `concept` column and no receipt number: what a
 * movement means is `kind` plus `note`, and the adapter composes the sentence.
 */
export interface WireLedgerEntry {
  id: Uuid;
  workerId: Uuid;
  kind: WireLedgerKind;
  /** SIGNED. `devengo` positive; `pago`, `anticipo`, `deduccion` negative. */
  amountCents: number;
  date: Instant;
  settlementId: Uuid | null;
  method: WirePayMethod | null;
  note: string | null;
  reversesId: Uuid | null;
  createdAt: Instant;
}

/**
 * The body for `/v1/payments`, `/v1/advances`, `/v1/deductions`,
 * `/v1/adjustments`. `amountCents` is POSITIVE — the server applies the sign,
 * and the database rejects the wrong one.
 */
export interface WireLedgerRequest {
  id: Uuid;
  workerId: Uuid;
  amountCents: number;
  method?: WirePayMethod | null;
  note?: string | null;
  date?: DayISO;
  /**
   * Pay more than is owed on purpose. Without it the server answers 409
   * AMOUNT_EXCEEDS_BALANCE, which is the guard against a typo on the payment
   * screen. The web never sets this: it offers the excess as an `anticipo`
   * instead, so the extra money keeps its correct name in the ledger.
   */
  allowOverpayment?: boolean;
}

export interface WireSettlementRequest {
  id: Uuid;
  workerId: Uuid;
  from: DayISO;
  to: DayISO;
  /** Empty or omitted means "everything pending in the period". */
  payableIds?: Uuid[];
  note?: string | null;
}

/* -- weekly price ---------------------------------------------------- */

/** `/v1/prices/weeks/{monday}` — and the path segment must BE a Monday. */
export interface WireWeekPrice {
  weekStart: DayISO;
  priceCents: number;
}

/* ------------------------------------------------------------------ */
/* Products, warehouses, sales and expenses  (RSP-018 … RSP-033)       */
/* ------------------------------------------------------------------ */

/**
 * TRANSCRIBED FROM THE STORE, NOT FROM A DESIGN DOCUMENT.
 *
 * `services/api/internal/httpapi` has no routes for any of this yet — the
 * other pair is writing the handlers as this is written. What DOES exist, and
 * is what these types were copied from field by field, is the store layer that
 * the handlers will marshal:
 *
 *   internal/store/products.go    Product, NewProduct, Customer
 *   internal/store/stock.go       StockMove, StockLevel, LabelBatch, Label
 *   internal/store/sales.go       Sale, NewSale, SalePatch
 *   internal/store/expenses.go    Expense, ExpenseTotals
 *   migrations/00009…00011        the columns and the CHECK constraints
 *
 * Copying the Go structs rather than `docs/modelo-datos.md` is the lesson of
 * Sprint 1 applied early: the document and the service disagreed in a couple
 * of dozen places, and the half of the app built against the document had to
 * be rewritten. A struct with `json:` tags on it cannot be wrong about what it
 * marshals.
 *
 * Two field names to watch, because they are not what a reader expects:
 *   `amountCents`  is `AmountMinor` in Go. The tag says amountCents.
 *   `localDay`     is a `time.Time`, so it arrives as a full RFC 3339 instant
 *                  at midnight and NOT as "2026-08-29". `day()` narrows it.
 */

/**
 * RSP-018/019. There is no editable stock field and there never will be:
 * `stock` is a SUM over `stock_moves` computed on read. See the note on
 * `WireStockMove`.
 */
export interface WireProduct {
  id: Uuid;
  name: string;
  categoryId: Uuid | null;
  /** The resolved catalogue name. */
  category: string | null;
  storageUnitId: Uuid;
  storageUnit: string;
  note: string | null;
  createdAt: Instant;
  deletedAt: Instant | null;
  /** Derived: `sum(stock_moves.qty)` across every warehouse. Never a column. */
  stock: number;
}

/** RSP-027's "Cliente (ej. cooperativa)". Idempotent by `lower(name)`. */
export interface WireCustomer {
  id: Uuid;
  name: string;
  documentType: string | null;
  docId: string | null;
  phone: string | null;
  createdAt: Instant;
  deletedAt: Instant | null;
}

/** The seven values of the `stock_reason` enum, in the database's order. */
export type WireStockReason =
  | "cosecha"
  | "compra"
  | "venta"
  | "consumo"
  | "merma"
  | "traslado"
  | "ajuste";

/**
 * One fact about the warehouse. The table is APPEND-ONLY — a trigger and a
 * REVOKE enforce it, exactly as they do for the ledger.
 *
 * This is the shape that makes "editar la cantidad en stock" impossible to
 * build even by accident: there is no PATCH and no PUT for a movement, and the
 * only way back is `reversesId`, a second movement that is the exact opposite
 * of the first, once.
 *
 * The sign travels with the reason and Postgres checks the pair
 * (`stock_sign`): cosecha and compra are positive, venta, consumo and merma
 * are negative, traslado and ajuste may be either.
 */
export interface WireStockMove {
  id: Uuid;
  productId: Uuid;
  product: string;
  warehouseId: Uuid;
  warehouse: string;
  plotId: Uuid | null;
  plot: string | null;
  plotCropId: Uuid | null;
  qty: number;
  reason: WireStockReason;
  note: string | null;
  workRecordId: Uuid | null;
  saleId: Uuid | null;
  /** Set on a movement that undoes another one. */
  reversesId: Uuid | null;
  /** Set on a movement that has already been undone. */
  reversedById: Uuid | null;
  localDay: Instant;
  createdBy: Uuid | null;
  createdAt: Instant;
  labelBatchId: Uuid | null;
}

/** One line of the existencias screen. A SUM, never a stored total. */
export interface WireStockLevel {
  productId: Uuid;
  product: string;
  storageUnit: string;
  warehouseId: Uuid;
  warehouse: string;
  qty: number;
}

/**
 * RSP-025's "el sistema imprime los stickers", on a server with no printer:
 * the batch is generated and given an id, and whatever holds the paper asks
 * for it.
 */
export interface WireLabelBatch {
  id: Uuid;
  stockMoveId: Uuid;
  count: number;
  printedAt: Instant | null;
  createdAt: Instant;
  labels: WireLabel[];
}

export interface WireLabel {
  code: string;
  product: string;
  storageUnit: string;
  qty: number;
  warehouse: string;
  plot: string | null;
  /** A plain day here, unlike everywhere else: it is printed, not parsed. */
  localDay: DayISO;
}

/**
 * RSP-026/027. A sale and its outgoing movement are written in ONE
 * transaction; `stockMoveId` is the movement it wrote. Voiding writes the
 * reversal rather than deleting either.
 *
 * `qty` cannot be patched — it is half of an append-only movement — so an
 * amount typed wrong is a void and a fresh sale.
 */
export interface WireSale {
  id: Uuid;
  productId: Uuid;
  product: string;
  storageUnit: string;
  customerId: Uuid | null;
  customer: string | null;
  warehouseId: Uuid;
  warehouse: string;
  qty: number;
  amountCents: number;
  receiptId: Uuid | null;
  note: string | null;
  localDay: Instant;
  createdBy: Uuid | null;
  createdAt: Instant;
  voidedAt: Instant | null;
  stockMoveId: Uuid | null;
  reversalMoveId: Uuid | null;
}

/**
 * RSP-030/031. `target` is derived by the server from which column is set, so
 * the form's "Tipo de gasto" round-trips without the client working it out.
 *
 * EXACTLY ONE of `activityId` and `plotId` is set, and `expense_target` in the
 * database is what says so — not a convention anybody can forget. An expense
 * charged to nothing shows up in the total and in no breakdown, and an expense
 * charged to both is counted twice.
 */
export interface WireExpense {
  id: Uuid;
  concept: string;
  amountCents: number;
  localDay: Instant;
  activityId: Uuid | null;
  activity: string | null;
  plotId: Uuid | null;
  plot: string | null;
  plotCropId: Uuid | null;
  crop: string | null;
  receiptId: Uuid | null;
  note: string | null;
  createdBy: Uuid | null;
  createdAt: Instant;
  deletedAt: Instant | null;
  target: "activity" | "plot";
}

/** The one number the gastos screen puts at the bottom. A SUM on the way out. */
export interface WireExpenseTotals {
  count: number;
  totalCents: number;
}

/** `GET /v1/expenses` answers the list AND its total, in one envelope. */
export interface WireExpenseList {
  items: WireExpense[];
  totals: WireExpenseTotals;
}

/* ------------------------------------------------------------------ */
/* Reports (cosecha)                                                   */
/* ------------------------------------------------------------------ */

/**
 * What every report row adds up to — and the two admissions it is not allowed
 * to leave out.
 *
 * `kg` and `valueCents` are NULLABLE and a null is "this could not be
 * established", which is a different fact from 0. This is the whole reason the
 * reports were designed the way they were: a farm read `$0` against every
 * harvest record in the console because a null amount was rendered as a
 * figure, and a zero is a sum a farm can genuinely owe.
 *
 * The two counts beside them are what make a partial sum readable as partial:
 *
 *   recordsNotInKg       weighings left out of `kg` because their work unit
 *                        has no `kgFactor` — a farm may invent "canasta", and
 *                        multiplying by a factor that is not there is how a
 *                        report invents harvest.
 *   recordsWithoutValue  weighings left out of `valueCents`.
 *
 * `records` is a real count and its zero means zero.
 */
export interface WireReportTotals {
  records: number;
  kg: number | null;
  recordsNotInKg: number;
  valueCents: number | null;
  recordsWithoutValue: number;
  /** True while some of the value still rides on the week's price. */
  valueIsEstimate: boolean;
}

/** Always `harvest`: work paid by the unit of work, never the week's payroll. */
export type WireReportScope = "harvest";

export interface WireReportWeek extends WireReportTotals {
  weekStart: DayISO;
  pickers: number;
  days: number;
  /** Null only if the farm has no standing price — a broken farm, not a free week. */
  priceCents: number | null;
  /** The week is over. A running week's total is not comparable with a finished one. */
  finished: boolean;
}

export interface WireReportWeeksResult {
  scope: WireReportScope;
  items: WireReportWeek[];
}

/**
 * One cell. `column` is the day in the day grid and the plot-crop id in the
 * crop grid — and NULL in the crop grid is the unattributed column: work that
 * names no crop, or names several. Splitting it would be a guess and counting
 * it twice would break the grid, so it gets a column of its own.
 */
export interface WireReportGridCell extends WireReportTotals {
  column: string | null;
}

export interface WireReportGridRow {
  workerId: Uuid;
  name: string;
  cells: WireReportGridCell[];
  total: WireReportTotals;
}

export interface WireReportGridColumn {
  key: string | null;
  label: string;
  total: WireReportTotals;
}

/** The only way to tell the unattributed column's two causes apart. */
export interface WireReportUnattributed {
  noCropLink: number;
  sharedAcrossCrops: number;
}

export interface WireReportGrid {
  columns: WireReportGridColumn[];
  rows: WireReportGridRow[];
  total: WireReportTotals;
  /** Present only when the crop grid has a null column. */
  unattributed?: WireReportUnattributed;
}

export interface WireReportWeekDetail {
  scope: WireReportScope;
  weekStart: DayISO;
  finished: boolean;
  byDay: WireReportGrid;
  byCrop: WireReportGrid;
  total: WireReportTotals;
}

export interface WireReportCropWeek extends WireReportTotals {
  weekStart: DayISO;
  pickers: number;
  days: number;
  finished: boolean;
}

export interface WireReportCrop extends WireReportTotals {
  scope: WireReportScope;
  plotCropId: Uuid;
  /** Crop, variety and plot, as a person would say it. */
  label: string;
  pickers: number;
  days: number;
  firstOn: DayISO | null;
  lastOn: DayISO | null;
  /**
   * The crop's OWN declared hectares, never the plot's as a fallback: a plot
   * with two crops would hand the whole area to each.
   */
  areaHa: number | null;
  kgPerHa: number | null;
  /**
   * Weighings on this crop that also name another. Counted here in full, so
   * the same kilos may appear again under the other crop — hence the count
   * rather than a silent split.
   */
  sharedRecords: number;
  /** Newest first. */
  byWeek: WireReportCropWeek[];
}

/** Why somebody has no index. Absent when they have one. */
export type WirePerformanceReason = "not_enough_comparable_days" | "no_records_in_kilos";

export interface WireWorkerPerformance extends WireReportTotals {
  workerId: Uuid;
  name: string;
  days: number;
  kgPerDay: number | null;
  /**
   * This picker against the mates who worked the same crop the same day, with
   * this picker taken OUT of the benchmark, averaged over daily ratios. 1.0 is
   * "exactly what the people beside them did".
   *
   * NULL — never a low number — for anybody with too few comparable days.
   * Printing a zero there would be an accusation the data does not support.
   */
  index: number | null;
  comparableDays: number;
  reason?: WirePerformanceReason;
  /** Recent half over earlier half. Null unless both halves carry four days. */
  trend: number | null;
}

export interface WireReportPerformanceResult {
  scope: WireReportScope;
  days: number;
  /** First day of the window, in the FARM's calendar, not UTC. */
  since: DayISO;
  minComparableDays: number;
  /** Best index first, everybody without one after them — never interleaved. */
  items: WireWorkerPerformance[];
}

export type WireAnomalyRule = "impossible" | "duplicate" | "digit" | "outlier" | "future";

export interface WireAnomaly {
  recordId: Uuid;
  workerId: Uuid;
  worker: string;
  crop: string | null;
  quantity: number;
  kg: number | null;
  date: DayISO;
  rule: WireAnomalyRule;
  /**
   * What the quantity was judged against. NULL for `future`, where there is
   * nothing to compare against — the phone put a 0 there, and a 0 in this
   * field reads as "compared against nothing".
   */
  reference: number | null;
}

export interface WireReportAnomaliesResult {
  scope: WireReportScope;
  days: number;
  maxKg: number;
  limit: number;
  since: DayISO;
  items: WireAnomaly[];
}

export interface WireHarvestWeekTotal {
  weekStart: DayISO;
  /** Null is a week whose kilos could not be established, never a week of nothing. */
  kg: number | null;
}

export interface WireHarvestShape {
  /** Never a zero-valued week: "no peak yet" and "a peak of nothing" differ. */
  peak: WireHarvestWeekTotal | null;
  fallingWeeks: number;
  windingDown: boolean;
  reason?: "no_finished_weeks";
}

export interface WireHarvestCurve {
  scope: WireReportScope;
  plotCropId: Uuid | null;
  currentWeek: DayISO;
  /** Newest first, as the query returns them. */
  weeks: WireHarvestWeekTotal[];
  shape: WireHarvestShape;
  /** Weeks left out of the reading because their kilos are unknown. */
  weeksWithoutKilos: number;
}
