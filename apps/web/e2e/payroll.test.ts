/**
 * CREW PAYROLL, AGAINST THE REAL SERVER.
 *
 * `CrewPayrollPage.test.tsx` tests it against MSW, which can only confirm that
 * the web app agrees with the web app's own idea of the API. This runs it
 * against Go and Postgres, for a reason that is not stylistic: **the race
 * guard for a group rests on `/v1/workers/{id}/payables` re-pricing a
 * `weekly_price` weigh-in at the price the week has NOW**. If the real server
 * did not do that — if it froze the price into the record — the pre-flight
 * check would never see a price change, the screen would say everything is in
 * order, and the only guard left would be the server's 409, person by person,
 * halfway through the run. The fake server cannot disprove that; this can.
 *
 * The path, which is the whole Saturday:
 *
 *     three hands, two at the week's price and one at a fixed price
 *     -> look at the crew and approve the gross
 *     -> the owner raises the week's price from the phone
 *     -> the pre-flight check sees it, says WHOSE, and nobody is settled
 *     -> look again, settle all three
 *     -> somebody hands out an advance up at the plot
 *     -> the payment pre-flight check sees it, and nobody is paid
 *     -> look again, pay all three
 *     -> undo the whole payroll and check that the work is pending again and
 *        the ledger balances to zero
 *
 * WITH NO SERVER this test skips and says so. It does not pass.
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
    `\nPAYROLL TEST SKIPPED: no API at ${API_URL}.\n` +
      `It did NOT pass — it was skipped. Start one with: cd services/api && make up && make migrate && make dev\n`,
  );
}

const suite = up ? describe : (describe.skip.bind(null) as unknown as typeof describe);
const suiteName = up
  ? "crew payroll against the real API"
  : `crew payroll against the real API — SKIPPED, no server at ${API_URL}`;

/** $800 a kilo, and $840 once the owner raises the week. */
const PRICE = 80_000;
const RAISED = 84_000;
/** A day's pruning, at a fixed price: it does not move when the week does. */
const PRUNING = 500_000;

const uniqueEmail = () => `nomina-${Date.now()}-${Math.floor(Math.random() * 1e4)}@bascula.test`;

function explain(e: unknown, step: string): never {
  if (e instanceof ApiError) {
    throw new Error(
      `${step}: HTTP ${e.status} ${e.code} — ${e.message}\ndetails: ${JSON.stringify(e.details)}`,
    );
  }
  throw e;
}

