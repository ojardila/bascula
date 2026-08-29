/**
 * Every route of `docs/arquitectura-api.md` this sprint touches, typed.
 *
 * Screens call these, never `http` directly, so that when the generated client
 * lands the change is confined to this file. Paths carry no farmId: the tenant
 * travels in the token (arquitectura-api.md §6), and a farmId in the path
 * invites someone to trust it.
 */
import { http } from "./client";
import type {
  Activity,
  ActivityInput,
  AdminFarm,
  Balance,
  CatalogItem,
  DeductionInput,
  FarmSummary,
  LedgerEntry,
  LoginChoice,
  LoginRequest,
  MeUser,
  Payables,
  Payment,
  PaymentInput,
  Plot,
  PlotInput,
  Session,
  SignupRequest,
  SignupResponse,
  Uuid,
  WeekPrice,
  WorkRecord,
  WorkRecordInput,
  Worker,
  WorkerInput,
  WorkerNote,
  WorkerProfile,
} from "./types";

export const api = {
  /* auth */
  signup: (body: SignupRequest) =>
    http.post<SignupResponse>("/v1/signup", body, { anonymous: true }),

  verifyEmail: (token: string) =>
    http.post<{ ok: true }>("/v1/signup/verify", { token }, { anonymous: true }),

  login: (body: LoginRequest) =>
    http.post<Session | LoginChoice>("/v1/auth/login", body, { anonymous: true }),

  logout: () => http.post<void>("/v1/auth/logout"),

  me: () => http.get<MeUser>("/v1/me"),

  /* farm */
  getFarm: () => http.get<FarmSummary>("/v1/farm"),

  /* catalogs */
  cropTypes: () => http.get<CatalogItem[]>("/v1/catalogs/crop-types"),
  varieties: (cropTypeId?: Uuid) =>
    http.get<CatalogItem[]>("/v1/catalogs/varieties", { query: { cropTypeId } }),
  createCropType: (name: string) =>
    http.post<CatalogItem>("/v1/catalogs/crop-types", { name }),
  createVariety: (cropTypeId: Uuid, name: string) =>
    http.post<CatalogItem>("/v1/catalogs/varieties", { cropTypeId, name }),

  /* plots */
  listPlots: (params?: { status?: string; q?: string }) =>
    http.get<Plot[]>("/v1/plots", { query: params }),
  getPlot: (id: Uuid) => http.get<Plot>(`/v1/plots/${id}`),
  createPlot: (body: PlotInput) => http.post<Plot>("/v1/plots", body),
  updatePlot: (id: Uuid, body: Partial<PlotInput>) =>
    http.patch<Plot>(`/v1/plots/${id}`, body),
  /** Never a DELETE. Logical removal is a status change (casos-de-uso RSP-003). */
  deactivatePlot: (id: Uuid) =>
    http.patch<Plot>(`/v1/plots/${id}`, { status: "inactive" }),
  reactivatePlot: (id: Uuid) =>
    http.patch<Plot>(`/v1/plots/${id}`, { status: "active" }),

  /* workers */
  listWorkers: (params?: { status?: string; q?: string }) =>
    http.get<Worker[]>("/v1/workers", { query: params }),
  getWorker: (id: Uuid) => http.get<Worker>(`/v1/workers/${id}`),
  createWorker: (body: WorkerInput) => http.post<Worker>("/v1/workers", body),
  updateWorker: (id: Uuid, body: Partial<WorkerInput>) =>
    http.patch<Worker>(`/v1/workers/${id}`, body),
  deactivateWorker: (id: Uuid) =>
    http.patch<Worker>(`/v1/workers/${id}`, { status: "inactive" }),
  reactivateWorker: (id: Uuid) =>
    http.patch<Worker>(`/v1/workers/${id}`, { status: "active" }),

  /** RSP-007 in one call: worker + balance + work records + ledger + notes. */
  workerProfile: (id: Uuid) => http.get<WorkerProfile>(`/v1/workers/${id}/profile`),
  workerBalance: (id: Uuid) => http.get<Balance>(`/v1/workers/${id}/balance`),
  workerLedger: (id: Uuid) => http.get<LedgerEntry[]>(`/v1/workers/${id}/ledger`),
  /** The RSP-008 screen: pending work records, debts and the total. */
  workerPayables: (id: Uuid) => http.get<Payables>(`/v1/workers/${id}/payables`),
  addNote: (id: Uuid, text: string) =>
    http.post<WorkerNote>(`/v1/workers/${id}/notes`, { text }),

  /* activities */
  listActivities: (params?: { category?: string; q?: string; status?: string }) =>
    http.get<Activity[]>("/v1/activities", { query: params }),
  createActivity: (body: ActivityInput) => http.post<Activity>("/v1/activities", body),
  updateActivity: (id: Uuid, body: Partial<ActivityInput>) =>
    http.patch<Activity>(`/v1/activities/${id}`, body),
  deactivateActivity: (id: Uuid) =>
    http.patch<Activity>(`/v1/activities/${id}`, { status: "inactive" }),
  reactivateActivity: (id: Uuid) =>
    http.patch<Activity>(`/v1/activities/${id}`, { status: "active" }),
  /** Owner only. Adds a dated rate; it does not overwrite the previous one. */
  setActivityRate: (id: Uuid, rateCents: number, validFrom: string) =>
    http.put<Activity>(`/v1/activities/${id}/rate`, { rateCents, validFrom }),

  /* work records (labores) */
  listWorkRecords: (params?: {
    workerId?: Uuid;
    plotId?: Uuid;
    activityId?: Uuid;
    from?: string;
    to?: string;
    q?: string;
    status?: string;
  }) => http.get<WorkRecord[]>("/v1/work-records", { query: params }),
  createWorkRecord: (body: WorkRecordInput) =>
    http.post<WorkRecord>("/v1/work-records", body),
  updateWorkRecord: (id: Uuid, body: Partial<WorkRecordInput>) =>
    http.patch<WorkRecord>(`/v1/work-records/${id}`, body),
  deactivateWorkRecord: (id: Uuid) =>
    http.patch<WorkRecord>(`/v1/work-records/${id}`, { status: "inactive" }),

  /* weekly price — what a work_unit + weekly_price activity is worth */
  weekPrice: (monday: string) => http.get<WeekPrice>(`/v1/prices/weeks/${monday}`),

  /* money */
  createPayment: (body: PaymentInput) => http.post<Payment>("/v1/payments", body),
  createAdvance: (body: PaymentInput) => http.post<Payment>("/v1/advances", body),
  createDeduction: (body: DeductionInput) => http.post<LedgerEntry>("/v1/deductions", body),
  reverseLedgerEntry: (id: Uuid, reason: string) =>
    http.post<LedgerEntry>(`/v1/ledger/${id}/reverse`, { reason }),

  /* super-admin — outside the tenant */
  adminListFarms: (params?: { q?: string; status?: string }) =>
    http.get<AdminFarm[]>("/v1/admin/farms", { query: params }),
  adminSetFarmStatus: (id: Uuid, status: "active" | "suspended") =>
    http.patch<AdminFarm>(`/v1/admin/farms/${id}`, { status }),
};
