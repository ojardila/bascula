/**
 * «1 venta(s)». «16 Bulto». Dos formas de que un producto le diga a quien lo
 * lee que no valía la pena escribirle una frase.
 */
import { describe, expect, it } from "vitest";
import { count, plural, unitLabel } from "./plural";

describe("sustantivos", () => {
  it("concuerda con el número", () => {
    expect(count(1, "venta", "ventas")).toBe("1 venta");
    expect(count(0, "venta", "ventas")).toBe("0 ventas");
    expect(count(4, "gasto", "gastos")).toBe("4 gastos");
    expect(plural(1, "labor", "labores")).toBe("labor");
    expect(plural(3, "labor", "labores")).toBe("labores");
  });
});

describe("unidades", () => {
  it("las escribe como las dice la finca", () => {
    expect(unitLabel(16, "Bulto")).toBe("bultos");
    expect(unitLabel(1, "Bulto")).toBe("bulto");
    expect(unitLabel(3, "arroba")).toBe("arrobas");
    expect(unitLabel(2, "canasta")).toBe("canastas");
  });

  /** Un símbolo de unidad no lleva ese: «16 kgs» delata a quien lo escribió. */
  it("no pluraliza los símbolos", () => {
    expect(unitLabel(38.5, "kg")).toBe("kg");
    expect(unitLabel(2, "ha")).toBe("ha");
    expect(unitLabel(1, "KG")).toBe("kg");
  });

  it("añade «es» tras consonante", () => {
    expect(unitLabel(2, "costal")).toBe("costales");
  });

  it("de una unidad ausente no inventa nada", () => {
    expect(unitLabel(2, null)).toBe("");
    expect(unitLabel(2, "  ")).toBe("");
  });
});
