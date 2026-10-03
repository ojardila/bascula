// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { emptyDraft, parseQuantity, quantityLabel, validateWorkRecord } from "./validation";
import type { Activity } from "../../api/types";

const base: Activity = {
  id: "act-1", name: "Guadañada", category: "mantenimiento",
  payMode: "time_unit", workUnit: null, timeUnit: "jornal",
  customQty: null, customPeriod: null,
  rateSource: "fixed", defaultRateCents: 4500000, status: "active",
};

describe("quantityLabel", () => {
  it("names every time unit, with a generic fallback", () => {
    expect(quantityLabel({ ...base, timeUnit: "semanal" })).toBe("semanas");
    expect(quantityLabel({ ...base, timeUnit: "quincenal" })).toBe("quincenas");
    expect(quantityLabel({ ...base, timeUnit: "mensual" })).toBe("meses");
    expect(quantityLabel({ ...base, timeUnit: null })).toBe("períodos");
  });
  it("falls back to 'unidades' for a work unit with no name", () => {
    expect(quantityLabel({ ...base, payMode: "work_unit", workUnit: null })).toBe("unidades");
  });
});

describe("parseQuantity", () => {
  it("rejects a number too long to be finite", () => {
    expect(parseQuantity("9".repeat(400))).toBeNull();
  });
});

describe("validateWorkRecord", () => {
  const draft = {
    ...emptyDraft("2026-08-26"),
    workerId: "w1", activityId: base.id, plotIds: ["p1"], plotCropIds: ["c1"], quantity: "2",
  };

  it("asks for the start date when it is blank", () => {
    const r = validateWorkRecord({ ...draft, dateFrom: "", dateTo: "" }, base, "id-1");
    expect(r.valid).toBe(false);
    expect(r.errors.dateFrom).toBe("Indique la fecha de la labor.");
  });

  it("uses the start date as the end date when the end is blank", () => {
    const r = validateWorkRecord({ ...draft, dateTo: "" }, base, "id-1");
    expect(r.valid).toBe(true);
    expect(r.input?.dateTo).toBe("2026-08-26");
  });

  it("asks for a price when a non-contract activity has none", () => {
    const r = validateWorkRecord(draft, { ...base, defaultRateCents: undefined }, "id-1");
    expect(r.errors.rateCents).toBe(
      "Indique el precio. La actividad no tiene uno vigente para esta fecha.",
    );
  });
});
