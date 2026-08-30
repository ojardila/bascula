/**
 * «Caldas · Pitalito». Pitalito es del Huila, y el formulario lo aceptó sin
 * decir nada porque el departamento venía puesto de fábrica.
 *
 * Lo que se prueba aquí es sobre todo lo que la tabla NO hace: no se queja de
 * los municipios que no conoce —que son la mayoría del país— y no se pronuncia
 * sobre los nombres que existen en dos departamentos. Una tabla parcial que
 * acusa es peor que ninguna tabla.
 */
import { describe, expect, it } from "vitest";
import { departmentMismatch, departmentOfMunicipality } from "./municipalities";

describe("el municipio que no es de ese departamento", () => {
  it("lo dice, con el departamento verdadero", () => {
    const msg = departmentMismatch("Caldas", "Pitalito");
    expect(msg).toContain("Huila");
    expect(msg).toContain("Pitalito");
  });

  it("se calla cuando el par es correcto", () => {
    expect(departmentMismatch("Caldas", "Chinchiná")).toBeNull();
    expect(departmentMismatch("Huila", "Pitalito")).toBeNull();
  });

  it("no distingue tildes ni mayúsculas", () => {
    expect(departmentMismatch("Caldas", "chinchina")).toBeNull();
    expect(departmentMismatch("Caldas", "PITALITO")).toContain("Huila");
  });

  /** La mitad del país no está en esta tabla, y de ésos no se dice nada. */
  it("se calla de lo que no conoce", () => {
    expect(departmentMismatch("Caldas", "Vereda La Nubia")).toBeNull();
    expect(departmentOfMunicipality("Puerto Carreño")).toBeNull();
  });

  /**
   * «Palestina» es de Caldas y también del Huila. De ésos no se puede afirmar
   * nada, así que no se afirma: acertar la mitad de las veces es peor que
   * callarse, porque enseña a no leer el aviso.
   */
  it("se calla de los nombres que están en dos departamentos", () => {
    expect(departmentOfMunicipality("Palestina")).toBeNull();
    expect(departmentMismatch("Caldas", "Palestina")).toBeNull();
    expect(departmentMismatch("Huila", "Palestina")).toBeNull();
  });

  it("se calla mientras el formulario está a medio llenar", () => {
    expect(departmentMismatch("", "Pitalito")).toBeNull();
    expect(departmentMismatch("Caldas", "")).toBeNull();
  });
});
