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
  toPlot,
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
  WirePlot,
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
   * type ever crosses the wire. The response carries both hectare figures and
   * any plots this one now overlaps; an overlap is a warning, never a refusal.
   */
  setPlotBoundary: async (id: Uuid, boundary: unknown): Promise<Plot> => {
    const p = await http.put<WirePlot>(`/v1/plots/${id}/boundary`, { boundary });
    return toPlot(p);
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

function plotToWire(body: PlotInput): Record<string, unknown> {
  return {
    id: body.id,
    name: body.name,
    areaHa: body.areaHa,
    department: body.department || null,
    municipality: body.municipality || null,
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

  return {
    id: body.id,
    name: body.name,
    category: body.category,
    payScheme,
    rateSource: rateSourceToWire(body.rateSource),
    ...(unitId ? { unitId } : {}),
    rate: {
      rateCents: body.defaultRateCents ?? 0,
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
