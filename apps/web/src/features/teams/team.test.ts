import { describe, expect, it } from "vitest";
import type { Worker } from "../../api/types";
import { matchesName } from "../workrecords/bulk";
import { isTeam, memberNames, teamLine, weighable } from "./team";
import { looksLikeTwoPeople } from "./TeamProfile";

function w(over: Partial<Worker>): Worker {
  return {
    id: over.id ?? "x", name: "", lastName: "", documentType: "CC", documentNumber: "",
    tag: null, phone: null, address: null, city: null, country: null, photoUrl: null,
    startedAt: null, status: "active", ...over,
  };
}

const team = w({
  id: "t", name: "Yorman y Sergio", kind: "equipo", tag: "46-63",
  members: [
    { id: "y", name: "Yorman", lastName: null, tag: "46", from: "2026-09-28", to: null },
    { id: "s", name: "Sergio", lastName: null, tag: "63", from: "2026-09-28", to: null },
  ],
});
const yorman = w({ id: "y", name: "Yorman", team: { id: "t", name: "Yorman y Sergio", from: "2026-09-28", to: null, members: 2 } });
const luis = w({ id: "l", name: "Luis", lastName: "Alarcón" });

describe("teams on the scale", () => {
  it("weighs the team, never a member on their own", () => {
    expect(weighable([team, yorman, luis]).map((x) => x.id)).toEqual(["t", "l"]);
  });
  it("finds the team by a member's name", () => {
    expect(matchesName(team, "sergio")).toBe(true);
    expect(matchesName(team, "luis")).toBe(false);
  });
  it("says who is in it", () => {
    expect(isTeam(team)).toBe(true);
    expect(isTeam(luis)).toBe(false);
    expect(memberNames(team)).toBe("Yorman, Sergio");
    expect(teamLine(team)).toBe("Equipo de 2 · Yorman, Sergio");
  });
  it("spots a person record that is really two people", () => {
    expect(looksLikeTwoPeople("Mauricio y Tatiana")).toBe(true);
    expect(looksLikeTwoPeople("Luis Alarcón")).toBe(false);
    expect(looksLikeTwoPeople("Yuly")).toBe(false);
  });
});
