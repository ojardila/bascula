/**
 * "1 venta(s)". "16 Bulto". Two ways for a product to tell whoever is reading
 * that writing them a sentence was not worth the trouble.
 */
import { describe, expect, it } from "vitest";
import { count, plural, unitLabel } from "./plural";

describe("nouns", () => {
  it("agrees with the number", () => {
    expect(count(1, "venta", "ventas")).toBe("1 venta");
    expect(count(0, "venta", "ventas")).toBe("0 ventas");
    expect(count(4, "gasto", "gastos")).toBe("4 gastos");
    expect(plural(1, "labor", "labores")).toBe("labor");
    expect(plural(3, "labor", "labores")).toBe("labores");
  });
});

describe("units", () => {
  it("writes them the way the farm says them", () => {
    expect(unitLabel(16, "Bulto")).toBe("bultos");
    expect(unitLabel(1, "Bulto")).toBe("bulto");
    expect(unitLabel(3, "arroba")).toBe("arrobas");
    expect(unitLabel(2, "canasta")).toBe("canastas");
  });

  /** A unit symbol takes no s: "16 kgs" gives away whoever wrote it. */
  it("does not pluralise symbols", () => {
    expect(unitLabel(38.5, "kg")).toBe("kg");
    expect(unitLabel(2, "ha")).toBe("ha");
    expect(unitLabel(1, "KG")).toBe("kg");
  });

  it("adds \"es\" after a consonant", () => {
    expect(unitLabel(2, "costal")).toBe("costales");
  });

  it("invents nothing when the unit is missing", () => {
    expect(unitLabel(2, null)).toBe("");
    expect(unitLabel(2, "  ")).toBe("");
  });
});
