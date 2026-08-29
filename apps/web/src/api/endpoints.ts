/**
 * Every call this app makes, against the routes `services/api` actually
 * serves.
 *
 * Sprint 1 wrote this file against `docs/arquitectura-api.md`. Sprint 2
 * pointed it at the running server and rewrote it against
 * `internal/httpapi/routes.go`, which is the only source of truth that can be
 * wrong in a way anybody notices.
 *
 * The contract of this module, unchanged from Sprint 1: **screens call these
 * functions and never `http` directly, and what comes back is a view model,
 * never a wire shape.** Everything peculiar about the server is absorbed here
 * or in `adapters.ts`. That indirection earned itself twice over this sprint:
 * the API grew eight routes and changed three shapes while this was being
 * written, and not one screen had to be touched for it.
 *
 * Four things worth knowing before editing.
 *
 * DEACTIVATE IS A PATCH, NOT A DELETE. Both exist. `DELETE /v1/workers/{id}`
 * removes logically and cannot be undone; `PATCH {status}` removes logically
 * AND restores, because the store grew `RestoreEmployee`/`RestorePlot`/
 * `RestoreWorkRecord` to make the reactivate button in the interface
 * implementable. The PATCH is what this file uses, so that deactivating and
 * reactivating are the same code path in both directions.
 *
 * PAYING IS TWO WRITES. On the phone and in the old mock, paying a set of
 * pending work records was one call. Here, settling is what turns work into a
 * `devengo` in the ledger, and only then is there a balance to pay against. So
 * `createPayment` does POST /v1/settlements and then POST /v1/payments. Both
 * carry client-generated UUIDv7 ids and both are idempotent by id, which is
 * what makes a retry after a timeout safe rather than a double payment.
 *
 * THE SERVER FILTERS. `q` and `status` are real query parameters on every list
 * route (`store.Filter`), so they go over the wire rather than being applied
 * to a fully-loaded list here. Anything the server does NOT filter on is
 * marked `LOCAL FILTER` at the site, so the handful of places that would need
 * a server-side filter later are greppable.
 *
 * REQUEST BODIES ARE EXACT. `decode` runs with `DisallowUnknownFields`, so a
 * stray key is not ignored — it is a 400 whose message does not name the
 * field. The builders at the bottom of this file send the store struct's keys
 * and nothing else. This cost an afternoon; hence the size of the comment.
 */
import { http, getTokens, setTokens } from "./client";
import { ApiError } from "./errors";
import {
  day,
  payModeToWire,
  quantityToWire,
  rateSourceToWire,
  toActivity,
  toAdminFarm,
  toBalance,
  toCatalogItem,
  toFarmSummary,
  toLedgerEntry,
  toMeUser,
  toNote,
  toPayables,
  toCustomer,
  toExpense,
  toLabelBatch,
  toPlot,
  toProduct,
  toSale,
  toStockLevel,
  toStockMove,
  toWeekPrice,
  toWorkRecord,
  toWorker,
} from "./adapters";
import { invalidateRefs, loadRefs } from "./refs";
import { mondayOf } from "../lib/dates";
import { uuidv7 } from "../lib/uuid";
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
  BoundaryResult,
  Customer,
  Expense,
  ExpenseInput,
  ExpenseList,
  SaleList,
  LabelBatch,
  Plot,
  PlotInput,
  Product,
  ProductInput,
  Sale,
  SaleInput,
  StockLevel,
  StockMove,
  StockMoveInput,
  StockReason,
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
import type {
  WireActivity,
  WireAdminFarm,
  WireBalance,
  WireCatalogItem,
  WireEmployee,
  WireFarm,
  WireLedgerEntry,
  WireList,
  WireMe,
  WireNote,
  WirePayables,
  WireBoundaryResult,
  WireCustomer,
  WireExpense,
  WireLabelBatch,
  WirePlot,
  WireProduct,
  WireSale,
  WireStockLevel,
  WireStockMove,
  WireSession,
  WireSettlement,
  WireSignupResponse,
  WireWeekPrice,
  WireWorkerProfile,
  WireWorkerPublic,
  WireWorkRecord,
  WireWorkUnit,
} from "./wire";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const items = <T>(res: WireList<T> | null | undefined): T[] => res?.items ?? [];

/**
 * "all" is the interface's word for "do not filter" and the server's word for
 * nothing at all — it would be rejected by `validStatus`. Translated here so
 * the filter chips can keep saying what they mean.
 */
const statusParam = (status?: string): string | undefined =>
  !status || status === "all" ? undefined : status;

/**
 * A local error dressed as an `ApiError`, so a screen's single catch block
 * handles "the server cannot do this" the same way it handles a 409.
 * `status: 0` marks it as never having left the browser.
 */
