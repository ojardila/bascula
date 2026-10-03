// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { line } from "../../api/grossChange";
import { groupReceiptLines, quantityLabel } from "./receiptLines";

const TODAY = new Date("2026-09-26T12:00:00Z");

describe("receipt lines, the gaps", () => {
  it("reads a line with no mode and no unit as a contract", () => {
    const [g] = groupReceiptLines([line("a", 100, { unitLabel: null })], TODAY);
    expect(g.quantityLabel).toBe("contrato");
  });

  it("orders several lotes alphabetically in one row", () => {
    const [g] = groupReceiptLines([line("a", 100, { plotNames: ["La Cumbre", "El Mango"] })], TODAY);
    expect(g.plotLabel).toBe("El Mango, La Cumbre");
  });

  it("shows a bare quantity when a weighed line has no unit label", () => {
    expect(quantityLabel(3, "work_unit", null)).toBe("3");
  });

  it("says one jornal in the singular", () => {
    expect(quantityLabel(1, "time_unit", null)).toBe("1 jornal");
  });
});
