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
import { api, grossChangeOf } from "../src/api/endpoints";
import { sentenceFor, type Formatters } from "../src/api/grossChange";
import { ApiError } from "../src/api/errors";
import { getTokens, http, setTokens } from "../src/api/client";
import { invalidateRefs } from "../src/api/refs";
import { formatDayLong } from "../src/lib/dates";
import { formatMoney } from "../src/lib/money";
import { uuidv7 } from "../src/lib/uuid";
import { areaHaOf, asGeometry, ringProblem, type Geometry } from "../src/lib/geo";

/** How the difference sentence writes figures and dates. */
const FMT: Formatters = { money: formatMoney, week: formatDayLong };

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
  let productId = "";
  let warehouseId = "";
  let saleId = "";
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

  /**
   * The map, against PostGIS.
   *
   * This is the only place in the repository where the polygon story is
   * checked end to end: the editor's own arithmetic, the wire format, ST_Multi,
   * ST_IsValid and ST_Area all have to agree, and none of the other suites can
   * see more than one of them. `npm test` measures a ring against a mock that
   * shares its area function, so of course they agree.
   *
   * The number to watch is 122,506 ha. That is what `ST_Area` on the geography
   * column returns for the square in `openapi.yaml`'s example, and it is what
   * `lib/geo.ts` has to land on for the area shown while somebody is dragging
   * a corner to be the same area they get after pressing Guardar.
   */
  it("guarda el polígono del lote, lo mide y avisa de los solapes", async () => {
    const square = (west: number): Geometry => ({
      type: "Polygon",
      coordinates: [
        [
          [west, 5.66],
          [west + 0.01, 5.66],
          [west + 0.01, 5.67],
          [west, 5.67],
          [west, 5.66],
        ],
      ],
    });

    const drawn = square(-75.88);
    const { plot, overlaps } = await api
      .setPlotBoundary(plotId, drawn)
      .catch((e) => explain(e, "guardar el polígono"));

    // GeoJSON in, GeoJSON out — and a MultiPolygon out, because ST_Multi
    // promotes on the way into the column. A client that assumes it gets back
    // what it sent draws nothing on the next reload.
    const stored = asGeometry(plot.boundary);
    expect(stored?.type).toBe("MultiPolygon");

    // Both figures, always. The declared 2,5 ha is untouched.
    expect(plot.areaHa).toBe(2.5);
    expect(plot.computedAreaHa).toBeCloseTo(122.506, 2);

    // And the browser's own preview agrees with PostGIS to five figures, which
    // is what keeps the number from jumping when the save lands.
    expect(areaHaOf(drawn)).toBeCloseTo(plot.computedAreaHa!, 2);

    expect(overlaps).toEqual([]);

    // A second lot on top of the first: stored, and reported. A warning, never
    // a refusal — two lots that touch are sometimes a terrace above a cafetal.
    const neighbour = await api
      .createPlot({
        id: uuidv7(),
        name: `El Solape ${Date.now()}`,
        department: "Caldas",
        municipality: "Chinchiná",
        areaHa: 1,
        crops: [],
        boundary: square(-75.875),
      })
      .catch((e) => explain(e, "crear el lote solapado con su polígono"));

    // The boundary went in with the plot, in one write, and was measured.
    expect(asGeometry(neighbour.boundary)?.type).toBe("MultiPolygon");
    expect(neighbour.computedAreaHa).toBeCloseTo(122.506, 2);

    const again = await api
      .setPlotBoundary(neighbour.id, square(-75.875))
      .catch((e) => explain(e, "reescribir el polígono del vecino"));
    expect(again.overlaps.map((o) => o.name)).toContain(
      (await api.getPlot(plotId)).name,
    );
  });

  /**
   * INVALID_GEOMETRY, in Spanish, from the code and not from the English text.
   *
   * The server's `message` is `ST_IsValidReason`'s output —
   * "Self-intersection[-75.875 5.665]" — which is our database talking. What a
   * person sees comes out of `ERROR_MESSAGES`, keyed by `code`.
   */
  it("rechaza un polígono que se cruza a sí mismo, y lo dice en español", async () => {
    const bowtie: Geometry = {
      type: "Polygon",
      coordinates: [
        [
          [-75.88, 5.66],
          [-75.87, 5.67],
          [-75.87, 5.66],
          [-75.88, 5.67],
          [-75.88, 5.66],
        ],
      ],
    };

    // The editor refuses it before the network does, naming the two sides.
    const problem = ringProblem(bowtie.coordinates[0]);
    expect(problem?.kind).toBe("selfIntersects");

    const failure = await api
      .setPlotBoundary(plotId, bowtie)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    const err = failure as ApiError;
    expect(err.status).toBe(400);
    expect(err.code).toBe("INVALID_GEOMETRY");
    expect(err.message).toMatch(/Self-intersection/); // the server's, for the log
    expect(err.spanishMessage).toMatch(/polígono/i); // ours, for the person
    expect(err.spanishMessage).not.toMatch(/Self-intersection/);

    // Refused means refused: the lot still has the square from the last test.
    const after = await api.getPlot(plotId).catch((e) => explain(e, "releer el lote"));
    expect(after.computedAreaHa).toBeCloseTo(122.506, 2);
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
    const approved = await api.previewSettlement(workerId, recordIds);
    expect(approved.grossCents).toBe(5_080_000);

    const settlement = await api
      .settle(workerId, recordIds, {
        expectedGrossCents: approved.grossCents,
        expectedLines: approved.lines,
      })
      .catch((e) => explain(e, "liquidar"));

    expect(settlement.grossCents).toBe(5_080_000);

    const balance = await api.workerBalance(workerId);
    expect(balance.earnedCents).toBe(5_080_000);
    expect(balance.paidCents).toBe(0);
    expect(balance.balanceCents).toBe(5_080_000);

    // The same records are now claimed, so there is nothing left to settle.
    // NOTHING_TO_SETTLE and not GROSS_CHANGED, and the ordering is the
    // server's on purpose: it establishes there is nothing to price before it
    // asks whether the price is the expected one. "Su cifra cambió" about an
    // empty selection would send somebody looking for a weighing that moved.
    await expect(
      api.settle(workerId, recordIds, { expectedGrossCents: 5_080_000 }),
    ).rejects.toMatchObject({ code: "NOTHING_TO_SETTLE" });
  });

  /**
   * The settlement is now a record the farm can look up, which is what the
   * `/liquidaciones` screen reads. There is no `GET /v1/settlements` on the
   * server — it answers 405 — so `listSettlements` composes the list out of
   * the ledgers; this proves the composition finds what was just written.
   */
  it("la liquidación queda listada, con su periodo y sus líneas", async () => {
    const list = await api.listSettlements().catch((e) => explain(e, "listar liquidaciones"));
    const mine = list.filter((s) => s.workerId === workerId);
    expect(mine).toHaveLength(1);
    expect(mine[0].grossCents).toBe(5_080_000);
    expect(mine[0].status).toBe("open");
    expect(mine[0].workerName).toBe("Rosa Quintero");
    // The period recorded is the one actually covered, not the 1970 the client
    // asks over when it means "everything outstanding".
    expect(mine[0].periodStart.slice(0, 4)).not.toBe("1970");

    const detail = await api.getSettlement(mine[0].id);
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines.reduce((a, l) => a + l.amountCents, 0)).toBe(5_080_000);
    expect(detail.lines.every((l) => l.rateCents === PRICE_PER_KG)).toBe(true);
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

  /* ------------------------------------------------------------------ */
  /* El candado de la liquidación                                        */
  /* ------------------------------------------------------------------ */

  /**
   * These two run on a worker of their OWN, hired here, and deliberately after
   * the walk above has finished asserting its by-hand arithmetic. They move
   * work records around to stage a race, and doing that to Rosa would quietly
   * rewrite the figures every comment in this file quotes.
   */
  describe("cuando el bruto se mueve entre mirarlo y aprobarlo", () => {
    let raceWorkerId = "";
    const raceRecords: string[] = [];

    beforeAll(async () => {
      const worker = await api
        .createWorker({
          id: uuidv7(),
          name: "Carmen",
          lastName: "Ospina",
          documentType: "CC",
          documentNumber: `9${Date.now()}`.slice(0, 10),
          phone: "",
          country: "Colombia",
        })
        .catch((e) => explain(e, "contratar para la prueba del candado"));
      raceWorkerId = worker.id;

      for (const quantity of [10, 20]) {
        const r = await api
          .createWorkRecord({
            id: uuidv7(),
            workerId: raceWorkerId,
            activityId,
            plotIds: [plotId],
            plotCropIds: [],
            dateFrom: today(),
            dateTo: today(),
            quantity,
          })
          .catch((e) => explain(e, "registrar labor para la prueba del candado"));
        raceRecords.push(r.id);
      }
    });

    /**
     * NAMING THE SET REMOVES THE RACE.
     *
     * This is the behaviour the contract asks for in as many words — "Send
     * `payableIds`. Naming the set removes the race entirely rather than
     * reporting it" — and it is worth proving rather than believing, because
     * it is the difference between a screen that refuses weekly and one that
     * never has to.
     */
    it("una pesada tardía no entra en lo que ya se aprobó", async () => {
      const approved = await api
        .previewSettlement(raceWorkerId, raceRecords)
        .catch((e) => explain(e, "previsualizar"));
      // 10 kg + 20 kg at $800.
      expect(approved.grossCents).toBe(2_400_000);

      await api
        .createWorkRecord({
          id: uuidv7(),
          workerId: raceWorkerId,
          activityId,
          plotIds: [plotId],
          plotCropIds: [],
          dateFrom: today(),
          dateTo: today(),
          quantity: 5,
          note: "pesada tardía, entra después de que la pantalla mostró el bruto",
        })
        .catch((e) => explain(e, "registrar la pesada tardía"));

      // The preview of the SAME named set is unmoved: the late weighing is
      // pending, and simply not part of what was approved.
      const again = await api.previewSettlement(raceWorkerId, raceRecords);
      expect(again.grossCents).toBe(2_400_000);
    });

    /**
     * And when the figure DOES move, nothing is written and the refusal says
     * what moved it.
     *
     * Staged as a payable disappearing from under the approval, which on a
     * farm is somebody else's settlement getting to it first. The assertions
     * are on the LEDGER, not on the error code: a guard that refused after
     * writing would produce the right code and the wrong balance.
     */
    it("se niega a liquidar una cifra distinta de la que se aprobó", async () => {
      const approved = await api.previewSettlement(raceWorkerId, raceRecords);
      const gone = approved.lines.find((l) => l.id === raceRecords[1])!;

      await api.deactivateWorkRecord(gone.id);

      const refusal = await api
        .settle(raceWorkerId, raceRecords, {
          expectedGrossCents: approved.grossCents,
          expectedLines: approved.lines,
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(refusal).toMatchObject({ code: "GROSS_CHANGED" });

      // Nothing was written, so the person can look again and approve the
      // real figure.
      const balance = await api.workerBalance(raceWorkerId);
      expect(balance.earnedCents).toBe(0);
      expect(balance.balanceCents).toBe(0);

      // And the refusal carries the explanation, not just a code.
      const change = grossChangeOf(refusal);
      expect(change).not.toBeNull();
      expect(change!.beforeCents).toBe(approved.grossCents);
      expect(change!.afterCents).toBe(approved.grossCents - gone.amountCents);
      expect(change!.removedIds).toEqual([gone.id]);
      expect(change!.causeIsKnown).toBe(true);
      expect(sentenceFor(change!, FMT)).toContain("salió una pesada de la liquidación");
      // The week is NOT reported as repriced: its price did not move, even
      // though `weeksInSettlement` carried it — as it always does.
      expect(change!.repriced).toEqual([]);
    });

    it("y aprobada de nuevo, la cifra nueva sí se liquida", async () => {
      const approved = await api.previewSettlement(raceWorkerId, raceRecords);
      const settlement = await api
        .settle(
          raceWorkerId,
          approved.lines.map((l) => l.id),
          { expectedGrossCents: approved.grossCents, expectedLines: approved.lines },
        )
        .catch((e) => explain(e, "liquidar la cifra nueva"));
      expect(settlement.grossCents).toBe(approved.grossCents);
      expect((await api.workerBalance(raceWorkerId)).earnedCents).toBe(approved.grossCents);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Inventario, ventas y gastos — RSP-018 … RSP-033                     */
  /* ------------------------------------------------------------------ */

  /**
   * The rule the whole inventory module is shaped around, checked against the
   * database that enforces it: EXISTENCIAS ARE DERIVED.
   *
   * `stock_moves` is append-only — a trigger and a REVOKE, the same defence
   * the ledger has — so `product.stock` is a SUM computed on every read. What
   * this walk proves is that the number the screen shows is the number that
   * falls out of the movements, through the real SQL and not through a mock
   * that shares our arithmetic.
   */
  it("deriva las existencias de los movimientos, y no hay otra forma de moverlas", async () => {
    const warehouse = await api
      .createWarehouse("Bodega principal")
      .catch((e) => explain(e, "crear la bodega"));
    warehouseId = warehouse.id;

    // Idempotent by lower(name), like every picker in this service: asking
    // twice is one row, which is what makes "escríbala si no está" safe.
    const again = await api.createWarehouse("bodega principal");
    expect(again.id).toBe(warehouseId);

    const product = await api
      .createProduct({
        id: uuidv7(),
        name: `Café pergamino ${Date.now()}`,
        categoryName: "Producto procesado",
        storageUnit: "Bulto",
      })
      .catch((e) => explain(e, "crear el producto"));
    productId = product.id;
    // Brand new, so nothing has moved: zero, and not null and not undefined.
    expect(product.stock).toBe(0);
    expect(product.storageUnit).toBe("Bulto");

    const harvest = await api
      .createStockMove({
        id: uuidv7(),
        productId,
        warehouseId,
        qty: 40,
        reason: "cosecha",
        date: today(),
      })
      .catch((e) => explain(e, "registrar la cosecha"));
    expect(harvest.move.qty).toBe(40);

    await api
      .createStockMove({
        id: uuidv7(),
        productId,
        warehouseId,
        qty: -5,
        reason: "merma",
        note: "Se mojó un bulto y medio",
        date: today(),
      })
      .catch((e) => explain(e, "registrar la merma"));

    const after = await api.getProduct(productId).catch((e) => explain(e, "releer el producto"));
    expect(after.stock).toBe(35);

    const levels = await api.stockLevels({ productId });
    expect(levels).toHaveLength(1);
    expect(levels[0].qty).toBe(35);
    expect(levels[0].warehouseId).toBe(warehouseId);
  });

  /**
   * THE SIGN IS NOT THE CALLER'S TO GET WRONG — and the server CORRECTS it
   * rather than refusing, which is worth knowing precisely.
   *
   * `handleCreateStockMove` flips the quantity to match the reason before
   * writing, and `stock_sign` catches anything that got past. So
   * `{qty: 5, reason: "merma"}` is a loss of five and a 201, not a 400. A form
   * built to show a validation error there would be defending against
   * something that never happens; `lib/stock.ts` applies the same rule on this
   * side only so the preview can say what the movement will do BEFORE it is
   * sent.
   */
  it("corrige el signo del movimiento según el motivo, en vez de rechazarlo", async () => {
    const before = (await api.getProduct(productId)).stock;
    const { move } = await api
      .createStockMove({
        id: uuidv7(),
        productId,
        warehouseId,
        qty: 5, // POSITIVE, for a reason that takes product out
        reason: "merma",
        date: today(),
      })
      .catch((e) => explain(e, "registrar la merma con el signo al revés"));

    expect(move.qty).toBe(-5);
    expect((await api.getProduct(productId)).stock).toBe(before - 5);
  });

  /**
   * The stock guard is on EVERY outgoing movement, not only on a sale. A
   * `consumo` for more than there is comes back 409 with the two numbers, and
   * `allowNegative` records it anyway — the same escape hatch, spelled the way
   * the movement schema spells it.
   */
  it("guarda la bodega en cualquier salida, no solo en una venta", async () => {
    const onHand = (await api.getProduct(productId)).stock;

    const refused = await api
      .createStockMove({
        id: uuidv7(),
        productId,
        warehouseId,
        qty: onHand + 50,
        reason: "consumo",
        date: today(),
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe("INSUFFICIENT_STOCK");
    expect((refused as ApiError).details.onHand).toBe(onHand);

    const forced = await api
      .createStockMove({
        id: uuidv7(),
        productId,
        warehouseId,
        qty: onHand + 50,
        reason: "consumo",
        date: today(),
        allowNegative: true,
      })
      .catch((e) => explain(e, "forzar el consumo"));
    expect(forced.move.qty).toBe(-(onHand + 50));
    expect((await api.getProduct(productId)).stock).toBe(-50);

    // And the way back out of an append-only table: its exact opposite, once.
    // This also puts the warehouse where the next case needs it, which is the
    // honest way to do it — there is no DELETE to reach for.
    const undone = await api
      .reverseStockMove(forced.move.id, "Se registró por error")
      .catch((e) => explain(e, "reversar el consumo"));
    expect(undone.qty).toBe(onHand + 50);
    expect(undone.reason).toBe("ajuste");
    expect(undone.reversesId).toBe(forced.move.id);
    expect((await api.getProduct(productId)).stock).toBe(onHand);

    // Once. A second attempt is a conflict with a name of its own.
    await expect(api.reverseStockMove(forced.move.id, "otra vez")).rejects.toMatchObject({
      code: "ALREADY_REVERSED",
    });
  });

  /** A `venta` movement belongs to a sale. Through this door it is refused. */
  it("no deja registrar una venta por la puerta del inventario", async () => {
    const direct = await api
      .createStockMove({
        id: uuidv7(),
        productId,
        warehouseId,
        qty: -1,
        reason: "venta",
        date: today(),
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(direct).toBeInstanceOf(ApiError);
    expect((direct as ApiError).status).toBe(400);
  });

  /**
   * A sale and its outgoing movement in one transaction, and a void that puts
   * the coffee back. This is the seam that cannot be checked anywhere else:
   * two lists that have to agree, kept in step by the database.
   */
  it("una venta saca producto de la bodega, y anularla lo devuelve", async () => {
    const before = (await api.getProduct(productId)).stock;

    const sale = await api
      .createSale({
        id: uuidv7(),
        productId,
        warehouseId,
        customerName: "Cooperativa de Caficultores",
        quantity: 12,
        amountCents: 14_400_000,
        date: today(),
      })
      .catch((e) => explain(e, "registrar la venta"));
    saleId = sale.id;
    expect(sale.quantity).toBe(12);
    expect(sale.amountCents).toBe(14_400_000);
    expect(sale.voided).toBe(false);
    // The movement written with it, in the same transaction.
    expect(sale.stockMoveId).toBeTruthy();

    expect((await api.getProduct(productId)).stock).toBe(before - 12);

    const list = await api.listSales({});
    expect(list.items.map((s) => s.id)).toContain(saleId);
    // The total is the server's sum over the LIVE sales, not ours.
    expect(list.totalCents).toBeGreaterThanOrEqual(14_400_000);

    const voided = await api.voidSale(saleId).catch((e) => explain(e, "anular la venta"));
    expect(voided.voided).toBe(true);
    // Flagged AND given back. Flagging alone would leave the coffee sold in
    // one list and gone from the other forever.
    expect((await api.getProduct(productId)).stock).toBe(before);

    // Once. There is no way back from a void: the reversal cannot itself be
    // reversed, so undoing the undo is not something the database can express.
    await expect(api.voidSale(saleId)).rejects.toMatchObject({
      code: "SALE_ALREADY_VOID",
    });
  });

  /**
   * Selling more than there is: refused with a code of its own, and
   * recordable with the override — the same shape as `allowOverpayment`, and
   * for the same reason. A warehouse whose opening balance was never entered
   * is ordinary, and a server that made it impossible to record what actually
   * left the farm would be a server nobody could use.
   */
  it("avisa cuando no hay tanto en bodega, y deja registrarlo de todos modos", async () => {
    const onHand = (await api.getProduct(productId)).stock;

    const refused = await api
      .createSale({
        id: uuidv7(),
        productId,
        warehouseId,
        quantity: onHand + 100,
        amountCents: 1_000_000,
        date: today(),
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe("INSUFFICIENT_STOCK");
    // In Spanish, and saying what to do about it.
    expect((refused as ApiError).spanishMessage).toMatch(/No hay suficiente producto/);

    const anyway = await api
      .createSale({
        id: uuidv7(),
        productId,
        warehouseId,
        quantity: onHand + 100,
        amountCents: 1_000_000,
        date: today(),
        allowNegativeStock: true,
      })
      .catch((e) => explain(e, "registrar la venta con el sobregiro"));
    expect(anyway.quantity).toBe(onHand + 100);
    expect((await api.getProduct(productId)).stock).toBe(-100);
  });

  /**
   * `expense_target`: a un gasto se le carga UNA cosa. Both and neither are
   * the two failures, and both come back as EXPENSE_TARGET_INVALID — one code
   * for one constraint.
   */
  it("carga un gasto a una sola cosa, y rechaza las dos y ninguna", async () => {
    const charged = await api
      .createExpense({
        id: uuidv7(),
        concept: "Fungicida para la roya",
        amountCents: 250_000_00,
        date: today(),
        target: "plot",
        plotId,
      })
      .catch((e) => explain(e, "registrar el gasto"));
    expect(charged.target).toBe("plot");
    expect(charged.plotId).toBe(plotId);
    expect(charged.activityId).toBeNull();

    const toActivity = await api
      .createExpense({
        id: uuidv7(),
        concept: "Combustible de la guadaña",
        amountCents: 180_000_00,
        date: today(),
        target: "activity",
        activityId,
      })
      .catch((e) => explain(e, "registrar el gasto de actividad"));
    expect(toActivity.target).toBe("activity");
    expect(toActivity.plotId).toBeNull();

    // Charged to nothing. The form cannot construct this — `ExpenseInput` is a
    // union — so the body is assembled by hand to prove the server refuses it.
    const neither = await http
      .post("/v1/expenses", {
        id: uuidv7(),
        concept: "Sin imputar",
        amountCents: 1000,
        localDay: `${today()}T00:00:00Z`,
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(neither).toBeInstanceOf(ApiError);
    expect((neither as ApiError).code).toBe("EXPENSE_TARGET_INVALID");

    const both = await http
      .post("/v1/expenses", {
        id: uuidv7(),
        concept: "Imputado dos veces",
        amountCents: 1000,
        localDay: `${today()}T00:00:00Z`,
        activityId,
        plotId,
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(both).toBeInstanceOf(ApiError);
    expect((both as ApiError).code).toBe("EXPENSE_TARGET_INVALID");

    // And the total is the server's, over the live rows.
    const list = await api.listExpenses({});
    expect(list.count).toBe(2);
    expect(list.totalCents).toBe(250_000_00 + 180_000_00);
  });

  /**
   * The other half of "un gasto no es una deuda". RSP-030 and RSP-007 use the
   * same word for the cost of a spraying and for what an employee owes the
   * farm; wiring them together would take money out of somebody's wages every
   * time a bag of fertiliser was recorded.
   */
  it("un gasto no toca el saldo de nadie", async () => {
    const before = (await api.workerBalance(workerId)).balanceCents;
    await api
      .createExpense({
        id: uuidv7(),
        concept: "Arriendo de la despulpadora",
        amountCents: 420_000_00,
        date: today(),
        target: "activity",
        activityId,
      })
      .catch((e) => explain(e, "registrar el gasto"));
    expect((await api.workerBalance(workerId)).balanceCents).toBe(before);
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
