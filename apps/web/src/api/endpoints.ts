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
  GROSS_CHANGED,
  explainGrossChange,
  readGrossDetails,
  type GrossChange,
} from "./grossChange";
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
  toFarmUser,
  toLedgerEntry,
  toMeUser,
  toNote,
  toPayableLine,
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
  roleToWire,
  type Refs,
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
  FarmUser,
  FarmUserInput,
  FarmUserStatus,
  LedgerEntry,
  LoginChoice,
  LoginRequest,
  MeUser,
  PayableLine,
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
  Role,
  Sale,
  SaleInput,
  Settlement,
  SettlementSummary,
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
  WireFarmUser,
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
  WireSettlementPreview,
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
/* The settlement race guard                                           */
/* ------------------------------------------------------------------ */

/**
 * Turn a 409 GROSS_CHANGED into something the payment screen can put in front
 * of somebody.
 *
 * The server has already refused and written nothing. What is missing is a
 * NAME and a DATE on the payable ids it named, so a fresh preview is fetched —
 * deliberately unfiltered, because a payable that arrived after the screen
 * loaded has an id nobody here has seen and filtering by the approved set
 * would hide the very rows that moved the figure.
 *
 * When that preview cannot be fetched — the network went away between the two
 * calls — the dialog still gets both figures and the counts, which is enough
 * to refuse safely. What it never gets is an invented cause.
 */
async function withGrossExplanation(
  e: ApiError,
  workerId: Uuid,
  approved: PayableLine[],
): Promise<ApiError> {
  const details = readGrossDetails(e.details);
  if (!details) return e;

  let fresh: PayableLine[] = [];
  try {
    fresh = (await api.previewSettlement(workerId)).lines;
  } catch {
    // Keep what the server said.
  }

  return new ApiError(409, {
    error: {
      code: GROSS_CHANGED,
      message: e.message,
      details: explainGrossChange(details, approved, fresh) as unknown as Record<string, unknown>,
    },
  });
}

/** Reads the explanation back off the error the screen caught. */
export function grossChangeOf(e: unknown): GrossChange | null {
  if (!(e instanceof ApiError) || e.code !== GROSS_CHANGED) return null;
  const d = e.details as Partial<GrossChange>;
  if (typeof d.beforeCents !== "number" || typeof d.afterCents !== "number") return null;
  return {
    beforeCents: d.beforeCents,
    afterCents: d.afterCents,
    deltaCents: d.deltaCents ?? d.afterCents - d.beforeCents,
    addedIds: d.addedIds ?? [],
    removedIds: d.removedIds ?? [],
    added: d.added ?? [],
    removed: d.removed ?? [],
    repriced: d.repriced ?? [],
    causeIsKnown: d.causeIsKnown === true,
  };
}

/* ------------------------------------------------------------------ */
/* Settlements as records                                              */
/* ------------------------------------------------------------------ */

const byNewestFirst = (a: SettlementSummary, b: SettlementSummary) =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;

/**
 * A row of the settlements list.
 *
 * `workerName` is joined from the worker list, and an id that resolves to
 * nothing becomes "—" rather than a UUID or a blank: the list is read to
 * answer "de quién", and a blank there reads as "nobody" instead of "we could
 * not find out".
 */
function toSettlementSummary(s: WireSettlement, names: Map<Uuid, string>): SettlementSummary {
  return {
    id: s.id,
    workerId: s.workerId,
    // The list route joins the name in; the detail route does not, and then
    // the map the caller built is what answers.
    workerName: s.workerName || names.get(s.workerId) || "—",
    periodStart: day(s.periodStart),
    periodEnd: day(s.periodEnd),
    grossCents: s.grossCents,
    status: s.status === "void" ? "void" : "open",
    /**
     * `itemCount`, NOT `items.length`. The list route sends `items: []` on
     * purpose — the lines live on the detail route — so counting the array
     * printed "LÍNEAS: 0" against every settlement in the farm, including ones
     * with five. The fallback covers the detail route, which sends the lines
     * and no count.
     */
    lineCount: s.itemCount ?? (s.items ?? []).length,
    note: s.note,
    createdAt: s.createdAt,
    voidedAt: s.voidedAt,
  };
}

