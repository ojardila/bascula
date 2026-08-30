/**
 * UNA SOLA RESPUESTA A «¿CUÁNTO LE DEBO?», Y SUS HUECOS.
 *
 * Estas pruebas no son de aritmética —sumar dos enteros no necesita prueba—
 * sino de lo que pasa cuando falta una de las dos mitades. Ése es el fallo que
 * este módulo existe para impedir: el perfil enseñaba $184.500, la lista «—» y
 * un total de $0, el tablero $334.500 y la pantalla de pagar $338.100. Cuatro
 * pantallas, cuatro cifras, y la única correcta escondida detrás de la
 * decisión de pagar.
 *
 * Lo que se afirma aquí es que ningún camino de este módulo devuelve un número
 * que signifique «no sé».
 */
import { describe, expect, it } from "vitest";
import {
  owedByWorker,
  owedOf,
  owedState,
  sumOwed,
  sumOwedToFarmWorkers,
  totalOwedCents,
  type Owed,
} from "./owed";

const owed = (balanceCents: number | null, pendingCents: number | null, est = false): Owed => ({
  balanceCents,
  pendingCents,
  pendingIsEstimate: est,
});

describe("la cifra de una persona", () => {
  it("es el libro más lo que falta liquidar — la misma que escribe «pagar»", () => {
    // María, en la finca sembrada: saldo 184.500, pendiente 153.600.
    const s = owedState(owed(184_500_00, 153_600_00));
    expect(s.kind).toBe("known");
    expect(s.kind === "known" && s.cents).toBe(338_100_00);
    expect(totalOwedCents(owed(184_500_00, 153_600_00))).toBe(338_100_00);
  });

  it("marca la cifra cuando parte todavía se paga al precio de la semana", () => {
    const s = owedState(owed(184_500_00, 153_600_00, true));
    expect(s.kind === "known" && s.isEstimate).toBe(true);
  });

  /** Un estimado de cero pesos no tiene nada que se pueda mover. */
  it("no marca como estimado lo que no tiene nada pendiente", () => {
    const s = owedState(owed(184_500_00, 0, true));
    expect(s.kind === "known" && s.isEstimate).toBe(false);
  });

  it("sin el libro no hay total, y no hay número que pintar por error", () => {
    const s = owedState(owed(null, 153_600_00));
    expect(s.kind).toBe("unknown");
    // Lo que importa: el caso `unknown` NO tiene miembro numérico. Una pantalla
    // no puede sacar de aquí un cero sin que TypeScript la pare.
    expect(Object.prototype.hasOwnProperty.call(s, "cents")).toBe(false);
    expect(totalOwedCents(owed(null, 153_600_00))).toBeNull();
  });

  /**
   * Lo pendiente sólo puede SUMAR, así que el saldo es un piso legítimo. Decir
   * «al menos $184.500» informa más que un guion y no miente.
   */
  it("sin lo pendiente da un piso, no un guion y no un total", () => {
    const s = owedState(owed(184_500_00, null));
    expect(s.kind).toBe("partial");
    expect(s.kind === "partial" && s.cents).toBe(184_500_00);
    expect(totalOwedCents(owed(184_500_00, null))).toBeNull();
  });

  it("un saldo negativo es un anticipo que la persona carga, y se conserva", () => {
    const s = owedState(owed(-45_000_00, 0));
    expect(s.kind === "known" && s.cents).toBe(-45_000_00);
  });
});

describe("la cifra de la finca", () => {
  it("suma sólo lo que se pudo establecer entero, y dice cuántos faltan", () => {
    const sum = sumOwed([owed(100_00, 50_00), owed(200_00, null), owed(null, null)]);
    // Con una cuenta a medias, el TOTAL de la finca ya no se puede afirmar…
    expect(sum.cents).toBeNull();
    // …pero el piso sí, y con él se puede escribir «al menos».
    expect(sum.floorCents).toBe(350_00);
    expect(sum.counted).toBe(1);
    expect(sum.unreadable).toBe(2);
  });

  it("cuando todo se leyó, el total es el total", () => {
    const sum = sumOwed([owed(100_00, 50_00), owed(200_00, 0)]);
    expect(sum.cents).toBe(350_00);
    expect(sum.unreadable).toBe(0);
  });

  /**
   * La plata que hay que contar el sábado no baja porque alguien deba. Un
   * anticipo se queda en la fila de esa persona y no se resta del total de la
   * finca.
   */
  it("no resta los anticipos de lo que la finca les debe a los demás", () => {
    expect(sumOwedToFarmWorkers([owed(100_00, 0), owed(-40_00, 0)]).cents).toBe(100_00);
  });

  it("de una finca sin nada leído no dice cero", () => {
    expect(sumOwed([owed(null, null)]).cents).toBeNull();
    expect(sumOwed([owed(null, null)]).floorCents).toBeNull();
  });
});

describe("armar las cuentas de las dos lecturas de lista", () => {
  const W1 = "w1";
  const W2 = "w2";

  it("junta el libro con lo que falta liquidar, por persona", () => {
    const map = owedByWorker(
      [{ workerId: W1, balanceCents: 100_00 }],
      [
        { workerId: W1, settled: false, estimatedAmountCents: 50_00, amountIsEstimate: true },
        { workerId: W1, settled: true, estimatedAmountCents: 900_00, amountIsEstimate: false },
        { workerId: W2, settled: false, estimatedAmountCents: 70_00, amountIsEstimate: false },
      ],
    );
    // Lo ya liquidado no se cuenta dos veces: está dentro del saldo.
    expect(totalOwedCents(map.get(W1)!)).toBe(150_00);
    expect(map.get(W1)!.pendingIsEstimate).toBe(true);
    // Sin fila en /v1/balances pero con la lectura buena, su libro está en cero
    // de verdad: no tiene un solo movimiento.
    expect(totalOwedCents(map.get(W2)!)).toBe(70_00);
  });

  it("una lectura caída deja su mitad en null, nunca en cero", () => {
    const noBalances = owedByWorker(null, [
      { workerId: W1, settled: false, estimatedAmountCents: 50_00, amountIsEstimate: false },
    ]);
    expect(noBalances.get(W1)!.balanceCents).toBeNull();
    expect(owedState(noBalances.get(W1)!).kind).toBe("unknown");

    const noRecords = owedByWorker([{ workerId: W1, balanceCents: 100_00 }], null);
    expect(noRecords.get(W1)!.pendingCents).toBeNull();
    expect(owedState(noRecords.get(W1)!).kind).toBe("partial");
  });

  it("de quien no aparece en ninguna lectura no se afirma nada", () => {
    const map = owedByWorker(null, null);
    expect(owedState(owedOf(map, "nadie", false, false)).kind).toBe("unknown");
    // Y con las dos lecturas buenas, sí: ese empleado está en cero.
    expect(totalOwedCents(owedOf(map, "nadie", true, true))).toBe(0);
  });
});
