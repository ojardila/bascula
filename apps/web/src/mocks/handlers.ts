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
import { mondayOf } from "../lib/dates";
import type {
  ActivityRequestBody,
  CatalogItemRequestBody,
  LoginRequestBody,
  PlotCropRequestBody,
  PlotRequestBody,
  RateRequestBody,
  RefreshRequestBody,
  ReverseRequestBody,
  SignupRequestBody,
  VerifyEmailRequestBody,
  WeekPriceRequestBody,
  WireActivity,
  WireActivityRate,
  WireCatalogItem,
  WireEmployee,
  WireLedgerEntry,
  WireLedgerKind,
  WireLedgerRequest,
  WireNote,
  WirePayMethod,
  WirePlot,
  WirePlotCrop,
  WireRole,
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
  | "ledger.reverse";

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
};

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
  ...(
    [
      ["activity-categories", (t: db.Tenant) => t.activityCategories],
      ["crop-types", (t: db.Tenant) => t.cropTypes],
      ["varieties", (t: db.Tenant) => t.varieties],
    ] as const
  ).flatMap(([slug, pick]) => [
    http.get(`*/v1/catalogs/${slug}`, ({ request }) => {
      const g = guard(request, "catalogs.read");
      if (g.deny) return g.deny;
      const items = [...pick(g.p.tenant)].sort((a, b) => a.name.localeCompare(b.name, "es"));
      return HttpResponse.json({ items });
    }),
    http.post(`*/v1/catalogs/${slug}`, async ({ request }) => {
      const g = guard(request, "catalogs.write");
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
    if (body.boundary != null) plot.boundary = body.boundary;
    return HttpResponse.json(plot);
  }),

  /**
   * GeoJSON in and GeoJSON out — no PostGIS type ever crosses the wire, which
   * is what keeps swapping the engine possible. The overlap list is a WARNING
   * and never a refusal: two plots that touch on the map are usually a drawing
   * that wants a second look and sometimes a terrace above a coffee lot, and
   * the server does not get to decide which.
   *
   * What is NOT emulated: `computedAreaHa` and the overlap set are PostGIS
   * measurements. The mock stores the geometry, leaves the measured area
   * exactly as it was, and reports no overlaps.
   */
  http.put("*/v1/plots/:id/boundary", async ({ request, params }) => {
    const g = guard(request, "plots.boundary.write");
    if (g.deny) return g.deny;
    const plot = g.p.tenant.plots.find((p) => p.id === params.id);
    if (!plot) return notFound();
    const body = (await request.json()) as { boundary?: unknown; geojson?: unknown };
    const geo = body.boundary ?? body.geojson;
    if (geo == null) return badRequest("boundary is required, as a GeoJSON geometry");
    plot.boundary = geo;
    return HttpResponse.json({ plot, overlaps: [] });
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
    const wanted = listStatus(params);
    const q = params.get("q");

    const rows = t.workRecords
      .filter((r) => wanted(r.deletedAt))
      .filter((r) => !workerId || r.workerId === workerId)
      .filter((r) => !activityId || r.activityId === activityId)
      .filter((r) => !plotId || r.plotIds.includes(plotId))
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
  return {
    validFrom: db.dayInstant(body.validFrom ?? today()),
    rateCents: body.rateCents ?? 0,
    // A time-based rate is per jornal unless it says otherwise.
    timeUnit: payScheme === "tiempo" ? (body.timeUnit ?? "jornal") : (body.timeUnit ?? null),
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
