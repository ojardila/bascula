// SPDX-License-Identifier: MIT
/**
 * A violation axe reports without an impact still makes a readable message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { expectNoAxeViolations } from "./a11yHelper";

afterEach(() => vi.restoreAllMocks());

describe("expectNoAxeViolations report", () => {
  it("writes n/a for a violation with no impact", async () => {
    const fakeRun = async () => ({
      violations: [{ id: "made-up", help: "Ayuda", impact: null, nodes: [{ target: ["#a"] }] }],
    });
    vi.spyOn(axe, "run").mockImplementation(fakeRun as unknown as typeof axe.run);
    await expect(expectNoAxeViolations(document.body)).rejects.toThrow(/\[n\/a\] made-up — Ayuda/);
  });
});