function unsupported(code: string, message: string): ApiError {
  return new ApiError(0, { error: { code, message } });
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

/**
 * A Go `time.Time` will not parse `"2026-08-27"`; it wants RFC 3339. Business
 * days therefore have to be widened to midnight UTC for the few request
 * bodies decoded into a `*time.Time` rather than parsed from a string —
 * `plantedOn` is the one this app sends. Getting this wrong is a 400
 * "malformed request body" that names no field.
 */
const instantOf = (d: string | null | undefined): string | null =>
  d ? `${d.slice(0, 10)}T00:00:00Z` : null;

/**
 * The widest range a settlement will accept.
 *
 * `/v1/settlements` requires `from` and `to` and refuses to default them,
 * which is right for an API and unhelpful for a screen whose question is "pay
 * this person what they are owed". The floor predates the product; the ceiling
 * is a year out, because a work record may legitimately be dated slightly
 * ahead when a farm records a full week on the Friday.
 *
 * (`/v1/workers/{id}/payables` defaults the same range server-side, which is
 * why reading needs no equivalent of this and only writing does.)
 */
function everRange(): { from: string; to: string } {
  const to = new Date();
  to.setUTCFullYear(to.getUTCFullYear() + 1);
  return { from: "1970-01-01", to: to.toISOString().slice(0, 10) };
}

/* ------------------------------------------------------------------ */
/* The API                                                             */
/* ------------------------------------------------------------------ */

export const api = {
  /* -- auth ---------------------------------------------------------- */

  /**
   * Register a farm and its first owner.
   *
   * The body must be exactly `{farm:{name,timezone,currency,priceCents},
   * owner:{email,name,password}}`. The Sprint 1 form sent `farm.department`
   * and `farm.municipality`, which produced a 400 naming no field — the single
   * most confusing failure of the whole integration. Those two describe a
   * PLOT, not a farm, and the farm's own address is set later in
   * Configuración.
   *
   * `priceCents` is required and positive because `seedFarm` uses it to price
   * the "Recoleccion" activity every new farm gets: a farm cannot exist
   * without a price for a kilo.
   */
  signup: async (body: SignupRequest): Promise<SignupResponse> => {
    const res = await http.post<WireSignupResponse>(
      "/v1/signup",
      {
        farm: {
          name: body.farm.name,
          timezone: body.farm.timezone || "America/Bogota",
          currency: body.farm.currency || "COP",
          priceCents: body.farm.priceCents,
        },
        owner: body.owner,
      },
      { anonymous: true },
    );
    return {
      farmId: res.farmId,
      userId: res.userId,
      verificationEmailSentTo: body.owner.email,
      // Present only when the server runs in development mode, where there is
      // no mail sender at all. The signup screen offers to verify in place
      // with it rather than telling somebody to check a mailbox that will
      // never receive anything.
      verificationToken: res.verificationToken ?? null,
    };
  },

  verifyEmail: (token: string) =>
    http.post<{ userId: Uuid; verified: boolean }>(
      "/v1/auth/verify-email",
      { token },
      { anonymous: true },
    ),

  /**
   * Open a session.
   *
   * Two things the Sprint 1 version got wrong. The response has no user object
   * in it — it is `{accessToken, refreshToken, expiresIn, farmId, farmName,
   * role}` — so the user has to be fetched afterwards, which means the tokens
   * have to be installed first. And an account belonging to several farms does
   * not answer with a choice: it answers **400 with `details.farms`**, an
   * error envelope, so the choice has to be caught rather than returned.
   */
  login: async (body: LoginRequest): Promise<Session | LoginChoice> => {
    let session: WireSession;
    try {
      session = await http.post<WireSession>(
        "/v1/auth/login",
        {
          email: body.email,
          password: body.password,
          farmId: body.farmId ?? "",
          // Naming the device ties the refresh-token family to this browser,
          // so revoking one device does not sign the owner out of the phone.
          deviceId: deviceId(),
        },
        { anonymous: true },
      );
    } catch (e) {
      const choice = farmChoiceFrom(e);
      if (choice) return choice;
      throw e;
    }

    setTokens({ accessToken: session.accessToken, refreshToken: session.refreshToken });
    invalidateRefs();
    try {
      const user = await api.me();
      return {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
        user,
      };
    } catch (e) {
      // A token we cannot use is worse than no token: it would leave the shell
      // showing a splash for ever on the next reload.
      setTokens(null);
      throw e;
    }
  },

  logout: async (): Promise<void> => {
    invalidateRefs();
    const tokens = getTokens();
    if (!tokens) return;
    // The route revokes the whole refresh family, so it needs the refresh
    // token in the body — the access token alone does not identify one.
    await http.post<void>("/v1/auth/logout", { refreshToken: tokens.refreshToken });
  },

  me: async (): Promise<MeUser> => toMeUser(await http.get<WireMe>("/v1/me")),

  /* -- the farm ------------------------------------------------------ */

  getFarm: async (): Promise<FarmSummary> =>
    toFarmSummary(await http.get<WireFarm>("/v1/farm")),

  /** Owner only. A bad IANA timezone is refused by the database, because it
   *  would silently shift every business day the farm has ever recorded. */
  updateFarm: async (body: Partial<FarmSummary>): Promise<FarmSummary> => {
    const out: Record<string, unknown> = {};
    if (body.name !== undefined) out.name = body.name;
    if (body.timezone !== undefined) out.timezone = body.timezone;
    if (body.currency !== undefined) out.currency = body.currency;
    if (body.priceCents != null) out.priceCents = body.priceCents;
    if (body.phone !== undefined) out.phone = body.phone || null;
    if (body.country !== undefined) out.country = body.country || null;
    if (body.city !== undefined) out.city = body.city || null;
    if (body.address !== undefined) out.address = body.address || null;
    if (body.areaHa !== undefined) out.areaHa = body.areaHa;
    return toFarmSummary(await http.put<WireFarm>("/v1/farm", out));
  },

  /* -- catalogues ---------------------------------------------------- */

  cropTypes: async (): Promise<CatalogItem[]> =>
    items(await http.get<WireList<WireCatalogItem>>("/v1/catalogs/crop-types")).map(
      toCatalogItem,
    ),

  /**
   * Varieties are a flat per-farm catalogue: the server does NOT scope them to
   * a crop type, so `cropTypeId` is accepted and ignored. Filtering by it here
   * would hide varieties that exist, which is worse than offering a cacao
   * variety to somebody entering coffee.
   */
  varieties: async (_cropTypeId?: Uuid): Promise<CatalogItem[]> =>
    items(await http.get<WireList<WireCatalogItem>>("/v1/catalogs/varieties")).map(
      toCatalogItem,
    ),

  createCropType: async (name: string): Promise<CatalogItem> => {
    // POST is idempotent by (farm, lower(name)) and answers 200 with the
    // existing row, which is what makes "add it if it is not there" safe to
    // press twice.
    const item = await http.post<WireCatalogItem>("/v1/catalogs/crop-types", { name });
    invalidateRefs();
    return toCatalogItem(item);
  },

  createVariety: async (_cropTypeId: Uuid, name: string): Promise<CatalogItem> => {
    const item = await http.post<WireCatalogItem>("/v1/catalogs/varieties", { name });
    invalidateRefs();
    return toCatalogItem(item);
  },

  activityCategories: async (): Promise<CatalogItem[]> =>
    items(
      await http.get<WireList<WireCatalogItem>>("/v1/catalogs/activity-categories"),
    ).map(toCatalogItem),

  workUnits: async (): Promise<Array<{ id: Uuid; code: string; label: string }>> =>
    items(await http.get<WireList<WireWorkUnit>>("/v1/catalogs/work-units")).map((u) => ({
      id: u.id,
      code: u.code,
      label: u.label,
    })),

  /* -- plots --------------------------------------------------------- */

  listPlots: async (params?: { status?: string; q?: string }): Promise<Plot[]> => {
    const res = await http.get<WireList<WirePlot>>("/v1/plots", {
      query: { q: params?.q, status: statusParam(params?.status) },
    });
    return items(res).map(toPlot);
  },

  getPlot: async (id: Uuid): Promise<Plot> =>
    toPlot(await http.get<WirePlot>(`/v1/plots/${id}`)),

  /**
   * The plot, its crops and the shape drawn on the map, in one write.
   *
   * `handleCreatePlot` stores a `boundary` sent here rather than dropping it,
   * so the new-plot form does not have to make a second call that could fail
   * on its own and leave a lot with no polygon and no explanation. The
   * dedicated PUT stays for the edit screen, where the point of the call is
   * the overlap list that only it returns.
   */
  createPlot: async (body: PlotInput): Promise<Plot> => {
    const created = await http.post<WirePlot>("/v1/plots", plotToWire(body));
    invalidateRefs();
    return toPlot(created);
  },

  updatePlot: async (id: Uuid, body: Partial<PlotInput>): Promise<Plot> => {
    // PATCH coalesces the identity fields; crops are managed through their own
    // nested routes, and sending `crops` here would be an unknown-field 400
    // even though creation accepts it.
    const updated = await http.patch<WirePlot>(`/v1/plots/${id}`, {
      name: body.name,
      areaHa: body.areaHa,
      department: body.department,
      municipality: body.municipality,
      // Absent unless the form actually redrew it: `hasBoundary` treats null
      // as "not sent", so an edit that never opened the map cannot wipe a
      // polygon somebody spent ten minutes on.
      ...(body.boundary ? { boundary: body.boundary } : {}),
    });
    invalidateRefs();
    return toPlot(updated);
  },

  /**
   * Refused with 409 PLOT_HAS_ACTIVE_CROPS while something is still planted:
   * taking a plot out of service under a live crop would orphan the work
   * records pointing at that crop.
   */
  deactivatePlot: async (id: Uuid): Promise<Plot> => {
    const p = await http.patch<WirePlot>(`/v1/plots/${id}`, { status: "inactive" });
    invalidateRefs();
    return toPlot(p);
  },

  reactivatePlot: async (id: Uuid): Promise<Plot> => {
    const p = await http.patch<WirePlot>(`/v1/plots/${id}`, { status: "active" });
    invalidateRefs();
    return toPlot(p);
  },

  /**
   * Store the polygon the owner drew. GeoJSON in, GeoJSON out — no PostGIS
   * type ever crosses the wire.
   *
   * THE RESPONSE IS NOT A PLOT. `handleSetPlotBoundary` answers
   * `{plot, overlaps}`, and this function used to read it as if it were the
   * plot itself: every field came back undefined and the recomputed hectares —
   * the one figure the whole call exists to fetch — silently became null. It
   * was never caught because nothing called it: the map was a placeholder
   * until this sprint, so the only consumer of this line was the type
   * annotation that made it look right.
   *
   * `overlaps` is a WARNING and never a refusal. Two plots that touch on the
   * map are usually a drawing worth a second look and sometimes a terrace
   * above a coffee lot, and the server does not get to decide which — so it
   * comes back beside the plot and the screen says so without blocking.
   *
   * `plot.crops` arrives EMPTY: the UPDATE returns the plot's own columns and
   * the handler does not re-join what is planted in it. Callers holding a
   * fuller plot should keep their crops rather than take these.
   */
  setPlotBoundary: async (id: Uuid, boundary: unknown): Promise<BoundaryResult> => {
    const res = await http.put<WireBoundaryResult>(`/v1/plots/${id}/boundary`, { boundary });
    return {
      plot: toPlot(res.plot),
      overlaps: (res.overlaps ?? []).map((o) => ({ id: o.id, name: o.name })),
    };
  },

  /* -- workers ------------------------------------------------------- */

  listWorkers: async (params?: { status?: string; q?: string }): Promise<Worker[]> => {
    const res = await http.get<WireList<WireEmployee | WireWorkerPublic>>("/v1/workers", {
      query: { q: params?.q, status: statusParam(params?.status) },
    });
    return items(res).map(toWorker);
  },

  getWorker: async (id: Uuid): Promise<Worker> =>
    toWorker(await http.get<WireEmployee>(`/v1/workers/${id}`)),

  createWorker: async (body: WorkerInput): Promise<Worker> => {
    const created = await http.post<WireEmployee>("/v1/workers", workerToWire(body));
    invalidateRefs();
    return toWorker(created);
  },

  updateWorker: async (id: Uuid, body: Partial<WorkerInput>): Promise<Worker> => {
    const updated = await http.patch<WireEmployee>(`/v1/workers/${id}`, workerToWire(body));
    invalidateRefs();
    return toWorker(updated);
  },

  deactivateWorker: async (id: Uuid): Promise<Worker> => {
    const w = await http.patch<WireEmployee>(`/v1/workers/${id}`, { status: "inactive" });
    invalidateRefs();
    return toWorker(w);
  },

  reactivateWorker: async (id: Uuid): Promise<Worker> => {
    const w = await http.patch<WireEmployee>(`/v1/workers/${id}`, { status: "active" });
    invalidateRefs();
    return toWorker(w);
  },

  /**
   * RSP-007 in two round trips.
   *
   * `/v1/workers/{id}/profile` returns worker, balance, ledger, `tasks` (the
   * work records) and notes. The one thing it does not carry is what is
   * unsettled, so `pendingCents` comes from `/v1/workers/{id}/payables`. That
   * is deliberately a second request rather than a sum over `tasks`: the
   * figure has to come from the same query the settlement will run, or the
   * profile and the payment screen can disagree about what is owed.
   *
   * Both requests are fired together with the reference data, because the task
   * rows need names the server did not send.
   */
  workerProfile: async (id: Uuid): Promise<WorkerProfile> => {
    const [profile, refs, payables] = await Promise.all([
      http.get<WireWorkerProfile>(`/v1/workers/${id}/profile`),
      loadRefs(),
      http.get<WirePayables>(`/v1/workers/${id}/payables`).catch(() => null),
    ]);
    return {
      worker: toWorker(profile.worker),
      balance: toBalance(profile.balance),
      workRecords: (profile.tasks ?? []).map((t) => toWorkRecord(t, refs)),
      pendingCents: payables?.grossCents ?? 0,
      ledger: (profile.ledger ?? []).map(toLedgerEntry),
      notes: (profile.notes ?? []).map(toNote),
    };
  },

  workerBalance: async (id: Uuid): Promise<Balance> =>
    toBalance(await http.get<WireBalance>(`/v1/workers/${id}/balance`)),

  /**
   * Every worker's position in one call. The dashboard used to add up a
   * `balanceCents` on the worker list, which that endpoint has never sent, so
   * the tile read $0 for a farm that owed a week of picking.
   */
  listBalances: async (): Promise<Balance[]> => {
    const res = await http.get<WireList<WireBalance>>("/v1/balances");
    return res.items.map(toBalance);
  },

  workerLedger: async (id: Uuid): Promise<LedgerEntry[]> =>
    items(await http.get<WireList<WireLedgerEntry>>(`/v1/workers/${id}/ledger`)).map(
      toLedgerEntry,
    ),

  /**
   * The RSP-008 screen in one call. With no range it means "everything
   * outstanding", which is the question the owner is actually asking.
   */
  workerPayables: async (id: Uuid): Promise<Payables> => {
    const [payables, refs] = await Promise.all([
      http.get<WirePayables>(`/v1/workers/${id}/payables`),
      loadRefs(),
    ]);
    return toPayables(payables, refs);
  },

  workerNotes: async (id: Uuid): Promise<WorkerNote[]> =>
    items(await http.get<WireList<WireNote>>(`/v1/workers/${id}/notes`)).map(toNote),

  /** Append-only: there is no edit and no delete on a note, by design. */
  addNote: async (id: Uuid, text: string): Promise<WorkerNote> =>
    toNote(await http.post<WireNote>(`/v1/workers/${id}/notes`, { id: uuidv7(), text })),

  /* -- activities ---------------------------------------------------- */

  listActivities: async (params?: {
    category?: string;
    q?: string;
    status?: string;
  }): Promise<Activity[]> => {
    const [res, refs] = await Promise.all([
      http.get<WireList<WireActivity>>("/v1/activities", {
        query: {
          q: params?.q,
          status: statusParam(params?.status),
          category: params?.category,
        },
      }),
      loadRefs(),
    ]);
    return items(res).map((a) => toActivity(a, refs));
  },

  createActivity: async (body: ActivityInput): Promise<Activity> => {
    const created = await http.post<WireActivity>("/v1/activities", await activityToWire(body));
    invalidateRefs();
    return toActivity(created, await loadRefs());
  },

  /**
   * Renames and re-categorises. It CANNOT change the pay scheme or the rate
   * source, and the server refuses outright rather than half-applying: work
   * records already written are pinned to (activityId, payScheme) by a
   * composite foreign key, and turning "tala por jornal" into a per-kilo
   * activity would rewrite the meaning of money already earned. An activity
   * that pays differently is a different activity.
   */
  updateActivity: async (id: Uuid, body: Partial<ActivityInput>): Promise<Activity> => {
    const out: Record<string, unknown> = {};
    if (body.name !== undefined) out.name = body.name;
    if (body.category !== undefined) out.category = body.category;
    const updated = await http.patch<WireActivity>(`/v1/activities/${id}`, out);
    invalidateRefs();
    return toActivity(updated, await loadRefs());
  },

  deactivateActivity: async (id: Uuid): Promise<Activity> => {
    const a = await http.patch<WireActivity>(`/v1/activities/${id}`, { status: "inactive" });
    invalidateRefs();
    return toActivity(a, await loadRefs());
  },

  reactivateActivity: async (id: Uuid): Promise<Activity> => {
    const a = await http.patch<WireActivity>(`/v1/activities/${id}`, { status: "active" });
    invalidateRefs();
    return toActivity(a, await loadRefs());
  },

  /**
   * Owner only. Opens a NEW validity period; it never edits the old one,
   * because a rate already frozen onto a work record has to stay explainable —
   * the answer to "why was I paid this" has to be a row with a date on it.
   */
  setActivityRate: async (id: Uuid, rateCents: number, validFrom: string): Promise<void> => {
    await http.put<unknown>(`/v1/activities/${id}/rate`, {
      rateCents,
      validFrom: day(validFrom) || undefined,
    });
    invalidateRefs();
  },

  /* -- work records -------------------------------------------------- */

  listWorkRecords: async (params?: {
    workerId?: Uuid;
    plotId?: Uuid;
    activityId?: Uuid;
    from?: string;
    to?: string;
    q?: string;
    status?: string;
  }): Promise<WorkRecord[]> => {
    const [res, refs] = await Promise.all([
      http.get<WireList<WireWorkRecord>>("/v1/work-records", {
        query: {
          workerId: params?.workerId,
          activityId: params?.activityId,
          plotId: params?.plotId,
          from: params?.from,
          to: params?.to,
          q: params?.q,
          status: statusParam(params?.status),
        },
      }),
      loadRefs(),
    ]);
    return items(res).map((r) => toWorkRecord(r, refs));
  },

  createWorkRecord: async (body: WorkRecordInput): Promise<WorkRecord> => {
    const created = await http.post<WireWorkRecord>("/v1/work-records", {
      id: body.id,
      activityId: body.activityId,
      workerId: body.workerId,
      quantity: quantityToWire(body.quantity),
      // Only send a rate when there is one: `null` and an absent key mean
      // different things. A present `rateCents` switches the server to
      // `explicit` pricing, which is also what permits a date range.
      ...(body.rateCents != null ? { rateCents: body.rateCents } : {}),
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      plotIds: body.plotIds ?? [],
      plotCropIds: body.plotCropIds ?? [],
      note: body.note ?? null,
    });
    return toWorkRecord(created, await loadRefs());
  },

  /**
   * Corrects a record that has not been paid. Everything that decides the
   * price is out of reach — only the quantity and the note can change — and a
   * record already inside a live settlement answers 409 WORK_RECORD_SETTLED
   * rather than being edited under the payment.
   */
  updateWorkRecord: async (id: Uuid, body: Partial<WorkRecordInput>): Promise<WorkRecord> => {
    const out: Record<string, unknown> = {};
    if (body.quantity !== undefined) out.quantity = quantityToWire(body.quantity);
    if (body.note !== undefined) out.note = body.note;
    const updated = await http.patch<WireWorkRecord>(`/v1/work-records/${id}`, out);
    return toWorkRecord(updated, await loadRefs());
  },

  deactivateWorkRecord: async (id: Uuid): Promise<WorkRecord> => {
    const r = await http.patch<WireWorkRecord>(`/v1/work-records/${id}`, {
      status: "inactive",
    });
    return toWorkRecord(r, await loadRefs());
  },

  reactivateWorkRecord: async (id: Uuid): Promise<WorkRecord> => {
    const r = await http.patch<WireWorkRecord>(`/v1/work-records/${id}`, { status: "active" });
    return toWorkRecord(r, await loadRefs());
  },

  /* -- weekly price -------------------------------------------------- */

  weekPrice: async (monday: string): Promise<WeekPrice> =>
    toWeekPrice(await http.get<WireWeekPrice>(`/v1/prices/weeks/${mondayOf(monday)}`)),

  setWeekPrice: async (monday: string, priceCents: number): Promise<WeekPrice> =>
    toWeekPrice(
      await http.put<WireWeekPrice>(`/v1/prices/weeks/${mondayOf(monday)}`, { priceCents }),
    ),

  /* -- money --------------------------------------------------------- */

  /**
   * Settle a set of pending work records: the write that turns work into money
   * owed. One `devengo` in the ledger for the gross, and every claimed record
   * marked settled so nothing can claim it twice.
   *
   * 409 NOTHING_TO_SETTLE when the selection matches nothing in the period;
   * 409 PAYABLE_ALREADY_CLAIMED when somebody else settled it first, which is
   * the anti-double-pay lock and the reason the sync banner is still up.
   */
  settle: async (
    workerId: Uuid,
    payableIds: Uuid[],
    note?: string,
  ): Promise<{ id: Uuid; grossCents: number }> => {
    const range = everRange();
    const s = await http.post<WireSettlement>("/v1/settlements", {
      id: uuidv7(),
      workerId,
      from: range.from,
      to: range.to,
      payableIds,
      note: note ?? null,
    });
    return { id: s.id, grossCents: s.grossCents };
  },

  /**
   * Hand money over.
   *
   * Two writes, in this order, because they are two facts: first the work
   * becomes a debt (`/v1/settlements`), then the debt is paid
   * (`/v1/payments`). Skipping the settlement posts a payment against a
   * balance that does not yet include the work, which the server rejects with
   * AMOUNT_EXCEEDS_BALANCE — the confusing 409 that made this ordering
   * obvious.
   *
   * `allowOverpayment` is deliberately never set. When the amount exceeds the
   * balance the server refuses, the screen offers the excess as an `anticipo`,
   * and the extra money keeps its correct name in the ledger instead of
   * becoming an unexplainable large payment.
   */
  createPayment: async (body: PaymentInput): Promise<Payment> => {
    if (body.payableIds && body.payableIds.length > 0) {
      await api.settle(body.workerId, body.payableIds);
    }
    const before = await api.workerBalance(body.workerId);
    const entry = await http.post<WireLedgerEntry>("/v1/payments", {
      id: body.id,
      workerId: body.workerId,
      amountCents: Math.abs(body.amountCents),
      method: body.method,
      note: body.note ?? null,
    });
    const after = await api.workerBalance(body.workerId);
    return {
      id: entry.id,
      workerId: entry.workerId,
      // The ledger stores a payment as negative; a receipt says how much was
      // handed over, which is the absolute value.
      amountCents: Math.abs(entry.amountCents),
      method: body.method,
      // The API issues no receipt numbers. The screen prints the movement id,
      // which is at least something a person can quote back to us.
      receiptNumber: entry.id,
      balanceBeforeCents: before.balanceCents,
      balanceAfterCents: after.balanceCents,
      date: day(entry.date),
    };
  },

  /** Money handed over ahead of the work. No balance check: exceeding the
   *  balance is what an advance IS. */
  createAdvance: async (body: PaymentInput): Promise<Payment> => {
    const entry = await http.post<WireLedgerEntry>("/v1/advances", {
      id: body.id,
      workerId: body.workerId,
      amountCents: Math.abs(body.amountCents),
      method: body.method,
      note: body.note ?? null,
    });
    const after = await api.workerBalance(body.workerId);
    return {
      id: entry.id,
      workerId: entry.workerId,
      amountCents: Math.abs(entry.amountCents),
      method: body.method,
      receiptNumber: entry.id,
      balanceBeforeCents: after.balanceCents + Math.abs(entry.amountCents),
      balanceAfterCents: after.balanceCents,
      date: day(entry.date),
    };
  },

  /**
   * What the worker owes the farm. NOT an expense: an expense is the farm's
   * own accounting and never touches anybody's ledger — mixing them would take
   * the cost of a spraying out of somebody's pay. The server refuses a
   * deduction carrying a payment method, which is the same distinction stated
   * from its side.
   */
  createDeduction: async (body: DeductionInput): Promise<LedgerEntry> =>
    toLedgerEntry(
      await http.post<WireLedgerEntry>("/v1/deductions", {
        id: body.id,
        workerId: body.workerId,
        amountCents: Math.abs(body.amountCents),
        note: body.concept,
        date: body.date || undefined,
      }),
    ),

  /**
   * Undo a movement. Nothing in the ledger is edited or deleted — the database
   * has rules forbidding both — so the only way back is a movement that
   * cancels the first one exactly, once. Twice is 409 ALREADY_REVERSED.
   */
  reverseLedgerEntry: async (id: Uuid, reason: string): Promise<LedgerEntry> =>
    toLedgerEntry(
      await http.post<WireLedgerEntry>(`/v1/ledger/${id}/reverse`, { note: reason }),
    ),

  /* -- products and inventory (RSP-018 … RSP-025) -------------------- */

  /**
   * EXISTENCIAS ARE DERIVED, so there is no `updateStock` on this object and
   * there is no field on `ProductInput` that carries a quantity. The only way
   * a number moves is `createStockMove`, which appends a fact. Anybody looking
   * for the missing "set the stock to 40" function: it is missing on purpose,
   * and `docs/modelo-datos.md` says why — "un stock materializado es un total
   * que se desincroniza de sus hechos".
   */
  listProducts: async (params?: {
    q?: string;
    status?: string;
    categoryId?: Uuid;
  }): Promise<Product[]> =>
    items(
      await routeMayBeMissing(
        http.get<WireList<WireProduct>>("/v1/products", {
          query: {
            q: params?.q,
            status: statusParam(params?.status),
            categoryId: params?.categoryId,
          },
        }),
        "inventario",
      ),
    ).map(toProduct),

  getProduct: async (id: Uuid): Promise<Product> =>
    toProduct(await http.get<WireProduct>(`/v1/products/${id}`)),

  createProduct: async (body: ProductInput): Promise<Product> =>
    toProduct(await http.post<WireProduct>("/v1/products", productToWire(body))),

  updateProduct: async (id: Uuid, body: Partial<ProductInput>): Promise<Product> =>
    toProduct(
      await http.patch<WireProduct>(`/v1/products/${id}`, productToWire(body as ProductInput)),
    ),

  deactivateProduct: async (id: Uuid): Promise<Product> =>
    toProduct(await http.patch<WireProduct>(`/v1/products/${id}`, { status: "inactive" })),

  reactivateProduct: async (id: Uuid): Promise<Product> =>
    toProduct(await http.patch<WireProduct>(`/v1/products/${id}`, { status: "active" })),

  /** Bodegas, categorías de producto y unidades de almacenamiento. */
  warehouses: async (): Promise<CatalogItem[]> =>
    items(
      await routeMayBeMissing(
        http.get<WireList<WireCatalogItem>>("/v1/warehouses"),
        "inventario",
      ),
    ).map(toCatalogItem),

  createWarehouse: async (name: string): Promise<CatalogItem> =>
    toCatalogItem(
      await http.post<WireCatalogItem>("/v1/warehouses", { id: uuidv7(), name }),
    ),

  productCategories: async (): Promise<CatalogItem[]> =>
    items(
      await routeMayBeMissing(
        http.get<WireList<WireCatalogItem>>("/v1/catalogs/product-categories"),
        "inventario",
      ),
    ).map(toCatalogItem),

  createProductCategory: async (name: string): Promise<CatalogItem> =>
    toCatalogItem(
      await http.post<WireCatalogItem>("/v1/catalogs/product-categories", {
        id: uuidv7(),
        name,
      }),
    ),

  storageUnits: async (): Promise<CatalogItem[]> =>
    items(
      await routeMayBeMissing(
        http.get<WireList<WireCatalogItem>>("/v1/catalogs/storage-units"),
        "inventario",
      ),
    ).map(toCatalogItem),

  createStorageUnit: async (name: string): Promise<CatalogItem> =>
    toCatalogItem(
      await http.post<WireCatalogItem>("/v1/catalogs/storage-units", { id: uuidv7(), name }),
    ),

  /**
   * The derived levels: one line per product per warehouse, and their total.
   *
   * Lines that net to zero are ABSENT rather than present as a zero — the view
   * has a `HAVING sum(qty) <> 0` — so a screen must read "not in the list" as
   * "none left" and never as "no such product".
   */
  stockLevels: async (params?: {
    productId?: Uuid;
    warehouseId?: Uuid;
  }): Promise<StockLevel[]> => {
    const res = await routeMayBeMissing(
      http.get<{ items: WireStockLevel[]; total: number }>("/v1/stock", {
        query: { productId: params?.productId, warehouseId: params?.warehouseId },
      }),
      "inventario",
    );
    return (res?.items ?? []).map(toStockLevel);
  },

  // NOT WRAPPED: `GET /v1/products/{id}/stock` exists and is the sharper form
  // of this — one product, confirmed to be ours, 404 instead of a credible
  // zero. Nothing calls it, because the movement dialog already holds the full
  // level list it loaded for the table, so a second round trip would buy only
  // freshness. The day the dialog needs that freshness, that is the route.

  listStockMoves: async (params?: {
    productId?: Uuid;
    warehouseId?: Uuid;
    reason?: StockReason;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<StockMove[]> =>
    items(
      await routeMayBeMissing(
        http.get<WireList<WireStockMove>>("/v1/stock/moves", {
          query: {
            productId: params?.productId,
            warehouseId: params?.warehouseId,
            reason: params?.reason,
            from: params?.from,
            to: params?.to,
            limit: params?.limit ? String(params.limit) : undefined,
          },
        }),
        "inventario",
      ),
    ).map(toStockMove),

  /**
   * The one write that changes what the warehouse holds.
   *
   * `qty` arrives SIGNED and the sign has to agree with the reason —
   * `stock_sign` in the database refuses the pair otherwise, so "a sale that
   * increased the stock" is not a state this system can reach. The form works
   * in positive numbers and calls `signedQty` on the way here, because asking
   * a storekeeper to type a minus sign is asking for the one day they forget.
   */
  createStockMove: async (
    body: StockMoveInput,
  ): Promise<{ move: StockMove; labelBatch: LabelBatch | null }> => {
    const res = await http.post<{ move: WireStockMove; labelBatch?: WireLabelBatch }>(
      "/v1/stock/moves",
      {
        id: body.id,
        productId: body.productId,
        warehouseId: body.warehouseId,
        plotId: body.plotId ?? null,
        plotCropId: body.plotCropId ?? null,
        qty: body.qty,
        reason: body.reason,
        note: body.note ?? null,
        // RFC 3339, NOT the plain day `openapi.yaml` promises.
        //
        // The spec says `localDay: {type: string, format: date}` on every one
        // of these three input schemas. The handlers decode into
        // `store.NewStockMove`, whose `LocalDay` is a `*time.Time`, and Go
        // will not parse "2026-08-29" into one: the answer is a 400
        // "malformed request body" that names no field, which is the single
        // most confusing failure this integration produces. Verified against
        // the running server, not inferred — see `instantOf`, which exists
        // because `plantedOn` did exactly this in Sprint 2.
        //
        // Absent means "today in the farm's timezone", which the DATABASE
        // decides — not this browser, whose clock may be anywhere.
        ...(body.date ? { localDay: instantOf(body.date) } : {}),
        // RSP-025's stickers, asked for with the movement rather than in a
        // second call: the server generates the batch and prints nothing.
        ...(body.labels ? { labels: body.labels } : {}),
        ...(body.allowNegative ? { allowNegative: true } : {}),
      },
    );
    // The 200-on-retry answers a bare movement; the 201 answers the envelope.
    const wire = (res as { move?: WireStockMove }).move ?? (res as unknown as WireStockMove);
    return {
      move: toStockMove(wire),
      labelBatch: res?.labelBatch ? toLabelBatch(res.labelBatch) : null,
    };
  },

  /**
   * The only way back through an append-only table: a second movement that is
   * the exact opposite of the first, once. `reason` is `ajuste` because that
   * is the only one whose sign is free; `reversesId` is what says what it
   * really is. A second attempt is 409 ALREADY_REVERSED.
   */
  reverseStockMove: async (id: Uuid, note: string): Promise<StockMove> =>
    toStockMove(await http.post<WireStockMove>(`/v1/stock/moves/${id}/reverse`, { note })),

  /**
   * Read a batch that already exists, rather than making another one.
   *
   * Reprinting is a GET. A screen that made a fresh batch every time somebody
   * clicked "ver stickers" would put a different code on the second sheet of
   * labels for the same sacks, which is exactly the thing the codes exist to
   * prevent.
   */
  getLabelBatch: async (id: Uuid): Promise<LabelBatch> =>
    toLabelBatch(await http.get<WireLabelBatch>(`/v1/label-batches/${id}`)),

  /* -- sales (RSP-026 … RSP-029) ------------------------------------- */

  /**
   * `status` and not an `includeVoided` flag.
   *
   * The column here is `voided_at` and not `deleted_at`, so an
   * `includeVoided` parameter looked like the honest name — until
   * `store.SaleFilter` turned out to embed the same `Filter` as every other
   * list route, for the reason its comment gives: on the screen it is the same
   * three chips. One vocabulary for "activo / inactivo / todos" across nine
   * list routes is worth more than a parameter named after the column.
   */
  listSales: async (params?: {
    q?: string;
    status?: string;
    from?: string;
    to?: string;
    productId?: Uuid;
    customerId?: Uuid;
  }): Promise<SaleList> => {
    const res = await routeMayBeMissing(
      http.get<{ items: WireSale[]; totalCents: number; totalQty: number }>("/v1/sales", {
        query: {
          q: params?.q,
          status: statusParam(params?.status),
          from: params?.from,
          to: params?.to,
          productId: params?.productId,
          customerId: params?.customerId,
        },
      }),
      "ventas",
    );
    return {
      items: (res?.items ?? []).map(toSale),
      // The server's own sum over the LIVE sales. Adding the rows up here
      // would total whatever happened to load.
      totalCents: res?.totalCents ?? 0,
      totalQty: res?.totalQty ?? 0,
    };
  },

  /**
   * A sale and its outgoing movement are ONE write. Splitting them would let
   * the sales list and the warehouse disagree with no third record to say
   * which is right.
   */
  createSale: async (body: SaleInput): Promise<Sale> =>
    toSale(
      await http.post<WireSale>("/v1/sales", {
        id: body.id,
        productId: body.productId,
        customerId: body.customerId ?? null,
        customer: body.customerName,
        warehouseId: body.warehouseId,
        qty: body.quantity,
        amountCents: body.amountCents,
        note: body.note ?? null,
        // RFC 3339, not the plain day the spec promises. See createStockMove.
        localDay: instantOf(body.date),
        allowNegativeStock: body.allowNegativeStock ?? false,
      }),
    ),

  /**
   * RSP-028, minus the quantity. That number is half of a movement that is
   * already written and append-only; changing it here would leave the
   * warehouse claiming one figure and the sales list another. The server
   * answers 400 SALE_QTY_IMMUTABLE and this signature does not offer it.
   */
  updateSale: async (
    id: Uuid,
    body: { customerId?: Uuid | null; amountCents?: number; note?: string | null; date?: string },
  ): Promise<Sale> =>
    toSale(
      await http.patch<WireSale>(`/v1/sales/${id}`, {
        customerId: body.customerId,
        amountCents: body.amountCents,
        note: body.note,
        localDay: body.date ? instantOf(body.date) : undefined,
      }),
    ),

  /**
   * RSP-029, and it is a DELETE.
   *
   * "Eliminar deja la venta inactiva" done honestly: the row is flagged AND
   * the product comes back into the warehouse as a reversing movement, in the
   * same transaction. Flagging alone would leave the coffee sold in one list
   * and gone from the other forever.
   *
   * There is no way back. The movement it reversed can be reversed only once,
   * so undoing the undo is not something the database can express — record a
   * new sale instead. That is why this is the one screen in the console whose
   * row menu has no "Reactivar".
   */
  voidSale: async (id: Uuid): Promise<Sale> =>
    toSale(await http.del<WireSale>(`/v1/sales/${id}`)),

  listCustomers: async (params?: { q?: string }): Promise<Customer[]> =>
    items(
      await routeMayBeMissing(
        http.get<WireList<WireCustomer>>("/v1/customers", { query: { q: params?.q } }),
        "ventas",
      ),
    ).map(toCustomer),

  createCustomer: async (name: string): Promise<Customer> =>
    toCustomer(await http.post<WireCustomer>("/v1/customers", { id: uuidv7(), name })),

  /* -- expenses (RSP-030 … RSP-033) ---------------------------------- */

  /**
   * The list comes back with its own total, because the screen shows one and a
   * total summed in the browser would only be the total of the page that
   * happened to load.
   */
  listExpenses: async (params?: {
    q?: string;
    status?: string;
    activityId?: Uuid;
    plotId?: Uuid;
    from?: string;
    to?: string;
  }): Promise<ExpenseList> => {
    const res = await routeMayBeMissing(
      http.get<{ items: WireExpense[]; totalCents: number; count: number }>("/v1/expenses", {
        query: {
          q: params?.q,
          status: statusParam(params?.status),
          activityId: params?.activityId,
          plotId: params?.plotId,
          from: params?.from,
          to: params?.to,
        },
      }),
      "gastos",
    );
    return {
      items: (res?.items ?? []).map(toExpense),
      // `count` and `totalCents` sit at the TOP of the envelope, beside
      // `items`, and not under a `totals` object.
      count: res?.count ?? 0,
      totalCents: res?.totalCents ?? 0,
    };
  },

  createExpense: async (body: ExpenseInput): Promise<Expense> =>
    toExpense(await http.post<WireExpense>("/v1/expenses", expenseToWire(body))),

  updateExpense: async (id: Uuid, body: ExpenseInput): Promise<Expense> =>
    toExpense(await http.patch<WireExpense>(`/v1/expenses/${id}`, expenseToWire(body))),

  deactivateExpense: async (id: Uuid): Promise<Expense> =>
    toExpense(await http.patch<WireExpense>(`/v1/expenses/${id}`, { status: "inactive" })),

  reactivateExpense: async (id: Uuid): Promise<Expense> =>
    toExpense(await http.patch<WireExpense>(`/v1/expenses/${id}`, { status: "active" })),

  /* -- super-admin --------------------------------------------------- */

  /**
   * The platform console. It can see that a farm exists and suspend it, and it
   * cannot read an employee, a work record or a peso of anybody's money — the
   * projection is the enforcement, and the permission table backs it with a
   * `Superadmin` flag a farm owner cannot satisfy.
   *
   * Two columns the Sprint 1 screen shows have no source and come back empty
   * rather than invented: the owner's address (the console cannot read users)
   * and the worker count (it cannot read employees). See `toAdminFarm`.
   */
  adminListFarms: async (params?: { q?: string; status?: string }): Promise<AdminFarm[]> =>
    items(
      await http.get<WireList<WireAdminFarm>>("/v1/admin/farms", {
        query: { q: params?.q, status: statusParam(params?.status) },
      }),
    ).map(toAdminFarm),

  /**
   * Suspension is not a delete and it is not instant: login and refresh both
   * refuse a suspended farm, so a phone already holding an access token keeps
   * working until that token expires — at most fifteen minutes.
   */
  adminSetFarmStatus: async (
    id: Uuid,
    status: "active" | "suspended",
  ): Promise<AdminFarm> =>
    toAdminFarm(await http.patch<WireAdminFarm>(`/v1/admin/farms/${id}`, { status })),
};

/* ------------------------------------------------------------------ */
/* Request bodies                                                      */
/* ------------------------------------------------------------------ */

/**
 * `decode` runs with `DisallowUnknownFields`, so each builder sends the store
 * struct's keys and NOTHING else. A stray `status` or `documentNumber` is not
 * ignored: it is a 400 whose message does not name the offending field, which
 * is a genuinely nasty thing to debug from the browser.
 */
function workerToWire(body: Partial<WorkerInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.id) out.id = body.id;
  if (body.name !== undefined) out.name = body.name;
  if (body.lastName !== undefined) out.lastName = body.lastName || null;
  if (body.documentType !== undefined) out.documentType = body.documentType || null;
  // The column is `docId`. The form still says `documentNumber`, which is the
  // phrase on the identity card.
  if (body.documentNumber !== undefined) out.docId = body.documentNumber || null;
  if (body.tag !== undefined) out.tag = body.tag || null;
  if (body.phone !== undefined) out.phone = body.phone || null;
  if (body.address !== undefined) out.address = body.address || null;
  if (body.city !== undefined) out.city = body.city || null;
  if (body.country !== undefined) out.country = body.country || null;
  // `photoDataUrl` and `startedAt` have nowhere to go: there is no media store
  // and no start-date column. Dropped here rather than sent and rejected.
  return out;
}


/**
 * A 404 on a COLLECTION route means the route is not there, not that a record
 * is missing.
 *
 * `services/api` is growing the products, sales and expenses handlers while
 * this is being written: the store layer and the migrations are in, the HTTP
 * routes are not, and `openapi.yaml` does not list them yet. Against the mock
 * everything answers; against a real server that has not caught up, a bare
 * `GET /v1/products` comes back as chi's 404 and the screen would say "no
 * encontramos ese registro", which sends whoever is looking at it hunting for
 * a product that was never created.
 *
 * The rule is only safe on collections, and that is why it is applied by hand
 * at each call site rather than in the client: `GET /v1/products/{id}` has a
 * perfectly good reason to answer 404 and must keep saying so.
 *
 * Nothing has to be flipped when the routes land. The day they answer, this
 * stops firing.
 */
async function routeMayBeMissing<T>(call: Promise<T>, module: string): Promise<T> {
  try {
    return await call;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      throw unsupported(
        "NOT_IMPLEMENTED_MODULE",
        `El servidor todavía no tiene el módulo de ${module}.`,
      );
    }
    throw e;
  }
}

function productToWire(body: ProductInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.id) out.id = body.id;
  if (body.name !== undefined) out.name = body.name;
  // Id OR name. `resolveCatalog` creates the row when only a name arrived,
  // which is the "con opción de crear" of RSP-019, and it is idempotent by
  // lower(name) so the catalogue cannot collect five "Bulto".
  if (body.categoryId) out.categoryId = body.categoryId;
  else if (body.categoryName) out.category = body.categoryName;
  if (body.storageUnitId) out.storageUnitId = body.storageUnitId;
  else if (body.storageUnit) out.storageUnit = body.storageUnit;
  if (body.note !== undefined) out.note = body.note || null;
  return out;
}

