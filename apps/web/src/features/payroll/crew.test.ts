/**
 * LA ARITMÉTICA DE LA NÓMINA DE CUADRILLA, sin pantalla.
 *
 * Lo que se prueba aquí es lo que decide si sale plata y cuánta: cuándo una
 * cifra aprobada dejó de ser válida, cuándo NO —que es la mitad que se olvida—
 * y qué confiesa el papel. `CrewPayrollPage.test.tsx` prueba el camino entero
 * contra el servidor simulado; esto prueba las reglas sobre números planos,
 * que es donde se pueden escribir los casos raros sin montar una finca.
 */
import { describe, expect, it } from "vitest";
import { line, sentenceFor } from "../../api/grossChange";
import { ApiError } from "../../api/errors";
import { formatDayLong } from "../../lib/dates";
import { formatMoney } from "../../lib/money";
import {
  driftOf, isComplete, payrollRowsOf, payrollScopeOf, payrollTitleOf, reasonOf,
  runIsPartial, undoHandleOf, undoIsEmpty,
  type PayrollRun, type RunRow, type SettleApproval,
} from "./crew";
import type { PayableLine, Payables, Uuid } from "../../api/types";

const FMT = { money: formatMoney, week: formatDayLong };

/** Lo pendiente de una persona, con el bruto que el servidor devolvería. */
function payables(lines: PayableLine[]): Payables {
  const grossCents = lines.reduce((a, l) => a + l.amountCents, 0);
  return { workRecords: lines, debts: [], grossCents, balanceCents: 0, totalCents: grossCents };
}

function approval(lines: PayableLine[], over: Partial<SettleApproval> = {}): SettleApproval {
  return {
    workerId: "w1" as Uuid,
    name: "María Restrepo",
    documentNumber: "1045882331",
    grossCents: lines.reduce((a, l) => a + l.amountCents, 0),
    quantity: lines.reduce((a, l) => a + l.quantity, 0),
    unitLabel: "kg",
    payableIds: lines.map((l) => l.id),
    lines,
    ...over,
  };
}

/** Una pesada al precio de la semana: la única clase de línea que se re-precia. */
const weighed = (id: string, kg: number, rateCents: number): PayableLine =>
  line(id as Uuid, Math.round(kg * rateCents), {
    quantity: kg,
    rateCents,
    rateSource: "weekly_price",
    unitLabel: "kg",
  });

describe("la guarda de la carrera, persona a persona dentro del grupo", () => {
  it("no dice nada cuando nada se movió", () => {
    const lines = [weighed("a", 38.5, 80_000), weighed("b", 41, 80_000)];
    expect(driftOf(approval(lines), payables(lines))).toBeNull();
  });

  /**
   * El caso que de verdad muerde a esta finca: las pesadas se pagan al precio
   * de la semana, que no está fijado hasta que se liquida. El dueño sube el
   * precio desde el teléfono y los MISMOS ids valen otra cosa, sin que aparezca
   * ni desaparezca una fila.
   */
  it("ve un cambio de precio de la semana y lo nombra", () => {
    const approved = [weighed("a", 38.5, 80_000), weighed("b", 41, 80_000)];
    const now = [weighed("a", 38.5, 84_000), weighed("b", 41, 84_000)];

    const drift = driftOf(approval(approved), payables(now));
    expect(drift).not.toBeNull();
    expect(drift!.beforeCents).toBe(6_360_000);
    expect(drift!.afterCents).toBe(6_678_000);
    expect(drift!.deltaCents).toBe(318_000);
    // La misma frase que la pantalla de una persona, palabra por palabra.
    expect(sentenceFor(drift!, FMT)).toContain(
      "el precio de la semana del 24 de agosto pasó de $800 a $840",
    );
  });

  /**
   * LA MITAD QUE SE OLVIDA. Una pesada tardía NO cambia la cifra que se firma:
   * la liquidación nombra sus `payableIds` y la nueva simplemente no está
   * dentro. Bloquear aquí sería gritar «cambió» cada sábado por la tarde, que
   * es cuando el pesador más registra — y una guarda que grita siempre es una
   * guarda que se aprende a ignorar.
   */
  it("NO bloquea porque haya llegado trabajo nuevo", () => {
    const approved = [weighed("a", 38.5, 80_000)];
    const now = [...approved, weighed("c", 12, 80_000)];
    expect(driftOf(approval(approved), payables(now))).toBeNull();
  });

  it("sí bloquea cuando una labor aprobada dejó de estar pendiente", () => {
    const approved = [weighed("a", 38.5, 80_000), weighed("b", 41, 80_000)];
    const now = [approved[0]];

    const drift = driftOf(approval(approved), payables(now));
    expect(drift).not.toBeNull();
    expect(drift!.afterCents).toBe(3_080_000);
    expect(drift!.removedIds).toEqual(["b"]);
    expect(sentenceFor(drift!, FMT)).toContain("salió una pesada de la liquidación");
  });

  it("y cuando todo desapareció, la cifra de ahora es cero y se dice", () => {
    const approved = [weighed("a", 38.5, 80_000)];
    const drift = driftOf(approval(approved), payables([]));
    expect(drift!.afterCents).toBe(0);
    expect(drift!.removedIds).toEqual(["a"]);
  });
});

