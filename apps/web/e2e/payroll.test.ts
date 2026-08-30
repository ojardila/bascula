/**
 * LA NÓMINA DE CUADRILLA, CONTRA EL SERVIDOR DE VERDAD.
 *
 * `CrewPayrollPage.test.tsx` la prueba contra MSW, que sólo puede confirmar que
 * la web está de acuerdo con la idea que la web tiene de la API. Esto la corre
 * contra Go y Postgres, y por un motivo que no es de estilo: **la guarda de la
 * carrera para un grupo se apoya en que `/v1/workers/{id}/payables` vuelva a
 * valorar una pesada `weekly_price` al precio que la semana tiene AHORA**. Si
 * el servidor real no lo hiciera —si congelara el precio en el registro— la
 * comprobación previa jamás vería un cambio de precio, la pantalla diría que
 * todo está en orden y la única guarda que quedaría sería el 409 del servidor,
 * persona a persona, en mitad de la corrida. El simulacro no puede
 * desmentirlo; esto sí.
 *
 * El camino, que es el sábado entero:
 *
 *     tres jornaleros, dos al precio de la semana y uno a precio fijo
 *     -> mirar la cuadrilla y aprobar el bruto
 *     -> el dueño sube el precio de la semana desde el teléfono
 *     -> la comprobación previa lo ve, dice DE QUIÉN, y no se liquida a nadie
 *     -> volver a mirar, liquidar a los tres
 *     -> alguien entrega un anticipo en el lote
 *     -> la comprobación previa del pago lo ve, y no se paga a nadie
 *     -> volver a mirar, pagar a los tres
 *     -> deshacer la nómina entera y comprobar que el trabajo vuelve a estar
 *        pendiente y el libro cuadra en cero
 *
 * CUANDO NO HAY SERVIDOR esta prueba se salta y lo dice. No pasa.
 *
 *     npm run test:e2e
 */
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { sentenceFor, type Formatters } from "../src/api/grossChange";
import { setTokens } from "../src/api/client";
import { invalidateRefs } from "../src/api/refs";
import { formatDayLong, mondayOf } from "../src/lib/dates";
import { formatMoney } from "../src/lib/money";
import { uuidv7 } from "../src/lib/uuid";
import type { MintId } from "../src/lib/writeOnce";
import {
  balanceCentsOf, checkPassed, checkPayRun, checkSettleRun, isComplete, loadCrew,
  payApprovalOf, payCheckPassed, payrollRowsOf, payrollScopeOf, runPayments,
  runSettlements, settleApprovalOf, undoRun,
  type CrewMember, type PayApproval, type SettleApproval,
} from "../src/features/payroll/crew";

const API_URL = process.env.BASCULA_API_URL ?? "http://localhost:8099";
const FMT: Formatters = { money: formatMoney, week: formatDayLong };

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
    `\nPRUEBA DE NÓMINA OMITIDA: no hay API en ${API_URL}.\n` +
      `NO pasó — se saltó. Levántela con: cd services/api && make up && make migrate && make dev\n`,
  );
}

const suite = up ? describe : (describe.skip.bind(null) as unknown as typeof describe);
const suiteName = up
  ? "la nómina de cuadrilla contra la API real"
  : `la nómina de cuadrilla contra la API real — OMITIDA, no hay servidor en ${API_URL}`;

/** $800 el kilo, y $840 cuando el dueño sube la semana. */
const PRICE = 80_000;
const RAISED = 84_000;
/** El jornal de la poda, a precio fijo: no se mueve cuando la semana sí. */
const PRUNING = 500_000;

const uniqueEmail = () => `nomina-${Date.now()}-${Math.floor(Math.random() * 1e4)}@bascula.test`;

function explain(e: unknown, step: string): never {
  if (e instanceof ApiError) {
    throw new Error(
      `${step}: HTTP ${e.status} ${e.code} — ${e.message}\ndetalles: ${JSON.stringify(e.details)}`,
    );
  }
  throw e;
}

/**
 * Un `mint` estable para toda la suite, que es lo que `useWriteOnce` da en el
 * navegador: el mismo hueco devuelve el mismo id siempre, así que un reintento
 * es un reintento y no una segunda escritura.
 */
function stableMint(): MintId {
  const ids = new Map<string, string>();
  return (slot = "") => {
    let id = ids.get(slot);
    if (id === undefined) {
      id = uuidv7();
      ids.set(slot, id);
    }
    return id;
  };
}