/**
 * The union collapses to the wire's four nullable columns here, and this is
 * the ONLY place it does.
 *
 * `expense_target` refuses a row with both targets or neither, so the fields
 * not named by `target` are sent as explicit nulls rather than omitted: on a
 * PATCH that moves an expense from an activity to a lot, an omitted
 * `activityId` would COALESCE back to the old one and the update would arrive
 * at the database charged to both.
 */
function expenseToWire(body: ExpenseInput): Record<string, unknown> {
  const common = {
    id: body.id,
    concept: body.concept,
    amountCents: body.amountCents,
    // RFC 3339, not the plain day the spec promises. See createStockMove.
    localDay: instantOf(body.date),
    note: body.note ?? null,
  };
  return body.target === "activity"
    ? { ...common, activityId: body.activityId, plotId: null, plotCropId: null }
    : {
        ...common,
        activityId: null,
        plotId: body.plotId,
        plotCropId: body.plotCropId ?? null,
      };
}

function plotToWire(body: PlotInput): Record<string, unknown> {
  return {
    id: body.id,
    name: body.name,
    areaHa: body.areaHa,
    department: body.department || null,
    municipality: body.municipality || null,
    ...(body.boundary ? { boundary: body.boundary } : {}),
    crops: (body.crops ?? []).map((c) => ({
      id: c.id,
      cropTypeId: c.cropTypeId,
      varietyId: c.varietyId,
      areaHa: c.areaHa,
      plantedOn: instantOf(c.plantedAt),
    })),
  };
}

