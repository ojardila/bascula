/**
 * The work-record form changes shape with the activity, and the combinations
 * are where a wrong peso figure is born. These walk every one of them.
 */
import { describe, expect, it } from "vitest";
import {
  emptyDraft, estimateCents, forcesSingleDay, needsQuantity, needsRateField,
  quantityLabel, validateWorkRecord, type WorkRecordDraft,
} from "./validation";
import type { Activity } from "../../api/types";

const base: Activity = {
  id: "act-1", name: "Recolección de café", category: "cosecha",
  payMode: "work_unit", workUnit: "kg", timeUnit: null,
  customQty: null, customPeriod: null,
  rateSource: "weekly_price", defaultRateCents: 80000, status: "active",
};

const weeklyPickup = base;
const fixedPickup: Activity = { ...base, id: "act-2", rateSource: "fixed", workUnit: "canasta", defaultRateCents: 350000 };
const jornal: Activity = {
  ...base, id: "act-3", name: "Guadañada", category: "mantenimiento",
  payMode: "time_unit", workUnit: null, timeUnit: "jornal",
  rateSource: "fixed", defaultRateCents: 4500000,
};
const contract: Activity = {
  ...base, id: "act-4", name: "Siembra de colinos", category: "siembra",
  payMode: "contract", workUnit: null, timeUnit: null,
  rateSource: "fixed", defaultRateCents: 120000000,
};

function draft(over: Partial<WorkRecordDraft> = {}): WorkRecordDraft {
  return {
    ...emptyDraft("2026-08-27"),
    workerId: "w-1",
    activityId: "act-1",
    plotIds: ["p-1"],
    plotCropIds: ["c-1"],
    quantity: "38,5",
    ...over,
  };
}

describe("form shape per pay mode", () => {
  it("asks for a quantity except on a contract", () => {
    expect(needsQuantity(weeklyPickup)).toBe(true);
    expect(needsQuantity(jornal)).toBe(true);
    expect(needsQuantity(contract)).toBe(false);
  });

  it("hides the price field only when the week sets it", () => {
    expect(needsRateField(weeklyPickup)).toBe(false);
    expect(needsRateField(fixedPickup)).toBe(true);
    expect(needsRateField(jornal)).toBe(true);
    expect(needsRateField(contract)).toBe(true);
  });

  it("names the quantity in the unit the person works in", () => {
    expect(quantityLabel(weeklyPickup)).toBe("kg");
    expect(quantityLabel(fixedPickup)).toBe("canasta");
    expect(quantityLabel(jornal)).toBe("jornales");
    expect(quantityLabel(contract)).toBe("");
  });
});

describe("the single-day rule for weekly prices", () => {
  it("applies to weekly_price and to nothing else", () => {
    expect(forcesSingleDay(weeklyPickup)).toBe(true);
    expect(forcesSingleDay(fixedPickup)).toBe(false);
    expect(forcesSingleDay(jornal)).toBe(false);
  });

  it("collapses a range instead of rejecting it", () => {
    // A jornal from Tuesday to Tuesday has no single Monday, so deriving a
    // weekly price over a range is the ambiguity that mis-pays a week. The
    // web collapses and says so; it does not bounce the form.
    const r = validateWorkRecord(
      draft({ dateFrom: "2026-08-24", dateTo: "2026-08-29" }),
      weeklyPickup,
      "id-1",
    );
    expect(r.valid).toBe(true);
    expect(r.input?.dateFrom).toBe("2026-08-24");
    expect(r.input?.dateTo).toBe("2026-08-24");
  });

  it("leaves a real range alone when the price is frozen on write", () => {
    const r = validateWorkRecord(
      draft({ activityId: "act-3", quantity: "2", dateFrom: "2026-08-24", dateTo: "2026-08-25" }),
      jornal,
      "id-2",
    );
    expect(r.valid).toBe(true);
    expect(r.input?.dateTo).toBe("2026-08-25");
  });

  it("rejects a range that runs backwards", () => {
    const r = validateWorkRecord(
      draft({ activityId: "act-3", quantity: "2", dateFrom: "2026-08-25", dateTo: "2026-08-24" }),
      jornal,
      "id-3",
    );
    expect(r.valid).toBe(false);
    expect(r.errors.dateTo).toMatch(/anterior/i);
  });
});