function toSettlement(s: WireSettlement, refs: Refs, workerName: string): Settlement {
  return {
    ...toSettlementSummary(s, new Map([[s.workerId, workerName]])),
    lines: (s.items ?? []).map(toPayableLine(refs)),
    /**
     * A line voided on its own, inside a settlement that is still open, cannot
     * happen through any route this app calls — voiding is whole-settlement.
     * It is surfaced anyway because the wire carries it, and a line that stops
     * counting towards the gross without saying so is exactly the sort of
     * silent arithmetic this screen exists to make visible.
     */
    voidedLineIds: (s.items ?? []).filter((p) => p.voided).map((p) => p.payableId),
  };
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

  /* -- the farm's users ---------------------------------------------- */

  /**
   * WHO CAN GET INTO THIS FARM, AND AS WHAT.
   *
   * `docs/casos-de-uso.md` §8 lists "Gestión de usuarios — listar y agregar
   * usuarios" and then says "pendiente de detallar", and
   * `docs/arquitectura-api.md` §329 answers it with the minimum that unblocks:
   * `GET|POST|PATCH /v1/users`, owner only. That is the shape written against
   * here, and it is written against the DOCUMENT rather than invented, which
   * is the difference between anticipating a route and making one up.
   *
   * THE SERVER SERVES IT NOW. `routes.go` has `/v1/users` and the running
   * build answers 200 — verified, not assumed. The sentence that used to
   * stand here said the opposite and had simply outlived the route landing,
   * which is how a screen ends up designed around a refusal that no longer
   * happens. `routeMayBeMissing` stays as a floor for an older server: it
   * turns a 404 into the local NOT_IMPLEMENTED refusal, and the screen shows
   * that refusal by name rather than an empty list, which would read as "this
   * farm has one user" and is a lie about who can log in.
   *
   * What the route does NOT send is `lastLoginAt` or `status`: the query
   * behind it selects id, email, name, role, email_verified_at and created_at
   * and nothing else. Both absences are carried through as absences — see
   * `toFarmUser` — because rendering "no lo sé" as "nunca" is what told the
   * owner he had never logged in.
   *
   * Only the owner. `docs/diagramas/sistema.md` §3.3 puts user management in
   * the owner column and NOT the administrator column, which is stricter than
   * `casos-de-uso.md` reads on its own; `permissions.ts` has said so since
   * sprint 1 (`config.users` is in OWNER and in neither of the others).
   */
  listFarmUsers: async (): Promise<FarmUser[]> => {
    const res = await routeMayBeMissing(
      http.get<WireList<WireFarmUser>>("/v1/users"),
      "usuarios",
    );
    return items(res).map(toFarmUser);
  },

  /**
   * Invite somebody, with the role they get.
   *
   * THERE IS NO EMAIL. `handleInviteUser` says so at the top: there is no mail
   * sender in the service, so it mints a password, hashes it, marks the address
   * verified because an administrator vouched for it, and returns the
   * plaintext ONCE in this response and nowhere else.
   *
   * That single field is the entire invitation. `toFarmUser` used to drop it
   * while the screen promised "le llega un correo", so every person invited
   * from this console got an account nobody could ever log into. It is carried
   * through now and the screen shows it, with the warning that it cannot be
   * read again.
   */
  inviteFarmUser: async (body: FarmUserInput): Promise<FarmUser> => {
    const created = await routeMayBeMissing(
      http.post<WireFarmUser>("/v1/users", {
        id: body.id,
        email: body.email.trim().toLowerCase(),
        name: body.name.trim(),
        role: roleToWire(body.role),
      }),
      "usuarios",
    );
    return toFarmUser(created);
  },

  /**
   * Change somebody's role, or take their access away.
   *
   * There is no delete. A membership that is revoked keeps its row, because
   * every work record and every settlement in the farm names the user that
   * wrote it, and a user id that resolves to nothing turns an audit trail into
   * a list of UUIDs. `status: "revoked"` is what closes the door.
   */
  updateFarmUser: async (
    id: Uuid,
    body: { role?: Role; status?: FarmUserStatus },
  ): Promise<FarmUser> => {
    const out: Record<string, unknown> = {};
    if (body.role !== undefined) out.role = roleToWire(body.role);
    if (body.status !== undefined) out.status = body.status;
    const updated = await routeMayBeMissing(
      http.patch<WireFarmUser>(`/v1/users/${id}`, out),
      "usuarios",
    );
    return toFarmUser(updated);
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
      // Caught, so a payables outage does not blank the whole profile — the
      // ledger and the notes are still worth showing. What it must NOT do is
      // turn into a figure: `?? 0` here read "$0 pendiente" for somebody owed
      // $868.000, and the screen then hid the detail because the total was
      // zero. The null travels all the way to the render.
      http.get<WirePayables>(`/v1/workers/${id}/payables`).catch(() => null),
    ]);
    return {
      worker: toWorker(profile.worker),
      balance: toBalance(profile.balance),
      workRecords: (profile.tasks ?? []).map((t) => toWorkRecord(t, refs)),
      pendingCents: payables ? payables.grossCents : null,
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
   * What settling this worker right now would produce, priced by the server.
   *
   * `/v1/settlements/preview` is not a convenience: the spec calls it "the same
   * code path the real settlement uses, so what the screen shows and what gets
   * written cannot drift apart". It honours `payableIds`, so the figure this
   * returns for a subset is exactly the figure `POST /v1/settlements` will
   * check `expectedGrossCents` against — which is what makes the guard below
   * a comparison of two identical derivations rather than of two similar ones.
   */
  previewSettlement: async (
    workerId: Uuid,
    payableIds?: Uuid[],
  ): Promise<{ lines: PayableLine[]; grossCents: number; balanceCents: number }> => {
    const range = everRange();
    const [preview, refs] = await Promise.all([
      http.post<WireSettlementPreview>("/v1/settlements/preview", {
        id: uuidv7(),
        workerId,
        from: range.from,
        to: range.to,
        ...(payableIds && payableIds.length > 0 ? { payableIds } : {}),
        note: null,
      }),
      loadRefs(),
    ]);
    return {
      lines: (preview.items ?? []).map(toPayableLine(refs)),
      // The SERVER'S figure, not a sum over the rows above. They agree today,
      // and the day a rounding rule changes they would not — and the one that
      // has to be shown is the one that will be written.
      grossCents: preview.grossCents,
      balanceCents: preview.balance?.balanceCents ?? 0,
    };
  },

  /**
   * Settle a set of pending work records: the write that turns work into money
   * owed. One `devengo` in the ledger for the gross, and every claimed record
   * marked settled so nothing can claim it twice.
   *
   * ── THE FIGURE THAT WAS APPROVED IS PART OF THE REQUEST ──────────────
   *
   * `expectedGrossCents` is REQUIRED BY THE SERVER, and required here for the
   * same reason: between the screen rendering a gross and somebody pressing
   * the button, a late weighing can arrive or the week's price can be changed,
   * and a settlement written without this field signs a figure nobody read.
   * The spec puts it plainly — "a money guard a client may omit is a guard
   * that is off in exactly the moment it matters."
   *
   * It comes from `/v1/settlements/preview`, which now honours `payableIds`,
   * so the figure shown IS the figure signed. Deriving it by adding up a table
   * on this side would be a second implementation of the server's pricing, and
   * the two would drift the first time a rounding rule changed.
   *
   * When the figure has moved the server answers 409 GROSS_CHANGED, having
   * written nothing, and the error that reaches the caller carries the reason
   * — see `withGrossExplanation`. There is deliberately no retry here and none
   * anywhere above: a retry that re-sends the stale approval is the same bug
   * with an extra click in front of it. The only way forward is a new
   * approval, which means a new `expectedGrossCents`, which means somebody
   * looked.
   *
   * 409 NOTHING_TO_SETTLE when the selection matches nothing in the period;
   * 409 PAYABLE_ALREADY_CLAIMED when somebody else settled it first, which is
   * the anti-double-pay lock and the reason the sync banner is still up.
   */
  settle: async (
    workerId: Uuid,
    payableIds: Uuid[],
    opts: {
      expectedGrossCents: number;
      expectedLines?: PayableLine[];
      note?: string;
      /**
       * The settlement's id, minted by the caller when the figure was
       * APPROVED. Passing it is what makes a second attempt a retry rather
       * than a second settlement: the server is idempotent by (farm_id, id)
       * and answers 200 with the settlement it already wrote.
       *
       * Minting it here instead — which is what this function used to do —
       * guarantees a fresh id per attempt, so the idempotency the server
       * built can never fire. The default is kept only for callers that write
       * once and cannot retry.
       */
      id?: Uuid;
    },
  ): Promise<{ id: Uuid; grossCents: number }> => {
    if (!Number.isInteger(opts.expectedGrossCents)) {
      // A programming error, not a user error, and it is caught here rather
      // than at the server's 400 so the message names the cause: reaching the
      // network without an approved figure would settle whatever the server
      // happens to hold.
      throw new Error("settle() requires expectedGrossCents: the figure the user approved");
    }
    if (payableIds.length === 0) {
      /**
       * NAMING THE SET IS NOT OPTIONAL EITHER, and it is worth being blunt
       * about why. An empty `payableIds` means "settle everything pending",
       * and it has two costs that compound:
       *
       *   1. It re-opens the race the guard exists to close. Naming the set
       *      does not merely REPORT the conflict, it REMOVES it — the
       *      settlement takes exactly what was approved, and a weighing that
       *      arrived since is simply not in it. The spec says so in as many
       *      words: "Send `payableIds`."
       *   2. When it does conflict, the server sets `payableIdsProvided:
       *      false` and sends no added/removed lists, because it was never
       *      told what the screen was showing. The difference dialog then has
       *      two figures and no cause — which is honest, and useless.
       *
       * So this app never sends it empty. A screen with nothing ticked has
       * nothing to settle and must not call this at all.
       */
      throw new Error("settle() requires the payables the user approved, by id");
    }
    const range = everRange();
    try {
      const s = await http.post<WireSettlement>("/v1/settlements", {
        id: opts.id ?? uuidv7(),
        workerId,
        from: range.from,
        to: range.to,
        payableIds,
        note: opts.note ?? null,
        expectedGrossCents: opts.expectedGrossCents,
      });
      return { id: s.id, grossCents: s.grossCents };
    } catch (e) {
      if (e instanceof ApiError && e.code === GROSS_CHANGED) {
        throw await withGrossExplanation(e, workerId, opts.expectedLines ?? []);
      }
      throw e;
    }
  },

  /* -- settlements as records ---------------------------------------- */

  /**
   * Every settlement the farm has made.
   *
   * `GET /v1/settlements` EXISTS NOW and answers 200 — verified against the
   * running server, which returns `{items, total}` with the worker's name
   * joined in and an `itemCount` per row. The comment that used to stand here
   * said the route was POST-only and 405 on a GET; that was true when it was
   * written and stopped being true without anybody deleting the sentence,
   * which is how a fallback path outlives its reason.
   *
   * The fan-out below is therefore DEAD in production and is kept only for a
   * server old enough to 404/405 the collection. It is one request per worker
   * plus one per settlement, and it exists in one piece so it can be deleted
   * in one piece. What it composed, and why that composition was the honest
   * one rather than the cheap one:
   *
   *   the ledger is the index   every settlement writes exactly one `devengo`
   *                             carrying its `settlementId`, so the union of
   *                             the workers' ledgers IS the set of settlements,
   *                             with no possibility of one being missed
   *   the settlement is the row `GET /v1/settlements/{id}` is what carries the
   *                             period actually covered and the frozen lines,
   *                             and the period is half of what the screen is
   *                             for ("de qué semana")
   *
   * Both fan-outs are parallel, which is why this is still not something to
   * call from the dashboard even on the slow path.
   */
  listSettlements: async (): Promise<SettlementSummary[]> => {
    const workers = await api.listWorkers({ status: "all" });
    const names = new Map(workers.map((w) => [w.id, `${w.name} ${w.lastName}`.trim()]));

    // If the collection route ever answers, prefer it: one request, and the
    // server's own ordering.
    try {
      const res = await http.get<WireList<WireSettlement>>("/v1/settlements");
      return items(res)
        .map((s) => toSettlementSummary(s, names))
        .sort(byNewestFirst);
    } catch (e) {
      // 405 today, 404 if the route is renamed. Anything else — a 403, an
      // expired session — is a real failure and must not be papered over by a
      // slow fallback that will fail the same way.
      if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) throw e;
    }

    const ledgers = await Promise.all(
      workers.map((w) =>
        http
          .get<WireList<WireLedgerEntry>>(`/v1/workers/${w.id}/ledger`)
          .then((r) => items(r))
          .catch(() => [] as WireLedgerEntry[]),
      ),
    );

    const ids = new Set<Uuid>();
    for (const entries of ledgers) {
      for (const e of entries) {
        if (e.kind === "devengo" && e.settlementId) ids.add(e.settlementId);
      }
    }

    const settled = await Promise.all(
      [...ids].map((id) =>
        http.get<WireSettlement>(`/v1/settlements/${id}`).catch(() => null),
      ),
    );
    return settled
      .filter((s): s is WireSettlement => s !== null)
      .map((s) => toSettlementSummary(s, names))
      .sort(byNewestFirst);
  },

  /**
   * One settlement with the lines it froze.
   *
   * The worker is fetched alongside rather than after: the settlement carries
   * a `workerId` and no name, and a receipt headed by a UUID is not a receipt.
   * A worker who has since been removed still resolves — `getWorker` reads the
   * row, not the tombstone — because a settlement outlives the employment.
   */
  getSettlement: async (id: Uuid): Promise<Settlement> => {
    const s = await http.get<WireSettlement>(`/v1/settlements/${id}`);
    const [refs, worker] = await Promise.all([
      loadRefs(),
      api.getWorker(s.workerId).catch(() => null),
    ]);
    return toSettlement(s, refs, worker ? `${worker.name} ${worker.lastName}`.trim() : "—");
  },

  /**
   * Cancel a settlement. The lines keep their rows and gain a `voidedAt`,
   * which is what releases their payables; the earning is cancelled by a
   * reversal, never deleted.
   *
   * `docs/diagramas/movil.md`: "No hay void -> open. Anular es definitivo."
   * The screen asks before calling this, and says that sentence while asking.
   */
  voidSettlement: async (id: Uuid, reversalId?: Uuid): Promise<Settlement> => {
    // The id OF THE REVERSAL, minted by the caller when the person confirmed,
    // so a resend is a retry the server can recognise rather than a second
    // attempt to undo — which is a 409 at best. See `lib/writeOnce.ts`.
    const s = await http.post<WireSettlement>(`/v1/settlements/${id}/void`, {
      id: reversalId ?? uuidv7(),
    });
    const [refs, worker] = await Promise.all([
      loadRefs(),
      api.getWorker(s.workerId).catch(() => null),
    ]);
    return toSettlement(s, refs, worker ? `${worker.name} ${worker.lastName}`.trim() : "—");
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
      if (body.expectedGrossCents === undefined) {
        throw new Error(
          "createPayment() with payableIds requires expectedGrossCents: " +
            "the gross the user saw and approved",
        );
      }
      await api.settle(body.workerId, body.payableIds, {
        expectedGrossCents: body.expectedGrossCents,
        expectedLines: body.expectedLines,
        // Same id on every attempt at the same approved figure, so a retry
        // re-uses the settlement instead of writing a second one. See
        // `lib/writeOnce.ts` for why the caller mints it and not us.
        id: body.settlementId,
      });
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