/**
 * A `mint` that is stable across the whole suite, which is what `useWriteOnce`
 * gives you in the browser: the same slot always hands back the same id, so a
 * retry is a retry and not a second write.
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

  it("opens a farm with a crew of three and two activities", async () => {
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
      .catch((e) => explain(e, "signing the farm up"));
    await api.verifyEmail(res.verificationToken!).catch((e) => explain(e, "confirming the email"));
    await api.login({ email, password }).catch((e) => explain(e, "signing in"));

    const cropType = await api.createCropType("Café").catch((e) => explain(e, "crop type"));
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
      .catch((e) => explain(e, "creating the plot"));
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
        .catch((e) => explain(e, `hiring ${name}`));
      workerIds.set(name, w.id);
    }

    // Picking goes at the week's price: it is the one that can move underneath
    // an open screen, and it is the reason this test exists.
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
        .catch((e) => explain(e, "creating the picking activity"))
    ).id;

    // Pruning carries its price frozen into the record. If the pre-flight
    // check flagged Teresa too when the kilo goes up, it would be crying wolf
    // — and a guard that cries wolf gets ignored.
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
        .catch((e) => explain(e, "creating the pruning activity"))
    ).id;

    await api.setWeekPrice(monday, PRICE).catch((e) => explain(e, "the week's price"));
    expect(workerIds.size).toBe(3);
  }, 60_000);

  it("records the crew's week", async () => {
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
        .catch((e) => explain(e, `recording ${worker}'s work`));

    await record("Rosa", pickingId, 38.5);
    await record("Aníbal", pickingId, 25);
    await record("Teresa", pruningId, 2);

    const crew = await loadCrew();
    // 38.5 x $800 = $30,800 · 25 x $800 = $20,000 · 2 days x $5,000 = $10,000
    expect(settleApprovalOf(byName(crew, "Rosa"))!.grossCents).toBe(3_080_000);
    expect(settleApprovalOf(byName(crew, "Aníbal"))!.grossCents).toBe(2_000_000);
    expect(settleApprovalOf(byName(crew, "Teresa"))!.grossCents).toBe(1_000_000);
    // Nobody has a balance yet: work is not a debt until it is settled.
    for (const name of ["Rosa", "Aníbal", "Teresa"]) {
      expect(balanceCentsOf(byName(crew, name))).toBe(0);
    }
  }, 60_000);

  /**
   * THE REASON THIS SUITE EXISTS. The owner raises the week's price while the
   * screen is open, and the pre-flight check — which writes nothing — has to
   * see it. Against the fake server this passes by construction; against
   * Postgres it only passes if the real server really does re-price what is
   * pending at today's price.
   */
  it("sees a changed gross in the pre-flight check and says whose it is", async () => {
    const crew = await loadCrew();
    const approvals = crew
      .map(settleApprovalOf)
      .filter((a): a is SettleApproval => a !== null);
    expect(approvals).toHaveLength(3);

    // Clean before anything moves.
    expect(checkPassed(await checkSettleRun(approvals))).toBe(true);

    // …and now the owner raises the week from $800 to $840, from the phone.
    await api.setWeekPrice(monday, RAISED).catch((e) => explain(e, "raising the price"));

    const check = await checkSettleRun(approvals);
    expect(checkPassed(check)).toBe(false);
    expect(check.unreadable).toHaveLength(0);

    // TWO of three, and they are the two on the week's price. Teresa's day
    // rate is frozen, so she does not show up.
    expect(check.drifts.map((d) => d.name).sort()).toEqual([
      "Aníbal Quintero",
      "Rosa Quintero",
    ]);

    const rosa = check.drifts.find((d) => d.name === "Rosa Quintero")!;
    expect(rosa.beforeCents).toBe(3_080_000);
    // 38.5 x $840 = $32,340, rounded by the server and not by us.
    expect(rosa.afterCents).toBe(3_234_000);
    expect(sentenceFor(rosa, FMT)).toContain(
      `el precio de la semana del ${formatDayLong(monday)} pasó de $800 a $840`,
    );

    // And nothing written: the check is a read, which is why "nobody gets
    // settled" can be a fact and not an intention.
    expect((await api.listSettlements()).items).toHaveLength(0);
  }, 60_000);

  it("settles the whole crew once it has been looked at again", async () => {
    const crew = await loadCrew();
    const approvals = crew
      .map(settleApprovalOf)
      .filter((a): a is SettleApproval => a !== null);

    expect(checkPassed(await checkSettleRun(approvals))).toBe(true);

    const rows = await runSettlements(approvals, stableMint(), "Nómina de cuadrilla e2e");
    expect(isComplete(rows)).toBe(true);
    expect(rows.every((r) => r.settlementId !== null)).toBe(true);

    // $32,340 + $21,000 + $10,000 = $63,340, all at the new price.
    const settled = rows.reduce((a, r) => a + (r.grossCents ?? 0), 0);
    expect(settled).toBe(6_334_000);

    const after = await loadCrew();
    expect(balanceCentsOf(byName(after, "Rosa"))).toBe(3_234_000);
    expect(balanceCentsOf(byName(after, "Aníbal"))).toBe(2_100_000);
    expect(balanceCentsOf(byName(after, "Teresa"))).toBe(1_000_000);
    // And nothing is pending any more: settling is what claims the work.
    expect(settleApprovalOf(byName(after, "Rosa"))).toBeNull();
  }, 60_000);

  /** The same guard over the other number, the only one that can still move. */
  it("pays nobody when one person's balance has changed", async () => {
    const crew = await loadCrew();
    const approvals = crew.map(payApprovalOf).filter((a): a is PayApproval => a !== null);
    expect(approvals).toHaveLength(3);
    expect(payCheckPassed(await checkPayRun(approvals))).toBe(true);

    // Somebody hands Aníbal a $5,000 advance up at the plot.
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

  it("and pays all three to the cent once the figure is up to date", async () => {
    const crew = await loadCrew();
    const approvals = crew.map(payApprovalOf).filter((a): a is PayApproval => a !== null);
    expect(payCheckPassed(await checkPayRun(approvals))).toBe(true);

    const rows = await runPayments(approvals, "efectivo", stableMint(), "Nómina e2e");
    expect(isComplete(rows)).toBe(true);
    // $32,340 + $16,000 + $10,000: Aníbal's advance is already deducted,
    // because the balance comes in with it deducted and nothing is subtracted
    // twice here.
    expect(rows.reduce((a, r) => a + (r.paidCents ?? 0), 0)).toBe(5_834_000);
    // Everybody square, according to the server's ledger.
    expect(rows.every((r) => r.balanceAfterCents === 0)).toBe(true);

    const after = await loadCrew();
    for (const name of ["Rosa", "Aníbal", "Teresa"]) {
      expect(balanceCentsOf(byName(after, name))).toBe(0);
      expect(payApprovalOf(byName(after, name))).toBeNull();
    }

    // And the payroll sheet people sign comes off those written figures: one
    // line per person, with what was handed over and the balance left.
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
   * Undoing a payroll run that went out wrong. It is what the phone had and
   * the web app did not, and what you have to be able to do at five o'clock on
   * a Saturday: reverse the payments, void the settlements, and get the work
   * back to pending so it can be done again properly.
   */
  it("undoes the whole payroll and puts the work back to pending", async () => {
    // The handle the screen would have accumulated over its two runs.
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

    // Nothing deleted: the settlements end up voided, not absent.
    const listed = await api.listSettlements();
    expect(listed.items).toHaveLength(3);
    expect(listed.items.every((s) => s.status === "void")).toBe(true);

    // And what really matters: voiding released the work, so the week can be
    // settled again. An undo that left the work claimed would be an undo you
    // cannot redo after.
    const crew = await loadCrew();
    expect(settleApprovalOf(byName(crew, "Rosa"))!.grossCents).toBe(3_234_000);
    expect(settleApprovalOf(byName(crew, "Teresa"))!.grossCents).toBe(1_000_000);

    // Aníbal's ledger: devengo, anticipo, pago and their two reversals. His
    // balance goes back to the advance he still owes, in the negative.
    expect(balanceCentsOf(byName(crew, "Aníbal"))).toBe(-500_000);
    expect(balanceCentsOf(byName(crew, "Rosa"))).toBe(0);
  }, 60_000);
});
