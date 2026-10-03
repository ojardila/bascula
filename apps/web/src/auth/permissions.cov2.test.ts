// SPDX-License-Identifier: MIT
/** A role this build does not know reads nothing and lands on the harvest. */
import { describe, expect, it } from "vitest";
import { can, landingPath, visibleModules, type Principal } from "./permissions";

const stranger = {
  role: "auditor",
  isSuperAdmin: false,
  farmStatus: "active",
} as unknown as Principal;

describe("an unknown role", () => {
  it("is refused every action and sees no module", () => {
    expect(can(stranger, "money.read")).toBe(false);
    expect(visibleModules(stranger)).toEqual([]);
  });

  it("lands on /cosecha, the default", () => {
    expect(landingPath(stranger)).toBe("/cosecha");
  });
});
