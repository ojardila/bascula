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
  WirePlot,
  WirePlotCrop,
  WireRateSource,
  WireRole,
  WireSession,
  WireSettlement,
  WireSettlementPreview,
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

import type { DayISO, Uuid, WirePayScheme, WireRateSource } from "../api/wire";

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