/**
 * An activity needs a category and, for a work-unit activity, a unit id. The
 * form supplies names, so the unit is resolved — and created if the farm has
 * not used it before, which is what "con opción de crear una nueva" means. The
 * category goes over as a NAME: the server resolves it against the per-farm
 * catalogue and creates it when it is new, which is the whole reason that
 * catalogue is a table and not an enum.
 */
async function activityToWire(body: ActivityInput): Promise<Record<string, unknown>> {
  const payScheme = payModeToWire(body.payMode);

  let unitId: string | undefined;
  if (payScheme === "unidad_trabajo") {
    const code = (body.workUnit || "kg").trim();
    const existing = (await api.workUnits()).find(
      (u) => fold(u.code) === fold(code) || fold(u.label) === fold(code),
    );
    const unit =
      existing ??
      (await http.post<WireWorkUnit>("/v1/catalogs/work-units", { code, label: code }));
    unitId = unit.id;
  }

  /**
   * THE SEED RATE, AND WHY A WEEKLY-PRICE ACTIVITY NEEDS ONE.
   *
   * An activity priced by the week has no rate of its own — that is the whole
   * point of it, and the form says so — so this used to send `rateCents: 0`.
   * `handlers_activities.go` refuses that unconditionally, before it looks at
   * the rate source, with `400 rate.rateCents must be positive`. The effect
   * was that NO farm could create a picking activity from the web at all: the
   * one activity the entire cosecha module is keyed on. The error named a
   * field the form does not show, so it read as a bug in the server.
   *
   * The fix is not to invent a number. `store.WeekPrice` resolves an unpriced
   * week as `COALESCE(week_prices override, farm_config.price_minor)`, so the
   * farm's standing price is precisely what the server itself would charge for
   * a week nobody has priced. Seeding the row with it states what is already
   * true rather than adding a second opinion.
   *
   * A farm with no standing price is refused here, in Spanish, naming what to
   * do — rather than being passed to the server to be refused in English about
   * a field nobody typed into.
   */
  let seedRateCents = body.defaultRateCents ?? 0;
  if (seedRateCents <= 0 && body.rateSource === "weekly_price") {
    seedRateCents = (await api.getFarm()).priceCents ?? 0;
    if (seedRateCents <= 0) {
      throw unsupported(
        "FARM_PRICE_UNSET",
        "Esta actividad se paga al precio de la semana, y la finca todavía no " +
          "tiene un precio base. Póngalo en Configuración y vuelva a guardar.",
      );
    }
  }

  return {
    id: body.id,
    name: body.name,
    category: body.category,
    payScheme,
    rateSource: rateSourceToWire(body.rateSource),
    ...(unitId ? { unitId } : {}),
    rate: {
      rateCents: seedRateCents,
      validFrom: body.validFrom ? day(body.validFrom) : undefined,
      timeUnit: body.timeUnit ?? null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Login details                                                       */
/* ------------------------------------------------------------------ */

/**
 * An address belonging to several farms produces
 * `400 {code: BAD_REQUEST, details: {farms: [{id, name, role}]}}`.
 * Recognising it is what turns an error into a screen with buttons on it.
 */
function farmChoiceFrom(e: unknown): LoginChoice | null {
  if (!(e instanceof ApiError) || e.status !== 400) return null;
  const farms = e.details?.farms;
  if (!Array.isArray(farms) || farms.length === 0) return null;
  return {
    choose: true,
    memberships: farms.map((f) => {
      const row = f as { id: string; name: string; role: string };
      return {
        farmId: row.id,
        farmName: row.name,
        role: row.role === "admin" ? "administrator" : (row.role as "owner" | "weigher"),
      };
    }),
  };
}

/**
 * A stable id for this browser, so a refresh-token family belongs to a device
 * rather than to a login. Without it every reload starts a new family and the
 * server accumulates them; with it, "cerrar sesión en este navegador" means
 * something.
 */
function deviceId(): string {
  const KEY = "bascula.deviceId";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const next = uuidv7();
    localStorage.setItem(KEY, next);
    return next;
  } catch {
    // Private windows throw on access. A per-session id is still better than
    // none: it keeps one tab's refreshes inside one family.
    return uuidv7();
  }
}

/** Kept for the screens that still import it. */
export { unsupported };