describe("por qué no entró alguien, dicho para quien tiene la plata en la mano", () => {
  it("nombra el bruto movido, la labor ya reclamada y el saldo que bajó", () => {
    expect(
      reasonOf(
        new ApiError(409, {
          error: {
            code: "GROSS_CHANGED",
            message: "x",
            details: { beforeCents: 1, afterCents: 2 },
          },
        }),
      ),
    ).toContain("El bruto cambió");
    expect(
      reasonOf(new ApiError(409, { error: { code: "PAYABLE_ALREADY_CLAIMED", message: "x" } })),
    ).toContain("Otra liquidación");
    expect(
      reasonOf(new ApiError(409, { error: { code: "AMOUNT_EXCEEDS_BALANCE", message: "x" } })),
    ).toContain("El saldo bajó");
  });

  /** Nunca se inventa una causa: un fallo de red se cuenta como fallo de red. */
  it("no inventa una causa para lo que no la tiene", () => {
    expect(reasonOf(new Error("boom"))).not.toContain("bruto");
  });
});

/* ------------------------------------------------------------------ */
/* El papel                                                            */
/* ------------------------------------------------------------------ */

const row = (name: string, over: Partial<RunRow> = {}): RunRow => ({
  workerId: name as Uuid,
  name,
  documentNumber: null,
  quantity: 10,
  grossCents: 1_000_000,
  paidCents: null,
  balanceAfterCents: null,
  status: "done",
  settlementId: `s-${name}` as Uuid,
  paymentId: null,
  reason: null,
  ...over,
});

const run = (rows: RunRow[], over: Partial<PayrollRun> = {}): PayrollRun => ({
  step: "settle",
  rows,
  scope: { filters: [], crewSize: rows.length, crewTotalCents: 3_000_000 },
  method: null,
  at: "2026-08-29T12:00:00Z",
  complete: isComplete(rows),
  unitLabel: "kg",
  ...over,
});

describe("la planilla confiesa su alcance", () => {
  it("una corrida de la cuadrilla entera no se declara parcial", () => {
    const r = run([row("María"), row("Jhon"), row("Luz")]);
    expect(runIsPartial(r)).toBe(false);
    expect(payrollScopeOf(r).filters).toEqual([]);
    expect(payrollTitleOf(r)).toBe("Planilla de liquidación de cuadrilla");
  });

  /** La mordida de `SettlementsPage`, heredada. */
  it("dice que había un filtro puesto", () => {
    const r = run([row("Rosa")], {
      scope: { filters: ["empleado contiene «Rosa»"], crewSize: 1, crewTotalCents: 1_000_000 },
    });
    expect(payrollScopeOf(r).filters).toContain("empleado contiene «Rosa»");
    expect(payrollTitleOf(r)).toContain("(parcial)");
  });

  /**
   * Y la forma que sólo tiene esta pantalla, y que es MÁS fácil de hacer sin
   * darse cuenta que escribir en un buscador: destildar a cuatro de treinta.
   */
  it("dice a cuánta gente se destildó, aunque no hubiera filtro", () => {
    const r = run([row("María")], {
      scope: { filters: [], crewSize: 30, crewTotalCents: 30_000_000 },
    });
    expect(payrollScopeOf(r).filters).toContain("se dejó fuera a 29 personas de la cuadrilla");
    expect(runIsPartial(r)).toBe(true);
  });

  it("nombra uno por uno a quien no entró, con su motivo", () => {
    const r = run([
      row("María"),
      row("Jhon", { status: "refused", reason: "El saldo bajó y el pago aprobado ya no cabe." }),
      row("Luz", { status: "skipped", settlementId: null }),
    ]);
    const phrase = payrollScopeOf(r).filters.join(" ");
    expect(phrase).toContain("no entraron 2");
    expect(phrase).toContain("Jhon (El saldo bajó");
    expect(phrase).toContain("Luz (no se llegó a intentar)");
  });

  /**
   * Un renglón con una firma al lado, para alguien a quien no se le entregó
   * nada, es una invitación a firmarlo.
   */
  it("sólo lleva renglón quien entró", () => {
    const r = run([row("María"), row("Jhon", { status: "refused", reason: "x" })]);
    expect(payrollRowsOf(r).map((x) => x.name)).toEqual(["María"]);
  });

  /** Ningún cero que signifique «no sé»: el saldo posterior aún no se ha leído. */
  it("no inventa un saldo posterior en la planilla de liquidación", () => {
    expect(payrollRowsOf(run([row("María")]))[0].balanceCents).toBeNull();
  });

  it("y sí lo lleva en la de pago, con lo entregado", () => {
    const r = run(
      [row("María", { paidCents: 2_000_000, balanceAfterCents: 0, paymentId: "p1" as Uuid })],
      { step: "pay" },
    );
    const [printed] = payrollRowsOf(r);
    expect(printed.paidCents).toBe(2_000_000);
    expect(printed.balanceCents).toBe(0);
    expect(payrollTitleOf(r)).toBe("Planilla de nómina");
  });
});

describe("lo que una corrida deja para deshacer", () => {
  it("recoge los pagos y las liquidaciones de todas las corridas", () => {
    const settled = run([row("María"), row("Jhon")]);
    const paid = run(
      [
        row("María", { paymentId: "p1" as Uuid, settlementId: null }),
        row("Jhon", { paymentId: "p2" as Uuid, settlementId: null }),
      ],
      { step: "pay" },
    );
    const handle = undoHandleOf([settled, paid]);
    expect(handle.settlements).toEqual(["s-María", "s-Jhon"]);
    expect(handle.payments).toEqual(["p1", "p2"]);
    expect(undoIsEmpty(handle)).toBe(false);
  });

  it("no ofrece deshacer lo que no se escribió", () => {
    const r = run([row("María", { status: "refused", settlementId: null, reason: "x" })]);
    expect(undoIsEmpty(undoHandleOf([r]))).toBe(true);
    expect(isComplete(r.rows)).toBe(false);
  });
});
