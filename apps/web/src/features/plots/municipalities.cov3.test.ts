// SPDX-License-Identifier: MIT
/**
 * The index behind `departmentOfMunicipality`: a name the table gives to two
 * departments without listing it as ambiguous is a bug in the table, and the
 * index goes quiet about it instead of picking one.
 */
import { describe, expect, it } from "vitest";
import { departmentOfMunicipality, indexMunicipalities } from "./municipalities";

describe("indexMunicipalities", () => {
  it("drops a name listed under two departments and marks it ambiguous", () => {
    const ambiguous = new Set<string>();
    const index = indexMunicipalities(
      { Caldas: ["Chinchiná", "Neira"], Huila: ["Chinchina", "Pitalito"] },
      ambiguous,
    );
    expect(index).toEqual({ neira: "Caldas", pitalito: "Huila" });
    expect([...ambiguous]).toEqual(["chinchina"]);
  });

  it("keeps a name repeated under the same department", () => {
    const index = indexMunicipalities({ Caldas: ["Neira", "neira"] }, new Set());
    expect(index).toEqual({ neira: "Caldas" });
  });

  it("leaves out a name a third department repeats once it is ambiguous", () => {
    const ambiguous = new Set<string>();
    const index = indexMunicipalities(
      { A: ["Uno"], B: ["Uno"], C: ["Uno"] },
      ambiguous,
    );
    expect(index).toEqual({});
    expect(ambiguous.has("uno")).toBe(true);
  });

  it("is what the module answers from", () => {
    expect(departmentOfMunicipality("Chinchiná")).toBe("Caldas");
    expect(departmentOfMunicipality("Palestina")).toBeNull();
  });
});
