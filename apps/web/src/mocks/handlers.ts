/**
 * The API, faked well enough to build against.
 *
 * Two rules kept this from becoming a lie the screens learn from:
 *
 * 1. **It enforces the role matrix.** A weigher asking for a worker profile
 *    gets a real 403 with `code: "PERMISSION_DENIED"`, and the list of
 *    workers comes back as the narrow projection — no document, no phone, no
 *    photo — exactly as `arquitectura-api.md` §6 specifies. If the mock were
 *    permissive, the 403 handling in the UI would be untested code that first
 *    runs in front of the owner.
 *
 * 2. **Derived figures are derived here too.** Balances are summed from the
 *    ledger on every request. A mock that returns a stored total teaches the
 *    UI to trust one.
 *
 * Writes mutate the module-level arrays, so a session survives navigation and
 * resets on reload. That is the right trade for a demo: seeded every time,
 * never a stale database nobody can explain.
 */
import { http, HttpResponse, delay } from "msw";
import * as db from "./db";
import { mondayOf } from "../lib/dates";
import type {
  Activity,
  ActivityInput,
  DeductionInput,
  LedgerEntry,
  MockRequestBody,
  PaymentInput,
  Plot,
  PlotInput,
  Worker,
  WorkerInput,
  WorkRecord,
  WorkRecordInput,
} from "./types";

/* -- plumbing -------------------------------------------------------- */

const TOKEN_PREFIX = "mock-access.";

function userFromRequest(request: Request): db.MockUser | null {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const userId = token.slice(TOKEN_PREFIX.length).split(".")[0];
  return db.users.find((u) => u.id === userId) ?? null;
}

function fail(status: number, code: string, message: string, details?: unknown) {
  return HttpResponse.json({ error: { code, message, details } }, { status });
}

const unauthenticated = () =>
  fail(401, "TOKEN_EXPIRED", "El token de acceso venció o no es válido.");
const forbidden = () =>
  fail(403, "PERMISSION_DENIED", "El rol no tiene permiso para esta operación.");

/** Guard: resolves the caller, or returns the response to send instead. */
function auth(request: Request) {
  const user = userFromRequest(request);
  if (!user) return { user: null, deny: unauthenticated() };
  return { user, deny: null };
}

const isWeigher = (u: db.MockUser) => u.role === "weigher";
const isOwner = (u: db.MockUser) => u.role === "owner";

/** The weigher's projection of a worker: enough to pick a name, nothing else. */
function narrowWorker(w: Worker) {
  return { id: w.id, name: w.name, lastName: w.lastName, status: w.status };
}

/** The weigher's projection of an activity: no price, ever. */
function narrowActivity(a: Activity) {
  const { defaultRateCents: _r, rates: _rs, ...rest } = a;
  return rest;
}

function matches(haystack: string, needle: string | null) {
  if (!needle) return true;
  return haystack.toLocaleLowerCase("es").includes(needle.toLocaleLowerCase("es"));
}

/* -- handlers -------------------------------------------------------- */

