/**
 * `services/api`, emulated. Not "an API-shaped thing the screens are happy
 * with" — the actual routes, the actual bodies, the actual codes.
 *
 * WHY THIS FILE WAS REWRITTEN IN SPRINT 2
 *
 * The sprint-1 mock was built from `docs/arquitectura-api.md`. The Go service
 * that shipped disagrees with that document in a couple of dozen places, and a
 * mock that keeps the document's shapes is worse than no mock at all: every
 * test passes through an adapter that will never run in production, and the
 * adapter that will run is the one nothing exercises. So the contract here is
 * now `src/api/wire.ts` and, behind it, `routes.go`, `perm.go` and
 * `domain/errors.go`. Where this file and the Go service disagree, this file
 * is wrong.
 *
 * Four rules keep it honest:
 *
 * 1. **The error envelope is the server's.** `{"error":{code,message,details}}`
 *    with codes out of `domain/errors.go`. The old mock invented
 *    PERMISSION_DENIED and UNAUTHENTICATED; the server has never sent either —
 *    it sends FORBIDDEN and UNAUTHORIZED/TOKEN_EXPIRED. `message` stays in the
 *    server's English on purpose (see the note on `fail`).
 *
 * 2. **The role matrix is a table, not an `if` per handler.** MATRIX below is
 *    a transcription of `auth.Matrix`, and every handler declares one action.
 *    A weigher therefore gets a real 403 on the whole money surface, and the
 *    narrow projections on workers and activities, exactly as he would in
 *    production.
 *
 * 3. **Derived figures are derived.** Balances are summed from the ledger on
 *    every read; `settled` is an existence check against live settlement items;
 *    a `weekly_price` payable is priced at settlement time. Nothing is stored
 *    that the server computes.
 *
 * 4. **Writes are idempotent by id and deletes are logical.** Re-posting a
 *    worker, plot, activity, work record or settlement whose id already exists
 *    answers 200 with the existing row, because a retry after a timeout must
 *    not be a conflict. Nothing is ever removed: a delete sets `deletedAt` or
 *    `archivedAt` and answers 204.
 *
 * Writes mutate the module-level store, so a session survives navigation and
 * resets on reload. `db.resetDb()` puts the farm back for a test that spent
 * somebody's balance.
 */
import { http, HttpResponse, delay } from "msw";
import * as db from "./db";
import { cropLabel } from "../api/adapters";
import { addDays, mondayOf, parseDay } from "../lib/dates";
import { readHarvest } from "../../../../packages/shared/src/harvest";
import * as geo from "../lib/geo";
import type {
  ActivityRequestBody,
  CatalogItemRequestBody,
  CustomerRequestBody,
  ExpenseRequestBody,
  LoginRequestBody,
  PlotCropRequestBody,
  PlotRequestBody,
  ProductRequestBody,
  RateRequestBody,
  RefreshRequestBody,
  ReverseRequestBody,
  SaleRequestBody,
  SignupRequestBody,
  StockMoveRequestBody,
  VerifyEmailRequestBody,
  WeekPriceRequestBody,
  WireActivity,
  WireActivityRate,
  WireCatalogItem,
  WireCustomer,
  WireEmployee,
  WireExpense,
  WireLedgerEntry,
  WireLedgerKind,
  WireLedgerRequest,
  WireNote,
  WirePayMethod,
  WireLabel,
  WireLabelBatch,
  WirePlot,
  WirePlotCrop,
  WireProduct,
  WireRole,
  WireSale,
  WireStockMove,
  WireStockReason,
  WireSession,
  WireSettlementRequest,
  WireWorkRecordRequest,
  WireWorkerPublic,
  WorkerRequestBody,
  WorkUnitRequestBody,
} from "./types";

/* -- the error envelope ---------------------------------------------- */

/**
 * `render.go`'s `errorBody`. `details` is `omitempty` there, so it is absent
 * here too rather than present-and-undefined.
 *
 * The message stays in ENGLISH, which is a deliberate reversal of what the
 * sprint-1 mock did. `render.go` says it plainly: the client branches on
 * `code` and the translation lives in the client. A mock that answers in
 * Spanish lets a screen display the server's message and look perfectly
 * correct, right up until production answers in English. The Spanish belongs
 * in `ERROR_MESSAGES` in `src/api/errors.ts`, keyed by code, and nowhere else.
 */
function fail(status: number, code: string, message: string, details?: Record<string, unknown>) {
  return HttpResponse.json(
    { error: details === undefined ? { code, message } : { code, message, details } },
    { status },
  );
}

const badRequest = (message: string, details?: Record<string, unknown>) =>
  fail(400, "BAD_REQUEST", message, details);
const notFound = () => fail(404, "NOT_FOUND", "resource not found");
const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  fail(409, code, message, details);

const noContent = () => new HttpResponse(null, { status: 204 });

/* -- tokens ---------------------------------------------------------- */

const ACCESS_PREFIX = "mock-access.";
const REFRESH_PREFIX = "mock-refresh.";
/** `auth.AccessTTL`. Short on purpose: the client's refresh path is real code. */
const ACCESS_TTL_SECONDS = 900;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * `mock-access.<userId>.<farmId>.<issuedAt>.<expiresAt>`.
 *
 * The trailing halves are optional so that a test may still hand-write
 * `mock-access.<userId>.test` and be signed in, which is how the navigation
 * tests sign in without going through the login box. A token with no expiry
 * never expires by the clock — but `db.expireAccessTokens()` still reaches it,
 * because that seam exists precisely so a test can drive the 401.
 */
function mintAccessToken(userId: string, farmId: string): string {
  const now = Date.now();
  return `${ACCESS_PREFIX}${userId}.${farmId}.${now}.${now + ACCESS_TTL_SECONDS * 1000}`;
}

interface Principal {
  user: db.MockUser;
  farmId: string;
  role: WireRole;
  tenant: db.Tenant;
}

type Guarded = { p: Principal; deny: null } | { p: null; deny: Response };

/**
 * Resolve the caller, or say why not. The two 401s are different codes and the
 * client tells them apart: UNAUTHORIZED means "no usable token, go to login",
 * TOKEN_EXPIRED means "rotate the refresh token and replay".
 */
function authenticate(request: Request): Guarded {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return { p: null, deny: fail(401, "UNAUTHORIZED", "a bearer token is required") };
  }
  const token = header.slice(7);
  if (!token.startsWith(ACCESS_PREFIX)) {
    return { p: null, deny: fail(401, "UNAUTHORIZED", "that access token is not valid") };
  }
  const [userId, farmPart, issuedPart, expiryPart] = token.slice(ACCESS_PREFIX.length).split(".");

  const issuedAt = Number.isNaN(Number(issuedPart)) ? 0 : Number(issuedPart);
  const expiresAt = Number.isNaN(Number(expiryPart)) ? null : Number(expiryPart);
  if ((expiresAt !== null && expiresAt <= Date.now()) || issuedAt < db.accessTokenEpochMs()) {
    return { p: null, deny: fail(401, "TOKEN_EXPIRED", "the access token has expired") };
  }

  const user = db.users.find((u) => u.id === userId);
  if (!user) {
    return { p: null, deny: fail(401, "UNAUTHORIZED", "that access token is not valid") };
  }
  const owned = db.membershipsOf(user.id);
  const membership = owned.find((m) => m.farmId === farmPart) ?? owned[0];
  if (!membership) {
    return { p: null, deny: fail(403, "FORBIDDEN", "that account belongs to no farm") };
  }
  const tenant = db.tenantOf(membership.farmId);
  if (!tenant) {
    // RLS answers a query with zero rows and no error when app.farm_id is
    // unset, and an empty worker list reads exactly like a new farm. So a
    // missing tenant is a loud 500 here too, never a plausible empty 200.
    return {
      p: null,
      deny: fail(500, "TENANT_NOT_SET", "tenant context was not established for this request"),
    };
  }
  return { p: { user, farmId: membership.farmId, role: membership.role, tenant }, deny: null };
}

/* -- the permission table -------------------------------------------- */

/**
 * `auth.Matrix`, transcribed. It lives in one table for the same reason it
 * does on the server: a table can be walked by a test and a hundred `if`s
 * cannot. Only the actions this mock serves are listed; the ones marked
 * `Money: true` on the server are exactly the ones a weigher is refused here.
 */
type Action =
  | "me.read"
  | "auth.logout"
  | "farm.read"
  | "farm.write"
  | "admin.farms.read"
  | "admin.farms.write"
  | "workers.read"
  | "workers.write"
  | "workers.read_private"
  | "workers.notes.read"
  | "workers.notes.write"
  | "workers.payables.read"
  | "plots.read"
  | "plots.write"
  | "plots.boundary.write"
  | "catalogs.read"
  | "catalogs.write"
  | "activities.read"
  | "activities.write"
  | "activities.rate.write"
  | "work_records.read"
  | "work_records.write"
  | "work_records.admin"
  | "prices.read"
  | "prices.write"
  | "settlements.preview"
  | "settlements.read"
  | "settlements.write"
  | "settlements.void"
  | "pending.read"
  | "balances.read"
  | "ledger.read"
  | "ledger.payment"
  | "ledger.advance"
  | "ledger.deduction"
  | "ledger.adjust"
  | "ledger.reverse"
  | "products.read"
  | "products.write"
  | "stock.read"
  | "stock.write"
  | "sales.read"
  | "sales.write"
  | "sales.void"
  | "expenses.read"
  | "expenses.write"
  | "reports.read";

const owners: WireRole[] = ["owner"];
const admins: WireRole[] = ["owner", "admin"];
const everyone: WireRole[] = ["owner", "admin", "weigher"];

interface Rule {
  roles: WireRole[];
  /**
   * The platform flag, required ON TOP of the farm role. It is not a fourth
   * role: a super-admin administers farms from the outside and cannot read
   * inside one, which is why only the two console actions carry it.
   */
  superadmin?: true;
}

const MATRIX: Record<Action, Rule> = {
  "me.read": { roles: everyone },
  "auth.logout": { roles: everyone },

  // Everybody reads the farm — the weigher's client needs the timezone and the
  // currency to render a date and an amount — but `priceCents` is dropped from
  // his projection. Only the owner writes it.
  "farm.read": { roles: everyone },
  "farm.write": { roles: owners },

  "admin.farms.read": { roles: everyone, superadmin: true },
  "admin.farms.write": { roles: everyone, superadmin: true },

  "workers.read": { roles: everyone },
  "workers.write": { roles: admins },
  "workers.read_private": { roles: admins },
  // A person's private file, on the weigher's deny list next to payroll.
  "workers.notes.read": { roles: admins },
  "workers.notes.write": { roles: admins },
  "workers.payables.read": { roles: admins },

  "plots.read": { roles: everyone },
  "plots.write": { roles: admins },
  "plots.boundary.write": { roles: admins },

  "catalogs.read": { roles: everyone },
  "catalogs.write": { roles: admins },

  "activities.read": { roles: everyone },
  "activities.write": { roles: admins },
  "activities.rate.write": { roles: owners },

  "work_records.read": { roles: everyone },
  "work_records.write": { roles: everyone },
  "work_records.admin": { roles: admins },

  "prices.read": { roles: admins },
  "prices.write": { roles: owners },

  "settlements.preview": { roles: admins },
  "settlements.read": { roles: admins },
  "settlements.write": { roles: admins },
  "settlements.void": { roles: admins },
  "pending.read": { roles: admins },
  "balances.read": { roles: admins },
  "ledger.read": { roles: admins },
  "ledger.payment": { roles: admins },
  "ledger.advance": { roles: admins },
  "ledger.deduction": { roles: admins },
  "ledger.adjust": { roles: admins },
  "ledger.reverse": { roles: admins },

  /**
   * The four new surfaces, and the weigher is on none of them.
   *
   * `docs/modelo-datos.md` §790: "ventas, gastos y stock_moves quedan fuera del
   * pesador con la misma forma que ledger." The movements go with the money
   * for a reason that is not obvious until you look at one: a movement names
   * the plot and the crop it came out of, so the list of them is a yield
   * report, and a yield report is exactly the figure the ledger keeps away
   * from whoever holds the scale.
   *
   * Migrations 00009 and 00010 say the same thing one layer down — every one
   * of these tables carries `current_role_name() IN ('owner','admin')` inside
   * its RLS policy, so a weigher who got past this table would still read
   * nothing. Denying it here is the message; denying it there is the guarantee.
   */
  "products.read": { roles: admins },
  "products.write": { roles: admins },
  "stock.read": { roles: admins },
  "stock.write": { roles: admins },
  "sales.read": { roles: admins },
  "sales.write": { roles: admins },
  // Voiding has an ACTION OF ITS OWN in `auth.Matrix`, not because the roles
  // differ today — they are the same `admins` — but because it is the one
  // write in this module that moves stock backwards, and an action is the
  // only unit the role table can later be changed in.
  "sales.void": { roles: admins },
  "expenses.read": { roles: admins },
  "expenses.write": { roles: admins },

  // `auth.Matrix` has this as {Roles: admins, Money: true}: a report is a read
  // of everybody's figures at once, so the weigher gets a 403 on all six.
  "reports.read": { roles: admins },
};

/**
 * Every picker that answers "add it if it is not there", with the PATH and the
 * ACTION each one really has in `routes.go`.
 *
 * Two things here were guesses that turned out wrong, and both are worth
 * keeping written down rather than silently fixed:
 *
 *   BODEGAS ARE NOT UNDER /v1/catalogs. They are `/v1/warehouses`, a resource
 *   of their own. Reading the route table rather than inferring from the shape
 *   is the whole lesson: a warehouse looks exactly like a catalogue from here
 *   — id and name, idempotent by lower(name), same handler on the server
 *   (`handleListCatalog(store.CatalogWarehouses)`) — and it still is not at
 *   that path.
 *
 *   THE PRODUCT PICKERS ARE NOT `catalogs.*`. `product-categories` and
 *   `storage-units` live under /v1/catalogs but are guarded by
 *   `products.read`/`products.write`, which is what puts them behind the same
 *   door as the module they belong to. A weigher may read crop types and may
 *   NOT read storage units, and that difference is only visible in the route
 *   table.
 *
 * Every POST here answers 200 and never 201: the caller does not need to know
 * whether the row already existed, only that this is the row that name means
 * on this farm. That is what makes the button safe to press twice.
 */
const CATALOG_ROUTES: Array<
  [path: string, pick: (t: db.Tenant) => WireCatalogItem[], read: Action, write: Action]
> = [
  ["catalogs/activity-categories", (t) => t.activityCategories, "catalogs.read", "catalogs.write"],
  ["catalogs/crop-types", (t) => t.cropTypes, "catalogs.read", "catalogs.write"],
  ["catalogs/varieties", (t) => t.varieties, "catalogs.read", "catalogs.write"],
  ["catalogs/product-categories", (t) => t.productCategories, "products.read", "products.write"],
  ["catalogs/storage-units", (t) => t.storageUnits, "products.read", "products.write"],
  ["warehouses", (t) => t.warehouses, "products.read", "products.write"],
];

/** Authenticate, then consult the table. Every handler starts with this. */
function guard(request: Request, action: Action): Guarded {
  const g = authenticate(request);
  if (!g.p) return g;
  const rule = MATRIX[action];
  if (!rule.roles.includes(g.p.role) || (rule.superadmin && !g.p.user.superadmin)) {
    return { p: null, deny: fail(403, "FORBIDDEN", "that role may not perform this action") };
  }
  return g;
}

/**
 * A projection decision, not an authorisation one: the table already let the
 * request through, and this only picks how much of the row goes on the wire.
 */
const seesPrivateData = (p: Principal) => p.role === "owner" || p.role === "admin";

/* -- small helpers --------------------------------------------------- */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const nowInstant = () => new Date().toISOString();
const today = () => nowInstant().slice(0, 10);

function matches(haystack: string | null, needle: string | null): boolean {
  if (!needle) return true;
  if (!haystack) return false;
  return haystack.toLocaleLowerCase("es").includes(needle.toLocaleLowerCase("es"));
}

const sameName = (a: string, b: string) =>
  a.trim().toLocaleLowerCase("es") === b.trim().toLocaleLowerCase("es");

/** `parseRange`: both ends mandatory, both `YYYY-MM-DD`, `to` not before `from`. */
function parseRange(from: string | null, to: string | null): { from: string; to: string } | Response {
  if (!from || !to) return badRequest("from and to are required, YYYY-MM-DD");
  if (!DAY.test(from)) return badRequest("from must be YYYY-MM-DD");
  if (!DAY.test(to)) return badRequest("to must be YYYY-MM-DD");
  if (to < from) return badRequest("to cannot be before from");
  return { from, to };
}

/**
 * `store.Filter`. The default list is the live one; only an explicit status
 * brings deleted rows back. `includeDeleted=true` is kept as a synonym for
 * `status=all`, because the phone already sends it.
 */
function listStatus(params: URLSearchParams): (deletedAt: string | null | undefined) => boolean {
  let status = params.get("status") ?? "";
  if (!status && params.get("includeDeleted") === "true") status = "all";
  if (status === "inactive") return (deletedAt) => deletedAt != null;
  if (status && status !== "active") return () => true;
  return (deletedAt) => deletedAt == null;
}

/**
 * `validStatus`. An unrecognised value is a 400 rather than a silent no-op:
 * `"status":"Inactive"` quietly doing nothing is how a delete button ships
 * broken.
 */
function validStatus(status: string | undefined): Response | null {
  if (status === undefined || status === "" || status === "active" || status === "inactive") {
    return null;
  }
  return badRequest('status must be "active" or "inactive"');
}

/** COALESCE semantics: an absent field and an explicit null both keep the old value. */
function patch<T extends object, K extends keyof T>(row: T, value: T[K] | undefined | null, key: K) {
  if (value !== undefined && value !== null) row[key] = value;
}

/** `EnsureCatalogItem`: idempotent by lower(name), so a picker cannot duplicate. */
function ensureCatalogItem(list: WireCatalogItem[], name: string, id?: string): WireCatalogItem {
  const existing = list.find((i) => sameName(i.name, name));
  if (existing) return existing;
  const created = { id: id ?? crypto.randomUUID(), name: name.trim() };
  list.push(created);
  return created;
}

/* -- projections ----------------------------------------------------- */

/** The weigher's four fields: enough to pick a person at the scale, no more. */
function projectWorker(e: WireEmployee, full: boolean): WireEmployee | WireWorkerPublic {
  if (full) return e;
  return { id: e.id, name: e.name, lastName: e.lastName, tag: e.tag };
}

