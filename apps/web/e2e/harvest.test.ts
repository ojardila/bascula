/**
 * The harvest module, against the real server.
 *
 * WHY THIS SUITE HAD TO EXIST. `npm test` renders the screens against MSW, so
 * it can only ever confirm that the web agrees with the web's idea of the
 * reports. The Go suite runs against Postgres, so it can only confirm the API
 * agrees with itself. Everything in between — the grids cross-footing, the
 * peak landing on the week a person would point at, the index coming out at
 * the ratio the shares imply, a planted 900 kg weighing being caught once and
 * not five times — is invisible to both.
 *
 * So this builds a SEASON on a real server: six weeks with a deliberate shape
 * (rising, a peak, then two hard falls), four pickers on two lots, two weekly
 * prices, and one weighing planted to trip the review rules. Then it reads it
 * back through the SIX report endpoints the browser calls, and checks that
 * every figure the five screens print is the figure the farm would expect.
 *
 * It also pins the property the whole module rests on: `kg` and `valueCents`
 * are nullable, and the client never turns a null into a zero.
 *
 * The arithmetic is deliberately checkable by hand. Six weeks of 100, 200,
 * 400, 280, 180 and 120 kg is 1.280 kg; at $800 that is $1.024.000.
 *
 * WHEN THE SERVER IS NOT RUNNING this suite skips and says so, exactly like
 * `live-api.test.ts`. It does not pass.
 *
 *     npm run test:e2e
 */
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import {
  reportAnomalies,
  reportCrop,
  reportHarvestCurve,
  reportPerformance,
  reportWeek,
  reportWeeks,
} from "../src/api/harvest";
import { setTokens } from "../src/api/client";
import { invalidateRefs } from "../src/api/refs";
import { uuidv7 } from "../src/lib/uuid";
import { addDays, mondayOf, parseDay } from "../src/lib/dates";
import { kgState, valueState } from "../src/features/harvest/totals";
import { anomalyReason } from "../src/features/harvest/text";

const API_URL = process.env.BASCULA_API_URL ?? "http://localhost:8099";

async function serverIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await serverIsUp();
if (!up) {
  console.error(
    `\nPRUEBA DE COSECHA OMITIDA: no hay API en ${API_URL}.\n` +
      `NO pasó — se saltó. Levántela con: cd services/api && make up && make migrate && make dev\n`,
  );
}

const suite = up ? describe : (describe.skip.bind(null) as unknown as typeof describe);
const suiteName = up
  ? "la cosecha contra la API real"
  : `la cosecha contra la API real — OMITIDA, no hay servidor en ${API_URL}`;

/** $800 a kilo for the early weeks, $900 once the season peaks. */
const EARLY_PRICE = 80_000;
const LATE_PRICE = 90_000;

const uniqueEmail = () => `cosecha-${Date.now()}-${Math.floor(Math.random() * 1e4)}@bascula.test`;

function explain(e: unknown, step: string): never {
  if (e instanceof ApiError) {
    throw new Error(`${step}: HTTP ${e.status} ${e.code} — ${e.message}`);
  }
  throw e;
}

/**
 * The season, as a table anybody can check.
 *
 * Weeks are counted BACK from the last finished week, so the shape is always
 * in the past and the running week never distorts it. Each week names what
 * each of the four pickers weighed on each of its two working days.
 *
 * The weekly totals come out 100, 200, 400, 280, 180, 120 — a rise, a peak in
 * week 3, then a 30 % and a 36 % fall, which is two consecutive drops over the
 * 25 % threshold and therefore a season the module must call "winding down".
 */
const SEASON: number[] = [100, 200, 400, 280, 180, 120];

/** How the week's kilos are split between the four pickers. Sums to 1. */
const SHARES = [0.4, 0.25, 0.2, 0.15];

