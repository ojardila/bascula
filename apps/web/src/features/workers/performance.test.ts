// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { comparisonSpan, daysWorkedText, kgText, weekChange, weekdayIndex } from "./performance";

describe("rendimiento: the sentences", () => {
  it("says the change in words, with the arrow", () => {
    expect(weekChange(112.4, 100)).toMatchObject({ arrow: "↑", sentence: "12 kg más que la semana pasada" });
    expect(weekChange(70, 1100)).toMatchObject({ arrow: "↓", sentence: "1.030 kg menos que la semana pasada" });
    expect(weekChange(50, 50.2)).toMatchObject({ direction: "same", sentence: "Lo mismo que la semana pasada" });
  });

  it("treats a week with no kilos as zero picked, for the comparison only", () => {
    expect(weekChange(null, 40).sentence).toBe("40 kg menos que la semana pasada");
    expect(weekChange(25, null).sentence).toBe("25 kg más que la semana pasada");
  });

  it("names what is being compared", () => {
    expect(weekdayIndex("2026-09-21")).toBe(0); // a Monday
    expect(comparisonSpan("2026-09-21")).toBe("Comparando solo los lunes.");
    expect(comparisonSpan("2026-09-24")).toBe("Comparando de lunes a jueves en las dos semanas.");
    expect(comparisonSpan("2026-09-27")).toBe("Semana completa contra semana completa.");
  });

  it("writes whole kilos and plurals", () => {
    expect(kgText(1234.6)).toBe("1.235 kg");
    expect(daysWorkedText(1)).toBe("1 día trabajado");
    expect(daysWorkedText(12)).toBe("12 días trabajados");
  });
});
