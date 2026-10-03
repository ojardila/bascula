import { describe, expect, it } from "vitest";
import { affix } from "./affix";

describe("affix", () => {
  it("wraps a value with what goes before and after it", () => {
    expect(affix("Kilo", " (", ")")).toBe(" (Kilo)");
    expect(affix("Café", " · ")).toBe(" · Café");
    expect(affix(3, "x")).toBe("x3");
  });

  it("says nothing when there is no value", () => {
    expect(affix(null, " (", ")")).toBe("");
    expect(affix(undefined, " · ")).toBe("");
    expect(affix("", " · ")).toBe("");
    expect(affix(0, " · ")).toBe("");
  });
});