suite(suiteName, () => {
  const email = uniqueEmail();
  const password = "una-clave-larga-de-verdad";

  const workerIds: string[] = [];
  let plotA = "";
  let plotB = "";
  let cropA = "";
  let cropB = "";
  let activityId = "";

  /** Monday of the last FINISHED week: the season ends there. */
  const lastFinishedMonday = addDays(parseDay(mondayOf(new Date().toISOString().slice(0, 10))), -7)
    .toISOString()
    .slice(0, 10);

  const mondayOfWeek = (i: number) =>
    addDays(parseDay(lastFinishedMonday), -7 * (SEASON.length - 1 - i)).toISOString().slice(0, 10);

  beforeAll(() => {
    setTokens(null);
    invalidateRefs();
  });

  it("abre una finca con dos lotes, cuatro recolectores y una actividad al precio de la semana", async () => {
    const res = await api
      .signup({
        farm: {
          name: `Finca Cosecha ${Date.now()}`,
          timezone: "America/Bogota",
          currency: "COP",
          priceCents: EARLY_PRICE,
        },
        owner: { email, name: "Dueña Cosecha", password },
      })
      .catch((e) => explain(e, "registrar la finca"));
    await api.verifyEmail(res.verificationToken!).catch((e) => explain(e, "confirmar el correo"));
    await api.login({ email, password }).catch((e) => explain(e, "entrar"));

    const cropType = await api.createCropType("Café").catch((e) => explain(e, "tipo de cultivo"));

    for (const [name, ref] of [
      ["La Cuchilla", "A"],
      ["El Guamo", "B"],
    ] as const) {
      const plot = await api
        .createPlot({
          id: uuidv7(),
          name: `${name} ${Date.now()}`,
          department: "Huila",
          municipality: "Pitalito",
          areaHa: 2,
          crops: [{ id: uuidv7(), cropTypeId: cropType.id, varietyId: null, areaHa: 2, plantedAt: null }],
        })
        .catch((e) => explain(e, `crear el lote ${name}`));
      if (ref === "A") {
        plotA = plot.id;
        cropA = plot.crops[0].id;
      } else {
        plotB = plot.id;
        cropB = plot.crops[0].id;
      }
    }

    for (const name of ["Ana", "Beto", "Carmen", "Diego"]) {
      const w = await api
        .createWorker({
          id: uuidv7(),
          name,
          lastName: "Pérez",
          documentType: "CC",
          documentNumber: `${Date.now()}${workerIds.length}`.slice(-10),
          phone: "3001234567",
        })
        .catch((e) => explain(e, `contratar a ${name}`));
      workerIds.push(w.id);
    }

    // THE activity: paid per work unit, priced by the week. That pair is the
    // server's own definition of the harvest (`store.HarvestActivityID`), and
    // it is what makes every record below land in this module.
    const activity = await api
      .createActivity({
        id: uuidv7(),
        name: "Recolección",
        category: "cosecha",
        payMode: "work_unit",
        workUnit: "kg",
        rateSource: "weekly_price",
        validFrom: "2020-01-01",
      })
      .catch((e) => explain(e, "crear la actividad de recolección"));
    activityId = activity.id;

    expect(activity.payMode).toBe("work_unit");
    expect(activity.rateSource).toBe("weekly_price");
    expect(workerIds).toHaveLength(4);
    expect(plotA).toBeTruthy();
    expect(plotB).toBeTruthy();
  }, 60_000);

  it("pone precio a cada semana de la temporada", async () => {
    for (let i = 0; i < SEASON.length; i++) {
      const monday = mondayOfWeek(i);
      // The price rises once the season peaks, which is what a farm does when
      // the trees are loaded and pickers are scarce.
      const price = i >= 3 ? LATE_PRICE : EARLY_PRICE;
      const set = await api.setWeekPrice(monday, price).catch((e) => explain(e, `precio de ${monday}`));
      expect(set.costPerUnitCents).toBe(price);
    }
  }, 60_000);

  it("registra la temporada: seis semanas, dos lotes, cuatro recolectores", async () => {
    for (let i = 0; i < SEASON.length; i++) {
      const monday = mondayOfWeek(i);
      // Two working days a week, Monday and Wednesday, so the week detail has
      // a real employee x day table to build.
      for (const [dayOffset, dayShare] of [
        [0, 0.6],
        [2, 0.4],
      ] as const) {
        const day = addDays(parseDay(monday), dayOffset).toISOString().slice(0, 10);
        // Everybody on lot A on Monday and lot B on Wednesday, so that the
        // yield index has three or more people on the same lot the same day —
        // without which nobody would get an index at all.
        const plotId = dayOffset === 0 ? plotA : plotB;
        const cropId = dayOffset === 0 ? cropA : cropB;

        for (let w = 0; w < workerIds.length; w++) {
          const quantity = Math.round(SEASON[i] * dayShare * SHARES[w] * 10) / 10;
          if (quantity <= 0) continue;
          await api
            .createWorkRecord({
              id: uuidv7(),
              workerId: workerIds[w],
              activityId,
              plotIds: [plotId],
              plotCropIds: [cropId],
              dateFrom: day,
              dateTo: day,
              quantity,
            })
            .catch((e) => explain(e, `labor de la semana ${monday}`));
        }
      }
    }
    expect(true).toBe(true);
  }, 180_000);

  /* ---------------------------------------------------------------- */

  it("lista las semanas con sus kilos, su valor y el precio de cada una", async () => {
    const res = await reportWeeks({ limit: 12 });
    expect(res.scope).toBe("harvest");

    // Newest first, as the contract says.
    const mine = res.items.filter((w) => w.weekStart >= mondayOfWeek(0));
    expect(mine.map((w) => w.weekStart)).toEqual(
      SEASON.map((_, i) => mondayOfWeek(i)).reverse(),
    );

    // The shape this suite planted, read back off the server.
    for (let i = 0; i < SEASON.length; i++) {
      const w = mine.find((x) => x.weekStart === mondayOfWeek(i))!;
      expect(w.kg).toBeCloseTo(SEASON[i], 1);
      expect(w.pickers).toBe(4);
      expect(w.days).toBe(2);
      expect(w.finished).toBe(true);
      expect(w.priceCents).toBe(i >= 3 ? LATE_PRICE : EARLY_PRICE);
      // Nothing has been settled, so every peso here can still move.
      expect(w.valueIsEstimate).toBe(true);
      // Everything converts to kilos and everything could be priced.
      expect(w.recordsNotInKg).toBe(0);
      expect(w.recordsWithoutValue).toBe(0);
      expect(valueState(w).kind).toBe("estimate");
      expect(kgState(w).kind).toBe("known");
      // Each week priced at its own price, by the server.
      expect(w.valueCents).toBeCloseTo(SEASON[i] * (i >= 3 ? LATE_PRICE : EARLY_PRICE), -3);
    }
  }, 60_000);

  it("lee la curva: el pico y el fin de temporada", async () => {
    const curve = await reportHarvestCurve({ weeks: 12 });
    expect(curve.scope).toBe("harvest");
    expect(curve.plotCropId).toBeNull();

    // 400 is the peak; 400 -> 280 is 30 % and 280 -> 180 is 36 %, so two
    // consecutive falls past the 25 % threshold, and the peak is behind us.
    expect(curve.shape.peak?.weekStart).toBe(mondayOfWeek(2));
    expect(curve.shape.peak?.kg).toBeCloseTo(400, 1);
    expect(curve.shape.fallingWeeks).toBeGreaterThanOrEqual(2);
    expect(curve.shape.windingDown).toBe(true);
    // No week had unknown kilos, so the reading was taken over a complete
    // series — which is the only condition under which it means anything.
    expect(curve.weeksWithoutKilos).toBe(0);
  }, 60_000);

  it("cuadra la semana por filas y por columnas, en las dos rejillas", async () => {
    const detail = await reportWeek(mondayOfWeek(2));
    expect(detail.weekStart).toBe(mondayOfWeek(2));
    expect(detail.finished).toBe(true);
    expect(detail.total.kg).toBeCloseTo(400, 1);

    // Two grids over the same weighings: they have to agree with each other.
    expect(detail.byDay.total.kg).toBeCloseTo(detail.byCrop.total.kg!, 6);

    for (const grid of [detail.byDay, detail.byCrop]) {
      const rows = grid.rows.reduce((s, r) => s + (r.total.kg ?? 0), 0);
      const cols = grid.columns.reduce((s, c) => s + (c.total.kg ?? 0), 0);
      expect(rows).toBeCloseTo(grid.total.kg!, 6);
      expect(cols).toBeCloseTo(grid.total.kg!, 6);
      expect(grid.rows).toHaveLength(4);
      // And every row's own cells add to its total.
      for (const r of grid.rows) {
        const cells = r.cells.reduce((s, c) => s + (c.kg ?? 0), 0);
        expect(cells).toBeCloseTo(r.total.kg!, 6);
      }
    }

    // Two working days, and two crops — one per day, by construction.
    expect(detail.byDay.columns).toHaveLength(2);
    expect(detail.byCrop.columns).toHaveLength(2);
    // Every weighing named exactly one crop, so there is no unattributed
    // column at all.
    expect(detail.byCrop.columns.every((c) => c.key !== null)).toBe(true);
    expect(detail.byCrop.unattributed).toBeUndefined();
  }, 60_000);

  it("responde 200 y dos rejillas vacías para una semana que nadie trabajó", async () => {
    // A Monday well before the season. "Nobody picked that week" is a true
    // answer, not a 404.
    const quiet = addDays(parseDay(mondayOfWeek(0)), -70).toISOString().slice(0, 10);
    const detail = await reportWeek(quiet);
    expect(detail.byDay.rows).toEqual([]);
    expect(detail.byCrop.rows).toEqual([]);
    // And the total is NOT a zero pretending to be a sum.
    expect(kgState(detail.total).kind).toBe("unknown");
    expect(detail.total.records).toBe(0);
  }, 60_000);

  it("separa los dos cultivos y da el área y los kg por hectárea de cada uno", async () => {
    const a = await reportCrop(cropA, 12);
    const b = await reportCrop(cropB, 12);

    expect(a.scope).toBe("harvest");
    expect(a.plotCropId).toBe(cropA);
    expect(a.label).toContain("La Cuchilla");
    expect(b.label).toContain("El Guamo");

    // Monday is 60 % of each week and Wednesday 40 %, so lot A leads.
    expect(a.kg).toBeGreaterThan(b.kg!);
    expect(a.kg! + b.kg!).toBeCloseTo(
      SEASON.reduce((x, y) => x + y, 0),
      0,
    );
    expect(a.pickers).toBe(4);
    expect(a.byWeek).toHaveLength(SEASON.length);
    // 2 ha declared on the crop itself, so kg/ha is answerable.
    expect(a.areaHa).toBe(2);
    expect(a.kgPerHa).toBeCloseTo(a.kg! / 2, 3);
    // No weighing names two crops, so nothing is double-counted.
    expect(a.sharedRecords).toBe(0);
  }, 60_000);

  it("da índice a los cuatro y deja a cada uno fuera de su propia referencia", async () => {
    const perf = await reportPerformance(120);
    expect(perf.scope).toBe("harvest");

    const mine = perf.items.filter((r) => r.name.endsWith("Pérez"));
    expect(mine).toHaveLength(4);
    expect(mine.every((r) => r.index !== null)).toBe(true);

    const ana = mine.find((r) => r.name.startsWith("Ana"))!;
    const diego = mine.find((r) => r.name.startsWith("Diego"))!;

    // Ana takes 40 % of every day and Diego 15 %. Against the MATES' mean —
    // which excludes the person themselves — that is 0.4/0.2 = 2.0 and
    // 0.15/(0.85/3) ≈ 0.53. Were the person counted in their own benchmark,
    // Ana would read 1.6 and everybody would be dragged toward 1.0.
    expect(ana.index).toBeCloseTo(2.0, 1);
    expect(diego.index).toBeCloseTo(0.53, 1);
    expect(ana.comparableDays).toBeGreaterThanOrEqual(perf.minComparableDays);

    // The list never interleaves: everybody with an index comes first.
    const firstWithout = perf.items.findIndex((r) => r.index === null);
    if (firstWithout >= 0) {
      expect(perf.items.slice(firstWithout).every((r) => r.index === null)).toBe(true);
    }
  }, 60_000);

  it("no ve anomalías en una temporada limpia, y sí en una pesada absurda", async () => {
    const clean = await reportAnomalies({ days: 120 });
    expect(clean.scope).toBe("harvest");
    expect(clean.items).toEqual([]);

    // 900 kg in one day: above any human ceiling AND far above both this
    // person's usual load and the rest of the crew's that day. Reported ONCE,
    // under the rule we are surest of.
    const day = mondayOfWeek(SEASON.length - 1);
    await api
      .createWorkRecord({
        id: uuidv7(),
        workerId: workerIds[1],
        activityId,
        plotIds: [plotA],
        plotCropIds: [cropA],
        dateFrom: day,
        dateTo: day,
        quantity: 900,
      })
      .catch((e) => explain(e, "registrar la pesada absurda"));

    const dirty = await reportAnomalies({ days: 120 });
    expect(dirty.items).toHaveLength(1);
    const found = dirty.items[0];
    expect(found.rule).toBe("impossible");
    expect(found.quantity).toBe(900);
    expect(found.worker).toContain("Beto");
    expect(found.reference).toBe(dirty.maxKg);

    // And the sentence a farm reads carries the numbers, not the rule name.
    const sentence = anomalyReason(found);
    expect(sentence).toMatch(/900/);
    expect(sentence).not.toMatch(/impossible/);
  }, 90_000);

  it("nunca convierte un nulo en un cero", async () => {
    // The one property the whole module rests on, checked on real payloads:
    // wherever the server declined to establish a figure, the client's own
    // readers say "unknown" rather than handing back 0.
    const res = await reportWeeks({ limit: 52 });
    for (const w of res.items) {
      if (w.kg === null) expect(kgState(w).kind).toBe("unknown");
      if (w.valueCents === null) expect(valueState(w).kind).toBe("unknown");
    }
    const empty = { records: 0, kg: null, recordsNotInKg: 0, valueCents: null,
      recordsWithoutValue: 0, valueIsEstimate: false };
    expect(kgState(empty).kind).toBe("unknown");
    expect(valueState(empty).kind).toBe("unknown");
  }, 60_000);
});
