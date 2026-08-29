/**
 * The test that proves the two halves fit.
 *
 * Everything else in this repository tests one side of the wire. The unit
 * suite runs against MSW, so it can only ever confirm that the web agrees with
 * the web's idea of the API. The Go suite runs against Postgres, so it can
 * only confirm that the API agrees with itself. Both were green throughout
 * Sprint 1, while `POST /v1/signup` from this app was a 400 and nobody knew.
 *
 * So this suite runs the app's REAL client module — `src/api/endpoints.ts`,
 * the same code the browser executes — against a REAL server with a REAL
 * database, and walks the path the farm actually cares about:
 *
 *     register a farm -> confirm the address -> log in
 *     -> hire a worker -> add a plot -> price an activity
 *     -> record two days of picking
 *     -> settle them (this is the write that turns work into money owed)
 *     -> pay part of it
 *     -> check what is still owed
 *
 * The last step is the one worth having. Every figure in it is derived: the
 * balance is summed from the ledger on every read, on both sides, and the only
 * way this assertion passes is if the client, the wire format, the SQL and the
 * money rules all agree. It is deliberately arithmetic anybody can check by
 * hand — 38,5 kg and 25 kg at $800, less a $30.000 payment.
 *
 * WHEN THE SERVER IS NOT RUNNING this suite skips, and says so at the top of
 * its lungs with the command to run. It does not pass. A live-integration test
 * that quietly reports success when it never connected is worse than not
 * having one, because it is a green tick that means nothing.
 *
 *     npm run test:e2e
 *
 * Point it somewhere else with BASCULA_API_URL.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { getTokens, setTokens } from "../src/api/client";
import { invalidateRefs } from "../src/api/refs";
import { uuidv7 } from "../src/lib/uuid";

const API_URL = process.env.BASCULA_API_URL ?? "http://localhost:8099";

const HOW_TO_START = `
┌──────────────────────────────────────────────────────────────────────────────
│  PRUEBA DE EXTREMO A EXTREMO OMITIDA: no hay API en ${API_URL}
│
│  Esta prueba NO pasó. Se saltó porque no encontró el servidor.
│  Para correrla, levante la API en otra terminal:
│
│    cd services/api
│    make up
│    make migrate
│    PORT=8099 SIGNUPS_PER_IP_PER_HOUR=100 \\
│      DATABASE_URL="postgres://bascula_api:bascula_api_dev@localhost:5433/bascula?sslmode=disable" \\
│      go run ./cmd/api
│
│  Y vuelva a correr:   npm run test:e2e
│
│  SIGNUPS_PER_IP_PER_HOUR importa: por defecto son 5 registros por IP y por
│  hora, guardados en Postgres, así que a la sexta corrida la prueba fallaría
│  con RATE_LIMITED en vez de decir algo útil.
└──────────────────────────────────────────────────────────────────────────────
`;

/**
 * Ask the server whether it is there, before Vitest collects anything.
 *
 * Top-level await rather than a `beforeAll`, because a hook cannot skip a
 * suite — it can only fail it, and "the API is not running on your laptop" is
 * not a failure of this branch.
 */
async function serverIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await serverIsUp();
if (!up) {
  // stderr, unconditionally, before the reporter prints anything. The suite
  // name below repeats it, because a banner scrolls away and a test name does
  // not.
  console.error(HOW_TO_START);
}

const suite = up
  ? describe
  : describe.skip.bind(null) as unknown as typeof describe;

const suiteName = up
  ? "la web contra la API real"
  : `la web contra la API real — OMITIDA, no hay servidor en ${API_URL} (levántelo: cd services/api && make up && make migrate && PORT=8099 SIGNUPS_PER_IP_PER_HOUR=100 go run ./cmd/api)`;

/* ------------------------------------------------------------------ */

/** $800 a kilo, in cents, which is what the wireframes are priced at. */
const PRICE_PER_KG = 80_000;

const today = () => new Date().toISOString().slice(0, 10);

