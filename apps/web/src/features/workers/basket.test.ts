/** «Número de canasto»: finding people by the number on their basket. */
import { describe, expect, it } from "vitest";
import { filterWorkers, matchesName } from "../workrecords/bulk";
import { basketOf, basketText } from "./Basket";
import type { Worker } from "../../api/types";

function w(id: string, name: string, tag: string | null, extra: Partial<Worker> = {}): Worker {
  return {
    id, name, lastName: "", documentType: "CC", documentNumber: "", tag, phone: null, address: null,
    city: null, country: null, photoUrl: null, startedAt: null, status: "active", ...extra,
  };
}

const people = [
  w("1", "Samir Kibay", "45"),
  w("2", "Yorman y Sergio", "46-63", {
    kind: "equipo",
    members: [
      { id: "y", name: "Yorman", lastName: null, tag: "46", from: "2026-09-28", to: null },
      { id: "s", name: "Sergio", lastName: null, tag: "63", from: "2026-09-28", to: null },
    ],
  }),
  w("3", "Kevin Sanguino", "4"),
  w("4", "Mauricio", null),
];

describe("searching by basket number", () => {
  it("matches the worker's own number", () => {
    expect(matchesName(people[0], "45")).toBe(true);
    expect(matchesName(people[3], "45")).toBe(false);
  });

  it("finds a team by its own number or by a member's", () => {
    expect(filterWorkers(people, "46-63").map((x) => x.id)).toEqual(["2"]);
    expect(filterWorkers(people, "63").map((x) => x.id)).toEqual(["2"]);
  });

  it("puts the exact number first", () => {
    // «4» is in 45, 46-63 and 4: Kevin (exactly 4) comes first.
    expect(filterWorkers(people, "4").map((x) => x.id)[0]).toBe("3");
    // «46» is one of the team's numbers: the team before anything that merely starts with it.
    expect(filterWorkers(people, "46")[0].id).toBe("2");
  });

  it("keeps the list's order when searching by name", () => {
    expect(filterWorkers(people, "").map((x) => x.id)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("basket labels", () => {
  it("says «Sin canasto» when there is none", () => {
    expect(basketOf("  ")).toBeNull();
    expect(basketText(null)).toBe("Sin canasto");
    expect(basketText(" 46 ")).toBe("Canasto 46");
  });
});
