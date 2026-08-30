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
 * hand — 38.5 kg and 25 kg at $800, less a $30,000 payment.
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
import { formatDayLong, mondayOf } from "../src/lib/dates";
import { formatMoney } from "../src/lib/money";
import { uuidv7 } from "../src/lib/uuid";
import { areaHaOf, asGeometry, ringProblem, type Geometry } from "../src/lib/geo";

/** How the difference sentence writes figures and dates. */
const FMT: Formatters = { money: formatMoney, week: formatDayLong };

const API_URL = process.env.BASCULA_API_URL ?? "http://localhost:8099";

const HOW_TO_START = `
┌──────────────────────────────────────────────────────────────────────────────
│  END-TO-END TEST SKIPPED: no API at ${API_URL}
│
│  This test did NOT pass. It was skipped because it found no server.
│  To run it, start the API in another terminal:
│
│    cd services/api
│    make up
│    make migrate
│    APP_ENV=development PORT=8099 SIGNUPS_PER_IP_PER_HOUR=100 \\
│      DATABASE_URL="postgres://bascula_api:bascula_api_dev@localhost:5433/bascula?sslmode=disable" \\
│      go run ./cmd/api
│
│  Then run again:   npm run test:e2e
│
│  SIGNUPS_PER_IP_PER_HOUR matters: the default is 5 signups per IP per hour,
│  kept in Postgres, so on the sixth run the test would fail with
│  RATE_LIMITED instead of saying anything useful.
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
  ? "the web app against the real API"
  : `the web app against the real API — SKIPPED, no server at ${API_URL} (start one: cd services/api && make up && make migrate && PORT=8099 SIGNUPS_PER_IP_PER_HOUR=100 go run ./cmd/api)`;

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
        `${step}: the server rate-limited signups per IP (5/hour by default).\n` +
          `Restart the API with SIGNUPS_PER_IP_PER_HOUR=100 and run the test again.`,
      );
    }
    throw new Error(
      `${step}: HTTP ${e.status} ${e.code} — ${e.message}\n` +
        `details: ${JSON.stringify(e.details)}`,
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

  it("registers a farm and hands back the verification token in development", async () => {
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
      .catch((e) => explain(e, "signing the farm up"));

    // Signing up names nobody: the route answers identically whether or not
    // the address already has an account, so that a stranger cannot use it to
    // learn who is registered. The ids arrive at verify-email.
    expect(res.verificationEmailSentTo).toBe(email);
    // In development the server echoes the token because there is no mail
    // sender. If this is null the server is running with APP_ENV set to
    // something else, and the rest of the suite cannot proceed.
    expect(
      res.verificationToken,
      "the server sent no verificationToken: is it running with APP_ENV=development?",
    ).toBeTruthy();

    await api
      .verifyEmail(res.verificationToken!)
      .catch((e) => explain(e, "confirming the email"));
  });

  it("refuses to let you in before confirming, and lets you in after", async () => {
    // The address is already verified by the previous step, so this checks the
    // other half of the pair: a wrong password is INVALID_CREDENTIALS and not
    // something vaguer.
    await expect(
      api.login({ email, password: "una-clave-que-no-es" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    const session = await api
      .login({ email, password })
      .catch((e) => explain(e, "signing in"));

    if ("choose" in session) throw new Error("did not expect a farm to choose from");
    expect(session.user.role).toBe("owner");
    expect(session.user.farm.name).toContain("Finca E2E");
    // 15 minutes. The transparent refresh in client.ts exists because of this
    // number, so it is worth asserting rather than assuming.
    expect(session.expiresIn).toBe(900);
  });

  it("stores the session where a reload will find it", () => {
    // This is the whole mechanism behind "the session survives a page
    // reload": AuthProvider reads these on mount and asks /v1/me. If the
    // tokens are not here, the reload lands on the login screen.
    const stored = localStorage.getItem("bascula.tokens");
    expect(stored, "the session was not stored in localStorage").toBeTruthy();
    expect(JSON.parse(stored!).accessToken).toBe(getTokens()?.accessToken);
  });

  it("hires a worker and opens a plot", async () => {
    const worker = await api
      .createWorker({
        id: uuidv7(),
        name: "Rosa",
        lastName: "Quintero",
        documentType: "CC",
        documentNumber: `10${Date.now() % 100000000}`,
        phone: "3001234567",
      })
      .catch((e) => explain(e, "creating the worker"));
    workerId = worker.id;
    expect(worker.name).toBe("Rosa");
    expect(worker.status).toBe("active");

    const cropType = await api
      .createCropType("Café")
      .catch((e) => explain(e, "creating the crop type"));

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
      .catch((e) => explain(e, "creating the plot"));
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
  it("stores the plot's polygon, measures it and warns about overlaps", async () => {
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
      .catch((e) => explain(e, "storing the polygon"));

    // GeoJSON in, GeoJSON out — and a MultiPolygon out, because ST_Multi
    // promotes on the way into the column. A client that assumes it gets back
    // what it sent draws nothing on the next reload.
    const stored = asGeometry(plot.boundary);
    expect(stored?.type).toBe("MultiPolygon");

    // Both figures, always. The declared 2.5 ha is untouched.
    expect(plot.areaHa).toBe(2.5);
    expect(plot.computedAreaHa).toBeCloseTo(122.506, 2);

    // And the browser's own preview agrees with PostGIS to five figures, which
    // is what keeps the number from jumping when the save lands.
    expect(areaHaOf(drawn)).toBeCloseTo(plot.computedAreaHa!, 2);

    expect(overlaps).toEqual([]);

    // A second plot on top of the first: stored, and reported. A warning,
    // never a refusal — two plots that touch are sometimes one terrace above
    // another on the same coffee slope.
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
      .catch((e) => explain(e, "creating the overlapping plot with its polygon"));

    // The boundary went in with the plot, in one write, and was measured.
    expect(asGeometry(neighbour.boundary)?.type).toBe("MultiPolygon");
    expect(neighbour.computedAreaHa).toBeCloseTo(122.506, 2);

    const again = await api
      .setPlotBoundary(neighbour.id, square(-75.875))
      .catch((e) => explain(e, "rewriting the neighbour's polygon"));
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
  it("rejects a self-crossing polygon, and says so in Spanish", async () => {
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
    const after = await api.getPlot(plotId).catch((e) => explain(e, "re-reading the plot"));
    expect(after.computedAreaHa).toBeCloseTo(122.506, 2);
  });

  it("creates an activity with a fixed price per kilo", async () => {
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
      .catch((e) => explain(e, "creating the activity"));

    activityId = activity.id;
    expect(activity.payMode).toBe("work_unit");
    expect(activity.rateSource).toBe("fixed");
    expect(activity.defaultRateCents).toBe(PRICE_PER_KG);
    // The unit came back as a label, which means the client's join against the
    // work-units catalogue worked — the server sent only a `unitId`.
    expect(activity.workUnit).toBe("kg");
  });

  it("records two pieces of work and prices them", async () => {
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
      .catch((e) => explain(e, "recording the first work record"));

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
      .catch((e) => explain(e, "recording the second work record"));

    recordIds.push(first.id, second.id);

    // 38.5 kg x $800 = $30,800. The same figure the wireframes quote, arrived
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

  it("shows both work records as pending, and nothing in the balance yet", async () => {
    const payables = await api
      .workerPayables(workerId)
      .catch((e) => explain(e, "reading what is pending"));

    expect(payables.workRecords).toHaveLength(2);
    expect(payables.grossCents).toBe(5_080_000);
    // Work that has not been settled is not yet a debt: the ledger is empty.
    expect(payables.balanceCents).toBe(0);
    expect(payables.totalCents).toBe(5_080_000);
  });

  it("settling is what turns work into money owed", async () => {
    const approved = await api.previewSettlement(workerId, recordIds);
    expect(approved.grossCents).toBe(5_080_000);

    const settlement = await api
      .settle(workerId, recordIds, {
        expectedGrossCents: approved.grossCents,
        expectedLines: approved.lines,
      })
      .catch((e) => explain(e, "settling"));

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
  it("lists the settlement, with its period and its lines", async () => {
    const list = await api.listSettlements().catch((e) => explain(e, "listing settlements"));
    // `listSettlements` hands back the list WITH ITS HOLES declared: with no
    // `GET /v1/settlements` it is composed by reading every employee's ledger,
    // and a failed read can no longer be mistaken for a farm that has settled
    // nothing.
    expect(list.unreadableLedgers + list.unreadableSettlements).toBe(0);
    const mine = list.items.filter((s) => s.workerId === workerId);
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

  it("refuses to pay more than is owed", async () => {
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

  it("pays part of it and leaves the exact balance owing", async () => {
    const receipt = await api
      .createPayment({
        id: uuidv7(),
        workerId,
        amountCents: 3_000_000, // $30,000 of the $50,800 owed
        method: "efectivo",
        note: "Abono en efectivo",
      })
      .catch((e) => explain(e, "pagar"));

    expect(receipt.amountCents).toBe(3_000_000);
    expect(receipt.balanceBeforeCents).toBe(5_080_000);
    expect(receipt.balanceAfterCents).toBe(2_080_000);

    // The assertion the whole suite exists for. $50,800 earned, $30,000 paid,
    // $20,800 still owed — summed from the ledger by the server, read back
    // through the app's own client, and checkable on paper.
    const balance = await api.workerBalance(workerId);
    expect(balance.earnedCents).toBe(5_080_000);
    expect(balance.paidCents).toBe(3_000_000);
    expect(balance.balanceCents).toBe(2_080_000);
  });

  it("leaves the movement explained in the history", async () => {
    const ledger = await api
      .workerLedger(workerId)
      .catch((e) => explain(e, "reading the history"));

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

  it("tells the same story from the profile, in one call", async () => {
    const profile = await api
      .workerProfile(workerId)
      .catch((e) => explain(e, "opening the profile"));

    expect(profile.worker.id).toBe(workerId);
    expect(profile.balance.balanceCents).toBe(2_080_000);
    expect(profile.workRecords).toHaveLength(2);
    // Everything was settled, so nothing is pending any more.
    expect(profile.pendingCents).toBe(0);
    expect(profile.workRecords.every((r) => r.settled)).toBe(true);
    // And a work record inside a live settlement cannot be edited out from
    // under the payment.
    await expect(api.deactivateWorkRecord(recordIds[0])).rejects.toMatchObject({
      code: "WORK_RECORD_SETTLED",
    });
  });

  /* ------------------------------------------------------------------ */
  /* The settlement lock                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * ── THE WEEK'S PRICE PER KILO, AGAINST THE REAL SERVER ─────────────────
   *
   * `PUT /v1/prices/weeks/{monday}` had been in the client since sprint 1 and
   * no screen called it, so this test did not exist either: the product's only
   * `PUT` that moves money already written had never been exercised against a
   * Postgres. Now there is a screen that calls it, and what has to be proved
   * against the real API is not that the `PUT` answers 200 — it is the
   * consequence, which is the part that costs money:
   *
   *   setting a week's price RE-PRICES that week's picking that has not been
   *   settled yet, and does NOT touch what has already been settled.
   *
   * It runs on a worker, an activity and a plot of its own, for the same
   * reason as the block below: moving the week's price underneath Rosa would
   * rewrite every figure the comments in this file quote by hand.
   */
  describe("the week's price per kilo", () => {
    let priceWorkerId = "";
    let weeklyActivityId = "";
    let monday = "";

    beforeAll(async () => {
      const worker = await api
        .createWorker({
          id: uuidv7(),
          name: "Aurora",
          lastName: "Cardona",
          documentType: "CC",
          documentNumber: `8${Date.now()}`.slice(0, 10),
          phone: "",
          country: "Colombia",
        })
        .catch((e) => explain(e, "hiring for the price test"));
      priceWorkerId = worker.id;

      // An activity whose price IS SET BY THE WEEK: the only kind of work a
      // weekly price change can move.
      const activity = await api
        .createActivity({
          id: uuidv7(),
          name: `Recolección semanal E2E ${Date.now()}`,
          category: "cosecha",
          payMode: "work_unit",
          workUnit: "kg",
          rateSource: "weekly_price",
          defaultRateCents: null,
          validFrom: "2020-01-01",
        })
        .catch((e) => explain(e, "creating the activity at the week's price"));
      weeklyActivityId = activity.id;
      monday = mondayOf(today());
    });

    it("can be set, which is what no screen knew how to do", async () => {
      const set = await api
        .setWeekPrice(monday, PRICE_PER_KG)
        .catch((e) => explain(e, "setting the week's price"));
      expect(set.costPerUnitCents).toBe(PRICE_PER_KG);

      const read = await api
        .weekPrice(monday)
        .catch((e) => explain(e, "re-reading the week's price"));
      expect(read.costPerUnitCents).toBe(PRICE_PER_KG);
      expect(read.monday).toBe(monday);
    });

    it("and what unsettled picking is worth comes off it", async () => {
      const record = await api
        .createWorkRecord({
          id: uuidv7(),
          workerId: priceWorkerId,
          activityId: weeklyActivityId,
          plotIds: [plotId],
          plotCropIds: [],
          dateFrom: today(),
          dateTo: today(),
          quantity: 50,
        })
        .catch((e) => explain(e, "recording the work at the week's price"));

      // 50 kg x $800. And it is not frozen: it is what it would be worth today.
      expect(record.amountIsEstimate).toBe(true);
      const payables = await api.workerPayables(priceWorkerId);
      expect(payables.grossCents).toBe(4_000_000);
    });

    /**
     * THE CONSEQUENCE. Raising the kilo from $800 to $900 raises what the farm
     * owes whoever picked that week and has not been paid yet — which is
     * exactly what the weekly price is for, and exactly why the screen says so
     * before saving it.
     */
    it("re-prices what has not been settled yet when it goes up", async () => {
      await api.setWeekPrice(monday, 90_000).catch((e) => explain(e, "raising the price"));

      const payables = await api.workerPayables(priceWorkerId);
      // 50 kg x $900.
      expect(payables.grossCents).toBe(4_500_000);
      // And it is still provisional: settling is what fixes it.
      expect(payables.workRecords[0].rateSource).toBe("weekly_price");
    });

    /** And what was ALREADY settled keeps its price: that is the deal settling makes. */
    it("but does not touch what has already been settled", async () => {
      const payables = await api.workerPayables(priceWorkerId);
      const ids = payables.workRecords.map((w) => w.id);
      const approved = await api.previewSettlement(priceWorkerId, ids);
      await api
        .settle(priceWorkerId, ids, {
          expectedGrossCents: approved.grossCents,
          expectedLines: approved.lines,
          id: uuidv7(),
        })
        .catch((e) => explain(e, "settling at the new price"));

      const balanceBefore = await api.workerBalance(priceWorkerId);
      expect(balanceBefore.balanceCents).toBe(4_500_000);

      // The price drops after settling, and the accrual does not move.
      await api.setWeekPrice(monday, 50_000).catch((e) => explain(e, "lowering the price"));
      const balanceAfter = await api.workerBalance(priceWorkerId);
      expect(balanceAfter.balanceCents).toBe(4_500_000);
    });
  });

  /**
   * These two run on a worker of their OWN, hired here, and deliberately after
   * the walk above has finished asserting its by-hand arithmetic. They move
   * work records around to stage a race, and doing that to Rosa would quietly
   * rewrite the figures every comment in this file quotes.
   */
  describe("when the gross moves between looking at it and approving it", () => {
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
        .catch((e) => explain(e, "hiring for the lock test"));
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
          .catch((e) => explain(e, "recording work for the lock test"));
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
    it("keeps a late weigh-in out of what was already approved", async () => {
      const approved = await api
        .previewSettlement(raceWorkerId, raceRecords)
        .catch((e) => explain(e, "previewing"));
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
        .catch((e) => explain(e, "recording the late weigh-in"));

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
    it("refuses to settle a figure other than the one that was approved", async () => {
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

    it("and settles the new figure once it has been approved again", async () => {
      const approved = await api.previewSettlement(raceWorkerId, raceRecords);
      const settlement = await api
        .settle(
          raceWorkerId,
          approved.lines.map((l) => l.id),
          { expectedGrossCents: approved.grossCents, expectedLines: approved.lines },
        )
        .catch((e) => explain(e, "settling the new figure"));
      expect(settlement.grossCents).toBe(approved.grossCents);
      expect((await api.workerBalance(raceWorkerId)).earnedCents).toBe(approved.grossCents);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Inventory, sales and expenses — RSP-018 … RSP-033                   */
  /* ------------------------------------------------------------------ */

  /**
   * The rule the whole inventory module is shaped around, checked against the
   * database that enforces it: STOCK LEVELS ARE DERIVED.
   *
   * `stock_moves` is append-only — a trigger and a REVOKE, the same defence
   * the ledger has — so `product.stock` is a SUM computed on every read. What
   * this walk proves is that the number the screen shows is the number that
   * falls out of the movements, through the real SQL and not through a mock
   * that shares our arithmetic.
   */
  it("derives the stock from the movements, and offers no other way to move it", async () => {
    const warehouse = await api
      .createWarehouse("Bodega principal")
      .catch((e) => explain(e, "creating the warehouse"));
    warehouseId = warehouse.id;

    // Idempotent by lower(name), like every picker in this service: asking
    // twice is one row, which is what makes "write it if it is not there" safe.
    const again = await api.createWarehouse("bodega principal");
    expect(again.id).toBe(warehouseId);

    const product = await api
      .createProduct({
        id: uuidv7(),
        name: `Café pergamino ${Date.now()}`,
        categoryName: "Producto procesado",
        storageUnit: "Bulto",
      })
      .catch((e) => explain(e, "creating the product"));
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
      .catch((e) => explain(e, "recording the harvest movement"));
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
      .catch((e) => explain(e, "recording the loss"));

    const after = await api.getProduct(productId).catch((e) => explain(e, "re-reading the product"));
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
  it("corrects the movement's sign to match the reason instead of refusing it", async () => {
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
      .catch((e) => explain(e, "recording the loss with the sign the wrong way round"));

    expect(move.qty).toBe(-5);
    expect((await api.getProduct(productId)).stock).toBe(before - 5);
  });

  /**
   * The stock guard is on EVERY outgoing movement, not only on a sale. A
   * `consumo` for more than there is comes back 409 with the two numbers, and
   * `allowNegative` records it anyway — the same escape hatch, spelled the way
   * the movement schema spells it.
   */
  it("guards the warehouse on any outgoing movement, not only on a sale", async () => {
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
      .catch((e) => explain(e, "forcing the consumption"));
    expect(forced.move.qty).toBe(-(onHand + 50));
    expect((await api.getProduct(productId)).stock).toBe(-50);

    // And the way back out of an append-only table: its exact opposite, once.
    // This also puts the warehouse where the next case needs it, which is the
    // honest way to do it — there is no DELETE to reach for.
    const undone = await api
      .reverseStockMove(forced.move.id, "Se registró por error")
      .catch((e) => explain(e, "reversing the consumption"));
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
  it("refuses to record a sale through the inventory door", async () => {
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
  it("takes product out of the warehouse on a sale, and puts it back on a void", async () => {
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
      .catch((e) => explain(e, "recording the sale"));
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

    const voided = await api.voidSale(saleId).catch((e) => explain(e, "voiding the sale"));
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
  it("warns when there is not that much in the warehouse, and records it anyway", async () => {
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
      .catch((e) => explain(e, "recording the sale with the overdraft"));
    expect(anyway.quantity).toBe(onHand + 100);
    expect((await api.getProduct(productId)).stock).toBe(-100);
  });

  /**
   * `expense_target`: an expense is charged to ONE thing. Both and neither are
   * the two failures, and both come back as EXPENSE_TARGET_INVALID — one code
   * for one constraint.
   */
  it("charges an expense to one thing, and refuses both or neither", async () => {
    const charged = await api
      .createExpense({
        id: uuidv7(),
        concept: "Fungicida para la roya",
        amountCents: 250_000_00,
        date: today(),
        target: "plot",
        plotId,
      })
      .catch((e) => explain(e, "recording the expense"));
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
      .catch((e) => explain(e, "recording the activity expense"));
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
   * The other half of "an expense is not a debt". RSP-030 and RSP-007 use the
   * same word for the cost of a spraying and for what an employee owes the
   * farm; wiring them together would take money out of somebody's wages every
   * time a bag of fertiliser was recorded.
   */
  it("leaves everybody's balance alone", async () => {
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
      .catch((e) => explain(e, "recording the expense"));
    expect((await api.workerBalance(workerId)).balanceCents).toBe(before);
  });

  /**
   * ── THE DOUBLE CLICK, AGAINST POSTGRES ────────────────────────────────
   *
   * The auditor drove the browser and got two `POST /v1/payments`, both 201,
   * and $20,000 handed over where the foreman had approved $10,000. Two
   * separate things had to be true for that:
   *
   *   1. the second click reached the network at all, because
   *      `disabled={busy}` is React state and both clicks of a double click
   *      land in one task, before any re-render; and
   *   2. the second request carried a DIFFERENT id, because the id was minted
   *      inside the call — so the server, which is idempotent by
   *      `(farm_id, id)`, correctly saw a different payment and wrote it.
   *
   * The unit suite proves the first half at the screen. This proves the second
   * against the real ledger, which is the only place it can be proved: MSW can
   * be made to agree with anything, and `store.AddLedgerEntry`'s
   * `ON CONFLICT (id) DO NOTHING` cannot.
   *
   * Both halves of the comparison are run, deliberately. A test that only
   * showed the fix working would not show that the mechanism is what makes it
   * work.
   */
  describe("two identical requests cannot pay twice", () => {
    it("same id: the second gets the payment that already exists, and the money leaves once", async () => {
      const before = await api.workerBalance(workerId);
      expect(before.balanceCents).toBeGreaterThan(2_000_00);

      // The id the screen mints ONCE, when the figure is approved, and reuses
      // for every attempt at that same approved fact. See lib/writeOnce.ts.
      const id = uuidv7();
      const pay = () =>
        api.createPayment({ id, workerId, amountCents: 1_000_00, method: "efectivo" });

      // Fired without awaiting in between, which is what two clicks in one
      // task look like from the network's point of view.
      const [a, b] = await Promise.all([pay(), pay()]);

      // One payment, one id, one movement in the ledger.
      expect(a.id).toBe(b.id);
      const payments = (await api.workerLedger(workerId)).filter(
        (e) => e.kind === "pago" && e.id === id,
      );
      expect(payments).toHaveLength(1);

      // And the money: $1,000 left the farm, not $2,000.
      const after = await api.workerBalance(workerId);
      expect(before.balanceCents - after.balanceCents).toBe(1_000_00);
    });

    it("different ids: the server writes two payments — which is the bug, not the server", async () => {
      const before = await api.workerBalance(workerId);
      const pay = () =>
        api.createPayment({
          // A FRESH id per attempt, which is exactly what the screen used to
          // do. The server is right to accept both: two ids are two payments.
          id: uuidv7(),
          workerId,
          amountCents: 1_000_00,
          method: "efectivo",
        });

      const [a, b] = await Promise.all([pay(), pay()]);
      expect(a.id).not.toBe(b.id);

      // $2,000 handed over where $1,000 was approved. This is the auditor's
      // finding, reproduced, and it is why the id has to be minted once.
      const after = await api.workerBalance(workerId);
      expect(before.balanceCents - after.balanceCents).toBe(2_000_00);
    });
  });

  it("refreshes the token without anybody noticing", async () => {
    const before = getTokens()!;

    // Corrupt only the ACCESS token. The next call gets a 401, the client
    // rotates the refresh token once, replays the request, and the caller sees
    // a normal answer. This is the path a farm administrator hits every
    // fifteen minutes with the payment screen open.
    setTokens({ accessToken: `${before.accessToken}-roto`, refreshToken: before.refreshToken });

    const me = await api.me().catch((e) => explain(e, "refreshing the session"));
    expect(me.role).toBe("owner");

    const after = getTokens()!;
    expect(after.accessToken).not.toBe(before.accessToken);
    // Refresh tokens are single use: a new one came back with the new access
    // token, and the old one is now dead.
    expect(after.refreshToken).not.toBe(before.refreshToken);
  });

  it("really does log out", async () => {
    await api.logout().catch((e) => explain(e, "logging out"));
    setTokens(null);
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
  });
});