const byName = (crew: CrewMember[], name: string) =>
  crew.find((m) => m.worker.name === name)!;

suite(suiteName, () => {
  const email = uniqueEmail();
  const password = "una-clave-larga-de-verdad";
  const today = new Date().toISOString().slice(0, 10);
  const monday = mondayOf(today);

  const workerIds = new Map<string, string>();
  let plotId = "";
  let pickingId = "";
  let pruningId = "";

  beforeAll(() => {
    setTokens(null);
    invalidateRefs();
  });

  it("abre una finca con una cuadrilla de tres y dos actividades", async () => {
    const res = await api
      .signup({
        farm: {
          name: `Finca Nómina ${Date.now()}`,
          timezone: "America/Bogota",
          currency: "COP",
          priceCents: PRICE,
        },
        owner: { email, name: "Dueño Nómina", password },
      })
      .catch((e) => explain(e, "registrar la finca"));
    await api.verifyEmail(res.verificationToken!).catch((e) => explain(e, "confirmar el correo"));
    await api.login({ email, password }).catch((e) => explain(e, "entrar"));

    const cropType = await api.createCropType("Café").catch((e) => explain(e, "tipo de cultivo"));
    const plot = await api
      .createPlot({
        id: uuidv7(),
        name: `La Cuchilla ${Date.now()}`,
        department: "Huila",
        municipality: "Pitalito",
        areaHa: 2,
        crops: [
          { id: uuidv7(), cropTypeId: cropType.id, varietyId: null, areaHa: 2, plantedAt: null },
        ],
      })
      .catch((e) => explain(e, "crear el lote"));
    plotId = plot.id;

    for (const name of ["Rosa", "Aníbal", "Teresa"]) {
      const w = await api
        .createWorker({
          id: uuidv7(),
          name,
          lastName: "Quintero",
          documentType: "CC",
          documentNumber: `${Date.now()}${workerIds.size}`.slice(-10),
          phone: "3001234567",
        })
        .catch((e) => explain(e, `contratar a ${name}`));
      workerIds.set(name, w.id);
    }

    // La recolección va al precio de la semana: es la que se puede mover bajo
    // una pantalla abierta, y es la razón de ser de esta prueba.
    pickingId = (
      await api
        .createActivity({
          id: uuidv7(),
          name: "Recolección",
          category: "cosecha",
          payMode: "work_unit",
          workUnit: "kg",
          rateSource: "weekly_price",
          validFrom: "2020-01-01",
        })
        .catch((e) => explain(e, "crear la recolección"))
    ).id;

    // La poda lleva su precio congelado en el registro. Si la comprobación
    // previa marcara también a Teresa cuando sube el kilo, estaría gritando de
    // más — y una guarda que grita de más se ignora.
    pruningId = (
      await api
        .createActivity({
          id: uuidv7(),
          name: "Poda",
          category: "mantenimiento",
          payMode: "time_unit",
          rateSource: "fixed",
          defaultRateCents: PRUNING,
          validFrom: "2020-01-01",
        })
        .catch((e) => explain(e, "crear la poda"))
    ).id;

    await api.setWeekPrice(monday, PRICE).catch((e) => explain(e, "precio de la semana"));
    expect(workerIds.size).toBe(3);
  }, 60_000);

  it("registra la semana de la cuadrilla", async () => {
    const record = (worker: string, activityId: string, quantity: number) =>
      api
        .createWorkRecord({
          id: uuidv7(),
          workerId: workerIds.get(worker)!,
          activityId,
          plotIds: [plotId],
          plotCropIds: [],
          dateFrom: today,
          dateTo: today,
          quantity,
        })
        .catch((e) => explain(e, `registrar la labor de ${worker}`));

    await record("Rosa", pickingId, 38.5);
    await record("Aníbal", pickingId, 25);
    await record("Teresa", pruningId, 2);

    const crew = await loadCrew();
    // 38,5 x $800 = $30.800 · 25 x $800 = $20.000 · 2 jornales x $5.000 = $10.000
    expect(settleApprovalOf(byName(crew, "Rosa"))!.grossCents).toBe(3_080_000);
    expect(settleApprovalOf(byName(crew, "Aníbal"))!.grossCents).toBe(2_000_000);
    expect(settleApprovalOf(byName(crew, "Teresa"))!.grossCents).toBe(1_000_000);
    // Nadie tiene saldo todavía: el trabajo no es deuda hasta que se liquida.
    for (const name of ["Rosa", "Aníbal", "Teresa"]) {
      expect(balanceCentsOf(byName(crew, name))).toBe(0);
    }
  }, 60_000);

  /**
   * EL MOTIVO POR EL QUE ESTA SUITE EXISTE. El dueño sube el precio de la
   * semana mientras la pantalla está abierta, y la comprobación previa —que no
   * escribe nada— tiene que verlo. Contra el simulacro esto pasa por
   * construcción; contra Postgres sólo pasa si el servidor de verdad vuelve a
   * valorar lo pendiente al precio de ahora.
   */
  it("si el bruto de uno cambió, la comprobación previa lo ve y dice de quién", async () => {
    const crew = await loadCrew();
    const approvals = crew
      .map(settleApprovalOf)
      .filter((a): a is SettleApproval => a !== null);
    expect(approvals).toHaveLength(3);

    // Limpio antes de que nada se mueva.
    expect(checkPassed(await checkSettleRun(approvals))).toBe(true);

    // …y ahora el dueño sube la semana de $800 a $840, desde el teléfono.
    await api.setWeekPrice(monday, RAISED).catch((e) => explain(e, "subir el precio"));

    const check = await checkSettleRun(approvals);
    expect(checkPassed(check)).toBe(false);
    expect(check.unreadable).toHaveLength(0);

    // DOS de tres, y son los dos que van al precio de la semana. Teresa lleva
    // su jornal congelado y no aparece.
    expect(check.drifts.map((d) => d.name).sort()).toEqual([
      "Aníbal Quintero",
      "Rosa Quintero",
    ]);

    const rosa = check.drifts.find((d) => d.name === "Rosa Quintero")!;
    expect(rosa.beforeCents).toBe(3_080_000);
    // 38,5 x $840 = $32.340, redondeado por el servidor y no por nosotros.
    expect(rosa.afterCents).toBe(3_234_000);
    expect(sentenceFor(rosa, FMT)).toContain(
      `el precio de la semana del ${formatDayLong(monday)} pasó de $800 a $840`,
    );

    // Y nada escrito: la comprobación es una lectura, y por eso «no se liquida
    // a nadie» puede ser verdad y no una intención.
    expect((await api.listSettlements()).items).toHaveLength(0);
  }, 60_000);

  it("después de volver a mirar, liquida a la cuadrilla entera", async () => {
    const crew = await loadCrew();
    const approvals = crew
      .map(settleApprovalOf)
      .filter((a): a is SettleApproval => a !== null);

    expect(checkPassed(await checkSettleRun(approvals))).toBe(true);

    const rows = await runSettlements(approvals, stableMint(), "Nómina de cuadrilla e2e");
    expect(isComplete(rows)).toBe(true);
    expect(rows.every((r) => r.settlementId !== null)).toBe(true);

    // $32.340 + $21.000 + $10.000 = $63.340, todo al precio nuevo.
    const settled = rows.reduce((a, r) => a + (r.grossCents ?? 0), 0);
    expect(settled).toBe(6_334_000);

    const after = await loadCrew();
    expect(balanceCentsOf(byName(after, "Rosa"))).toBe(3_234_000);
    expect(balanceCentsOf(byName(after, "Aníbal"))).toBe(2_100_000);
    expect(balanceCentsOf(byName(after, "Teresa"))).toBe(1_000_000);
    // Y ya no queda nada pendiente: liquidar es lo que reclama las labores.
    expect(settleApprovalOf(byName(after, "Rosa"))).toBeNull();
  }, 60_000);

  /** La misma guarda sobre el otro número, que es el único que puede moverse ya. */
  it("si el saldo de uno cambió, no se paga a nadie", async () => {
    const crew = await loadCrew();
    const approvals = crew.map(payApprovalOf).filter((a): a is PayApproval => a !== null);
    expect(approvals).toHaveLength(3);
    expect(payCheckPassed(await checkPayRun(approvals))).toBe(true);

    // Alguien le entrega $5.000 de anticipo a Aníbal en el lote.
    await api
      .createAdvance({
        id: uuidv7(),
        workerId: workerIds.get("Aníbal")!,
        amountCents: 500_000,
        method: "efectivo",
        note: "Anticipo en el lote",
      })
      .catch((e) => explain(e, "anticipo"));

    const check = await checkPayRun(approvals);
    expect(payCheckPassed(check)).toBe(false);
    expect(check.drifts).toHaveLength(1);
    expect(check.drifts[0].name).toBe("Aníbal Quintero");
    expect(check.drifts[0].beforeCents).toBe(2_100_000);
    expect(check.drifts[0].afterCents).toBe(1_600_000);
    expect(check.drifts[0].deltaCents).toBe(-500_000);
  }, 60_000);

  it("y con la cifra nueva paga a los tres, al centavo", async () => {
    const crew = await loadCrew();
    const approvals = crew.map(payApprovalOf).filter((a): a is PayApproval => a !== null);
    expect(payCheckPassed(await checkPayRun(approvals))).toBe(true);

    const rows = await runPayments(approvals, "efectivo", stableMint(), "Nómina e2e");
    expect(isComplete(rows)).toBe(true);
    // $32.340 + $16.000 + $10.000: el anticipo de Aníbal ya está descontado,
    // porque el saldo lo trae descontado y aquí no se resta nada dos veces.
    expect(rows.reduce((a, r) => a + (r.paidCents ?? 0), 0)).toBe(5_834_000);
    // Todo el mundo a paz y salvo, según el libro del servidor.
    expect(rows.every((r) => r.balanceAfterCents === 0)).toBe(true);

    const after = await loadCrew();
    for (const name of ["Rosa", "Aníbal", "Teresa"]) {
      expect(balanceCentsOf(byName(after, name))).toBe(0);
      expect(payApprovalOf(byName(after, name))).toBeNull();
    }

    // Y la planilla que se firma sale de esas cifras ya escritas: una línea por
    // persona, con lo entregado y el saldo que queda.
    const run = {
      step: "pay" as const,
      rows,
      scope: { filters: [], crewSize: 3, crewTotalCents: 5_834_000 },
      method: "efectivo" as const,
      at: new Date().toISOString(),
      complete: true,
      unitLabel: "kg",
    };
    expect(payrollRowsOf(run)).toHaveLength(3);
    expect(payrollScopeOf(run).filters).toEqual([]);
  }, 60_000);

  /**
   * Deshacer una nómina mal lanzada. Es lo que el teléfono tenía y la web no, y
   * lo que hay que poder hacer un sábado a las cinco: reversar los pagos,
   * anular las liquidaciones, y que el trabajo vuelva a estar pendiente para
   * volverlo a hacer bien.
   */
  it("deshace la nómina entera y devuelve el trabajo a pendiente", async () => {
    // El asa que la pantalla habría acumulado en sus dos corridas.
    const settlements = (await api.listSettlements()).items.map((s) => s.id);
    const payments: string[] = [];
    for (const id of workerIds.values()) {
      const ledger = await api.workerLedger(id);
      payments.push(...ledger.filter((e) => e.kind === "pago").map((e) => e.id));
    }
    expect(settlements).toHaveLength(3);
    expect(payments).toHaveLength(3);

    const result = await undoRun(
      { payments, settlements },
      "Nómina deshecha en la prueba",
      stableMint(),
    );
    expect(result.failures).toEqual([]);
    expect(result.paymentsReversed).toBe(3);
    expect(result.settlementsVoided).toBe(3);

    // Nada borrado: las liquidaciones quedan anuladas, no ausentes.
    const listed = await api.listSettlements();
    expect(listed.items).toHaveLength(3);
    expect(listed.items.every((s) => s.status === "void")).toBe(true);

    // Y lo que importa de verdad: anular soltó las labores, así que la semana
    // se puede volver a liquidar. Un deshacer que dejara el trabajo reclamado
    // sería un deshacer que no deja rehacer.
    const crew = await loadCrew();
    expect(settleApprovalOf(byName(crew, "Rosa"))!.grossCents).toBe(3_234_000);
    expect(settleApprovalOf(byName(crew, "Teresa"))!.grossCents).toBe(1_000_000);

    // El libro de Aníbal: devengo, anticipo, pago y sus dos reversos. Su saldo
    // vuelve a ser el anticipo que sigue debiendo, en negativo.
    expect(balanceCentsOf(byName(crew, "Aníbal"))).toBe(-500_000);
    expect(balanceCentsOf(byName(crew, "Rosa"))).toBe(0);
  }, 60_000);
});