export const handlers = [
  /* ---- signup and auth ---- */

  http.post("*/v1/signup", async ({ request }) => {
    await delay(400);
    const body = (await request.json()) as MockRequestBody["signup"];
    const email = body.owner?.email?.trim().toLowerCase();
    if (!email || !body.owner?.password || !body.farm?.name) {
      return fail(400, "VALIDATION_FAILED", "Faltan datos obligatorios.", {
        fields: {
          ...(body.farm?.name ? {} : { "farm.name": "Escriba el nombre de la finca." }),
          ...(email ? {} : { "owner.email": "Escriba un correo." }),
          ...(body.owner?.password ? {} : { "owner.password": "Escriba una contraseña." }),
        },
      });
    }
    if (db.users.some((u) => u.email === email)) {
      return fail(409, "EMAIL_ALREADY_REGISTERED", "Ese correo ya tiene una cuenta.");
    }
    // Born unverified: the farm is not usable until the mail is confirmed.
    db.users.push({
      id: crypto.randomUUID(),
      email,
      password: body.owner.password,
      name: body.owner.name,
      role: "owner",
      isSuperAdmin: false,
      emailVerified: false,
    });
    return HttpResponse.json(
      { farmId: db.FARM_ID, verificationEmailSentTo: email },
      { status: 201 },
    );
  }),

  http.post("*/v1/signup/verify", async () => {
    await delay(200);
    for (const u of db.users) u.emailVerified = true;
    return HttpResponse.json({ ok: true });
  }),

  http.post("*/v1/auth/login", async ({ request }) => {
    await delay(350);
    const body = (await request.json()) as MockRequestBody["login"];
    const user = db.users.find(
      (u) => u.email === body.email?.trim().toLowerCase() && u.password === body.password,
    );
    // One generic message for both wrong email and wrong password: telling
    // them apart is a free account-enumeration oracle.
    if (!user) return fail(401, "UNAUTHENTICATED", "Correo o contraseña incorrectos.");
    if (!user.emailVerified) {
      return fail(403, "EMAIL_NOT_VERIFIED", "Falta confirmar el correo.");
    }
    return HttpResponse.json({
      accessToken: `${TOKEN_PREFIX}${user.id}.${Date.now()}`,
      refreshToken: `mock-refresh.${user.id}`,
      expiresIn: 900,
      user: db.meFor(user),
    });
  }),

  http.post("*/v1/auth/refresh", async ({ request }) => {
    const body = (await request.json()) as { refreshToken?: string };
    const userId = body.refreshToken?.split(".")[1];
    const user = db.users.find((u) => u.id === userId);
    if (!user) return fail(401, "TOKEN_EXPIRED", "El refresh token no es válido.");
    return HttpResponse.json({
      accessToken: `${TOKEN_PREFIX}${user.id}.${Date.now()}`,
      refreshToken: `mock-refresh.${user.id}`,
    });
  }),

  http.post("*/v1/auth/logout", () => new HttpResponse(null, { status: 204 })),

  http.get("*/v1/me", ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    return HttpResponse.json(db.meFor(user));
  }),

  http.get("*/v1/farm", ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    return HttpResponse.json(db.farm);
  }),

  /* ---- catalogs ---- */

  http.get("*/v1/catalogs/crop-types", ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    return HttpResponse.json(db.cropTypes);
  }),

  http.get("*/v1/catalogs/varieties", ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    const cropTypeId = new URL(request.url).searchParams.get("cropTypeId");
    return HttpResponse.json(
      cropTypeId ? db.varieties.filter((v) => v.cropTypeId === cropTypeId) : db.varieties,
    );
  }),

  // Idempotent by lower(name): the autocomplete never duplicates.
  http.post("*/v1/catalogs/crop-types", async ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    const { name } = (await request.json()) as { name: string };
    const existing = db.cropTypes.find(
      (c) => c.name.toLocaleLowerCase("es") === name.trim().toLocaleLowerCase("es"),
    );
    if (existing) return HttpResponse.json(existing, { status: 200 });
    const created = { id: crypto.randomUUID(), name: name.trim() };
    db.cropTypes.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  http.post("*/v1/catalogs/varieties", async ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    const { name, cropTypeId } = (await request.json()) as {
      name: string;
      cropTypeId: string;
    };
    const existing = db.varieties.find(
      (v) =>
        v.cropTypeId === cropTypeId &&
        v.name.toLocaleLowerCase("es") === name.trim().toLocaleLowerCase("es"),
    );
    if (existing) return HttpResponse.json(existing, { status: 200 });
    const created = { id: crypto.randomUUID(), name: name.trim(), cropTypeId };
    db.varieties.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  /* ---- plots ---- */

  http.get("*/v1/plots", ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    const params = new URL(request.url).searchParams;
    const status = params.get("status");
    const q = params.get("q");
    return HttpResponse.json(
      db.plots.filter(
        (p) =>
          (!status || status === "all" || p.status === status) &&
          (matches(p.name, q) || matches(p.municipality, q) || matches(p.department, q)),
      ),
    );
  }),

  http.get("*/v1/plots/:id", ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    const plot = db.plots.find((p) => p.id === params.id);
    return plot
      ? HttpResponse.json(plot)
      : fail(404, "NOT_FOUND", "La parcela no existe.");
  }),

  http.post("*/v1/plots", async ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    await delay(300);
    const body = (await request.json()) as PlotInput;

    // Idempotent by id: a retry after a timeout returns the existing row.
    const already = db.plots.find((p) => p.id === body.id);
    if (already) return HttpResponse.json(already, { status: 200 });

    const created: Plot = {
      id: body.id,
      name: body.name,
      department: body.department,
      municipality: body.municipality,
      areaHa: body.areaHa,
      computedAreaHa: null,
      boundary: null,
      status: "active",
      crops: body.crops.map((c) => ({
        id: c.id,
        cropTypeId: c.cropTypeId,
        cropTypeName: db.cropTypes.find((t) => t.id === c.cropTypeId)?.name ?? "—",
        varietyId: c.varietyId,
        varietyName: db.varieties.find((v) => v.id === c.varietyId)?.name ?? null,
        areaHa: c.areaHa,
        plantedAt: c.plantedAt,
      })),
    };
    db.plots.unshift(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  http.patch("*/v1/plots/:id", async ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    const plot = db.plots.find((p) => p.id === params.id);
    if (!plot) return fail(404, "NOT_FOUND", "La parcela no existe.");
    const body = (await request.json()) as Partial<PlotInput> & { status?: string };

    if (body.status === "inactive" && !isOwner(user)) return forbidden();

    if (body.name !== undefined) plot.name = body.name;
    if (body.department !== undefined) plot.department = body.department;
    if (body.municipality !== undefined) plot.municipality = body.municipality;
    if (body.areaHa !== undefined) plot.areaHa = body.areaHa;
    if (body.status === "inactive" || body.status === "active") plot.status = body.status;
    if (body.crops) {
      plot.crops = body.crops.map((c) => ({
        id: c.id,
        cropTypeId: c.cropTypeId,
        cropTypeName: db.cropTypes.find((t) => t.id === c.cropTypeId)?.name ?? "—",
        varietyId: c.varietyId,
        varietyName: db.varieties.find((v) => v.id === c.varietyId)?.name ?? null,
        areaHa: c.areaHa,
        plantedAt: c.plantedAt,
      }));
    }
    return HttpResponse.json(plot);
  }),

  /* ---- workers ---- */

  http.get("*/v1/workers", ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    const params = new URL(request.url).searchParams;
    const status = params.get("status");
    const q = params.get("q");
    const rows = db.workers.filter(
      (w) =>
        (!status || status === "all" || w.status === status) &&
        (matches(`${w.name} ${w.lastName}`, q) || matches(w.documentNumber, q)),
    );
    if (isWeigher(user)) return HttpResponse.json(rows.map(narrowWorker));
    return HttpResponse.json(
      rows.map((w) => ({ ...w, balanceCents: db.balanceOf(w.id).balanceCents })),
    );
  }),

  http.get("*/v1/workers/:id/profile", ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    const worker = db.workers.find((w) => w.id === params.id);
    if (!worker) return fail(404, "NOT_FOUND", "El empleado no existe.");
    const id = worker.id;
    return HttpResponse.json({
      worker,
      balance: db.balanceOf(id),
      workRecords: db.workRecords.filter((w) => w.workerId === id && w.status === "active"),
      pendingCents: db.pendingCents(id),
      ledger: db.ledger.filter((l) => l.workerId === id).slice().reverse(),
      notes: db.notes[id] ?? [],
    });
  }),

  http.get("*/v1/workers/:id/balance", ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    return HttpResponse.json(db.balanceOf(String(params.id)));
  }),

  http.get("*/v1/workers/:id/payables", ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    const id = String(params.id);
    const pending = db.pendingFor(id);
    const debts = db.ledger
      .filter((l) => l.workerId === id && (l.kind === "deduccion" || l.kind === "anticipo"))
      .map((l) => ({ id: l.id, concept: l.concept, date: l.date, amountCents: -l.amountCents }));
    return HttpResponse.json({
      workRecords: pending.map((w) => ({
        id: w.id,
        activityName: w.activityName,
        dateFrom: w.dateFrom,
        dateTo: w.dateTo,
        plotNames: w.plotNames,
        quantity: w.quantity,
        unitLabel: w.unitLabel,
        amountCents: w.estimatedAmountCents,
      })),
      debts,
      totalCents: db.balanceOf(id).balanceCents + db.pendingCents(id),
    });
  }),

  http.get("*/v1/workers/:id", ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    const worker = db.workers.find((w) => w.id === params.id);
    if (!worker) return fail(404, "NOT_FOUND", "El empleado no existe.");
    return HttpResponse.json(isWeigher(user) ? narrowWorker(worker) : worker);
  }),

  http.post("*/v1/workers", async ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    await delay(300);
    const body = (await request.json()) as WorkerInput;

    const already = db.workers.find((w) => w.id === body.id);
    if (already) return HttpResponse.json(already, { status: 200 });

    // Identification is unique per farm: the same cedula twice is one person
    // with two ledgers, which is how somebody gets paid twice.
    if (
      db.workers.some(
        (w) =>
          w.documentType === body.documentType &&
          w.documentNumber === body.documentNumber &&
          w.status === "active",
      )
    ) {
      return fail(409, "DUPLICATE_DOCUMENT", "Ya existe un empleado con esa identificación.", {
        fields: { documentNumber: "Ya hay un empleado activo con esta identificación." },
      });
    }

    const created: Worker = {
      id: body.id,
      name: body.name,
      lastName: body.lastName,
      documentType: body.documentType,
      documentNumber: body.documentNumber,
      phone: body.phone ?? null,
      address: body.address ?? null,
      city: body.city ?? null,
      country: body.country ?? "Colombia",
      photoUrl: body.photoDataUrl ?? null,
      startedAt: body.startedAt ?? null,
      status: "active",
    };
    db.workers.unshift(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  http.patch("*/v1/workers/:id", async ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    const worker = db.workers.find((w) => w.id === params.id);
    if (!worker) return fail(404, "NOT_FOUND", "El empleado no existe.");
    const body = (await request.json()) as Partial<WorkerInput> & { status?: string };
    if (body.status === "inactive" && !isOwner(user)) return forbidden();
    Object.assign(worker, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
      ...(body.documentType !== undefined ? { documentType: body.documentType } : {}),
      ...(body.documentNumber !== undefined ? { documentNumber: body.documentNumber } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
      ...(body.city !== undefined ? { city: body.city } : {}),
      ...(body.photoDataUrl !== undefined ? { photoUrl: body.photoDataUrl } : {}),
      ...(body.status === "active" || body.status === "inactive" ? { status: body.status } : {}),
    });
    return HttpResponse.json(worker);
  }),

  http.post("*/v1/workers/:id/notes", async ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    const { text } = (await request.json()) as { text: string };
    const id = String(params.id);
    const note = {
      id: crypto.randomUUID(),
      text,
      date: new Date().toISOString().slice(0, 10),
      authorName: user.name,
    };
    db.notes[id] = [note, ...(db.notes[id] ?? [])];
    return HttpResponse.json(note, { status: 201 });
  }),

  /* ---- activities ---- */

  http.get("*/v1/activities", ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    const params = new URL(request.url).searchParams;
    const category = params.get("category");
    const status = params.get("status");
    const q = params.get("q");
    let rows = db.activities.filter(
      (a) =>
        (!category || category === "all" || a.category === category) &&
        (!status || status === "all" || a.status === status) &&
        matches(a.name, q),
    );
    // The weigher only ever registers work paid by unit of work.
    if (isWeigher(user)) {
      rows = rows.filter((a) => a.payMode === "work_unit" && a.status === "active");
      return HttpResponse.json(rows.map(narrowActivity));
    }
    return HttpResponse.json(rows);
  }),

  http.post("*/v1/activities", async ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    const body = (await request.json()) as ActivityInput;
    const already = db.activities.find((a) => a.id === body.id);
    if (already) return HttpResponse.json(already, { status: 200 });
    const created: Activity = {
      id: body.id,
      name: body.name,
      category: body.category,
      payMode: body.payMode,
      workUnit: body.workUnit ?? null,
      timeUnit: body.timeUnit ?? null,
      customQty: null,
      customPeriod: null,
      rateSource: body.rateSource,
      defaultRateCents: body.defaultRateCents ?? undefined,
      rates: body.defaultRateCents
        ? [{ validFrom: body.validFrom ?? "2026-01-01", rateCents: body.defaultRateCents }]
        : [],
      status: "active",
    };
    db.activities.unshift(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  http.patch("*/v1/activities/:id", async ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    const activity = db.activities.find((a) => a.id === params.id);
    if (!activity) return fail(404, "NOT_FOUND", "La actividad no existe.");
    const body = (await request.json()) as Partial<ActivityInput> & { status?: string };
    // Prices are the owner's alone (sync-and-roles.md).
    if (body.defaultRateCents !== undefined && !isOwner(user)) return forbidden();
    if (body.status === "inactive" && !isOwner(user)) return forbidden();
    Object.assign(activity, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.payMode !== undefined ? { payMode: body.payMode } : {}),
      ...(body.workUnit !== undefined ? { workUnit: body.workUnit } : {}),
      ...(body.timeUnit !== undefined ? { timeUnit: body.timeUnit } : {}),
      ...(body.rateSource !== undefined ? { rateSource: body.rateSource } : {}),
      ...(body.defaultRateCents !== undefined
        ? { defaultRateCents: body.defaultRateCents ?? undefined }
        : {}),
      ...(body.status === "active" || body.status === "inactive" ? { status: body.status } : {}),
    });
    return HttpResponse.json(activity);
  }),

  http.put("*/v1/activities/:id/rate", async ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (!isOwner(user)) return forbidden();
    const activity = db.activities.find((a) => a.id === params.id);
    if (!activity) return fail(404, "NOT_FOUND", "La actividad no existe.");
    const { rateCents, validFrom } = (await request.json()) as {
      rateCents: number;
      validFrom: string;
    };
    // A new dated rate, not an overwrite: prices have history (decision 4).
    activity.rates = [...(activity.rates ?? []), { validFrom, rateCents }].sort((a, b) =>
      a.validFrom.localeCompare(b.validFrom),
    );
    activity.defaultRateCents = rateCents;
    return HttpResponse.json(activity);
  }),

  /* ---- work records ---- */

  http.get("*/v1/work-records", ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    const params = new URL(request.url).searchParams;
    const workerId = params.get("workerId");
    const plotId = params.get("plotId");
    const status = params.get("status");
    const q = params.get("q");
    const rows = db.workRecords.filter(
      (w) =>
        (!workerId || w.workerId === workerId) &&
        (!plotId || w.plotIds.includes(plotId)) &&
        (!status || status === "all" || w.status === status) &&
        (matches(w.activityName, q) ||
          matches(w.workerName, q) ||
          matches(w.plotNames.join(" "), q)),
    );
    return HttpResponse.json(rows);
  }),

  http.post("*/v1/work-records", async ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    await delay(300);
    const body = (await request.json()) as WorkRecordInput;

    const already = db.workRecords.find((w) => w.id === body.id);
    if (already) return HttpResponse.json(already, { status: 200 });

    const activity = db.activities.find((a) => a.id === body.activityId);
    if (!activity) return fail(400, "VALIDATION_FAILED", "La actividad no existe.");
    if (isWeigher(user) && activity.payMode !== "work_unit") return forbidden();

    const worker = db.workers.find((w) => w.id === body.workerId);
    if (!worker) return fail(400, "VALIDATION_FAILED", "El empleado no existe.");

    if (activity.rateSource === "weekly_price" && body.dateFrom !== body.dateTo) {
      return fail(
        400,
        "WEEKLY_PRICE_NEEDS_SINGLE_DAY",
        "Una labor con precio semanal tiene que ser de un solo día.",
        { fields: { dateTo: "Con precio semanal la labor es de un solo día." } },
      );
    }

    // Where the money comes from: the weekly price of that Monday when the
    // activity derives it, the frozen rate on the row otherwise.
    const rateForEstimate =
      activity.rateSource === "weekly_price"
        ? db.weekPrices.find((p) => p.monday === mondayOf(body.dateFrom))?.costPerUnitCents ??
          activity.defaultRateCents ??
          0
        : (body.rateCents ?? activity.defaultRateCents ?? 0);

    const plotNames = body.plotIds.map(
      (id) => db.plots.find((p) => p.id === id)?.name ?? "—",
    );
    const plotCropNames = body.plotCropIds.map((id) => {
      for (const p of db.plots) {
        const c = p.crops.find((x) => x.id === id);
        if (c) return [c.cropTypeName, c.varietyName].filter(Boolean).join(" ");
      }
      return "—";
    });

    const created: WorkRecord = {
      id: body.id,
      workerId: worker.id,
      workerName: `${worker.name} ${worker.lastName}`,
      activityId: activity.id,
      activityName: activity.name,
      category: activity.category,
      payMode: activity.payMode,
      unitLabel: activity.workUnit ?? activity.timeUnit,
      plotIds: body.plotIds,
      plotNames,
      plotCropIds: body.plotCropIds,
      plotCropNames,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      quantity: body.quantity,
      // Null while it is not frozen yet: weekly_price freezes at settlement.
      rateCents: activity.rateSource === "weekly_price" ? null : rateForEstimate,
      estimatedAmountCents: Math.round(body.quantity * rateForEstimate),
      note: body.note ?? null,
      settled: false,
      status: "active",
    };
    db.workRecords.unshift(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  http.patch("*/v1/work-records/:id", async ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    const record = db.workRecords.find((w) => w.id === params.id);
    if (!record) return fail(404, "NOT_FOUND", "La labor no existe.");
    // A settled record is a document, not a draft. Void the settlement first.
    if (record.settled) {
      return fail(
        409,
        "WORK_RECORD_SETTLED",
        "La labor ya está en una liquidación viva.",
        { winningSettlement: { id: "0192f3a0-000b-7000-8000-000000000001", date: "2026-08-23" } },
      );
    }
    const body = (await request.json()) as Partial<WorkRecordInput> & { status?: string };
    if (body.status === "inactive" || body.status === "active") record.status = body.status;
    if (body.quantity !== undefined) {
      record.quantity = body.quantity;
      record.estimatedAmountCents = Math.round(body.quantity * (record.rateCents ?? 80000));
    }
    if (body.note !== undefined) record.note = body.note;
    return HttpResponse.json(record);
  }),

  /* ---- weekly price ---- */

  http.get("*/v1/prices/weeks/:monday", ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    const monday = String(params.monday);
    const found = db.weekPrices.find((p) => p.monday === monday);
    // Falling back to the latest known price is what the phone does: a week
    // with no price set is not an error, it is "same as last week".
    const fallback = db.weekPrices[db.weekPrices.length - 1];
    return HttpResponse.json(found ?? { monday, costPerUnitCents: fallback.costPerUnitCents });
  }),

  /* ---- money ---- */

  http.post("*/v1/payments", async ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    await delay(400);
    const body = (await request.json()) as PaymentInput;
    const before = db.balanceOf(body.workerId).balanceCents;

    if (body.amountCents <= 0) {
      return fail(400, "VALIDATION_FAILED", "El valor tiene que ser mayor que cero.", {
        fields: { amountCents: "El valor tiene que ser mayor que cero." },
      });
    }
    // RSP-008 forbids paying more than the balance; the ledger would allow it.
    // The excess is an "anticipo", posted separately, never folded in here.
    if (body.amountCents > before) {
      return fail(409, "AMOUNT_EXCEEDS_BALANCE", "El valor supera el saldo pendiente.", {
        balanceCents: before,
      });
    }

    // Settling the pending work records is what turns them into a devengo.
    const claimed = body.payableIds ?? [];
    if (claimed.length) {
      let devengoCents = 0;
      for (const id of claimed) {
        const rec = db.workRecords.find((w) => w.id === id);
        if (!rec) continue;
        if (rec.settled) {
          return fail(409, "PAYABLE_ALREADY_CLAIMED", "Otra liquidación ya tomó estas labores.", {
            winningSettlement: { id: crypto.randomUUID(), date: "2026-08-29" },
          });
        }
        rec.settled = true;
        devengoCents += rec.estimatedAmountCents;
      }
      if (devengoCents > 0) {
        db.ledger.push({
          id: crypto.randomUUID(),
          workerId: body.workerId,
          kind: "devengo",
          concept: `Liquidación de ${claimed.length} labor(es)`,
          amountCents: devengoCents,
          date: new Date().toISOString().slice(0, 10),
          method: null,
          receiptNumber: null,
          reversesId: null,
        });
      }
    }

    const receiptNumber = String(41 + db.ledger.filter((l) => l.kind === "pago").length).padStart(4, "0");
    const entry: LedgerEntry = {
      id: body.id,
      workerId: body.workerId,
      kind: "pago",
      concept: `${body.method === "transferencia" ? "Transferencia" : "Efectivo"} · recibo #${receiptNumber}`,
      amountCents: -body.amountCents,
      date: new Date().toISOString().slice(0, 10),
      method: body.method,
      receiptNumber,
      reversesId: null,
    };
    db.ledger.push(entry);

    return HttpResponse.json(
      {
        id: entry.id,
        workerId: body.workerId,
        amountCents: body.amountCents,
        method: body.method,
        receiptNumber,
        balanceBeforeCents: before,
        balanceAfterCents: db.balanceOf(body.workerId).balanceCents,
        date: entry.date,
      },
      { status: 201 },
    );
  }),

  http.post("*/v1/advances", async ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    const body = (await request.json()) as PaymentInput;
    const before = db.balanceOf(body.workerId).balanceCents;
    const entry: LedgerEntry = {
      id: body.id,
      workerId: body.workerId,
      kind: "anticipo",
      concept: body.note || "Anticipo",
      amountCents: -body.amountCents,
      date: new Date().toISOString().slice(0, 10),
      method: body.method,
      receiptNumber: null,
      reversesId: null,
    };
    db.ledger.push(entry);
    return HttpResponse.json(
      {
        id: entry.id,
        workerId: body.workerId,
        amountCents: body.amountCents,
        method: body.method,
        receiptNumber: "—",
        balanceBeforeCents: before,
        balanceAfterCents: db.balanceOf(body.workerId).balanceCents,
        date: entry.date,
      },
      { status: 201 },
    );
  }),

  http.post("*/v1/deductions", async ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (isWeigher(user)) return forbidden();
    const body = (await request.json()) as DeductionInput;
    const entry: LedgerEntry = {
      id: body.id,
      workerId: body.workerId,
      kind: "deduccion",
      concept: body.concept,
      amountCents: -Math.abs(body.amountCents),
      date: body.date,
      method: null,
      receiptNumber: null,
      reversesId: null,
    };
    db.ledger.push(entry);
    return HttpResponse.json(entry, { status: 201 });
  }),

  /* ---- super-admin ---- */

  http.get("*/v1/admin/farms", ({ request }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (!user.isSuperAdmin) return forbidden();
    const params = new URL(request.url).searchParams;
    const q = params.get("q");
    const status = params.get("status");
    return HttpResponse.json(
      db.adminFarms.filter(
        (f) =>
          (!status || status === "all" || f.status === status) &&
          (matches(f.name, q) || matches(f.ownerEmail, q)),
      ),
    );
  }),

  http.patch("*/v1/admin/farms/:id", async ({ request, params }) => {
    const { user, deny } = auth(request);
    if (!user) return deny;
    if (!user.isSuperAdmin) return forbidden();
    const target = db.adminFarms.find((f) => f.id === params.id);
    if (!target) return fail(404, "NOT_FOUND", "La finca no existe.");
    const { status } = (await request.json()) as { status: "active" | "suspended" };
    target.status = status;
    return HttpResponse.json(target);
  }),
];
