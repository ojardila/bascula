import { describe, expect, it } from "vitest";
import { formatNumber, pesos, toCsv } from "./csv";

describe("csv for Excel in Spanish", () => {
  it("uses semicolons, a BOM and CRLF", () => {
    const csv = toCsv(["Nombre", "Kilos"], [["Ana", 12.5]]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toBe("\uFEFFNombre;Kilos\r\nAna;12,5\r\n");
  });

  it("quotes cells that carry a separator, a quote or a newline", () => {
    const csv = toCsv(["a"], [['El "Alto"; lote 2']]);
    expect(csv).toContain('"El ""Alto""; lote 2"');
  });

  it("leaves unknown values empty instead of writing a zero", () => {
    expect(toCsv(["v"], [[null], [undefined]])).toBe("\uFEFFv\r\n\r\n\r\n");
    expect(pesos(null)).toBeNull();
  });

  it("writes numbers with a decimal comma and no grouping", () => {
    expect(formatNumber(1234567.25)).toBe("1234567,25");
    expect(pesos(123456)).toBe(1235);
  });
});
