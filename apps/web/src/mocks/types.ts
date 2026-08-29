/**
 * What the mock handlers read off the wire.
 *
 * Every response type is re-exported from `src/api/wire.ts` rather than
 * redefined, so the mock cannot drift from the transcription of the Go
 * structs: if a field is renamed there, this file stops compiling here.
 *
 * The request types below are not in `wire.ts` because the app does not send
 * them — the mock RECEIVES them. They are transcribed from the Go request
 * structs (`workerRequest` is `store.Employee` decoded straight, `plotRequest`
 * is `store.Plot`, and so on), with every field optional: `decode` rejects
 * unknown fields but nothing makes a client send a known one, and the update
 * handlers patch with COALESCE so an absent field keeps its value.
 */
export type {
  ApiErrorBody,
  DayISO,
  Instant,
  Uuid,
  WireActivity,
  WireActivityRate,
  WireBalance,
  WireCatalogItem,
  WireCustomer,
  WireExpense,
  WireExpenseList,
  WireExpenseTotals,
  WireEmployee,
  WireFarmChoice,
  WireLedgerEntry,
  WireLedgerKind,
  WireLedgerRequest,
  WireList,
  WireMe,
  WireNote,
  WirePayMethod,
  WirePayScheme,
  WirePayable,
  WirePending,
  WireLabel,
  WireLabelBatch,
  WirePlot,
  WirePlotCrop,
  WireProduct,
  WireRateSource,
  WireRole,
  WireSale,
  WireStockLevel,
  WireStockMove,
  WireStockReason,
  WireSession,
  WireSettlement,
  WireSettlementPreview,
  WireFarmUser,
  WireSettlementRequest,
  WireSignupRequest,
  WireSignupResponse,
  WireWeekPrice,
  WireWorkRecord,
  WireWorkRecordRequest,
  WireWorkUnit,
  WireWorkerProfile,
  WireWorkerPublic,
} from "../api/wire";

import type { DayISO, Uuid, WirePayScheme, WireRateSource, WireStockReason } from "../api/wire";

/* -- auth ------------------------------------------------------------ */

export interface LoginRequestBody {
  email?: string;
  password?: string;
  /** Only sent when the account belongs to more than one farm. */
  farmId?: string;
  deviceId?: string;
}

export interface RefreshRequestBody {
  refreshToken?: string;
  deviceId?: string;
}

export interface VerifyEmailRequestBody {
  token?: string;
}

/* -- workers --------------------------------------------------------- */

/** `store.Employee`, decoded from the body verbatim. Note `docId`. */
export interface WorkerRequestBody {
  id?: Uuid;
  name?: string;
  lastName?: string | null;
  documentType?: string | null;
  docId?: string | null;
  tag?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  municipality?: string | null;
  country?: string | null;
  photoId?: string | null;
}

/* -- plots ----------------------------------------------------------- */

/**
 * A crop may name its type by id or by name — `handleCreatePlot` accepts
 * either and 400s when both are missing, because the picker offers "add it if
 * it is not there" and a brand new name has no id yet.
 */
export interface PlotCropRequestBody {
  id?: Uuid;
  cropTypeId?: string;
  cropType?: string;
  varietyId?: string | null;
  variety?: string | null;
  areaHa?: number | null;
  plantedOn?: string | null;
  removedOn?: string | null;
}

export interface PlotRequestBody {
  id?: Uuid;
  name?: string;
  areaHa?: number | null;
  computedAreaHa?: number | null;
  department?: string | null;
  municipality?: string | null;
  /**
   * The shape drawn on the map, accepted on the create and the patch as well
   * as on the dedicated PUT. `hasBoundary` in the Go handler treats an absent
   * field and a null as the same thing, so an edit that never opened the map
   * cannot erase a polygon.
   */
  boundary?: unknown;
  crops?: PlotCropRequestBody[];
}

/* -- activities ------------------------------------------------------ */

export interface RateRequestBody {
  validFrom?: DayISO;
  rateCents?: number;
  timeUnit?: string | null;
  customQty?: number | null;
  customUnit?: string | null;
}

export interface ActivityRequestBody {
  id?: Uuid;
  name?: string;
  categoryId?: string;
  category?: string;
  payScheme?: WirePayScheme;
  rateSource?: WireRateSource;
  unitId?: string | null;
  rate?: RateRequestBody;
}