describe("the price the client is allowed to send", () => {
  it("never sends a rate for a weekly-priced activity", () => {
    // Sending the activity default here would freeze a stale price into a
    // record whose price is supposed to be decided at settlement.
    const r = validateWorkRecord(draft({ rateCents: 99999 }), weeklyPickup, "id-4");
    expect(r.valid).toBe(true);
    expect(r.input?.rateCents).toBeNull();
  });

  it("falls back to the activity's rate when the field is left alone", () => {
    const r = validateWorkRecord(
      draft({ activityId: "act-3", quantity: "2", rateCents: null }),
      jornal,
      "id-5",
    );
    expect(r.input?.rateCents).toBe(4500000);
  });

  it("refuses a rate of zero or less", () => {
    const r = validateWorkRecord(
      draft({ activityId: "act-3", quantity: "2", rateCents: 0 }),
      jornal,
      "id-6",
    );
    expect(r.valid).toBe(false);
    expect(r.errors.rateCents).toBeTruthy();
  });

  it("asks a contract for its total and gives it quantity 1", () => {
    const missing = validateWorkRecord(
      { ...draft({ activityId: "act-4", quantity: "" }), rateCents: null },
      { ...contract, defaultRateCents: undefined },
      "id-7",
    );
    expect(missing.valid).toBe(false);
    expect(missing.errors.rateCents).toMatch(/contrato/i);

    const ok = validateWorkRecord(draft({ activityId: "act-4", quantity: "" }), contract, "id-8");
    expect(ok.valid).toBe(true);
    expect(ok.input?.quantity).toBe(1);
    expect(ok.input?.rateCents).toBe(120000000);
  });
});

describe("the obligatory fields say which and why", () => {
  it("names every missing one at once, not one per submit", () => {
    const r = validateWorkRecord(
      { ...emptyDraft("2026-08-27"), activityId: "act-1" },
      weeklyPickup,
      "id-9",
    );
    expect(r.valid).toBe(false);
    expect(r.errors.workerId).toBeTruthy();
    expect(r.errors.plotIds).toBeTruthy();
    expect(r.errors.plotCropIds).toBeTruthy();
    expect(r.errors.quantity).toBeTruthy();
  });

  it("explains the quantity in the activity's own unit", () => {
    const r = validateWorkRecord(draft({ quantity: "" }), weeklyPickup, "id-10");
    expect(r.errors.quantity).toContain("kg");
  });

  it("refuses a quantity of zero, which would be a labor worth nothing", () => {
    const r = validateWorkRecord(draft({ quantity: "0" }), weeklyPickup, "id-11");
    expect(r.valid).toBe(false);
    expect(r.errors.quantity).toMatch(/mayor que cero/i);
  });

  it("reads a decimal comma, because that is how it will be typed", () => {
    const r = validateWorkRecord(draft({ quantity: "38,5" }), weeklyPickup, "id-12");
    expect(r.input?.quantity).toBe(38.5);
  });

  it("says so when no activity has been chosen", () => {
    const r = validateWorkRecord(draft(), null, "id-13");
    expect(r.valid).toBe(false);
    expect(r.errors.activityId).toBeTruthy();
  });
});

describe("the estimate shown next to the form", () => {
  it("multiplies quantity by the week's price for a pickup", () => {
    expect(estimateCents(weeklyPickup, 38.5, 80000)).toBe(3080000);
  });

  it("multiplies jornales by the frozen rate", () => {
    expect(estimateCents(jornal, 2, 4500000)).toBe(9000000);
  });

  it("is the total itself for a contract, whatever the quantity", () => {
    expect(estimateCents(contract, null, 120000000)).toBe(120000000);
  });

  it("shows nothing rather than a zero when a factor is missing", () => {
    // "$0" next to a form somebody is still filling in reads as a bug, and
    // worse, as a promise that the work is worth nothing.
    expect(estimateCents(weeklyPickup, null, 80000)).toBeNull();
    expect(estimateCents(weeklyPickup, 38.5, null)).toBeNull();
  });
});
