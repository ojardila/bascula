// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { farmGreeting, farmSlugProblem, farmUrlForHere, isFarmHost, showsFarmEntry } from "./farmHost";

afterEach(() => vi.unstubAllGlobals());

describe("farmHost, the remaining edges", () => {
  it("says an address over 63 letters is too long", () => {
    expect(farmSlugProblem("a".repeat(64))).toBe("La dirección es muy larga. Use máximo 63 letras.");
  });

  it("greets nobody when the farm name is only spaces", () => {
    expect(farmGreeting("   ")).toBe("");
  });

  /**
   * Outside a browser (a script, server-side code) there is no `window`: the
   * host is read as empty instead of throwing.
   */
  it("treats a missing window as the production main domain", () => {
    vi.stubGlobal("window", undefined);
    expect(typeof window).toBe("undefined");
    const url = farmUrlForHere("lapalma");
    const farm = isFarmHost();
    const entry = showsFarmEntry();
    vi.unstubAllGlobals();
    expect(url).toBe("https://lapalma.bascula.engp.io");
    expect(farm).toBe(false);
    expect(entry).toBe(false);
  });
});