/* -- catalogues ------------------------------------------------------ */

export interface CatalogItemRequestBody {
  id?: Uuid;
  name?: string;
}

export interface WorkUnitRequestBody {
  id?: Uuid;
  code?: string;
  label?: string;
  kgFactor?: number | null;
}

/* -- money ----------------------------------------------------------- */

export interface WeekPriceRequestBody {
  priceCents?: number;
}

export interface ReverseRequestBody {
  note?: string | null;
}

/* -- signup ---------------------------------------------------------- */

/** Every field optional: the whole point of the handler is to reject holes. */
export interface SignupRequestBody {
  farm?: { name?: string; timezone?: string; currency?: string; priceCents?: number };
  owner?: { email?: string; name?: string; password?: string };
}

/* -- products, stock, sales and expenses (RSP-018 … RSP-033) --------- */

/**
 * The write shapes, transcribed from the Go store's `New…` structs the same
 * way the ones above were. Category, storage unit, warehouse and customer may
 * arrive as an ID OR AS A NAME: `resolveCatalog` and `EnsureCustomer` create
 * the row when only a name came, which is the "con opción de crear" that
 * RSP-019 and RSP-027 ask for, and it is idempotent by `lower(name)` so a
 * picker cannot accumulate five "Bodega principal".
 */
export interface ProductRequestBody {
  id?: Uuid;
  name?: string;
  categoryId?: Uuid | null;
  category?: string;
  storageUnitId?: Uuid | null;
  storageUnit?: string;
  note?: string | null;
  status?: string;
}

export interface CustomerRequestBody {
  id?: Uuid;
  name?: string;
  documentType?: string | null;
  docId?: string | null;
  phone?: string | null;
}

/**
 * `localDay` absent means "the farm's today", which the DATABASE decides. Go
 * has no business ruling on which calendar day 19:30 in Bogotá belongs to, and
 * neither does this mock.
 */
export interface StockMoveRequestBody {
  id?: Uuid;
  productId?: Uuid;
  /**
   * REQUIRED, and by id only. A warehouse is not created on the way past the
   * way a category is — `POST /v1/warehouses` is its own call — so there is no
   * `warehouse` name field here. The first draft of this file had one, copied
   * from the sale's body, which is exactly the kind of invented field a mock
   * teaches a client to send and production answers 400 to.
   */
  warehouseId?: Uuid;
  plotId?: Uuid | null;
  plotCropId?: Uuid | null;
  /**
   * MAY ARRIVE UNSIGNED. `handleCreateStockMove` flips it to match the reason
   * before writing, so `{qty: 40, reason: "merma"}` is a merma of −40 and a
   * 201, NOT a 400. Only `traslado` and `ajuste` keep the caller's sign, being
   * the two the CHECK leaves free.
   */
  qty?: number;
  reason?: WireStockReason;
  note?: string | null;
  workRecordId?: Uuid | null;
  saleId?: Uuid | null;
  reversesId?: Uuid | null;
  localDay?: string | null;
  /** How many identification stickers to generate. RSP-025. 0..500. */
  labels?: number;
  /**
   * Record an outgoing movement that takes the level below zero. Guards EVERY
   * outgoing movement and not only a sale: a `consumo` for more than there is
   * answers 409 INSUFFICIENT_STOCK with `details.onHand` and
   * `details.requested`, exactly as a sale does.
   */
  allowNegative?: boolean;
}

export interface SaleRequestBody {
  id?: Uuid;
  productId?: Uuid;
  customerId?: Uuid | null;
  /** A name instead of an id; created if it is not there yet. */
  customer?: string;
  /** Required: a sale takes the product out of somewhere. By id only. */
  warehouseId?: Uuid;
  qty?: number;
  amountCents?: number;
  receiptId?: Uuid | null;
  note?: string | null;
  localDay?: string | null;
  /** "Yes, I know the warehouse says there is not that much. Record it." */
  allowNegativeStock?: boolean;
}

export interface ExpenseRequestBody {
  id?: Uuid;
  concept?: string;
  amountCents?: number;
  localDay?: string | null;
  activityId?: Uuid | null;
  plotId?: Uuid | null;
  plotCropId?: Uuid | null;
  receiptId?: Uuid | null;
  note?: string | null;
  status?: string;
}