/**
 * The weigher's activity list has NO `rate` key at all — `omitempty` on a nil
 * pointer, not a null. Neither does anybody's, on a day when no rate is in
 * force; `wire.ts` warns never to assume it is there.
 */
function projectActivity(a: db.MockActivity, withRates: boolean, on: string): WireActivity {
  const { rates: _rates, ...rest } = a;
  if (!withRates) return rest;
  const rate = db.rateInForce(a, on);
  return rate ? { ...rest, rate } : rest;
}

/** `GetSettlement`: the items are re-read through the work records, as there. */
function projectSettlement(t: db.Tenant, s: db.MockSettlement) {
  const { items, ...rest } = s;
  return {
    ...rest,
    items: items.map((item) => {
      const record = t.workRecords.find((r) => r.id === item.payableId);
      const activity = t.activities.find((a) => a.id === record?.activityId);
      return {
        payableId: item.payableId,
        activityId: record?.activityId ?? "",
        activity: activity?.name ?? "",
        payScheme: record?.payScheme ?? "unidad_trabajo",
        rateSource: record?.rateSource ?? "explicit",
        quantity: item.quantity,
        unitId: record?.unitId ?? null,
        date: record?.dateFrom ?? item.weekStart,
        weekStart: item.weekStart,
        rateCents: item.rateCents,
        amountCents: item.amountCents,
        voided: item.voidedAt !== null,
      };
    }),
  };
}

/* -- sessions -------------------------------------------------------- */

/** `issueSession`: a short access token and an opaque, single-use refresh one. */
function issueSession(user: db.MockUser, membership: db.MockMembership, familyId: string): WireSession {
  const refreshToken = `${REFRESH_PREFIX}${crypto.randomUUID()}`;
  db.refreshTokens.push({
    token: refreshToken,
    familyId,
    userId: user.id,
    farmId: membership.farmId,
    expiresAt: Date.now() + REFRESH_TTL_MS,
    rotatedAt: null,
    revokedAt: null,
  });
  const farm = db.farmOf(membership.farmId);
  return {
    accessToken: mintAccessToken(user.id, membership.farmId),
    refreshToken,
    expiresIn: ACCESS_TTL_SECONDS,
    farmId: membership.farmId,
    farmName: farm?.name ?? "",
    role: membership.role,
  };
}

/* -- handlers -------------------------------------------------------- */

