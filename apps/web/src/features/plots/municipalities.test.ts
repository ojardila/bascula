/**
 * "Caldas · Pitalito". Pitalito is in Huila, and the form accepted it without
 * a word because the department came prefilled from the factory.
 *
 * What is tested here is mostly what the table does NOT do: it does not
 * complain about municipalities it does not know —most of the country— and it
 * takes no position on names that exist in two departments. A partial table
 * that accuses is worse than no table at all.
 */
import { describe, expect, it } from "vitest";
import { departmentMismatch, departmentOfMunicipality } from "./municipalities";

describe("the municipality that is not in that department", () => {
  it("says so, and names the real department", () => {
    const msg = departmentMismatch("Caldas", "Pitalito");
    expect(msg).toContain("Huila");
    expect(msg).toContain("Pitalito");
  });

  it("stays quiet when the pair is right", () => {
    expect(departmentMismatch("Caldas", "Chinchiná")).toBeNull();
    expect(departmentMismatch("Huila", "Pitalito")).toBeNull();
  });

  it("does not care about accents or capitals", () => {
    expect(departmentMismatch("Caldas", "chinchina")).toBeNull();
    expect(departmentMismatch("Caldas", "PITALITO")).toContain("Huila");
  });

  /** Half the country is not in this table, and about those it says nothing. */
  it("stays quiet about what it does not know", () => {
    expect(departmentMismatch("Caldas", "Vereda La Nubia")).toBeNull();
    expect(departmentOfMunicipality("Puerto Carreño")).toBeNull();
  });

  /**
   * "Palestina" is in Caldas and also in Huila. About those nothing can be
   * claimed, so nothing is: being right half the time is worse than staying
   * quiet, because it teaches people not to read the warning.
   */
  it("stays quiet about names that live in two departments", () => {
    expect(departmentOfMunicipality("Palestina")).toBeNull();
    expect(departmentMismatch("Caldas", "Palestina")).toBeNull();
    expect(departmentMismatch("Huila", "Palestina")).toBeNull();
  });

  it("stays quiet while the form is only half filled in", () => {
    expect(departmentMismatch("", "Pitalito")).toBeNull();
    expect(departmentMismatch("Caldas", "")).toBeNull();
  });
});
