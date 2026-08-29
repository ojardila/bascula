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

/* -- activities ------------------------------------------------------ */

export interface WireActivityRate {
  validFrom: Instant;
  rateCents: number;
  timeUnit: string | null;
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
  items: WirePayable[];
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
