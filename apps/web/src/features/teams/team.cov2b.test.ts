// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import type { Worker } from "../../api/types";
import { teamSize, memberCount, memberNames, teamLine, teamSearchText } from "./team";

describe("team helpers with no members listed", () => {
  it("counts nobody and names nobody", () => {
    expect(memberCount({})).toBe(0);
    expect(memberNames({})).toBe("");
    expect(teamLine({})).toBe("Equipo de 0");
    expect(teamSearchText({} as Worker)).toBe("");
  });

  it("searches members with no last name or tag", () => {
    const w = { members: [{ id: "m1", name: "Yorman", lastName: null, tag: null }] } as unknown as Worker;
    expect(teamSearchText(w).trim()).toBe("Yorman");
  });

  it("says a team of one in the singular", () => {
    expect(teamSize(1)).toBe("Equipo de 1");
  });
});
