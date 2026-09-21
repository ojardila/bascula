import { describe, expect, it } from "vitest";
import { pickHarvestActivity } from "./RecoleccionFormPage";
import type { Activity } from "../../api/types";

function act(partial: Partial<Activity> & Pick<Activity, "id" | "name" | "rateSource">): Activity {
  return {
    category: "cosecha",
    payMode: "work_unit",
    workUnit: "kg",
    timeUnit: null,
    customQty: null,
    customPeriod: null,
    defaultRateCents: undefined,
    status: "active",
    ...partial,
  } as Activity;
}

describe("pickHarvestActivity", () => {
  it("prefers a weekly-price activity named Recolección", () => {
    const picked = pickHarvestActivity([
      act({ id: "1", name: "Deshierbe", rateSource: "fixed" }),
      act({ id: "2", name: "Recolección de café", rateSource: "weekly_price" }),
      act({ id: "3", name: "Otra semanal", rateSource: "weekly_price" }),
    ]);
    expect(picked?.id).toBe("2");
  });

  it("falls back to any weekly-price activity", () => {
    const picked = pickHarvestActivity([
      act({ id: "9", name: "Por kilo", rateSource: "weekly_price" }),
    ]);
    expect(picked?.id).toBe("9");
  });

  it("returns null when nothing qualifies", () => {
    expect(
      pickHarvestActivity([act({ id: "1", name: "Jornal", rateSource: "fixed" })]),
    ).toBeNull();
  });
});