/** A different address every run: signup is idempotent for nobody. */
const uniqueEmail = () => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e4)}@bascula.test`;

/**
 * Turn a failed call into something a person can act on. Without this, a
 * rate-limited signup reports as `ApiError: 429` sixteen frames deep.
 */
function explain(e: unknown, step: string): never {
  if (e instanceof ApiError) {
    if (e.code === "RATE_LIMITED") {
      throw new Error(
        `${step}: el servidor limitó los registros por IP (5/hora por defecto).\n` +
          `Reinicie la API con SIGNUPS_PER_IP_PER_HOUR=100 y vuelva a correr la prueba.`,
      );
    }
    throw new Error(
      `${step}: HTTP ${e.status} ${e.code} — ${e.message}\n` +
        `detalles: ${JSON.stringify(e.details)}`,
    );
  }
  throw e;
}

suite(suiteName, () => {
  const email = uniqueEmail();
  const password = "una-clave-larga-de-verdad";

  let workerId = "";
  let plotId = "";
  let activityId = "";
  const recordIds: string[] = [];

  beforeAll(() => {
    // Each run is its own farm, so nothing carries over between runs and the
    // suite never depends on the state a previous run left behind.
    setTokens(null);
    invalidateRefs();
  });

  it("registra una finca y devuelve el token de verificación en desarrollo", async () => {
    const res = await api
      .signup({
        farm: {
          name: `Finca E2E ${Date.now()}`,
          timezone: "America/Bogota",
          currency: "COP",
          priceCents: PRICE_PER_KG,
        },
        owner: { email, name: "Dueña E2E", password },
      })
      .catch((e) => explain(e, "registrar la finca"));

    expect(res.farmId).toBeTruthy();
    expect(res.userId).toBeTruthy();
    // In development the server echoes the token because there is no mail
    // sender. If this is null the server is running with APP_ENV set to
    // something else, and the rest of the suite cannot proceed.
    expect(
      res.verificationToken,
      "el servidor no devolvió verificationToken: ¿está corriendo con APP_ENV=development?",
    ).toBeTruthy();

    await api
      .verifyEmail(res.verificationToken!)
      .catch((e) => explain(e, "confirmar el correo"));
  });

  it("no deja entrar antes de confirmar, y sí después", async () => {
    // The address is already verified by the previous step, so this checks the
    // other half of the pair: a wrong password is INVALID_CREDENTIALS and not
    // something vaguer.
    await expect(
      api.login({ email, password: "una-clave-que-no-es" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    const session = await api
      .login({ email, password })
      .catch((e) => explain(e, "entrar"));

    if ("choose" in session) throw new Error("no se esperaba elegir finca");
    expect(session.user.role).toBe("owner");
    expect(session.user.farm.name).toContain("Finca E2E");
    // 15 minutes. The transparent refresh in client.ts exists because of this
    // number, so it is worth asserting rather than assuming.
    expect(session.expiresIn).toBe(900);
  });

  it("guarda la sesión donde una recarga la encuentra", () => {
    // This is the whole mechanism behind "la sesión sobrevive a recargar la
    // página": AuthProvider reads these on mount and asks /v1/me. If the
    // tokens are not here, the reload lands on the login screen.
    const stored = localStorage.getItem("bascula.tokens");
    expect(stored, "la sesión no quedó guardada en localStorage").toBeTruthy();
    expect(JSON.parse(stored!).accessToken).toBe(getTokens()?.accessToken);
  });

  it("contrata un trabajador y abre un lote", async () => {
    const worker = await api
      .createWorker({
        id: uuidv7(),
        name: "Rosa",
        lastName: "Quintero",
        documentType: "CC",
        documentNumber: `10${Date.now() % 100000000}`,
        phone: "3001234567",
      })
      .catch((e) => explain(e, "crear el trabajador"));
    workerId = worker.id;
    expect(worker.name).toBe("Rosa");
    expect(worker.status).toBe("active");

    const cropType = await api
      .createCropType("Café")
      .catch((e) => explain(e, "crear el tipo de cultivo"));

    const plot = await api
      .createPlot({
        id: uuidv7(),
        name: `La Cuchilla ${Date.now()}`,
        department: "Caldas",
        municipality: "Chinchiná",
        areaHa: 2.5,
        crops: [
          {
            id: uuidv7(),
            cropTypeId: cropType.id,
            varietyId: null,
            areaHa: 2.5,
            plantedAt: "2023-03-01",
          },
        ],
      })
      .catch((e) => explain(e, "crear el lote"));
    plotId = plot.id;
    expect(plot.crops).toHaveLength(1);
    expect(plot.crops[0].cropTypeName).toBe("Café");
  });

  it("crea una actividad con precio fijo por kilo", async () => {
    const activity = await api
      .createActivity({
        id: uuidv7(),
        name: `Recolección E2E ${Date.now()}`,
        category: "cosecha",
        payMode: "work_unit",
        workUnit: "kg",
        rateSource: "fixed",
        defaultRateCents: PRICE_PER_KG,
        // Well before the work, so the rate is in force on the day it is used.
        validFrom: "2020-01-01",
      })
      .catch((e) => explain(e, "crear la actividad"));

    activityId = activity.id;
    expect(activity.payMode).toBe("work_unit");
    expect(activity.rateSource).toBe("fixed");
    expect(activity.defaultRateCents).toBe(PRICE_PER_KG);
    // The unit came back as a label, which means the client's join against the
    // work-units catalogue worked — the server sent only a `unitId`.
    expect(activity.workUnit).toBe("kg");
  });

  it("registra dos labores y les calcula el valor", async () => {
    const day = today();

    const first = await api
      .createWorkRecord({
        id: uuidv7(),
        workerId,
        activityId,
        plotIds: [plotId],
        plotCropIds: [],
        dateFrom: day,
        dateTo: day,
        quantity: 38.5,
      })
      .catch((e) => explain(e, "registrar la primera labor"));

    const second = await api
      .createWorkRecord({
        id: uuidv7(),
        workerId,
        activityId,
        plotIds: [plotId],
        plotCropIds: [],
        dateFrom: day,
        dateTo: day,
        quantity: 25,
      })
      .catch((e) => explain(e, "registrar la segunda labor"));

    recordIds.push(first.id, second.id);

    // 38,5 kg x $800 = $30.800. The same figure the wireframes quote, arrived
    // at by the server's round(quantity x rate) rather than by our arithmetic.
    expect(first.estimatedAmountCents).toBe(3_080_000);
    expect(second.estimatedAmountCents).toBe(2_000_000);
    // Names the server never sent: resolved client-side from the reference
    // data. If the join broke, these would be "—".
    expect(first.workerName).toBe("Rosa Quintero");
    expect(first.plotNames[0]).toContain("La Cuchilla");
    expect(first.unitLabel).toBe("kg");
    expect(first.settled).toBe(false);
  });

  it("muestra las dos labores como pendientes, y nada en el saldo todavía", async () => {
    const payables = await api
      .workerPayables(workerId)
      .catch((e) => explain(e, "consultar lo pendiente"));

    expect(payables.workRecords).toHaveLength(2);
    expect(payables.grossCents).toBe(5_080_000);
    // Work that has not been settled is not yet a debt: the ledger is empty.
    expect(payables.balanceCents).toBe(0);
    expect(payables.totalCents).toBe(5_080_000);
  });

  it("liquidar es lo que convierte el trabajo en plata debida", async () => {
    const settlement = await api
      .settle(workerId, recordIds)
      .catch((e) => explain(e, "liquidar"));

    expect(settlement.grossCents).toBe(5_080_000);

    const balance = await api.workerBalance(workerId);
    expect(balance.earnedCents).toBe(5_080_000);
    expect(balance.paidCents).toBe(0);
    expect(balance.balanceCents).toBe(5_080_000);

    // The same records are now claimed, so there is nothing left to settle.
    await expect(api.settle(workerId, recordIds)).rejects.toMatchObject({
      code: "NOTHING_TO_SETTLE",
    });
  });

  it("no deja pagar más de lo que se debe", async () => {
    // The guard against a typo on the payment screen. The client never sets
    // allowOverpayment: the excess is offered as an anticipo instead, so the
    // extra money keeps its correct name in the ledger.
    const tooMuch = api.createPayment({
      id: uuidv7(),
      workerId,
      amountCents: 9_000_000,
      method: "efectivo",
    });

    await expect(tooMuch).rejects.toMatchObject({ code: "AMOUNT_EXCEEDS_BALANCE" });

    // And it says how much is actually owed, which is what the screen needs to
    // offer the excess as an advance.
    await tooMuch.catch((e: ApiError) => {
      expect(Number(e.details.balanceCents)).toBe(5_080_000);
    });
  });

  it("paga una parte y deja el saldo a favor exacto", async () => {
    const receipt = await api
      .createPayment({
        id: uuidv7(),
        workerId,
        amountCents: 3_000_000, // $30.000 of the $50.800 owed
        method: "efectivo",
        note: "Abono en efectivo",
      })
      .catch((e) => explain(e, "pagar"));

    expect(receipt.amountCents).toBe(3_000_000);
    expect(receipt.balanceBeforeCents).toBe(5_080_000);
    expect(receipt.balanceAfterCents).toBe(2_080_000);

    // The assertion the whole suite exists for. $50.800 earned, $30.000 paid,
    // $20.800 still owed — summed from the ledger by the server, read back
    // through the app's own client, and checkable on paper.
    const balance = await api.workerBalance(workerId);
    expect(balance.earnedCents).toBe(5_080_000);
    expect(balance.paidCents).toBe(3_000_000);
    expect(balance.balanceCents).toBe(2_080_000);
  });

  it("deja el movimiento explicado en el historial", async () => {
    const ledger = await api
      .workerLedger(workerId)
      .catch((e) => explain(e, "leer el historial"));

    const kinds = ledger.map((e) => e.kind);
    expect(kinds).toContain("devengo");
    expect(kinds).toContain("pago");

    const payment = ledger.find((e) => e.kind === "pago")!;
    // Stored negative, and carrying the note somebody typed rather than a
    // generic label — there is no `concept` column, so the client composes it.
    expect(payment.amountCents).toBe(-3_000_000);
    expect(payment.concept).toBe("Abono en efectivo");
    expect(payment.method).toBe("efectivo");

    const earning = ledger.find((e) => e.kind === "devengo")!;
    expect(earning.amountCents).toBe(5_080_000);
    expect(earning.settlementId).toBeTruthy();
  });

  it("el perfil cuenta la misma historia en una sola llamada", async () => {
    const profile = await api
      .workerProfile(workerId)
      .catch((e) => explain(e, "abrir el perfil"));

    expect(profile.worker.id).toBe(workerId);
    expect(profile.balance.balanceCents).toBe(2_080_000);
    expect(profile.workRecords).toHaveLength(2);
    // Everything was settled, so nothing is pending any more.
    expect(profile.pendingCents).toBe(0);
    expect(profile.workRecords.every((r) => r.settled)).toBe(true);
    // And a labor inside a live settlement cannot be edited out from under the
    // payment.
    await expect(api.deactivateWorkRecord(recordIds[0])).rejects.toMatchObject({
      code: "WORK_RECORD_SETTLED",
    });
  });

  it("refresca el token sin que nadie se entere", async () => {
    const before = getTokens()!;

    // Corrupt only the ACCESS token. The next call gets a 401, the client
    // rotates the refresh token once, replays the request, and the caller sees
    // a normal answer. This is the path a farm administrator hits every
    // fifteen minutes with the payment screen open.
    setTokens({ accessToken: `${before.accessToken}-roto`, refreshToken: before.refreshToken });

    const me = await api.me().catch((e) => explain(e, "refrescar la sesión"));
    expect(me.role).toBe("owner");

    const after = getTokens()!;
    expect(after.accessToken).not.toBe(before.accessToken);
    // Refresh tokens are single use: a new one came back with the new access
    // token, and the old one is now dead.
    expect(after.refreshToken).not.toBe(before.refreshToken);
  });

  it("cierra la sesión de verdad", async () => {
    await api.logout().catch((e) => explain(e, "cerrar sesión"));
    setTokens(null);
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
  });
});