export const handlers = [
  http.get("*/health", () => HttpResponse.json({ status: "ok" })),

  /* ---- signup ---- */

  /**
   * `handleSignup`. The most exposed surface in the system, and the
   * validations are the contract: a password under ten characters, a farm
   * without a name and a farm without a price are all 400 BAD_REQUEST, not a
   * "VALIDATION_FAILED" with a field map — the server has no such code.
   *
   * The per-IP rate limit is the one guard not emulated: MSW has no client
   * address to count against.
   */
  http.post("*/v1/signup", async ({ request }) => {
    await delay(400);
    const body = (await request.json()) as SignupRequestBody;
    const email = body.owner?.email?.trim().toLowerCase() ?? "";
    if (!email || !email.includes("@")) return badRequest("owner.email is required");
    if ((body.owner?.password ?? "").length < 10) {
      return badRequest("owner.password must be at least 10 characters");
    }
    if (!body.farm?.name?.trim()) return badRequest("farm.name is required");
    if (!body.farm.priceCents || body.farm.priceCents <= 0) {
      return badRequest("farm.priceCents must be positive");
    }

    const password = body.owner!.password!;
    let user = db.users.find((u) => u.email === email);
    if (user) {
      // An existing address may open a second farm, but only by proving it
      // owns the account, and only up to the cap.
      if (user.password !== password) {
        return conflict("EMAIL_TAKEN", "that address already has an account");
      }
      if (db.membershipsOf(user.id).length >= 3) {
        return conflict("FARM_LIMIT_REACHED", "that address already owns as many farms as it may");
      }
    } else {
      user = {
        id: crypto.randomUUID(),
        email,
        password,
        name: body.owner?.name ?? "",
        superadmin: false,
        // Born unverified: the farm exists, but nobody can open a session on
        // it until the address is confirmed.
        emailVerified: false,
        role: "owner",
      };
      db.users.push(user);
    }

    const farmId = crypto.randomUUID();
    db.farms.push({
      id: farmId,
      name: body.farm.name.trim(),
      timezone: body.farm.timezone || "America/Bogota",
      currency: body.farm.currency || "COP",
      minorUnit: 2,
      phone: null,
      country: null,
      city: null,
      address: null,
      areaHa: null,
      suspendedAt: null,
      createdAt: nowInstant(),
      priceCents: body.farm.priceCents,
    });
    db.memberships.push({ farmId, userId: user.id, role: "owner" });
    // `seedFarm`: a kilo and a "Recoleccion" priced from the weekly table, so
    // the farm can weigh coffee on day one. Nothing else.
    db.tenants.set(farmId, db.emptyTenant(farmId, body.farm.priceCents, () => crypto.randomUUID()));

    const verificationToken = crypto.randomUUID();
    db.verifications.push({ token: verificationToken, userId: user.id, farmId, consumedAt: null });

    return HttpResponse.json(
      {
        farmId,
        userId: user.id,
        verificationRequired: true,
        // `DevEcho`. There is no mail sender yet, so in development the token
        // comes back in the response and the app offers to verify in place. In
        // production this key is simply absent.
        verificationToken,
      },
      { status: 201 },
    );
  }),

  http.post("*/v1/auth/verify-email", async ({ request }) => {
    const body = (await request.json()) as VerifyEmailRequestBody;
    const row = db.verifications.find((v) => v.token === body.token && v.consumedAt === null);
    if (!row) return badRequest("that verification link is not valid any more");
    row.consumedAt = Date.now();
    const user = db.users.find((u) => u.id === row.userId);
    if (user) user.emailVerified = true;
    return HttpResponse.json({ userId: row.userId, verified: true });
  }),

  /* ---- login, refresh, logout ---- */

  http.post("*/v1/auth/login", async ({ request }) => {
    await delay(350);
    const body = (await request.json()) as LoginRequestBody;
    const email = body.email?.trim().toLowerCase();
    const user = db.users.find((u) => u.email === email);

    // One answer whether the address exists or not: telling them apart is a
    // free account-enumeration oracle.
    if (!user || user.password !== body.password) {
      return fail(401, "INVALID_CREDENTIALS", "email or password is not correct");
    }
    if (!user.emailVerified) {
      return fail(403, "EMAIL_NOT_VERIFIED", "verify the email address before opening a session");
    }

    const owned = db.membershipsOf(user.id);
    if (owned.length === 0) return fail(403, "FORBIDDEN", "that account belongs to no farm");

    let chosen: db.MockMembership | undefined;
    if (body.farmId) {
      chosen = owned.find((m) => m.farmId === body.farmId);
      if (!chosen) return fail(403, "FORBIDDEN", "that account does not belong to that farm");
    } else if (owned.length === 1) {
      chosen = owned[0];
    } else {
      // An error envelope, not a success body: the client has to catch it,
      // which is why the farm choice cannot be a union arm of the response.
      return badRequest("choose a farm", {
        farms: owned.map((m) => ({
          id: m.farmId,
          name: db.farmOf(m.farmId)?.name ?? "",
          role: m.role,
        })),
      });
    }
    if (db.farmOf(chosen.farmId)?.suspendedAt) {
      return fail(403, "FARM_SUSPENDED", "that farm is suspended");
    }
    return HttpResponse.json(issueSession(user, chosen, crypto.randomUUID()));
  }),

  /**
   * `handleRefresh` rotates. Every refresh token is single use: presenting one
   * that was already rotated means a replay or a stolen copy, so the whole
   * family dies rather than the request merely failing. That is what makes the
   * client's single-flight refresh worth having, and it is only testable if
   * the mock actually does it.
   */
  http.post("*/v1/auth/refresh", async ({ request }) => {
    const body = (await request.json()) as RefreshRequestBody;
    const row = db.refreshTokens.find((t) => t.token === body.refreshToken);
    if (!row) return fail(401, "TOKEN_EXPIRED", "that refresh token is not valid");
    if (row.revokedAt !== null) return fail(401, "TOKEN_REUSED", "that session was closed");
    if (row.rotatedAt !== null) {
      for (const t of db.refreshTokens) {
        if (t.familyId === row.familyId && t.revokedAt === null) t.revokedAt = Date.now();
      }
      return fail(
        401,
        "TOKEN_REUSED",
        "that refresh token was already used; the session has been closed",
      );
    }
    if (row.expiresAt <= Date.now()) return fail(401, "TOKEN_EXPIRED", "that refresh token expired");

    const user = db.users.find((u) => u.id === row.userId);
    const membership = db.membershipFor(row.farmId, row.userId);
    if (!user || !membership) return fail(401, "TOKEN_EXPIRED", "that refresh token is not valid");
    if (db.farmOf(row.farmId)?.suspendedAt) {
      return fail(403, "FARM_SUSPENDED", "that farm is suspended");
    }
    row.rotatedAt = Date.now();
    return HttpResponse.json(issueSession(user, membership, row.familyId));
  }),

  http.post("*/v1/auth/logout", async ({ request }) => {
    const g = guard(request, "auth.logout");
    if (g.deny) return g.deny;
    const body = (await request.json().catch(() => ({}))) as RefreshRequestBody;
    const row = db.refreshTokens.find((t) => t.token === body.refreshToken);
    if (row) {
      for (const t of db.refreshTokens) {
        if (t.familyId === row.familyId && t.revokedAt === null) t.revokedAt = Date.now();
      }
    }
    // Logging out an unknown token is still a successful logout.
    return noContent();
  }),

  /**
   * `handleMe`. Note what is NOT here: no farm status, no trial counter, no
   * membership list. The old view model had all three and the old mock made
   * values up for them.
   */
  http.get("*/v1/me", ({ request }) => {
    const g = guard(request, "me.read");
    if (g.deny) return g.deny;
    const farm = db.farmOf(g.p.farmId);
    return HttpResponse.json({
      id: g.p.user.id,
      email: g.p.user.email,
      name: g.p.user.name,
      role: g.p.role,
      farm: {
        id: g.p.farmId,
        name: farm?.name ?? "",
        timezone: farm?.timezone ?? "America/Bogota",
        currency: farm?.currency ?? "COP",
      },
      superadmin: g.p.user.superadmin,
    });
  }),

  /* ---- the farm, and the console outside it ---- */

  /**
   * There is no `/v1/farms/{id}`: the tenant travels in the token, and a farm
   * id in the path invites somebody to trust it. The weigher gets the same
   * route and a shorter answer — `priceCents` is simply absent for him.
   */
  http.get("*/v1/farm", ({ request }) => {
    const g = guard(request, "farm.read");
    if (g.deny) return g.deny;
    const farm = db.farmOf(g.p.farmId);
    if (!farm) return notFound();
    const { priceCents, ...rest } = farm;
    return seesPrivateData(g.p)
      ? HttpResponse.json({ ...rest, priceCents })
      : HttpResponse.json(rest);
  }),

  http.put("*/v1/farm", async ({ request }) => {
    const g = guard(request, "farm.write");
    if (g.deny) return g.deny;
    const farm = db.farmOf(g.p.farmId);
    if (!farm) return notFound();
    const body = (await request.json()) as Partial<db.MockFarm>;
    if (body.priceCents != null && body.priceCents <= 0) {
      return badRequest("priceCents must be positive");
    }
    // The timezone is patchable and validated: a bad IANA name would silently
    // shift every business day this farm has ever recorded.
    if (body.timezone != null && !isTimezone(body.timezone)) {
      return badRequest("that is not a valid IANA timezone name");
    }
    patch(farm, body.name, "name");
    patch(farm, body.timezone, "timezone");
    patch(farm, body.currency, "currency");
    patch(farm, body.phone, "phone");
    patch(farm, body.country, "country");
    patch(farm, body.city, "city");
    patch(farm, body.address, "address");
    patch(farm, body.areaHa, "areaHa");
    patch(farm, body.priceCents, "priceCents");
    return HttpResponse.json(farm);
  }),

  /**
   * The console can see that a farm exists and suspend it, and nothing else.
   * Every field below is a column of `farms`; the projection IS the
   * enforcement, because none of them is a way to infer what is inside.
   */
  http.get("*/v1/admin/farms", ({ request }) => {
    const g = guard(request, "admin.farms.read");
    if (g.deny) return g.deny;
    const params = new URL(request.url).searchParams;
    const status = params.get("status") ?? "";
    if (!["", "active", "suspended"].includes(status)) {
      return badRequest('status must be "active" or "suspended"');
    }
    const q = params.get("q");
    return HttpResponse.json({
      items: db.farms
        .filter((f) => matches(f.name, q))
        .filter(
          (f) =>
            !status ||
            (status === "active" ? f.suspendedAt === null : f.suspendedAt !== null),
        )
        .sort((a, b) => a.name.localeCompare(b.name, "es"))
        .map(adminFarm),
    });
  }),

  http.patch("*/v1/admin/farms/:id", async ({ request, params }) => {
    const g = guard(request, "admin.farms.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as { status?: string };
    if (body.status !== "active" && body.status !== "suspended") {
      return badRequest('status must be "active" or "suspended"');
    }
    const farm = db.farms.find((f) => f.id === params.id);
    if (!farm) return notFound();
    // Suspension is not a delete and it is not instant: login and refresh both
    // refuse a suspended farm, so a handset already holding an access token
    // keeps working until that token expires.
    farm.suspendedAt = body.status === "suspended" ? nowInstant() : null;
    return HttpResponse.json(adminFarm(farm));
  }),

  /* ---- catalogues ---- */

  /**
   * Every catalogue POST answers 200, never 201: the caller does not need to
   * know whether the row existed, only that this is the row that name means on
   * this farm. That is what makes "add it if it is not there" safe to press
   * twice.
   */
  ...CATALOG_ROUTES.flatMap(([path, pick, read, write]) => [
    http.get(`*/v1/${path}`, ({ request }) => {
      const g = guard(request, read);
      if (g.deny) return g.deny;
      const items = [...pick(g.p.tenant)].sort((a, b) => a.name.localeCompare(b.name, "es"));
      return HttpResponse.json({ items });
    }),
    http.post(`*/v1/${path}`, async ({ request }) => {
      const g = guard(request, write);
      if (g.deny) return g.deny;
      const body = (await request.json()) as CatalogItemRequestBody;
      if (!body.name) return badRequest("name is required");
      return HttpResponse.json(ensureCatalogItem(pick(g.p.tenant), body.name, body.id));
    }),
  ]),

  http.get("*/v1/catalogs/work-units", ({ request }) => {
    const g = guard(request, "catalogs.read");
    if (g.deny) return g.deny;
    const items = [...g.p.tenant.workUnits].sort((a, b) => a.code.localeCompare(b.code, "es"));
    return HttpResponse.json({ items });
  }),

  http.post("*/v1/catalogs/work-units", async ({ request }) => {
    const g = guard(request, "catalogs.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as WorkUnitRequestBody;
    if (!body.code) return badRequest("code is required");
    // Idempotent by lower(code), like `EnsureWorkUnit`.
    const existing = g.p.tenant.workUnits.find((u) => sameName(u.code, body.code!));
    if (existing) return HttpResponse.json(existing);
    const created = {
      id: body.id ?? crypto.randomUUID(),
      code: body.code,
      label: body.label || body.code,
      kgFactor: body.kgFactor ?? null,
    };
    g.p.tenant.workUnits.push(created);
    return HttpResponse.json(created);
  }),

  /* ---- workers ---- */

  http.get("*/v1/workers", ({ request }) => {
    const g = guard(request, "workers.read");
    if (g.deny) return g.deny;
    const params = new URL(request.url).searchParams;
    const wanted = listStatus(params);
    const q = params.get("q");
    const full = seesPrivateData(g.p);
    const rows = g.p.tenant.workers
      .filter((w) => wanted(w.deletedAt))
      // The document is searched for EVERYBODY, including the weigher, and
      // then dropped from his projection: he can find a person by the number
      // on their card without the number coming back on the wire.
      .filter(
        (w) =>
          matches(`${w.name} ${w.lastName ?? ""}`, q) || matches(w.docId, q) || matches(w.tag, q),
      )
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, "es") ||
          (a.lastName ?? "").localeCompare(b.lastName ?? "", "es"),
      );
    return HttpResponse.json({ items: rows.map((w) => projectWorker(w, full)) });
  }),

  http.get("*/v1/workers/:id/profile", ({ request, params }) => {
    const g = guard(request, "workers.read_private");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const worker = t.workers.find((w) => w.id === params.id);
    if (!worker) return notFound();
    const limit = Number(new URL(request.url).searchParams.get("limit")) || 50;
    // `tasks`, not `workRecords`: the key on the wire is the server's word.
    return HttpResponse.json({
      worker,
      balance: db.balanceOf(t, worker.id),
      ledger: t.ledger
        .filter((l) => l.workerId === worker.id)
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
      tasks: t.workRecords
        .filter((r) => r.workerId === worker.id && r.deletedAt === null)
        .sort((a, b) => b.dateFrom.localeCompare(a.dateFrom))
        .map((r) => db.projectWorkRecord(t, r)),
      notes: notesOf(t, worker.id, 100),
    });
  }),

  /**
   * The whole payment screen in one call. The guard on the first line is the
   * reason it is not three: every number below comes out of a SUM, and a SUM
   * over an id that matches nothing returns zero — a perfectly credible "this
   * person is settled up", and what a worker of another farm would produce.
   *
   * The arithmetic must not be redone by the caller. `debts` are ALREADY
   * inside `balanceCents`; subtracting them again charges the worker twice.
   */
  http.get("*/v1/workers/:id/payables", ({ request, params }) => {
    const g = guard(request, "workers.payables.read");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const worker = t.workers.find((w) => w.id === params.id);
    if (!worker) return notFound();
    const query = new URL(request.url).searchParams;
    const from = query.get("from");
    const to = query.get("to");
    if (from !== null && !DAY.test(from)) return badRequest("from must be YYYY-MM-DD");
    if (to !== null && !DAY.test(to)) return badRequest("to must be YYYY-MM-DD");
    // No range means everything outstanding, which is the question the owner
    // is actually asking: they pay what is owed, not what is owed this
    // fortnight.
    const tasks = db.pending(t, worker.id, from ?? "1970-01-01", to ?? "2999-12-31");
    const balance = db.balanceOf(t, worker.id);
    const grossCents = tasks.reduce((a, x) => a + x.amountCents, 0);
    return HttpResponse.json({
      workerId: worker.id,
      tasks,
      debts: db.debtsOf(t, worker.id),
      balance,
      grossCents,
      balanceCents: balance.balanceCents,
      totalCents: balance.balanceCents + grossCents,
    });
  }),

  /**
   * A note is append-only: there is no PATCH and no DELETE on one, and there
   * never will be — a note that can be rewritten afterwards is not a record of
   * anything. Decision 1 also nails it to the farm: it has no exit route.
   */
  http.get("*/v1/workers/:id/notes", ({ request, params }) => {
    const g = guard(request, "workers.notes.read");
    if (g.deny) return g.deny;
    const worker = g.p.tenant.workers.find((w) => w.id === params.id);
    // An unknown worker must not read as a person with nothing written about
    // them, so this is a 404 and never an empty list.
    if (!worker) return notFound();
    const limit = Number(new URL(request.url).searchParams.get("limit")) || 100;
    return HttpResponse.json({ items: notesOf(g.p.tenant, worker.id, limit) });
  }),

  http.post("*/v1/workers/:id/notes", async ({ request, params }) => {
    const g = guard(request, "workers.notes.write");
    if (g.deny) return g.deny;
    const worker = g.p.tenant.workers.find((w) => w.id === params.id);
    if (!worker) return notFound();
    const body = (await request.json()) as {
      id?: string;
      text?: string;
      note?: string;
      date?: string;
    };
    const text = (body.text || body.note || "").trim();
    if (!text) return badRequest("text is required");
    if (body.date && !DAY.test(body.date)) return badRequest("date must be YYYY-MM-DD");
    const created: WireNote = {
      id: body.id ?? crypto.randomUUID(),
      workerId: worker.id,
      // The day the note is ABOUT, which is not necessarily today.
      date: db.dayInstant(body.date ?? today()),
      text,
      createdBy: g.p.user.id,
      createdAt: nowInstant(),
    };
    g.p.tenant.notes.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  http.get("*/v1/workers/:id/balance", ({ request, params }) => {
    const g = guard(request, "balances.read");
    if (g.deny) return g.deny;
    // The balance query sums a ledger, so an id that matches nothing sums to
    // zero and reads as a perfectly plausible "owes nothing". Confirm the
    // worker is ours first and let a miss be the ordinary 404.
    const worker = g.p.tenant.workers.find((w) => w.id === params.id);
    if (!worker) return notFound();
    return HttpResponse.json(db.balanceOf(g.p.tenant, worker.id));
  }),

  http.get("*/v1/workers/:id/ledger", ({ request, params }) => {
    const g = guard(request, "ledger.read");
    if (g.deny) return g.deny;
    const worker = g.p.tenant.workers.find((w) => w.id === params.id);
    // The same trap one step quieter: an empty list for an unknown id reads as
    // "no movements yet" rather than "no such person".
    if (!worker) return notFound();
    const limit = Number(new URL(request.url).searchParams.get("limit")) || 100;
    return HttpResponse.json({
      items: g.p.tenant.ledger
        .filter((l) => l.workerId === worker.id)
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
    });
  }),

  http.get("*/v1/workers/:id", ({ request, params }) => {
    const g = guard(request, "workers.read");
    if (g.deny) return g.deny;
    const worker = g.p.tenant.workers.find((w) => w.id === params.id);
    if (!worker) return notFound();
    return HttpResponse.json(projectWorker(worker, seesPrivateData(g.p)));
  }),

  http.post("*/v1/workers", async ({ request }) => {
    const g = guard(request, "workers.write");
    if (g.deny) return g.deny;
    await delay(300);
    const body = (await request.json()) as WorkerRequestBody;
    if (!body.name) return badRequest("name is required");
    const t = g.p.tenant;

    const id = body.id ?? crypto.randomUUID();
    const already = t.workers.find((w) => w.id === id);
    if (already) return HttpResponse.json(already);

    // `ux_employees_doc`. The same cedula twice is one person with two
    // ledgers, which is how somebody gets paid twice.
    if (
      body.docId &&
      t.workers.some((w) => w.deletedAt == null && w.docId === body.docId)
    ) {
      return conflict(
        "DUPLICATE_DOCUMENT",
        "another worker on this farm already has that document",
      );
    }

    const created: WireEmployee = {
      id,
      name: body.name,
      lastName: body.lastName ?? null,
      documentType: body.documentType ?? null,
      docId: body.docId ?? null,
      tag: body.tag ?? null,
      phone: body.phone ?? null,
      address: body.address ?? null,
      city: body.city ?? null,
      municipality: body.municipality ?? null,
      country: body.country ?? "CO",
      photoId: body.photoId ?? null,
      createdAt: nowInstant(),
      deletedAt: null,
    };
    t.workers.unshift(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  /**
   * "Eliminar nunca borra": taking somebody off the payroll and putting them
   * back on next harvest are both a PATCH on the same row, never a DELETE and
   * a second registration under a new id that loses their history. The status
   * transition runs first, so a body that reactivates AND renames works.
   */
  http.patch("*/v1/workers/:id", async ({ request, params }) => {
    const g = guard(request, "workers.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as WorkerRequestBody & { status?: string };
    const bad = validStatus(body.status);
    if (bad) return bad;
    const worker = g.p.tenant.workers.find((w) => w.id === params.id);
    if (!worker) return notFound();
    if (body.status === "inactive" && worker.deletedAt == null) worker.deletedAt = nowInstant();
    if (body.status === "active") worker.deletedAt = null;
    // `UpdateEmployee` skips deleted rows by design; a deactivation on its own
    // still answers with the row it changed.
    if (worker.deletedAt != null) return HttpResponse.json(worker);
    patch(worker, body.name, "name");
    patch(worker, body.lastName, "lastName");
    patch(worker, body.documentType, "documentType");
    patch(worker, body.docId, "docId");
    patch(worker, body.tag, "tag");
    patch(worker, body.phone, "phone");
    patch(worker, body.address, "address");
    patch(worker, body.city, "city");
    patch(worker, body.municipality, "municipality");
    patch(worker, body.country, "country");
    patch(worker, body.photoId, "photoId");
    return HttpResponse.json(worker);
  }),

  /**
   * Logical, like every delete in this service: the financial history has to
   * survive the person leaving the farm. There is no `status` to set back.
   */
  http.delete("*/v1/workers/:id", ({ request, params }) => {
    const g = guard(request, "workers.write");
    if (g.deny) return g.deny;
    const worker = g.p.tenant.workers.find((w) => w.id === params.id && w.deletedAt == null);
    if (!worker) return notFound();
    worker.deletedAt = nowInstant();
    return noContent();
  }),

  /* ---- plots ---- */

  http.get("*/v1/plots", ({ request }) => {
    const g = guard(request, "plots.read");
    if (g.deny) return g.deny;
    const params = new URL(request.url).searchParams;
    const wanted = listStatus(params);
    const q = params.get("q");
    return HttpResponse.json({
      items: g.p.tenant.plots
        .filter((p) => wanted(p.deletedAt))
        .filter(
          (p) => matches(p.name, q) || matches(p.department, q) || matches(p.municipality, q),
        )
        .sort((a, b) => a.name.localeCompare(b.name, "es")),
    });
  }),

  http.get("*/v1/plots/:id", ({ request, params }) => {
    const g = guard(request, "plots.read");
    if (g.deny) return g.deny;
    const plot = g.p.tenant.plots.find((p) => p.id === params.id);
    return plot ? HttpResponse.json(plot) : notFound();
  }),

  /** The plot and its crops arrive in one body, because the form is one form. */
  http.post("*/v1/plots", async ({ request }) => {
    const g = guard(request, "plots.write");
    if (g.deny) return g.deny;
    await delay(300);
    const body = (await request.json()) as PlotRequestBody;
    if (!body.name) return badRequest("name is required");
    const t = g.p.tenant;

    const id = body.id ?? crypto.randomUUID();
    const already = t.plots.find((p) => p.id === id);
    if (already) return HttpResponse.json(already);

    for (const c of body.crops ?? []) {
      if (!c.cropTypeId && !c.cropType) return badRequest("every crop needs cropTypeId or cropType");
    }
    if (t.plots.some((p) => p.deletedAt === null && sameName(p.name, body.name!))) {
      return conflict("DUPLICATE_NAME", "this farm already has a plot with that name");
    }

    const created: WirePlot = {
      id,
      name: body.name,
      areaHa: body.areaHa ?? null,
      // PostGIS measures the drawn polygon; there is no polygon yet.
      computedAreaHa: null,
      department: body.department ?? null,
      municipality: body.municipality ?? null,
      // GeoJSON in and GeoJSON out; there is no polygon until somebody draws
      // one, and no PostGIS type ever crosses the wire.
      boundary: null,
      createdAt: nowInstant(),
      deletedAt: null,
      crops: (body.crops ?? []).map((c) => buildCrop(t, id, c)),
    };
    // `handleCreatePlot` stores a boundary sent with the form rather than
    // dropping it: the form is one form, and an ignored field in an accepted
    // request is the worst of both answers.
    if (body.boundary != null) {
      const stored = applyBoundary(created, body.boundary);
      if (stored instanceof Response) return stored;
    }
    t.plots.unshift(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  /**
   * `UpdatePlot` patches four scalars and nothing else — crops have routes of
   * their own, so a PATCH carrying a `crops` array does not replace them.
   */
  http.patch("*/v1/plots/:id", async ({ request, params }) => {
    const g = guard(request, "plots.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as PlotRequestBody & {
      status?: string;
      boundary?: unknown;
    };
    const bad = validStatus(body.status);
    if (bad) return bad;
    const plot = g.p.tenant.plots.find((p) => p.id === params.id);
    if (!plot) return notFound();

    if (body.status === "inactive" && plot.deletedAt === null) {
      // The same refusal DELETE makes, for the same reason.
      const active = plot.crops.filter((c) => c.deletedAt === null).length;
      if (active > 0) {
        return conflict(
          "PLOT_HAS_ACTIVE_CROPS",
          "remove the crops before taking the plot out of service",
          { activeCrops: active },
        );
      }
      plot.deletedAt = nowInstant();
    }
    if (body.status === "active") plot.deletedAt = null;
    if (plot.deletedAt !== null) return HttpResponse.json(plot);

    patch(plot, body.name, "name");
    patch(plot, body.areaHa, "areaHa");
    patch(plot, body.department, "department");
    patch(plot, body.municipality, "municipality");
    if (body.boundary != null) {
      const stored = applyBoundary(plot, body.boundary);
      if (stored instanceof Response) return stored;
    }
    return HttpResponse.json(plot);
  }),

  /**
   * GeoJSON in and GeoJSON out — no PostGIS type ever crosses the wire, which
   * is what keeps swapping the engine possible. The overlap list is a WARNING
   * and never a refusal: two plots that touch on the map are usually a drawing
   * that wants a second look and sometimes a terrace above a coffee lot, and
   * the server does not get to decide which.
   *
   * SPRINT 3 STOPPED PRETENDING HERE. This handler used to store the geometry,
   * leave `computedAreaHa` exactly as it was and report no overlaps — which
   * meant the map screen could be developed and tested end to end without ever
   * exercising the three things the route exists for. `applyBoundary` now does
   * what `store.SetPlotBoundary` does: refuse an invalid ring with
   * INVALID_GEOMETRY, promote a Polygon to a MultiPolygon the way `ST_Multi`
   * does, and measure the hectares.
   */
  http.put("*/v1/plots/:id/boundary", async ({ request, params }) => {
    const g = guard(request, "plots.boundary.write");
    if (g.deny) return g.deny;
    const plot = g.p.tenant.plots.find((p) => p.id === params.id);
    if (!plot) return notFound();
    const body = (await request.json()) as { boundary?: unknown; geojson?: unknown };
    const geo = body.boundary ?? body.geojson;
    if (geo == null) return badRequest("boundary is required, as a GeoJSON geometry");
    const stored = applyBoundary(plot, geo);
    if (stored instanceof Response) return stored;
    return HttpResponse.json({ plot, overlaps: overlappingPlots(g.p.tenant, plot) });
  }),

  /**
   * Refuses while something is still planted: taking a plot out of service
   * under a live crop orphans the work records that point at that crop.
   */
  http.delete("*/v1/plots/:id", ({ request, params }) => {
    const g = guard(request, "plots.write");
    if (g.deny) return g.deny;
    const plot = g.p.tenant.plots.find((p) => p.id === params.id && p.deletedAt === null);
    if (!plot) return notFound();
    const active = plot.crops.filter((c) => c.deletedAt === null).length;
    if (active > 0) {
      return conflict(
        "PLOT_HAS_ACTIVE_CROPS",
        "remove the crops before taking the plot out of service",
        { activeCrops: active },
      );
    }
    plot.deletedAt = nowInstant();
    return noContent();
  }),

  http.post("*/v1/plots/:id/crops", async ({ request, params }) => {
    const g = guard(request, "plots.write");
    if (g.deny) return g.deny;
    const plot = g.p.tenant.plots.find((p) => p.id === params.id && p.deletedAt === null);
    if (!plot) return notFound();
    const body = (await request.json()) as PlotCropRequestBody;
    if (!body.cropTypeId && !body.cropType) {
      return badRequest("cropTypeId or cropType is required");
    }
    const created = buildCrop(g.p.tenant, plot.id, body);
    plot.crops.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  http.delete("*/v1/plots/:id/crops/:cropId", ({ request, params }) => {
    const g = guard(request, "plots.write");
    if (g.deny) return g.deny;
    const plot = g.p.tenant.plots.find((p) => p.id === params.id);
    const crop = plot?.crops.find((c) => c.id === params.cropId && c.deletedAt === null);
    if (!crop) return notFound();
    crop.deletedAt = nowInstant();
    return noContent();
  }),

  /* ---- activities ---- */

  /**
   * The same route to everybody and a different projection to the weigher: his
   * list arrives without a single rate in it. `on` picks the day the rate is
   * read for, which is what makes a historical work record explainable.
   */
  http.get("*/v1/activities", ({ request }) => {
    const g = guard(request, "activities.read");
    if (g.deny) return g.deny;
    const params = new URL(request.url).searchParams;
    const on = params.get("on");
    if (on !== null && !DAY.test(on)) return badRequest("on must be a date, YYYY-MM-DD");
    const wanted = listStatus(params);
    const category = params.get("category");
    const q = params.get("q");
    const withRates = seesPrivateData(g.p);
    const items = g.p.tenant.activities
      .filter((a) => wanted(a.archivedAt))
      .filter((a) => !category || category === "all" || a.category === category)
      .filter((a) => matches(a.name, q))
      .sort((a, b) => a.category.localeCompare(b.category, "es") || a.name.localeCompare(b.name, "es"))
      .map((a) => projectActivity(a, withRates, on ?? today()));
    return HttpResponse.json({ items });
  }),

  http.post("*/v1/activities", async ({ request }) => {
    const g = guard(request, "activities.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as ActivityRequestBody;
    const t = g.p.tenant;

    if (!body.name) return badRequest("name is required");
    if (!body.payScheme || !["contrato", "tiempo", "unidad_trabajo"].includes(body.payScheme)) {
      return badRequest("payScheme must be contrato, tiempo or unidad_trabajo");
    }
    if (!body.category && !body.categoryId) return badRequest("categoryId or category is required");
    const rateSource = body.rateSource ?? "activity_dated";
    if (rateSource === "weekly_price" && body.payScheme !== "unidad_trabajo") {
      return badRequest("only a work-unit activity can be priced by the week");
    }
    if (rateSource === "explicit") {
      return badRequest("an activity is priced by date or by the week; 'explicit' belongs to a task");
    }
    const rateCents = body.rate?.rateCents ?? 0;
    if (rateCents <= 0) return badRequest("rate.rateCents must be positive");
    if (body.payScheme === "unidad_trabajo" && !body.unitId) {
      return badRequest("a work-unit activity needs unitId");
    }
    if (body.payScheme !== "unidad_trabajo" && body.unitId) {
      return badRequest("only a work-unit activity has a unit");
    }
    if (body.rate?.validFrom && !DAY.test(body.rate.validFrom)) {
      return badRequest("rate.validFrom must be a date, YYYY-MM-DD");
    }

    const id = body.id ?? crypto.randomUUID();
    const already = t.activities.find((a) => a.id === id);
    if (already) return HttpResponse.json(projectActivity(already, seesPrivateData(g.p), today()));
    if (t.activities.some((a) => a.archivedAt === null && sameName(a.name, body.name!))) {
      return conflict("DUPLICATE_NAME", "this farm already has an activity with that name");
    }

    const category = body.categoryId
      ? t.activityCategories.find((c) => c.id === body.categoryId)
      : ensureCatalogItem(t.activityCategories, body.category!);
    if (!category) return badRequest("categoryId or category is required");

    const created: db.MockActivity = {
      id,
      name: body.name,
      categoryId: category.id,
      category: category.name,
      payScheme: body.payScheme,
      rateSource,
      unitId: body.unitId ?? null,
      archivedAt: null,
      rates: [toRate(body.rate ?? {}, body.payScheme)],
    };
    t.activities.unshift(created);
    return HttpResponse.json(projectActivity(created, true, today()), { status: 201 });
  }),

  /**
   * Name, category and status only. `payScheme` and `rateSource` are out of
   * reach on purpose: an activity that pays differently is a different
   * activity, and changing the scheme under a frozen rate would make an old
   * work record unexplainable.
   */
  http.patch("*/v1/activities/:id", async ({ request, params }) => {
    const g = guard(request, "activities.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as ActivityRequestBody & { status?: string };
    const bad = validStatus(body.status);
    if (bad) return bad;
    if (body.payScheme !== undefined || body.rateSource !== undefined) {
      return badRequest(
        "payScheme and rateSource cannot be changed; an activity that pays differently is a different activity",
      );
    }
    const t = g.p.tenant;
    const activity = t.activities.find((a) => a.id === params.id);
    if (!activity) return notFound();
    if (body.status === "inactive" && activity.archivedAt === null) {
      activity.archivedAt = nowInstant();
    }
    if (body.status === "active") activity.archivedAt = null;

    if (body.name && !sameName(body.name, activity.name)) {
      if (t.activities.some((a) => a.id !== activity.id && sameName(a.name, body.name!))) {
        return conflict("DUPLICATE_NAME", "this farm already has an activity with that name");
      }
      activity.name = body.name;
    }
    const category = body.categoryId
      ? t.activityCategories.find((c) => c.id === body.categoryId)
      : body.category
        ? ensureCatalogItem(t.activityCategories, body.category)
        : undefined;
    if (category) {
      activity.categoryId = category.id;
      activity.category = category.name;
    }
    return HttpResponse.json(projectActivity(activity, seesPrivateData(g.p), today()));
  }),

  http.get("*/v1/activities/:id/rates", ({ request, params }) => {
    const g = guard(request, "activities.rate.write");
    if (g.deny) return g.deny;
    const activity = g.p.tenant.activities.find((a) => a.id === params.id);
    if (!activity) return notFound();
    const items = [...activity.rates].sort((a, b) => b.validFrom.localeCompare(a.validFrom));
    return HttpResponse.json({ items });
  }),

  /**
   * Opens a new validity period; it never edits an old one. A rate already
   * frozen onto a record has to stay explainable — the answer to "why was I
   * paid this" is a row with a date on it (decision 4).
   */
  http.put("*/v1/activities/:id/rate", async ({ request, params }) => {
    const g = guard(request, "activities.rate.write");
    if (g.deny) return g.deny;
    const activity = g.p.tenant.activities.find((a) => a.id === params.id);
    if (!activity) return notFound();
    const body = (await request.json()) as RateRequestBody;
    if (!body.rateCents || body.rateCents <= 0) return badRequest("rateCents must be positive");
    if (body.validFrom && !DAY.test(body.validFrom)) {
      return badRequest("rate.validFrom must be a date, YYYY-MM-DD");
    }
    const rate = toRate(body, activity.payScheme);
    // Upsert on (activity_id, valid_from), as the ON CONFLICT clause does.
    const at = activity.rates.findIndex((r) => r.validFrom === rate.validFrom);
    if (at >= 0) activity.rates[at] = rate;
    else activity.rates.push(rate);
    return HttpResponse.json({
      activityId: activity.id,
      rates: [...activity.rates].sort((a, b) => b.validFrom.localeCompare(a.validFrom)),
    });
  }),

  http.delete("*/v1/activities/:id", ({ request, params }) => {
    const g = guard(request, "activities.write");
    if (g.deny) return g.deny;
    const activity = g.p.tenant.activities.find((a) => a.id === params.id && a.archivedAt === null);
    if (!activity) return notFound();
    activity.archivedAt = nowInstant();
    return noContent();
  }),

  /* ---- work records ---- */

  http.get("*/v1/work-records", ({ request }) => {
    const g = guard(request, "work_records.read");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const params = new URL(request.url).searchParams;
    const from = params.get("from");
    const to = params.get("to");
    if (from !== null && !DAY.test(from)) return badRequest("from must be YYYY-MM-DD");
    if (to !== null && !DAY.test(to)) return badRequest("to must be YYYY-MM-DD");
    const workerId = params.get("workerId");
    const activityId = params.get("activityId");
    const plotId = params.get("plotId");
    // `workRecordFilter` in handlers_work_records.go takes payScheme and
    // plotCropId too. The mock ignored both, which meant the harvest module's
    // `?payScheme=unidad_trabajo` was answered here with every jornal on the
    // farm and only narrowed client-side — so the one filter the module leans
    // on was never exercised against anything.
    const payScheme = params.get("payScheme");
    const plotCropId = params.get("plotCropId");
    const wanted = listStatus(params);
    const q = params.get("q");

    const rows = t.workRecords
      .filter((r) => wanted(r.deletedAt))
      .filter((r) => !workerId || r.workerId === workerId)
      .filter((r) => !activityId || r.activityId === activityId)
      .filter((r) => !plotId || r.plotIds.includes(plotId))
      .filter((r) => !payScheme || r.payScheme === payScheme)
      .filter((r) => !plotCropId || r.plotCropIds.includes(plotCropId))
      .filter((r) => !from || db.dayOf(r.dateFrom) >= from)
      .filter((r) => !to || db.dayOf(r.dateTo) <= to)
      .filter((r) => {
        if (!q) return true;
        const activity = t.activities.find((a) => a.id === r.activityId);
        const worker = t.workers.find((w) => w.id === r.workerId);
        return (
          matches(activity?.name ?? null, q) ||
          matches(worker ? `${worker.name} ${worker.lastName ?? ""}` : null, q) ||
          matches(r.note, q)
        );
      })
      // The weigher reads back only his own rows. On the server that narrowing
      // is the RLS policy on work_records, not a WHERE clause in a handler.
      .filter((r) => g.p.role !== "weigher" || r.createdBy === g.p.user.id)
      .sort((a, b) => b.dateFrom.localeCompare(a.dateFrom) || b.createdAt.localeCompare(a.createdAt));

    return HttpResponse.json({ items: rows.map((r) => db.projectWorkRecord(t, r)) });
  }),

  /**
   * The one write in the system that decides money at write time, so most of
   * it is about which price applies and when it froze.
   */
  http.post("*/v1/work-records", async ({ request }) => {
    const g = guard(request, "work_records.write");
    if (g.deny) return g.deny;
    await delay(300);
    const body = (await request.json()) as WireWorkRecordRequest;
    const t = g.p.tenant;

    if (!body.activityId || !body.workerId) {
      return badRequest("activityId and workerId are required");
    }
    if (!body.dateFrom) return badRequest("dateFrom is required, YYYY-MM-DD");
    if (!DAY.test(body.dateFrom)) return badRequest("dateFrom must be YYYY-MM-DD");
    const from = body.dateFrom;
    const to = body.dateTo ?? from;
    if (!DAY.test(to)) return badRequest("dateTo must be YYYY-MM-DD");
    if (to < from) return badRequest("dateTo cannot be before dateFrom");

    const id = body.id ?? crypto.randomUUID();
    const already = t.workRecords.find((r) => r.id === id);
    if (already) return HttpResponse.json(db.projectWorkRecord(t, already));

    const activity = t.activities.find((a) => a.id === body.activityId);
    if (!activity) return notFound();

    // A weigher records weighings and nothing else. A weighing is an activity
    // priced by the week, which means he never sees a rate, never sets one and
    // never needs to. Refusing here makes it a clear 403 instead of an
    // unexplained NO_RATE_IN_FORCE.
    if (g.p.role === "weigher") {
      if (activity.rateSource !== "weekly_price") {
        return fail(403, "FORBIDDEN", "a weigher may only record work priced by the week");
      }
      if (body.rateCents != null) return fail(403, "FORBIDDEN", "a weigher may not set a rate");
    }

    // A contract is one thing done once: amount = round(1 * total).
    // `decode` runs with UseNumber and a JSON string will not unmarshal into a
    // json.Number, so a quoted quantity is a 400 on the server too.
    const quantity = activity.payScheme === "contrato" ? 1 : body.quantity;
    if (!db.isPositiveQuantity(quantity)) return badRequest("quantity must be a positive number");

    let rateSource = activity.rateSource;
    let rateCents: number | null = null;
    if (body.rateCents != null) {
      // The caller named the price, so it freezes here and a date range is
      // perfectly legal.
      if (body.rateCents <= 0) return badRequest("rateCents must be positive");
      rateSource = "explicit";
      rateCents = body.rateCents;
    } else if (activity.rateSource === "weekly_price") {
      // Left open: the week's price is looked up when the settlement runs.
      rateSource = "weekly_price";
    } else {
      rateSource = "activity_dated";
      const inForce = db.rateInForce(activity, from);
      if (!inForce) {
        return conflict("NO_RATE_IN_FORCE", "that activity has no rate in force on that date");
      }
      rateCents = inForce.rateCents;
    }

    // Decision 4: a record whose price is derived from a date must be a single
    // day. A wage from Tuesday to Tuesday has no single validity period and no
    // single week. Naming the rate is what buys the range.
    if (rateSource !== "explicit" && from !== to) {
      return badRequest(
        "a work record priced by date must be a single day; send rateCents to freeze a price over a range",
        { code: "RANGE_NEEDS_FROZEN_RATE" },
      );
    }

    let amountCents: number | null = null;
    if (rateCents !== null) {
      amountCents = db.amountCents(quantity, rateCents);
      if (amountCents <= 0) return badRequest("the work record adds up to zero");
    }

    const created: db.MockWorkRecord = {
      id,
      workerId: body.workerId,
      activityId: activity.id,
      payScheme: activity.payScheme,
      rateSource,
      startedAt: db.noonInstant(from),
      endedAt: to === from ? null : db.noonInstant(to),
      dateFrom: db.dayInstant(from),
      dateTo: db.dayInstant(to),
      weekStart: db.dayInstant(mondayOf(from)),
      quantity,
      // The unit rides on the activity, so a weigher who may not read a single
      // price still records kilos rather than a bare number.
      unitId: activity.unitId,
      rateCents,
      amountCents,
      // What it is worth, always a number — the server derives the same thing.
      // A brand new record cannot be settled, so an unfrozen amount here is
      // always the week's price applied to the quantity.
      estimatedAmountCents:
        amountCents ?? db.amountCents(quantity, db.weekPriceOf(g.p.tenant, mondayOf(from))),
      amountIsEstimate: amountCents === null,
      note: body.note ?? null,
      createdBy: g.p.user.id,
      createdAt: nowInstant(),
      deletedAt: null,
      plotIds: body.plotIds ?? [],
      plotCropIds: body.plotCropIds ?? [],
    };
    t.workRecords.unshift(created);
    return HttpResponse.json(db.projectWorkRecord(t, created), { status: 201 });
  }),

  http.get("*/v1/work-records/:id", ({ request, params }) => {
    const g = guard(request, "work_records.read");
    if (g.deny) return g.deny;
    const record = g.p.tenant.workRecords.find((r) => r.id === params.id);
    if (!record) return notFound();
    return HttpResponse.json(db.projectWorkRecord(g.p.tenant, record));
  }),

  /**
   * Corrects a record that has not been paid. Everything that decides the
   * price is out of reach — activity, dates, rate — because changing any of
   * them would rewrite an amount somebody has already been told. A record
   * inside a live settlement answers 409 rather than being edited under the
   * payment.
   */
  http.patch("*/v1/work-records/:id", async ({ request, params }) => {
    const g = guard(request, "work_records.admin");
    if (g.deny) return g.deny;
    const body = (await request.json()) as {
      quantity?: number;
      note?: string | null;
      status?: string;
    };
    const bad = validStatus(body.status);
    if (bad) return bad;
    if (body.quantity !== undefined && !db.isPositiveQuantity(body.quantity)) {
      return badRequest("quantity must be a positive number");
    }
    const t = g.p.tenant;
    const record = t.workRecords.find((r) => r.id === params.id);
    if (!record) return notFound();
    if (db.isSettled(t, record.id)) {
      return conflict(
        "WORK_RECORD_SETTLED",
        "the work record is part of a live settlement; void the settlement first",
      );
    }
    if (body.status === "inactive") {
      if (record.deletedAt === null) record.deletedAt = nowInstant();
      return HttpResponse.json(db.projectWorkRecord(t, record));
    }
    if (body.status === "active") record.deletedAt = null;
    if (record.deletedAt !== null) return notFound();

    if (body.quantity !== undefined) {
      record.quantity = body.quantity;
      // The amount follows the quantity, and stays null while the price is
      // still open: `CASE WHEN price_minor IS NULL THEN NULL`.
      record.amountCents =
        record.rateCents === null ? null : db.amountCents(body.quantity, record.rateCents);
    }
    patch(record, body.note, "note");
    return HttpResponse.json(db.projectWorkRecord(t, record));
  }),

  /**
   * Work that has already been paid is cancelled by voiding its settlement,
   * not by editing it away.
   */
  http.delete("*/v1/work-records/:id", ({ request, params }) => {
    const g = guard(request, "work_records.admin");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const record = t.workRecords.find((r) => r.id === params.id && r.deletedAt === null);
    if (!record) return notFound();
    if (db.isSettled(t, record.id)) {
      return conflict(
        "WORK_RECORD_SETTLED",
        "the work record is part of a live settlement and cannot be removed",
      );
    }
    record.deletedAt = nowInstant();
    return noContent();
  }),

  /* ---- weekly price ---- */

  http.get("*/v1/prices/weeks/:monday", ({ request, params }) => {
    const g = guard(request, "prices.read");
    if (g.deny) return g.deny;
    const monday = String(params.monday);
    const bad = checkMonday(monday);
    if (bad) return bad;
    return HttpResponse.json({
      weekStart: monday,
      priceCents: db.weekPriceOf(g.p.tenant, monday),
    });
  }),

  http.put("*/v1/prices/weeks/:monday", async ({ request, params }) => {
    const g = guard(request, "prices.write");
    if (g.deny) return g.deny;
    const monday = String(params.monday);
    const bad = checkMonday(monday);
    if (bad) return bad;
    const body = (await request.json()) as WeekPriceRequestBody;
    if (!body.priceCents || body.priceCents <= 0) return badRequest("priceCents must be positive");
    const existing = g.p.tenant.weekPrices.find((p) => p.weekStart === monday);
    if (existing) existing.priceCents = body.priceCents;
    else g.p.tenant.weekPrices.push({ weekStart: monday, priceCents: body.priceCents });
    return HttpResponse.json({ weekStart: monday, priceCents: body.priceCents });
  }),

  /* ---- pending and balances ---- */

  http.get("*/v1/pending", ({ request }) => {
    const g = guard(request, "pending.read");
    if (g.deny) return g.deny;
    const params = new URL(request.url).searchParams;
    const workerId = params.get("workerId");
    if (!workerId) return badRequest("workerId is required");
    const range = parseRange(params.get("from"), params.get("to"));
    if (range instanceof Response) return range;
    const items = db.pending(g.p.tenant, workerId, range.from, range.to);
    return HttpResponse.json({
      workerId,
      from: db.dayInstant(range.from),
      to: db.dayInstant(range.to),
      items,
      totalCents: items.reduce((a, p) => a + p.amountCents, 0),
    });
  }),

  http.get("*/v1/balances", ({ request }) => {
    const g = guard(request, "balances.read");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const items = t.workers
      .filter((w) => w.deletedAt == null)
      .map((w) => db.balanceOf(t, w.id))
      .sort((a, b) => b.balanceCents - a.balanceCents);
    return HttpResponse.json({ items });
  }),

  /* ---- settlements ---- */

  /** The same code path the real settlement uses, so the screen cannot drift. */
  http.post("*/v1/settlements/preview", async ({ request }) => {
    const g = guard(request, "settlements.preview");
    if (g.deny) return g.deny;
    const body = (await request.json()) as WireSettlementRequest;
    const range = parseRange(body.from ?? null, body.to ?? null);
    if (range instanceof Response) return range;
    const items = db.pending(g.p.tenant, body.workerId, range.from, range.to);
    return HttpResponse.json({
      workerId: body.workerId,
      from: db.dayInstant(range.from),
      to: db.dayInstant(range.to),
      items,
      grossCents: items.reduce((a, p) => a + p.amountCents, 0),
      balance: db.balanceOf(g.p.tenant, body.workerId),
    });
  }),

  /**
   * This — not the payment — is what creates the `devengo`. The old mock
   * folded the two together, following the design document; the server
   * separates them, and it has to, because a settlement is the receipt and a
   * payment is the cash. One settlement writes ONE `devengo` for the gross and
   * claims the payables it took in.
   */
  http.post("*/v1/settlements", async ({ request }) => {
    const g = guard(request, "settlements.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as WireSettlementRequest;
    const t = g.p.tenant;

    if (!body.workerId) return badRequest("workerId is required");
    const range = parseRange(body.from ?? null, body.to ?? null);
    if (range instanceof Response) return range;

    const id = body.id ?? crypto.randomUUID();
    const already = t.settlements.find((s) => s.id === id);
    if (already) return HttpResponse.json(projectSettlement(t, already));

    const all = db.pending(t, body.workerId, range.from, range.to);
    const wanted = new Set(body.payableIds ?? []);
    // Empty or omitted means "everything pending in the period".
    const chosen = wanted.size ? all.filter((p) => wanted.has(p.payableId)) : all;
    if (chosen.length === 0) {
      return conflict("NOTHING_TO_SETTLE", "there is nothing to settle in that period");
    }
    // `db.pending` already drops anything a live settlement holds, so this can
    // only fire on a race — which is exactly when the unique index fires on the
    // server. It is kept so the client's recovery path has something to meet.
    for (const p of chosen) {
      const claim = db.liveClaim(t, p.payableId);
      if (claim) {
        return conflict(
          "PAYABLE_ALREADY_CLAIMED",
          "a payable is already part of a live settlement",
          {
            payableId: p.payableId,
            winningSettlement: {
              id: claim.settlement.id,
              grossCents: claim.settlement.grossCents,
              createdAt: claim.settlement.createdAt,
            },
          },
        );
      }
    }

    const grossCents = chosen.reduce((a, p) => a + p.amountCents, 0);
    if (grossCents <= 0) return conflict("NOTHING_TO_SETTLE", "the settlement adds up to nothing");

    // The period the settlement records is the one it actually covers, not the
    // window the caller happened to ask over: a caller asking from 1970 means
    // "everything outstanding", and writing 1970 on the receipt is nonsense.
    let periodStart = db.dayInstant(range.to);
    for (const p of chosen) if (p.weekStart < periodStart) periodStart = p.weekStart;

    const createdAt = nowInstant();
    const settlement: db.MockSettlement = {
      id,
      workerId: body.workerId,
      periodStart,
      periodEnd: db.dayInstant(range.to),
      grossCents,
      status: "open",
      note: body.note ?? null,
      createdAt,
      voidedAt: null,
      items: chosen.map((p) => ({
        payableId: p.payableId,
        weekStart: p.weekStart,
        quantity: p.quantity,
        rateCents: p.rateCents,
        amountCents: p.amountCents,
        voidedAt: null,
      })),
    };
    t.settlements.push(settlement);
    t.ledger.push({
      id: crypto.randomUUID(),
      workerId: body.workerId,
      kind: "devengo",
      amountCents: grossCents,
      date: db.dayInstant(today()),
      settlementId: id,
      method: null,
      note: body.note ?? null,
      reversesId: null,
      createdAt,
    });
    return HttpResponse.json(projectSettlement(t, settlement), { status: 201 });
  }),

  http.get("*/v1/settlements/:id", ({ request, params }) => {
    const g = guard(request, "settlements.read");
    if (g.deny) return g.deny;
    const settlement = g.p.tenant.settlements.find((s) => s.id === params.id);
    if (!settlement) return notFound();
    return HttpResponse.json(projectSettlement(g.p.tenant, settlement));
  }),

  /**
   * Cancels without editing a thing. The items keep their rows for the record
   * but gain a `voidedAt`, which is what releases their payables; the earning
   * is cancelled by a reversal, never deleted.
   */
  http.post("*/v1/settlements/:id/void", ({ request, params }) => {
    const g = guard(request, "settlements.void");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const settlement = t.settlements.find((s) => s.id === params.id);
    if (!settlement) return notFound();
    if (settlement.status === "void") {
      return conflict("SETTLEMENT_ALREADY_VOID", "the settlement is already void");
    }
    const at = nowInstant();
    for (const item of settlement.items) if (item.voidedAt === null) item.voidedAt = at;
    settlement.status = "void";
    settlement.voidedAt = at;

    for (const entry of t.ledger.filter(
      (l) =>
        l.settlementId === settlement.id &&
        l.kind === "devengo" &&
        !t.ledger.some((r) => r.reversesId === l.id),
    )) {
      t.ledger.push({
        id: crypto.randomUUID(),
        workerId: entry.workerId,
        kind: "reverso",
        amountCents: -entry.amountCents,
        date: db.dayInstant(today()),
        settlementId: settlement.id,
        method: null,
        note: null,
        reversesId: entry.id,
        createdAt: at,
      });
    }
    return HttpResponse.json(projectSettlement(t, settlement));
  }),

  /* ---- ledger movements ---- */

  http.post("*/v1/payments", ledgerHandler("pago", true)),
  // No balance check on an advance: exceeding the balance is what an advance is.
  http.post("*/v1/advances", ledgerHandler("anticipo", false)),
  // Not an expense. An expense is the farm's own accounting and never touches
  // anybody's ledger; mixing them takes the cost of a spraying out of a wage.
  http.post("*/v1/deductions", ledgerHandler("deduccion", false)),
  http.post("*/v1/adjustments", ledgerHandler("ajuste", false)),

  /**
   * The only way back. Nothing in the ledger is edited or deleted — the
   * database forbids both — so a mistake is undone by a movement that cancels
   * the first one exactly, once.
   */
  http.post("*/v1/ledger/:id/reverse", async ({ request, params }) => {
    const g = guard(request, "ledger.reverse");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const entry = t.ledger.find((l) => l.id === params.id);
    if (!entry) return notFound();
    if (entry.kind === "reverso") {
      return conflict("ALREADY_REVERSED", "a reversal cannot be reversed");
    }
    if (t.ledger.some((l) => l.reversesId === entry.id)) {
      return conflict("ALREADY_REVERSED", "that movement was already reversed");
    }
    const body = (await request.json().catch(() => ({}))) as ReverseRequestBody;
    const created: WireLedgerEntry = {
      id: crypto.randomUUID(),
      workerId: entry.workerId,
      kind: "reverso",
      amountCents: -entry.amountCents,
      date: db.dayInstant(today()),
      settlementId: entry.settlementId,
      method: null,
      note: body.note ?? null,
      reversesId: entry.id,
      createdAt: nowInstant(),
    };
    t.ledger.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),
  /* ---- products (RSP-018 … RSP-021) ---- */

  /**
   * "Agrupa por categoría mostrando nombre y unidades existentes" — and the
   * unidades existentes are summed from the movements on every read, which is
   * why there is nothing to keep in step and nothing to fall behind.
   */
  http.get("*/v1/products", ({ request }) => {
    const g = guard(request, "products.read");
    if (g.deny) return g.deny;
    const params = new URL(request.url).searchParams;
    const wanted = listStatus(params);
    const q = params.get("q");
    const categoryId = params.get("categoryId");
    const t = g.p.tenant;
    return HttpResponse.json({
      items: t.products
        .filter((p) => wanted(p.deletedAt))
        .filter((p) => matches(p.name, q))
        .filter((p) => !categoryId || p.categoryId === categoryId)
        .map((p) => projectProduct(t, p))
        .sort(
          (a, b) =>
            (a.category ?? "").localeCompare(b.category ?? "", "es") ||
            a.name.localeCompare(b.name, "es"),
        ),
    });
  }),

  http.post("*/v1/products", async ({ request }) => {
    const g = guard(request, "products.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as ProductRequestBody;
    const t = g.p.tenant;
    if (!body.name || !body.name.trim()) return badRequest("name is required");

    const id = body.id ?? crypto.randomUUID();
    const already = t.products.find((p) => p.id === id);
    if (already) return HttpResponse.json(projectProduct(t, already));

    // ux_products_name, partial on `deleted_at IS NULL`: a product taken out of
    // service does not block the name being used again.
    if (t.products.some((p) => p.deletedAt === null && sameName(p.name, body.name!))) {
      return conflict("DUPLICATE_NAME", "this farm already has a product with that name");
    }

    const storageUnitId = resolveCatalog(t.storageUnits, body.storageUnitId, body.storageUnit);
    if (!storageUnitId) return badRequest("storageUnitId or storageUnit is required");

    const created: db.MockProduct = {
      id,
      name: body.name.trim(),
      // A category is optional; the storage unit is not. `resolveCatalog`
      // answers null for both when nothing was sent, and this is where the two
      // stop being the same case.
      categoryId: resolveCatalog(t.productCategories, body.categoryId, body.category),
      storageUnitId,
      note: body.note ?? null,
      createdAt: nowInstant(),
      deletedAt: null,
    };
    t.products.push(created);
    return HttpResponse.json(projectProduct(t, created), { status: 201 });
  }),

  http.get("*/v1/products/:id", ({ request, params }) => {
    const g = guard(request, "products.read");
    if (g.deny) return g.deny;
    const product = g.p.tenant.products.find((p) => p.id === params.id);
    return product ? HttpResponse.json(projectProduct(g.p.tenant, product)) : notFound();
  }),

  http.patch("*/v1/products/:id", async ({ request, params }) => {
    const g = guard(request, "products.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as ProductRequestBody;
    const bad = validStatus(body.status);
    if (bad) return bad;
    const t = g.p.tenant;
    const product = t.products.find((p) => p.id === params.id);
    if (!product) return notFound();

    if (body.status === "inactive") product.deletedAt ??= nowInstant();
    if (body.status === "active") product.deletedAt = null;

    patch(product, body.name?.trim(), "name");
    patch(product, resolveCatalog(t.productCategories, body.categoryId, body.category), "categoryId");
    patch(product, resolveCatalog(t.storageUnits, body.storageUnitId, body.storageUnit), "storageUnitId");
    patch(product, body.note, "note");
    return HttpResponse.json(projectProduct(t, product));
  }),

  /**
   * RSP-021, logical. The movements it already has stay exactly where they
   * are — they are facts, and a product leaving the catalogue does not
   * un-harvest last week's coffee.
   */
  http.delete("*/v1/products/:id", ({ request, params }) => {
    const g = guard(request, "products.write");
    if (g.deny) return g.deny;
    const product = g.p.tenant.products.find((p) => p.id === params.id && p.deletedAt === null);
    if (!product) return notFound();
    product.deletedAt = nowInstant();
    return noContent();
  }),

  /* ---- customers (RSP-027's "Cliente") ---- */

  http.get("*/v1/customers", ({ request }) => {
    const g = guard(request, "sales.read");
    if (g.deny) return g.deny;
    const params = new URL(request.url).searchParams;
    const wanted = listStatus(params);
    const q = params.get("q");
    return HttpResponse.json({
      items: g.p.tenant.customers
        .filter((c) => wanted(c.deletedAt))
        .filter((c) => matches(c.name, q) || matches(c.docId, q))
        .sort((a, b) => a.name.localeCompare(b.name, "es")),
    });
  }),

  /**
   * `EnsureCustomer`: idempotent by lower(name), and the existing row wins
   * with its blanks filled in. The sales screen must not be able to produce
   * two "Cooperativa" that are different rows.
   */
  http.post("*/v1/customers", async ({ request }) => {
    const g = guard(request, "sales.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as CustomerRequestBody;
    if (!body.name || !body.name.trim()) return badRequest("name is required");
    const t = g.p.tenant;

    const existing = t.customers.find((c) => c.deletedAt === null && sameName(c.name, body.name!));
    if (existing) {
      patch(existing, body.documentType, "documentType");
      patch(existing, body.docId, "docId");
      patch(existing, body.phone, "phone");
      return HttpResponse.json(existing);
    }
    const created: WireCustomer = {
      id: body.id ?? crypto.randomUUID(),
      name: body.name.trim(),
      documentType: body.documentType ?? null,
      docId: body.docId ?? null,
      phone: body.phone ?? null,
      createdAt: nowInstant(),
      deletedAt: null,
    };
    t.customers.push(created);
    // 200, like every other picker: `handleCreateCustomer` answers
    // `http.StatusOK` whether it inserted or found. The caller does not need
    // to know which, only that this is the row that name means here.
    return HttpResponse.json(created);
  }),

  /* ---- existencias y movimientos (RSP-025) ---- */

  /**
   * The `stock_levels` view. Note what is NOT here: any way to write one.
   * The level is the sum of the movements and the only verb is "append".
   */
  http.get("*/v1/stock", ({ request }) => {
    const g = guard(request, "stock.read");
    if (g.deny) return g.deny;
    const params = new URL(request.url).searchParams;
    const productId = params.get("productId") ?? undefined;
    const warehouseId = params.get("warehouseId") ?? undefined;
    const t = g.p.tenant;
    // StockLevels' warning, applied: a narrowing id has to be confirmed as
    // this farm's BEFORE it is summed, because a sum over somebody else's id
    // answers 0 and "0 bultos in the warehouse" is a perfectly credible wrong
    // answer.
    const foreign = confirmOurs(t, { product: productId, warehouse: warehouseId });
    if (foreign) return foreign;
    const items = db.stockLevels(t, productId, warehouseId);
    return HttpResponse.json({
      items,
      total: db.round3(items.reduce((a, l) => a + l.qty, 0)),
    });
  }),

  /**
   * The per-product breakdown — the sharpest form of the zero trap in this
   * module, one product and one number, which is why the product is confirmed
   * to be ours before the sum runs. A product of another farm is a 404 and
   * never a believable "0 bultos".
   */
  http.get("*/v1/products/:id/stock", ({ request, params }) => {
    const g = guard(request, "stock.read");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const id = String(params.id);
    const foreign = confirmOurs(t, { product: id });
    if (foreign) return foreign;
    const byWarehouse = db.stockLevels(t, id);
    return HttpResponse.json({
      productId: id,
      byWarehouse,
      total: db.round3(byWarehouse.reduce((a, l) => a + l.qty, 0)),
    });
  }),

  http.get("*/v1/stock/moves", ({ request }) => {
    const g = guard(request, "stock.read");
    if (g.deny) return g.deny;
    const params = new URL(request.url).searchParams;
    const t = g.p.tenant;
    const productId = params.get("productId");
    const warehouseId = params.get("warehouseId");
    const reason = params.get("reason");
    const from = params.get("from");
    const to = params.get("to");
    if (reason && !STOCK_REASONS.includes(reason as WireStockReason)) {
      return badRequest(`reason must be one of ${STOCK_REASONS.join(", ")}`);
    }
    const foreign = confirmOurs(t, { product: productId, warehouse: warehouseId });
    if (foreign) return foreign;
    const limitParam = Number(params.get("limit") ?? 0);
    const limit = limitParam > 0 && limitParam <= 500 ? limitParam : 200;

    return HttpResponse.json({
      items: t.stockMoves
        .filter((m) => !productId || m.productId === productId)
        .filter((m) => !warehouseId || m.warehouseId === warehouseId)
        .filter((m) => !reason || m.reason === reason)
        .filter((m) => !from || m.localDay.slice(0, 10) >= from)
        .filter((m) => !to || m.localDay.slice(0, 10) <= to)
        .sort(
          (a, b) =>
            b.localDay.localeCompare(a.localDay) || b.createdAt.localeCompare(a.createdAt),
        )
        .slice(0, limit)
        .map((m) => projectStockMove(t, m)),
    });
  }),

  /**
   * The ONLY way the warehouse changes. There is deliberately no PATCH and no
   * PUT beside it: `stock_moves_is_append_only()` raises on UPDATE and DELETE
   * and `REVOKE UPDATE, DELETE` backs it up, so a route that edited one could
   * not be written even if somebody wanted it.
   */
  http.post("*/v1/stock/moves", async ({ request }) => {
    const g = guard(request, "stock.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as StockMoveBody;
    const t = g.p.tenant;

    // Both ids are required and neither may be a name: `StockMoveInput` has no
    // `warehouse` field, and the server decodes with DisallowUnknownFields.
    if (!body.productId || !body.warehouseId) {
      return badRequest("productId and warehouseId are required");
    }
    if (body.qty === 0) return badRequest("qty cannot be zero");
    if (!body.reason || !STOCK_REASONS.includes(body.reason)) {
      return badRequest(`reason must be one of ${STOCK_REASONS.join(", ")}`);
    }
    // A 'venta' movement is the shadow of a sale and is written by the sales
    // handler, in the same transaction as the sale. Letting one in here would
    // be the one way to get stock and sales to disagree.
    if (body.reason === "venta") {
      return badRequest("record the sale at POST /v1/sales; it writes its own stock movement");
    }
    const labels = body.labels ?? 0;
    if (!Number.isInteger(labels) || labels < 0 || labels > 500) {
      return badRequest("labels must be between 0 and 500");
    }

    const foreign = confirmOurs(t, {
      product: body.productId,
      warehouse: body.warehouseId,
      plot: body.plotId,
      plotCrop: body.plotCropId,
      workRecord: body.workRecordId,
    });
    if (foreign) return foreign;

    const id = body.id ?? crypto.randomUUID();
    // A retry answers the BARE movement, not the envelope: there is nothing to
    // generate a second time, and a second label batch is exactly what a retry
    // must not produce.
    const already = t.stockMoves.find((m) => m.id === id);
    if (already) return HttpResponse.json(projectStockMove(t, already));

    // The guard only runs on the way out, and only when it was not waived.
    const signed =
      OUTGOING_REASONS.has(body.reason) && (body.qty ?? 0) > 0 ? -(body.qty ?? 0) : (body.qty ?? 0);
    if (signed < 0 && !body.allowNegative) {
      const short = guardStock(t, body.productId, body.warehouseId, signed);
      if (short) return short;
    }

    const created = insertStockMove(t, { ...body, id }, g.p.user.id);
    if (created instanceof Response) return created;

    // `{move, labelBatch?}` — an envelope, because RSP-025's stickers are asked
    // for ON the movement (`labels`) and not at a route of their own. The
    // server generates the batch and does not print: a request that blocked on
    // a printer would fail a harvest because the paper ran out.
    const out: Record<string, unknown> = { move: projectStockMove(t, created) };
    if (labels > 0) {
      const batch: db.MockLabelBatch = {
        id: crypto.randomUUID(),
        stockMoveId: created.id,
        count: labels,
        printedAt: null,
        createdAt: nowInstant(),
      };
      t.labelBatches.push(batch);
      out.labelBatch = projectLabelBatch(t, batch);
    }
    return HttpResponse.json(out, { status: 201 });
  }),

  http.post("*/v1/stock/moves/:id/reverse", async ({ request, params }) => {
    const g = guard(request, "stock.write");
    if (g.deny) return g.deny;
    const body = (await request.json().catch(() => ({}))) as ReverseRequestBody;
    const created = reverseStockMove(g.p.tenant, String(params.id), body.note ?? null, g.p.user.id);
    if (created instanceof Response) return created;
    return HttpResponse.json(projectStockMove(g.p.tenant, created), { status: 201 });
  }),

  http.get("*/v1/label-batches/:id", ({ request, params }) => {
    const g = guard(request, "stock.read");
    if (g.deny) return g.deny;
    const batch = g.p.tenant.labelBatches.find((b) => b.id === params.id);
    if (!batch) return notFound();
    return HttpResponse.json(projectLabelBatch(g.p.tenant, batch));
  }),

  /* ---- ventas (RSP-026 … RSP-029) ---- */

  http.get("*/v1/sales", ({ request }) => {
    const g = guard(request, "sales.read");
    if (g.deny) return g.deny;
    const params = new URL(request.url).searchParams;
    // `SaleFilter` reuses the vocabulary of every other list — "active" hides
    // the voided ones — even though the column is `voided_at` and not
    // `deleted_at`, because on the screen it is the same switch.
    const wanted = listStatus(params);
    const q = params.get("q");
    const productId = params.get("productId");
    const customerId = params.get("customerId");
    const from = params.get("from");
    const to = params.get("to");
    const t = g.p.tenant;

    // A filter by another farm's product would list nothing and total zero,
    // which reads as "we have sold none of that" rather than "that is not
    // ours". Confirm before adding up.
    const foreign = confirmOurs(t, { product: productId, customer: customerId });
    if (foreign) return foreign;

    const items = t.sales
      .filter((s) => wanted(s.voidedAt))
      .map((s) => projectSale(t, s))
      .filter((s) => matches(s.product, q) || matches(s.customer, q))
      .filter((s) => !productId || s.productId === productId)
      .filter((s) => !customerId || s.customerId === customerId)
      .filter((s) => !from || s.localDay.slice(0, 10) >= from)
      .filter((s) => !to || s.localDay.slice(0, 10) <= to)
      .sort(
        (a, b) => b.localDay.localeCompare(a.localDay) || b.createdAt.localeCompare(a.createdAt),
      );

    // The totals count LIVE sales only, even when the voided ones are in the
    // list: a sale that was undone is not money the farm took.
    const live = items.filter((sale) => sale.voidedAt === null);
    return HttpResponse.json({
      items,
      totalCents: live.reduce((a, sale) => a + sale.amountCents, 0),
      totalQty: db.round3(live.reduce((a, sale) => a + sale.qty, 0)),
    });
  }),

  /**
   * `CreateSale` writes the sale AND its outgoing movement, in one
   * transaction. Splitting them is how the sales list and the warehouse start
   * disagreeing with nothing to say which is right, and the database is in on
   * it: `stock_venta_has_sale` makes the movement impossible without the sale.
   */
  http.post("*/v1/sales", async ({ request }) => {
    const g = guard(request, "sales.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as SaleRequestBody;
    const t = g.p.tenant;

    if (!body.productId) return badRequest("productId is required");
    if (!body.warehouseId) {
      return badRequest("warehouseId is required: a sale takes the product out of somewhere");
    }
    if (typeof body.qty !== "number" || !(body.qty > 0)) return badRequest("qty must be positive");
    if (
      typeof body.amountCents !== "number" ||
      !Number.isInteger(body.amountCents) ||
      body.amountCents <= 0
    ) {
      return badRequest("amountCents must be positive");
    }

    // The customer picker resolves a NAME into a row, so the sales screen can
    // offer "add it if it is not there" like every other picker here.
    let customerId = body.customerId ?? null;
    if (!customerId && body.customer) {
      const existing = t.customers.find(
        (c) => c.deletedAt === null && sameName(c.name, body.customer!),
      );
      if (existing) {
        customerId = existing.id;
      } else {
        const created: WireCustomer = {
          id: crypto.randomUUID(),
          name: body.customer.trim(),
          documentType: null,
          docId: null,
          phone: null,
          createdAt: nowInstant(),
          deletedAt: null,
        };
        t.customers.push(created);
        customerId = created.id;
      }
    }

    const foreign = confirmOurs(t, {
      product: body.productId,
      warehouse: body.warehouseId,
      customer: customerId,
    });
    if (foreign) return foreign;

    const id = body.id ?? crypto.randomUUID();
    const already = t.sales.find((sale) => sale.id === id);
    if (already) return HttpResponse.json(projectSale(t, already));

    if (!body.allowNegativeStock) {
      const short = guardStock(t, body.productId, body.warehouseId, -body.qty);
      if (short) return short;
    }

    const sale: db.MockSale = {
      id,
      productId: body.productId,
      customerId,
      warehouseId: body.warehouseId,
      qty: db.round3(body.qty),
      amountCents: body.amountCents,
      receiptId: body.receiptId ?? null,
      note: body.note ?? null,
      localDay: db.dayInstant(body.localDay || today()),
      createdBy: g.p.user.id,
      createdAt: nowInstant(),
      voidedAt: null,
    };
    const move = insertStockMove(
      t,
      {
        productId: body.productId,
        warehouseId: body.warehouseId,
        qty: -sale.qty, // out. stock_sign refuses any other answer for 'venta'.
        reason: "venta",
        localDay: body.localDay ?? null,
      },
      g.p.user.id,
      { fromSale: id },
    );
    if (move instanceof Response) return move;
    t.sales.push(sale);
    return HttpResponse.json(projectSale(t, sale), { status: 201 });
  }),

  http.get("*/v1/sales/:id", ({ request, params }) => {
    const g = guard(request, "sales.read");
    if (g.deny) return g.deny;
    const sale = g.p.tenant.sales.find((s) => s.id === params.id);
    return sale ? HttpResponse.json(projectSale(g.p.tenant, sale)) : notFound();
  }),

  /**
   * RSP-028, minus the one field that cannot move.
   *
   * `qty` is half of a stock movement that is already written and append-only.
   * Changing it here would leave the warehouse claiming one number and the
   * sales list another, so `SalePatch` simply has no such field and the server
   * decodes with `DisallowUnknownFields` — which makes a body carrying `qty` a
   * 400 about an unknown field. That is emulated rather than dressed up in a
   * code of its own, because a code the server does not send is a code no
   * screen may branch on.
   */
  http.patch("*/v1/sales/:id", async ({ request, params }) => {
    const g = guard(request, "sales.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as SaleRequestBody & { status?: string };
    const t = g.p.tenant;
    // `salePatchRequest` accepts both of these ONLY to refuse them with an
    // explanation. Silently ignoring a field the caller sent is the worst of
    // both answers: the request succeeds and the number on the screen is not
    // the number stored.
    if (body.qty !== undefined) {
      return badRequest(
        "the quantity of a sale is fixed by its stock movement: void the sale and record it again",
      );
    }
    if (body.status === "inactive") {
      return badRequest(
        "use DELETE to void a sale; voiding returns the stock as well as flagging the row",
      );
    }
    if (body.status === "active") {
      return badRequest("a voided sale is not restored: record a new one");
    }
    // `UPDATE ... WHERE id = $1 AND voided_at IS NULL` — a voided sale is not
    // edited (`sales_void_is_final`), and it matches no row, so: 404.
    const sale = t.sales.find((s) => s.id === params.id && s.voidedAt === null);
    if (!sale) return notFound();
    if (body.amountCents !== undefined) {
      const bad = validAmount(body.amountCents);
      if (bad) return bad;
    }
    patch(sale, body.customerId, "customerId");
    patch(sale, body.amountCents, "amountCents");
    patch(sale, body.receiptId, "receiptId");
    patch(sale, body.note, "note");
    if (body.localDay) sale.localDay = db.dayInstant(body.localDay);
    return HttpResponse.json(projectSale(t, sale));
  }),

  /**
   * RSP-029's "eliminar deja la venta inactiva", done honestly: the row is
   * flagged AND the coffee comes back, as a reversing movement in the same
   * transaction. Flagging alone would leave it sold in the list and gone from
   * the warehouse forever.
   *
   * IT IS A DELETE AND IT ANSWERS 200 WITH THE SALE — not a POST to /void, and
   * not a 204. The verb is the interesting part: "eliminar" in the use case IS
   * a void here, so DELETE is the honest spelling of it, and the body comes
   * back because the caller needs the `voidedAt` and the `reversalMoveId` the
   * sale now carries.
   *
   * It has an ACTION of its own, `sales.void`, and the guard uses it.
   *
   * There is no un-void. `ux_moves_reverses` lets a movement be reversed
   * exactly once, so a sale recorded by mistake is followed by a NEW sale.
   */
  http.delete("*/v1/sales/:id", ({ request, params }) => {
    const g = guard(request, "sales.void");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const sale = t.sales.find((s) => s.id === params.id);
    if (!sale) return notFound();
    if (sale.voidedAt !== null) {
      return conflict("SALE_ALREADY_VOID", "that sale is already void");
    }
    const move = t.stockMoves.find((m) => m.saleId === sale.id && m.reason === "venta");
    if (!move) return fail(500, "INTERNAL", "the sale has no stock movement to reverse");
    const reversal = reverseStockMove(t, move.id, `void of sale ${sale.id}`, g.p.user.id);
    if (reversal instanceof Response) return reversal;
    sale.voidedAt = nowInstant();
    return HttpResponse.json(projectSale(t, sale));
  }),

  /* ---- gastos (RSP-030 … RSP-033) ---- */

  /**
   * The list AND its total, in one envelope, because the screen shows both and
   * a second round trip for a SUM the server already walked would be a second
   * chance for the two to disagree.
   *
   * The total counts LIVE rows only, exactly as `ListExpenses` does: a
   * logically deleted expense may be visible under the "Inactivos" filter and
   * is still not money the farm spent.
   */
  http.get("*/v1/expenses", ({ request }) => {
    const g = guard(request, "expenses.read");
    if (g.deny) return g.deny;
    const params = new URL(request.url).searchParams;
    const wanted = listStatus(params);
    const q = params.get("q");
    const activityId = params.get("activityId");
    const plotId = params.get("plotId");
    const from = params.get("from");
    const to = params.get("to");
    const t = g.p.tenant;

    const items = t.expenses
      .filter((e) => wanted(e.deletedAt))
      .filter((e) => matches(e.concept, q))
      .filter((e) => !activityId || e.activityId === activityId)
      .filter((e) => !plotId || e.plotId === plotId)
      .filter((e) => !from || e.localDay.slice(0, 10) >= from)
      .filter((e) => !to || e.localDay.slice(0, 10) <= to)
      .sort(
        (a, b) => b.localDay.localeCompare(a.localDay) || b.createdAt.localeCompare(a.createdAt),
      )
      .map((e) => projectExpense(t, e));

    // TOP LEVEL, not nested: `{items, totalCents, count}`. And the total counts
    // LIVE rows only, exactly as `ListExpenses` does — an expense visible
    // under the "Inactivos" filter is still not money the farm spent.
    const live = items.filter((e) => e.deletedAt === null);
    return HttpResponse.json({
      items,
      totalCents: live.reduce((a, e) => a + e.amountCents, 0),
      count: live.length,
    });
  }),

  http.post("*/v1/expenses", async ({ request }) => {
    const g = guard(request, "expenses.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as ExpenseRequestBody;
    const t = g.p.tenant;

    if (!body.concept || !body.concept.trim()) return badRequest("concept is required");
    const badAmount = validAmount(body.amountCents);
    if (badAmount) return badAmount;
    const target = validateExpenseTarget(t, body);
    if (target) return target;
    const foreign = confirmOurs(t, {
      activity: body.activityId,
      plot: body.plotId,
      plotCrop: body.plotCropId,
    });
    if (foreign) return foreign;

    // The id check comes AFTER the validation and the ownership checks, which
    // is the order `handleCreateExpense` uses: a retry of a request that was
    // never valid should get the same refusal it got the first time.
    const id = body.id ?? crypto.randomUUID();
    const already = t.expenses.find((e) => e.id === id);
    if (already) return HttpResponse.json(projectExpense(t, already));

    const created: db.MockExpense = {
      id,
      concept: body.concept.trim(),
      amountCents: body.amountCents!,
      localDay: db.dayInstant(body.localDay || today()),
      activityId: body.activityId ?? null,
      plotId: body.plotId ?? null,
      plotCropId: body.plotCropId ?? null,
      receiptId: body.receiptId ?? null,
      note: body.note ?? null,
      createdBy: g.p.user.id,
      createdAt: nowInstant(),
      deletedAt: null,
    };
    // NOTHING HAPPENS TO ANYBODY'S LEDGER HERE, and there is no worker id to
    // do it with. RSP-030's "gasto" is the farm's own accounting; RSP-007's is
    // a line in one person's file. Wiring them together takes money out of
    // somebody's wages, silently and correctly according to the code.
    t.expenses.push(created);
    return HttpResponse.json(projectExpense(t, created), { status: 201 });
  }),

  http.get("*/v1/expenses/:id", ({ request, params }) => {
    const g = guard(request, "expenses.read");
    if (g.deny) return g.deny;
    const expense = g.p.tenant.expenses.find((e) => e.id === params.id);
    return expense ? HttpResponse.json(projectExpense(g.p.tenant, expense)) : notFound();
  }),

  /**
   * RSP-032. The imputation can MOVE — from an activity to a plot — so the
   * three target columns are patched as a triple rather than one by one:
   * COALESCE would keep the old `activity_id` alive and `expense_target` would
   * then refuse the result, correctly and unhelpfully.
   */
  http.patch("*/v1/expenses/:id", async ({ request, params }) => {
    const g = guard(request, "expenses.write");
    if (g.deny) return g.deny;
    const body = (await request.json()) as ExpenseRequestBody;
    const bad = validStatus(body.status);
    if (bad) return bad;
    const t = g.p.tenant;
    const expense = t.expenses.find((e) => e.id === params.id);
    if (!expense) return notFound();

    if (body.status === "inactive") expense.deletedAt ??= nowInstant();
    if (body.status === "active") expense.deletedAt = null;

    if (body.amountCents !== undefined) {
      const badAmount = validAmount(body.amountCents);
      if (badAmount) return badAmount;
    }

    const retarget =
      body.activityId != null || body.plotId != null || body.plotCropId != null;
    if (retarget) {
      const target = validateExpenseTarget(t, body);
      if (target) return target;
      const foreign = confirmOurs(t, {
        activity: body.activityId,
        plot: body.plotId,
        plotCrop: body.plotCropId,
      });
      if (foreign) return foreign;
      // The imputation moves as a UNIT. "Charge this to the plot instead" is
      // impossible to express field by field: the old activityId would survive
      // a COALESCE patch and `expense_target` would refuse the result,
      // correctly and unhelpfully.
      expense.activityId = body.activityId ?? null;
      expense.plotId = body.plotId ?? null;
      expense.plotCropId = body.plotCropId ?? null;
    }

    patch(expense, body.concept?.trim(), "concept");
    patch(expense, body.amountCents, "amountCents");
    patch(expense, body.note, "note");
    patch(expense, body.receiptId, "receiptId");
    if (body.localDay) expense.localDay = db.dayInstant(body.localDay);
    return HttpResponse.json(projectExpense(t, expense));
  }),

  http.delete("*/v1/expenses/:id", ({ request, params }) => {
    const g = guard(request, "expenses.write");
    if (g.deny) return g.deny;
    const expense = g.p.tenant.expenses.find((e) => e.id === params.id && e.deletedAt === null);
    if (!expense) return notFound();
    expense.deletedAt = nowInstant();
    return noContent();
  }),

  /* -- reports (cosecha) --------------------------------------------- */

  http.get("*/v1/reports/weeks", ({ request }) => {
    const g = guard(request, "reports.read");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const params = new URL(request.url).searchParams;
    const from = params.get("from");
    const to = params.get("to");
    const limit = Number(params.get("limit") ?? 0) || 0;

    const rows = harvestOf(t).filter(
      (r) => (!from || db.dayOf(r.dateFrom) >= from) && (!to || db.dayOf(r.dateFrom) <= to),
    );
    const byWeek = groupBy(rows, (r) => db.dayOf(r.weekStart));
    const items = [...byWeek.entries()]
      .map(([weekStart, list]) => ({
        weekStart,
        ...totalsOf(t, list),
        pickers: new Set(list.map((r) => r.workerId)).size,
        days: new Set(list.map((r) => db.dayOf(r.dateFrom))).size,
        priceCents: db.weekPriceOf(t, weekStart) || null,
        finished: weekStart < mondayOf(today()),
      }))
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

    return HttpResponse.json({
      scope: "harvest",
      items: limit > 0 ? items.slice(0, limit) : items,
    });
  }),

  http.get("*/v1/reports/weeks/:monday", ({ request, params }) => {
    const g = guard(request, "reports.read");
    if (g.deny) return g.deny;
    const monday = String(params.monday);
    const bad = checkMonday(monday);
    if (bad) return bad;
    const t = g.p.tenant;

    const rows = harvestOf(t).filter((r) => db.dayOf(r.weekStart) === monday);
    return HttpResponse.json({
      scope: "harvest",
      weekStart: monday,
      finished: monday < mondayOf(today()),
      byDay: gridOf(t, rows, "day"),
      byCrop: gridOf(t, rows, "crop"),
      total: totalsOf(t, rows),
    });
  }),

  http.get("*/v1/reports/crops/:plotCropId", ({ request, params }) => {
    const g = guard(request, "reports.read");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const id = String(params.plotCropId);

    // Confirmed to belong to this farm BEFORE anything is summed: a sum over
    // another farm's id comes back as a plausible "this crop produced nothing".
    const plot = t.plots.find((p) => (p.crops ?? []).some((c) => c.id === id));
    const crop = plot?.crops?.find((c) => c.id === id);
    if (!plot || !crop) return notFound();

    const rows = harvestOf(t).filter((r) => (r.plotCropIds ?? []).includes(id));
    const days = rows.map((r) => db.dayOf(r.dateFrom)).sort();
    const totals = totalsOf(t, rows);
    const byWeek = [...groupBy(rows, (r) => db.dayOf(r.weekStart)).entries()]
      .map(([weekStart, list]) => ({
        weekStart,
        ...totalsOf(t, list),
        pickers: new Set(list.map((r) => r.workerId)).size,
        days: new Set(list.map((r) => db.dayOf(r.dateFrom))).size,
        finished: weekStart < mondayOf(today()),
      }))
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

    return HttpResponse.json({
      scope: "harvest",
      plotCropId: id,
      label: `${cropLabel(crop)} — ${plot.name}`,
      ...totals,
      pickers: new Set(rows.map((r) => r.workerId)).size,
      days: new Set(days).size,
      firstOn: days[0] ?? null,
      lastOn: days[days.length - 1] ?? null,
      areaHa: crop.areaHa ?? null,
      kgPerHa: crop.areaHa && totals.kg !== null ? totals.kg / crop.areaHa : null,
      sharedRecords: rows.filter((r) => (r.plotCropIds ?? []).length > 1).length,
      byWeek,
    });
  }),

  http.get("*/v1/reports/performance", ({ request }) => {
    const g = guard(request, "reports.read");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const days = Number(new URL(request.url).searchParams.get("days") ?? 30) || 30;
    const since = addDays(parseDay(today()), -days).toISOString().slice(0, 10);
    const rows = harvestOf(t).filter((r) => db.dayOf(r.dateFrom) >= since);

    return HttpResponse.json({
      scope: "harvest",
      days,
      since,
      minComparableDays: MIN_COMPARABLE_DAYS,
      items: performanceOf(t, rows),
    });
  }),

  http.get("*/v1/reports/anomalies", ({ request }) => {
    const g = guard(request, "reports.read");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const params = new URL(request.url).searchParams;
    const days = Number(params.get("days") ?? 120) || 120;
    const maxKg = Number(params.get("maxKg") ?? 120) || 120;
    const limit = Number(params.get("limit") ?? 200) || 200;
    const since = addDays(parseDay(today()), -days).toISOString().slice(0, 10);
    const rows = harvestOf(t).filter((r) => db.dayOf(r.dateFrom) >= since);

    return HttpResponse.json({
      scope: "harvest",
      days,
      maxKg,
      limit,
      since,
      items: anomaliesOf(t, rows, maxKg).slice(0, limit),
    });
  }),

  http.get("*/v1/reports/harvest-curve", ({ request }) => {
    const g = guard(request, "reports.read");
    if (g.deny) return g.deny;
    const t = g.p.tenant;
    const params = new URL(request.url).searchParams;
    const plotCropId = params.get("plotCropId");
    const weeks = Number(params.get("weeks") ?? 26) || 26;

    if (plotCropId && !t.plots.some((p) => (p.crops ?? []).some((c) => c.id === plotCropId))) {
      return notFound();
    }

    const rows = harvestOf(t).filter(
      (r) => !plotCropId || (r.plotCropIds ?? []).includes(plotCropId),
    );
    const series = [...groupBy(rows, (r) => db.dayOf(r.weekStart)).entries()]
      .map(([weekStart, list]) => ({ weekStart, kg: totalsOf(t, list).kg }))
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
      .slice(0, weeks);

    const current = mondayOf(today());
    // A week whose kilos are unknown is EXCLUDED, not zeroed: treating it as 0
    // would manufacture a 100 % drop and tell a farm its season was over.
    const finished = series.filter((w) => w.weekStart < current && w.kg !== null) as {
      weekStart: string;
      kg: number;
    }[];

    const shape = readHarvest(
      finished.map((w) => ({ week: w.weekStart, kg: w.kg })),
      current,
    );

    return HttpResponse.json({
      scope: "harvest",
      plotCropId: plotCropId ?? null,
      currentWeek: current,
      weeks: series,
      shape: {
        peak: shape.peak ? { weekStart: shape.peak.week, kg: shape.peak.kg } : null,
        fallingWeeks: shape.fallingWeeks,
        windingDown: shape.windingDown,
        ...(finished.length === 0 ? { reason: "no_finished_weeks" as const } : {}),
      },
      weeksWithoutKilos: series.filter((w) => w.kg === null).length,
    });
  }),

];

/* -- the shared ledger write ----------------------------------------- */

/**
 * `addLedgerEntry`. The client sends a POSITIVE amount and the sign is applied
 * here: a `pago`, an `anticipo` and a `deduccion` are all negative in the
 * ledger, and the database refuses a positive one outright. Only an `ajuste`
 * keeps the sign it arrived with, because an adjustment can go either way.
 */
function ledgerHandler(kind: WireLedgerKind, checkBalance: boolean) {
  const action = (
    {
      pago: "ledger.payment",
      anticipo: "ledger.advance",
      deduccion: "ledger.deduction",
      ajuste: "ledger.adjust",
    } as const
  )[kind as "pago" | "anticipo" | "deduccion" | "ajuste"];

  return async ({ request }: { request: Request }) => {
    const g = guard(request, action);
    if (g.deny) return g.deny;
    await delay(200);
    const body = (await request.json()) as WireLedgerRequest;
    const t = g.p.tenant;

    if (!body.workerId) return badRequest("workerId is required");
    if (!body.amountCents) return badRequest("amountCents cannot be zero");

    let amount = body.amountCents;
    if (kind !== "ajuste") {
      // Accept either convention from the client and normalise; the database
      // would reject the wrong sign anyway.
      amount = -Math.abs(amount);
      if (body.method != null && !["efectivo", "transferencia", "otro"].includes(body.method)) {
        return badRequest("method must be efectivo, transferencia or otro");
      }
      if (kind === "deduccion" && body.method != null) {
        return badRequest("a deduction has no payment method");
      }
    }
    if (body.date && !DAY.test(body.date)) return badRequest("date must be YYYY-MM-DD");

    // The server leans on the foreign key here and a bad workerId is a 500.
    // A 404 is the same refusal with a code the client can read.
    if (!t.workers.some((w) => w.id === body.workerId)) return notFound();

    if (checkBalance && !body.allowOverpayment) {
      // Partial and full payment need no flag of their own: a payment is
      // partial when it is less than the balance. The check runs against the
      // DERIVED balance, never against a stored total, and `details.balanceCents`
      // is what the payment screen reads to offer the excess as an advance.
      const balance = db.balanceOf(t, body.workerId);
      if (-amount > balance.balanceCents) {
        return conflict("AMOUNT_EXCEEDS_BALANCE", "the payment is larger than what is owed", {
          balanceCents: balance.balanceCents,
        });
      }
    }

    const created: WireLedgerEntry = {
      id: body.id ?? crypto.randomUUID(),
      workerId: body.workerId,
      kind,
      amountCents: amount,
      date: db.dayInstant(body.date ?? today()),
      settlementId: null,
      method: (body.method ?? null) as WirePayMethod | null,
      note: body.note ?? null,
      reversesId: null,
      createdAt: nowInstant(),
    };
    t.ledger.push(created);
    return HttpResponse.json(created, { status: 201 });
  };
}

/* -- small builders -------------------------------------------------- */

/** `AdminFarm`: columns of `farms`, and `status` derived from `suspendedAt`. */
function adminFarm(f: db.MockFarm) {
  return {
    id: f.id,
    name: f.name,
    timezone: f.timezone,
    currency: f.currency,
    country: f.country,
    city: f.city,
    status: f.suspendedAt === null ? "active" : "suspended",
    suspendedAt: f.suspendedAt,
    createdAt: f.createdAt,
  };
}

/** Newest first, by the day the note is about and then by when it was written. */
function notesOf(t: db.Tenant, workerId: string, limit: number): WireNote[] {
  return t.notes
    .filter((n) => n.workerId === workerId)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/**
 * The `farms_tz_valid` CHECK, as close as a browser gets: `Intl` throws on a
 * name it does not know, and that throw is the whole test.
 */
function isTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * `store.SetPlotBoundary`, in the three steps that matter to a caller.
 *
 * 1. ST_IsValid. A ring that crosses itself has no area anybody would agree
 *    on, so `computedAreaHa` would be a confident lie and the write is
 *    refused with INVALID_GEOMETRY. So is a Point, a LineString, or a body
 *    that is not GeoJSON at all — same code, different sentence, exactly as
 *    the Go store does it.
 * 2. ST_Multi. The column is a MultiPolygon, so a plain Polygon is PROMOTED
 *    on the way in and comes back out as a MultiPolygon. Emulating this is
 *    the whole reason the editor reads MultiPolygon: without it, the map
 *    would work perfectly against the mock and break on the first reload
 *    against the real server.
 * 3. ST_Area/10000. Measured here with the same spherical sum the editor
 *    previews with, which is within a tenth of a percent of PostGIS on the
 *    ellipsoid — close enough that the mock cannot teach a screen to expect
 *    the wrong order of magnitude.
 *
 * Returns a Response when it refused, and nothing when it stored.
 */
function applyBoundary(plot: WirePlot, raw: unknown): Response | void {
  const geometry = geo.asGeometry(raw);
  if (!geometry) {
    return fail(400, "INVALID_GEOMETRY", "that is not a GeoJSON geometry this service can read");
  }
  for (const ring of geo.outerRings(geometry)) {
    const problem = geo.ringProblem(ring);
    if (problem) {
      return fail(400, "INVALID_GEOMETRY", `Self-intersection or degenerate ring: ${problem.kind}`);
    }
  }
  const multi: geo.MultiPolygonGeometry = {
    type: "MultiPolygon",
    coordinates: geo.polygonsOf(geometry).map((rings) => rings.map(geo.closeRing)),
  };
  plot.boundary = multi;
  plot.computedAreaHa = Number(geo.areaHaOf(multi).toFixed(4));
}

/**
 * `store.OverlappingPlots`: the other live plots whose polygon this one runs
 * into. A warning, never a refusal.
 */
function overlappingPlots(t: db.Tenant, plot: WirePlot): WireCatalogItem[] {
  const mine = geo.asGeometry(plot.boundary);
  if (!mine) return [];
  return t.plots
    .filter((p) => p.id !== plot.id && p.deletedAt === null && p.boundary != null)
    .flatMap((p) => {
      const theirs = geo.asGeometry(p.boundary);
      return theirs && geo.geometriesIntersect(mine, theirs) ? [{ id: p.id, name: p.name }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

/* ------------------------------------------------------------------ */
/* Products, the warehouse, sales and expenses                         */
/* ------------------------------------------------------------------ */

/**
 * The joins and the sum, on the way out.
 *
 * `stock` is `productCols`'s correlated sub-select and is computed here on
 * every single read, exactly as it is there. It is the whole point of
 * migration 00009 and it is worth being blunt about: THERE IS NO ROUTE THAT
 * SETS A QUANTITY. If a screen wants the number to change, it records a
 * movement. A mock that stored a total would let "editar existencias" be built
 * and tested and shipped, and only production would ever disagree.
 */
function projectProduct(t: db.Tenant, p: db.MockProduct): WireProduct {
  return {
    ...p,
    category: t.productCategories.find((c) => c.id === p.categoryId)?.name ?? null,
    storageUnit: t.storageUnits.find((u) => u.id === p.storageUnitId)?.name ?? "",
    stock: db.productStock(t, p.id),
  };
}

/**
 * `reversedById` is a sub-select and not a column: a movement does not know it
 * has been undone, the undoing knows what it undid. Storing the back-pointer
 * would mean writing to an append-only row to record that it was reversed,
 * which is the exact thing the trigger forbids.
 */
function projectStockMove(t: db.Tenant, m: db.MockStockMove): WireStockMove {
  return {
    ...m,
    product: t.products.find((p) => p.id === m.productId)?.name ?? "",
    warehouse: t.warehouses.find((w) => w.id === m.warehouseId)?.name ?? "",
    plot: (m.plotId && t.plots.find((p) => p.id === m.plotId)?.name) || null,
    reversedById: t.stockMoves.find((r) => r.reversesId === m.id)?.id ?? null,
    labelBatchId:
      t.labelBatches
        .filter((b) => b.stockMoveId === m.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.id ?? null,
  };
}

function projectSale(t: db.Tenant, s: db.MockSale): WireSale {
  const product = t.products.find((p) => p.id === s.productId);
  const move = t.stockMoves.find((m) => m.saleId === s.id && m.reason === "venta");
  const reversal = move ? t.stockMoves.find((r) => r.reversesId === move.id) : undefined;
  return {
    ...s,
    product: product?.name ?? "",
    storageUnit: t.storageUnits.find((u) => u.id === product?.storageUnitId)?.name ?? "",
    customer: (s.customerId && t.customers.find((c) => c.id === s.customerId)?.name) || null,
    warehouse: t.warehouses.find((w) => w.id === s.warehouseId)?.name ?? "",
    stockMoveId: move?.id ?? null,
    reversalMoveId: reversal?.id ?? null,
  };
}

/**
 * `target` is derived from WHICH COLUMN IS SET and never from anything the
 * caller sent — `scanExpense` does exactly this. A client able to name the
 * target independently of the ids could send "activity" with only a plot on
 * it, and every per-activity breakdown would be wrong in a way no constraint
 * could catch, because both halves would be individually valid.
 *
 * `crop` is the crop TYPE's name (ct.name in `expenseFrom`), not the variety.
 */
function projectExpense(t: db.Tenant, e: db.MockExpense): WireExpense {
  const plot = e.plotId ? t.plots.find((p) => p.id === e.plotId) : undefined;
  const crop = e.plotCropId ? plot?.crops.find((c) => c.id === e.plotCropId) : undefined;
  return {
    ...e,
    activity: (e.activityId && t.activities.find((a) => a.id === e.activityId)?.name) || null,
    plot: plot?.name ?? null,
    crop: crop?.cropType ?? null,
    target: e.activityId ? "activity" : "plot",
  };
}

/**
 * `GetLabelBatch`: the stickers are RENDERED from the movement every time they
 * are read, never frozen into rows. A sticker is a picture of a fact, not a
 * fact of its own — and a batch whose stored text disagreed with the movement
 * it names would be a lie printed on paper and stuck to a sack.
 *
 * The quantity splits evenly and the REMAINDER GOES ON THE LAST ONE, which is
 * what keeps the total on the paper equal to the total in the warehouse:
 * eleven arrobas over four labels is 2,75 each, and eleven over three is
 * 3,667 + 3,667 + 3,666.
 */
function projectLabelBatch(t: db.Tenant, b: db.MockLabelBatch): WireLabelBatch | null {
  const move = t.stockMoves.find((m) => m.id === b.stockMoveId);
  if (!move) return null;
  const product = t.products.find((p) => p.id === move.productId);
  const each = move.qty / b.count;
  const labels: WireLabel[] = [];
  for (let i = 0; i < b.count; i++) {
    labels.push({
      code: `${b.id.slice(0, 8)}-${i + 1}`,
      product: product?.name ?? "",
      storageUnit: t.storageUnits.find((u) => u.id === product?.storageUnitId)?.name ?? "",
      qty: db.round3(i === b.count - 1 ? move.qty - each * (b.count - 1) : each),
      warehouse: t.warehouses.find((w) => w.id === move.warehouseId)?.name ?? "",
      plot: (move.plotId && t.plots.find((p) => p.id === move.plotId)?.name) || null,
      localDay: move.localDay.slice(0, 10),
    });
  }
  return { ...b, labels };
}

/**
 * `confirmOurs` in `handlers_stock.go`: every id the caller named has to
 * belong to this farm BEFORE anything is added up.
 *
 * This is the trap the API pair says has bitten the project twice, and it is
 * the reason so many of these routes 404 on a filter. RLS narrows rows rather
 * than raising, so a SUM over another farm's product returns 0 and a list
 * returns []. "There are no sacks in that warehouse" is a completely credible
 * answer, and it is the same answer an empty warehouse gives. A wrong answer
 * that looks right is the expensive kind.
 *
 * The mock has no RLS to be fooled by — a tenant's arrays simply do not
 * contain another farm's rows — but it has to answer 404 in the same places,
 * or a screen gets built expecting an empty list where production sends an
 * error.
 */
function confirmOurs(t: db.Tenant, checks: Partial<Record<Owned, string | null | undefined>>): Response | null {
  for (const [kind, id] of Object.entries(checks) as Array<[Owned, string | null | undefined]>) {
    if (!id) continue;
    const found = {
      product: () => t.products.some((p) => p.id === id),
      warehouse: () => t.warehouses.some((w) => w.id === id),
      plot: () => t.plots.some((p) => p.id === id),
      plotCrop: () => t.plots.some((p) => p.crops.some((c) => c.id === id)),
      customer: () => t.customers.some((c) => c.id === id),
      activity: () => t.activities.some((a) => a.id === id),
      workRecord: () => t.workRecords.some((rec) => rec.id === id),
    }[kind]();
    if (!found) return fail(404, "NOT_FOUND", `no ${kind} with that id on this farm`);
  }
  return null;
}

type Owned =
  | "product"
  | "warehouse"
  | "plot"
  | "plotCrop"
  | "customer"
  | "activity"
  | "workRecord";

/**
 * `stockMoveRequest` in `handlers_stock.go`: the store's write shape plus the
 * two fields the HTTP layer adds on top of it.
 *
 * Declared here rather than in `mocks/types.ts` only because that file belongs
 * to the other half of this pair and is being edited right now. It wants
 * folding back in.
 */
type StockMoveBody = StockMoveRequestBody & {
  /** RSP-025's stickers, asked for ON the movement. 0..500. */
  labels?: number;
  /**
   * The stock guard's escape hatch. NOTE THE SPELLING: it is `allowNegative`
   * here and `allowNegativeStock` on a sale. Two names for one idea is not a
   * tidiness problem to fix on this side — it is what the two request schemas
   * say, and a mock that accepted either would let a screen ship sending the
   * wrong one to a server that would silently ignore it and refuse the write.
   */
  allowNegative?: boolean;
};

/** `store.StockReasons`, in the enum's own order. */
const STOCK_REASONS: WireStockReason[] = [
  "cosecha",
  "compra",
  "venta",
  "consumo",
  "merma",
  "traslado",
  "ajuste",
];

/** `store.OutgoingReasons`: the ones `stock_sign` requires to be negative. */
const OUTGOING_REASONS = new Set<WireStockReason>(["venta", "consumo", "merma"]);
const INCOMING_REASONS = new Set<WireStockReason>(["cosecha", "compra"]);

/**
 * `resolveCatalog`: "either an id or a name" becomes an id, creating the row
 * when only a name arrived. Returns null when neither was sent, and the caller
 * decides what that means — a category is optional, a storage unit is not.
 */
function resolveCatalog(
  list: WireCatalogItem[],
  id: string | null | undefined,
  name: string | undefined,
): string | null {
  if (id) return id;
  if (!name || !name.trim()) return null;
  return ensureCatalogItem(list, name).id;
}

/**
 * `InsertStockMove` plus every CHECK, trigger and index that guards it, and
 * the one courtesy the handler adds on top.
 *
 * THE SIGN IS APPLIED, NOT DEMANDED. `handleCreateStockMove` flips the
 * quantity to match the reason before the row is built — a client that sends
 * 40 for a merma gets a merma of 40 out, not a 400 it has to guess its way out
 * of. `traslado` and `ajuste` keep whatever sign they were given, because
 * those two are the ones `stock_sign` leaves free and there is nothing to
 * infer. The database still checks the pair; this is the courtesy, not the
 * guarantee, which is why the CHECK is emulated below as well.
 *
 * (The first version of this mock REFUSED a mismatched sign with a 400. That
 * was a guess, and it was wrong in the direction that matters: a screen built
 * against it would have shipped a validation error the server never sends.)
 *
 * Returns the row it appended, or the Response it refused with.
 */
function insertStockMove(
  t: db.Tenant,
  body: StockMoveRequestBody,
  createdBy: string,
  opts: { fromSale?: string } = {},
): db.MockStockMove | Response {
  const reason = body.reason;
  if (!reason || !STOCK_REASONS.includes(reason)) {
    return badRequest(`reason must be one of ${STOCK_REASONS.join(", ")}`);
  }
  let qty = body.qty;
  if (typeof qty !== "number" || !Number.isFinite(qty) || qty === 0) {
    return badRequest("qty cannot be zero");
  }
  if (OUTGOING_REASONS.has(reason) && qty > 0) qty = -qty;
  if (INCOMING_REASONS.has(reason) && qty < 0) qty = -qty;

  // stock_sign, for the pair the handler could not infer.
  if ((INCOMING_REASONS.has(reason) && qty < 0) || (OUTGOING_REASONS.has(reason) && qty > 0)) {
    return badRequest(
      "the sign of the quantity does not match the reason: cosecha and compra come in, venta, consumo and merma go out",
    );
  }

  // stock_crop_needs_plot, then check_stock_move_crop(): a movement that said
  // "lote 3, café del lote 7" would make every per-plot report quietly wrong.
  if (body.plotCropId && !body.plotId) {
    return badRequest("plotCropId needs the plotId it is planted in");
  }
  if (body.plotId && body.plotCropId) {
    const plot = t.plots.find((p) => p.id === body.plotId);
    if (!plot?.crops.some((c) => c.id === body.plotCropId)) {
      return badRequest(`crop ${body.plotCropId} is not planted in plot ${body.plotId}`);
    }
  }

  // check_stock_reverso(): once, and never a reversal of a reversal.
  if (body.reversesId) {
    const origin = t.stockMoves.find((m) => m.id === body.reversesId);
    if (!origin) return badRequest("reversal without origin");
    if (origin.reversesId) {
      return conflict("ALREADY_REVERSED", "a reversal cannot be reversed");
    }
    if (t.stockMoves.some((m) => m.reversesId === origin.id)) {
      return conflict("ALREADY_REVERSED", "that movement has already been reversed");
    }
    if (origin.productId !== body.productId || origin.warehouseId !== body.warehouseId) {
      return badRequest("reversal crosses product or warehouse");
    }
    if (db.round3(qty) !== db.round3(-origin.qty)) {
      return badRequest("the reversal does not cancel its origin");
    }
  }

  const created: db.MockStockMove = {
    id: body.id ?? crypto.randomUUID(),
    productId: body.productId!,
    warehouseId: body.warehouseId!,
    plotId: body.plotId ?? null,
    plotCropId: body.plotCropId ?? null,
    qty: db.round3(qty),
    reason,
    note: body.note ?? null,
    workRecordId: body.workRecordId ?? null,
    saleId: opts.fromSale ?? null,
    reversesId: body.reversesId ?? null,
    // `set_stock_move_local_day()`: absent means the FARM's today, computed by
    // the database. Requests carry a plain `YYYY-MM-DD`; responses carry the
    // instant a Go `time.Time` marshals to.
    localDay: db.dayInstant(body.localDay || today()),
    createdBy,
    createdAt: nowInstant(),
  };
  t.stockMoves.push(created);
  return created;
}

/**
 * `guardStock`: refuse to take out more than is there, unless told to go
 * ahead. It runs on the DERIVED level and it is only ever a 409 the caller can
 * override — a warehouse whose opening balance was never recorded is ordinary,
 * and a server that made it impossible to record what actually left would be a
 * server nobody could use.
 *
 * `qty` is signed, so the details read `{onHand, requested}` with `requested`
 * positive.
 */
function guardStock(t: db.Tenant, productId: string, warehouseId: string, qty: number): Response | null {
  const onHand = db.stockOnHand(t, productId, warehouseId);
  if (onHand + qty < 0) {
    return conflict("INSUFFICIENT_STOCK", "there is not that much in the warehouse", {
      onHand,
      requested: -qty,
    });
  }
  return null;
}

/** `ReverseStockMove`: the only way back through an append-only table. */
function reverseStockMove(
  t: db.Tenant,
  id: string,
  note: string | null,
  createdBy: string,
): db.MockStockMove | Response {
  const origin = t.stockMoves.find((m) => m.id === id);
  if (!origin) return notFound();
  return insertStockMove(
    t,
    {
      productId: origin.productId,
      warehouseId: origin.warehouseId,
      plotId: origin.plotId,
      plotCropId: origin.plotCropId,
      qty: -origin.qty,
      // 'ajuste' is the one reason whose sign is free, which is what lets the
      // opposite of an outgoing movement be positive without lying about why
      // it exists. `reversesId` is what says what it really is.
      reason: "ajuste",
      note,
      reversesId: origin.id,
    },
    createdBy,
  );
}

/**
 * `validateExpenseTarget`, which is RSP-031's "Tipo de gasto" as a rule rather
 * than as a select:
 *
 *     (activity_id IS NOT NULL)::int
 *   + (COALESCE(plot_id, plot_crop_id) IS NOT NULL)::int = 1
 *
 * Not both, and NOT NEITHER. "Neither" is the case worth refusing loudly: an
 * expense charged to nothing appears in the total and in no breakdown, and the
 * gap between the two is what nobody can account for at the end of the year.
 *
 * TWO SENTENCES, ONE CODE. `TranslateExpenseError` answers
 * EXPENSE_TARGET_INVALID for both halves, and the handler's own check writes a
 * different message for each — so a form can put the right words on the screen
 * while a screen may only ever branch on the code. Splitting it into two codes
 * (which is what the first version of this mock did) would let a screen depend
 * on a distinction the server has never drawn.
 *
 * NOTE WHAT IS NOT COUNTED. The handler weighs `activityId` and `plotId` only;
 * `plotCropId` is NOT a target on its own. A body carrying just a crop is
 * therefore "neither", not "a plot expense" — which is the same thing
 * `expense_crop_needs_plot` says one layer down, arrived at from the other
 * side.
 */
function validateExpenseTarget(t: db.Tenant, body: ExpenseRequestBody): Response | null {
  const hasActivity = Boolean(body.activityId);
  const hasPlot = Boolean(body.plotId);
  if (hasActivity && hasPlot) {
    return fail(
      400,
      "EXPENSE_TARGET_INVALID",
      "an expense is charged to an activity or to a plot/crop, not to both",
    );
  }
  if (!hasActivity && !hasPlot) {
    return fail(
      400,
      "EXPENSE_TARGET_INVALID",
      "an expense is charged to an activity or to a plot/crop; it cannot be charged to neither",
    );
  }
  // check_expense_crop(): the same rule as the stock movement, for the same
  // reason — a crop belongs to the plot it was named with, or every per-plot
  // cost report is quietly wrong.
  if (body.plotId && body.plotCropId) {
    const plot = t.plots.find((p) => p.id === body.plotId);
    if (!plot?.crops.some((c) => c.id === body.plotCropId)) {
      return badRequest(`crop ${body.plotCropId} is not planted in plot ${body.plotId}`);
    }
  }
  return null;
}

/** `amount_minor bigint NOT NULL CHECK (amount_minor > 0)`, said in TypeScript. */
function validAmount(cents: unknown): Response | null {
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents <= 0) {
    return badRequest("amountCents must be a positive whole number of cents");
  }
  return null;
}

/**
 * `CreatePlotCrop` resolves the crop type and the variety through their
 * catalogues first, creating the entry when the caller sent a name that is not
 * there yet. That is what "with an option to add it if it is not there" means.
 */
function buildCrop(t: db.Tenant, plotId: string, c: PlotCropRequestBody): WirePlotCrop {
  const cropType = c.cropTypeId
    ? t.cropTypes.find((x) => x.id === c.cropTypeId)
    : ensureCatalogItem(t.cropTypes, c.cropType!);
  const variety = c.varietyId
    ? t.varieties.find((x) => x.id === c.varietyId)
    : c.variety
      ? ensureCatalogItem(t.varieties, c.variety)
      : undefined;
  return {
    id: c.id ?? crypto.randomUUID(),
    plotId,
    cropTypeId: cropType?.id ?? "",
    cropType: cropType?.name ?? "",
    varietyId: variety?.id ?? null,
    variety: variety?.name ?? null,
    areaHa: c.areaHa ?? null,
    plantedOn: c.plantedOn ? db.dayInstant(c.plantedOn) : null,
    removedOn: c.removedOn ? db.dayInstant(c.removedOn) : null,
    deletedAt: null,
  };
}

/** `rateRequest.toStore`: an absent validFrom means today. */
function toRate(body: RateRequestBody, payScheme: string): WireActivityRate {
  // `timeUnit` on the request is still a loose string — the mock RECEIVES it
  // and the server's decoder is what rejects a value outside the enum. Narrowed
  // here rather than at the field, so an unknown one becomes the server's own
  // refusal below instead of a type error nobody can act on.
  const timeUnit = (body.timeUnit ?? null) as WireActivityRate["timeUnit"];
  return {
    validFrom: db.dayInstant(body.validFrom ?? today()),
    rateCents: body.rateCents ?? 0,
    // A time-based rate is per jornal unless it says otherwise.
    timeUnit: payScheme === "tiempo" ? (timeUnit ?? "jornal") : timeUnit,
    customQty: body.customQty ?? null,
    customUnit: body.customUnit ?? null,
  };
}

/**
 * `parseMonday`. The week is named by its Monday's ISO date and the path
 * segment must BE a Monday — the phone's old "2026-W33" is obsolete, because
 * `WEEK_OF` already produces the Monday.
 */
function checkMonday(raw: string): Response | null {
  if (!DAY.test(raw)) return badRequest("the week is named by its Monday, YYYY-MM-DD");
  if (mondayOf(raw) !== raw) return badRequest("that date is not a Monday");
  return null;
}

/* ------------------------------------------------------------------ */
/* Reports: the mock's half of `internal/store/reports.go`             */
/* ------------------------------------------------------------------ */

/**
 * The harvest, as the server defines it: work paid by the unit of work at the
 * week's price. `store.HarvestActivityID` is the same predicate, and it is a
 * pair rather than a category because categories are a per-farm catalogue a
 * farm may rename.
 */
function harvestOf(t: db.Tenant): db.MockWorkRecord[] {
  return t.workRecords.filter(
    (r) =>
      r.deletedAt === null && r.payScheme === "unidad_trabajo" && r.rateSource === "weekly_price",
  );
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/**
 * `ReportTotals`, with the two admissions the contract will not let a row
 * leave out.
 *
 * `kg` is null when NOT ONE weighing could be expressed in kilos — a farm may
 * invent a work unit ("canasta") with no `kgFactor`, and multiplying by a
 * factor that is not there is how a report invents harvest. Those are counted
 * in `recordsNotInKg` instead. `valueCents` is null on the same principle.
 *
 * Neither is ever 0 as a stand-in. That is the whole point of the shape.
 */
function totalsOf(t: db.Tenant, rows: db.MockWorkRecord[]) {
  let kg: number | null = null;
  let valueCents: number | null = null;
  let recordsNotInKg = 0;
  let recordsWithoutValue = 0;
  let valueIsEstimate = false;

  for (const r of rows) {
    const unit = t.workUnits.find((u) => u.id === r.unitId);
    if (unit?.kgFactor != null) kg = (kg ?? 0) + r.quantity * unit.kgFactor;
    else recordsNotInKg += 1;

    const projected = db.projectWorkRecord(t, r);
    const amount = projected.estimatedAmountCents ?? projected.amountCents;
    if (amount != null) {
      valueCents = (valueCents ?? 0) + amount;
      if (projected.amountIsEstimate) valueIsEstimate = true;
    } else {
      recordsWithoutValue += 1;
    }
  }

  return { records: rows.length, kg, recordsNotInKg, valueCents, recordsWithoutValue, valueIsEstimate };
}

/**
 * One grid: worker x day, or worker x crop.
 *
 * The crop grid can carry a column keyed `null` — work that names no crop, or
 * names several. Splitting it would be a guess and attributing it twice would
 * make the columns exceed the grid, so it gets a column of its own and
 * `unattributed` says which of the two it was. Rows, columns and the grand
 * total are folded from the SAME cells, so they agree by construction.
 */
function gridOf(t: db.Tenant, rows: db.MockWorkRecord[], axis: "day" | "crop") {
  const colKey = (r: db.MockWorkRecord): string | null => {
    if (axis === "day") return db.dayOf(r.dateFrom);
    const ids = r.plotCropIds ?? [];
    return ids.length === 1 ? ids[0] : null;
  };

  const label = (key: string | null): string => {
    if (key === null) return "Sin asignar";
    if (axis === "day") return key;
    for (const p of t.plots) {
      const c = (p.crops ?? []).find((x) => x.id === key);
      if (c) return `${cropLabel(c)} — ${p.name}`;
    }
    return "—";
  };

  const cellRows = [...groupBy(rows, (r) => r.workerId).entries()].map(([workerId, list]) => {
    const worker = t.workers.find((w) => w.id === workerId);
    return {
      workerId,
      name: worker ? [worker.name, worker.lastName].filter(Boolean).join(" ") : "—",
      cells: [...groupBy(list, colKey).entries()].map(([column, cl]) => ({
        column,
        ...totalsOf(t, cl),
      })),
      total: totalsOf(t, list),
    };
  });

  const columns = [...groupBy(rows, colKey).entries()]
    .map(([key, list]) => ({ key, label: label(key), total: totalsOf(t, list) }))
    .sort((a, b) => {
      // The unattributed column always sits last; it is a remainder, not a lot.
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      return axis === "day"
        ? a.key.localeCompare(b.key)
        : (b.total.kg ?? 0) - (a.total.kg ?? 0);
    });

  const unattributedRows = rows.filter((r) => colKey(r) === null);
  const grid: Record<string, unknown> = {
    columns,
    rows: cellRows.sort((a, b) => (b.total.kg ?? 0) - (a.total.kg ?? 0)),
    total: totalsOf(t, rows),
  };
  if (axis === "crop" && unattributedRows.length > 0) {
    grid.unattributed = {
      noCropLink: unattributedRows.filter((r) => (r.plotCropIds ?? []).length === 0).length,
      sharedAcrossCrops: unattributedRows.filter((r) => (r.plotCropIds ?? []).length > 1).length,
    };
  }
  return grid;
}

/** At least this many people on a crop on a day before anyone is compared. */
const MIN_CREW_ON_CROP_DAY = 3;
/** And at least this many such days before anybody gets an index at all. */
const MIN_COMPARABLE_DAYS = 3;

/**
 * The comparative index, as `INDEX_SQL` computes it.
 *
 * Three things that were all wrong in the phone's first version and must stay
 * right here: the person is EXCLUDED from their own benchmark, it averages
 * DAILY RATIOS rather than dividing sums, and a crop-day with fewer than three
 * people is dropped rather than compared anyway.
 *
 * `index` is null — never a low number — for anybody without enough basis, and
 * `reason` says which. A zero there would be an accusation the data cannot
 * support.
 */
function performanceOf(t: db.Tenant, rows: db.MockWorkRecord[]) {
  const kgOf = (r: db.MockWorkRecord): number | null => {
    const unit = t.workUnits.find((u) => u.id === r.unitId);
    return unit?.kgFactor != null ? r.quantity * unit.kgFactor : null;
  };

  // (worker, crop, day) -> kilos
  const cells = new Map<string, { workerId: string; crop: string; day: string; kg: number }>();
  for (const r of rows) {
    const kg = kgOf(r);
    if (kg === null) continue;
    const crop = (r.plotCropIds ?? [])[0] ?? "—";
    const day = db.dayOf(r.dateFrom);
    const key = `${r.workerId}|${crop}|${day}`;
    const cur = cells.get(key);
    if (cur) cur.kg += kg;
    else cells.set(key, { workerId: r.workerId, crop, day, kg });
  }

  const base = new Map<string, { tot: number; n: number }>();
  for (const c of cells.values()) {
    const k = `${c.crop}|${c.day}`;
    const b = base.get(k) ?? { tot: 0, n: 0 };
    b.tot += c.kg;
    b.n += 1;
    base.set(k, b);
  }

  const ratios = new Map<string, { day: string; ratio: number }[]>();
  for (const c of cells.values()) {
    const b = base.get(`${c.crop}|${c.day}`)!;
    if (b.n < MIN_CREW_ON_CROP_DAY) continue;
    const matesMean = (b.tot - c.kg) / (b.n - 1);
    if (!(matesMean > 0)) continue;
    const list = ratios.get(c.workerId) ?? [];
    list.push({ day: c.day, ratio: c.kg / matesMean });
    ratios.set(c.workerId, list);
  }

  const items = [...groupBy(rows, (r) => r.workerId).entries()].map(([workerId, list]) => {
    const worker = t.workers.find((w) => w.id === workerId);
    const totals = totalsOf(t, list);
    const days = new Set(list.map((r) => db.dayOf(r.dateFrom))).size;
    const mine = ratios.get(workerId) ?? [];
    const comparableDays = new Set(mine.map((r) => r.day)).size;
    const enough = comparableDays >= MIN_COMPARABLE_DAYS;
    const index = enough ? mine.reduce((s, r) => s + r.ratio, 0) / mine.length : null;

    return {
      workerId,
      name: worker ? [worker.name, worker.lastName].filter(Boolean).join(" ") : "—",
      ...totals,
      days,
      kgPerDay: totals.kg !== null && days > 0 ? totals.kg / days : null,
      index,
      comparableDays,
      ...(index === null
        ? {
            reason:
              totals.kg === null
                ? ("no_records_in_kilos" as const)
                : ("not_enough_comparable_days" as const),
          }
        : {}),
      trend: null,
    };
  });

  // Best index first, everybody without one after them — never interleaved.
  return items.sort((a, b) => {
    if (a.index === null && b.index === null) return (b.kg ?? 0) - (a.kg ?? 0);
    if (a.index === null) return 1;
    if (b.index === null) return -1;
    return b.index - a.index;
  });
}

/**
 * The five review rules, in the order of how sure we are. A weighing that
 * breaks more than one is reported once, under the first that matched.
 *
 * `reference` is what the quantity was judged against and is NULL for
 * `future`, where there is nothing to compare against — a 0 there would read
 * as "compared against nothing".
 */
function anomaliesOf(t: db.Tenant, rows: db.MockWorkRecord[], maxKg: number) {
  const kgOf = (r: db.MockWorkRecord): number | null => {
    const unit = t.workUnits.find((u) => u.id === r.unitId);
    return unit?.kgFactor != null ? r.quantity * unit.kgFactor : null;
  };
  const cropOf = (r: db.MockWorkRecord): string | null => {
    const id = (r.plotCropIds ?? [])[0];
    if (!id) return null;
    for (const p of t.plots) {
      const c = (p.crops ?? []).find((x) => x.id === id);
      if (c) return `${cropLabel(c)} — ${p.name}`;
    }
    return null;
  };

  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  const push = (r: db.MockWorkRecord, rule: string, reference: number | null) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    const worker = t.workers.find((w) => w.id === r.workerId);
    out.push({
      recordId: r.id,
      workerId: r.workerId,
      worker: worker ? [worker.name, worker.lastName].filter(Boolean).join(" ") : "—",
      crop: cropOf(r),
      quantity: r.quantity,
      kg: kgOf(r),
      date: db.dayOf(r.dateFrom),
      rule,
      reference,
    });
  };

  for (const r of rows) {
    const kg = kgOf(r);
    if (r.quantity <= 0) push(r, "impossible", maxKg);
    else if (kg !== null && kg > maxKg) push(r, "impossible", maxKg);
  }

  for (const list of groupBy(
    rows,
    (r) => `${r.workerId}|${(r.plotCropIds ?? [])[0] ?? "—"}|${r.quantity}`,
  ).values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (let i = 1; i < sorted.length; i++) {
      const gap = Date.parse(sorted[i].createdAt) - Date.parse(sorted[i - 1].createdAt);
      if (Number.isFinite(gap) && gap >= 0 && gap <= 3 * 60_000) {
        push(sorted[i], "duplicate", sorted[i].quantity);
      }
    }
  }

  // The reference EXCLUDES the suspect row: including it makes the rule
  // algebraically unable to fire, which the phone shipped with for versions.
  for (const [, list] of groupBy(rows, (r) => r.workerId)) {
    const kgs = list.map(kgOf).filter((k): k is number => k !== null);
    if (kgs.length < 2) continue;
    const sum = kgs.reduce((a, b) => a + b, 0);
    for (const r of list) {
      const kg = kgOf(r);
      if (kg === null) continue;
      const reference = (sum - kg) / (kgs.length - 1);
      if (reference > 0 && kg >= 4 * reference) push(r, "digit", reference);
    }
  }

  for (const [, list] of groupBy(
    rows,
    (r) => `${(r.plotCropIds ?? [])[0] ?? "—"}|${db.dayOf(r.dateFrom)}`,
  )) {
    if (list.length < 5) continue;
    const kgs = list.map(kgOf).filter((k): k is number => k !== null);
    if (kgs.length < 5) continue;
    const sum = kgs.reduce((a, b) => a + b, 0);
    for (const r of list) {
      const kg = kgOf(r);
      if (kg === null) continue;
      const reference = (sum - kg) / (kgs.length - 1);
      if (reference > 0 && kg >= 4 * reference) push(r, "outlier", reference);
    }
  }

  for (const r of rows) if (db.dayOf(r.dateFrom) > today()) push(r, "future", null);

  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
