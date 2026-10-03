// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import type { WireAnomaly } from "../../api/wire";
import {
  anomalyHeadline,
  anomalyReason,
  noIndexReason,
  unattributedReason,
} from "./text";

const base: WireAnomaly = {
  recordId: "r1",
  workerId: "w1",
  worker: "Ana Ruiz",
  crop: "Café",
  quantity: 120,
  kg: 120,
  date: "2026-03-10",
  rule: "impossible",
  reference: null,
} as WireAnomaly;

const a = (over: Partial<WireAnomaly>): WireAnomaly =>
  ({ ...base, ...over }) as WireAnomaly;

describe("anomalyHeadline", () => {
  it("labels every rule", () => {
    expect(anomalyHeadline(a({ rule: "impossible", quantity: 0 }))).toBe(
      "Peso en cero",
    );
    expect(anomalyHeadline(a({ rule: "impossible" }))).toBe("Peso imposible");
    expect(anomalyHeadline(a({ rule: "duplicate" }))).toBe(
      "Posible doble registro",
    );
    expect(anomalyHeadline(a({ rule: "digit" }))).toBe("¿Un cero de más?");
    expect(anomalyHeadline(a({ rule: "outlier" }))).toBe(
      "Muy por encima del lote",
    );
    expect(anomalyHeadline(a({ rule: "future" }))).toBe("Fecha futura");
  });
});

describe("anomalyReason", () => {
  it("explains a zero weight", () => {
    expect(anomalyReason(a({ rule: "impossible", quantity: 0 }))).toMatch(
      /sin peso/,
    );
  });

  it("explains an impossible weight with and without the cap", () => {
    expect(anomalyReason(a({ rule: "impossible" }))).not.toMatch(/tope/);
    expect(anomalyReason(a({ rule: "impossible", reference: 90 }))).toMatch(
      /tope que usamos/,
    );
  });

  it("explains a duplicate, naming the crop or the plot", () => {
    expect(anomalyReason(a({ rule: "duplicate" }))).toMatch(
      /Ana Ruiz tiene dos pesadas.*en Café/,
    );
    expect(anomalyReason(a({ rule: "duplicate", crop: null }))).toMatch(
      /en el lote/,
    );
  });

  it("explains an extra digit with and without a reference", () => {
    expect(anomalyReason(a({ rule: "digit" }))).toMatch(/muy superior/);
    expect(anomalyReason(a({ rule: "digit", reference: 30 }))).toMatch(
      /cuatro veces/,
    );
  });

  it("explains an outlier with and without a reference", () => {
    const plain = anomalyReason(a({ rule: "outlier" }));
    expect(plain).toMatch(/resto de la cuadrilla/);
    expect(plain).not.toMatch(/cada uno/);
    expect(anomalyReason(a({ rule: "outlier", reference: 40 }))).toMatch(
      /cada uno/,
    );
  });

  it("explains a future date", () => {
    expect(anomalyReason(a({ rule: "future" }))).toMatch(
      /todavía no ha llegado/,
    );
  });
});

describe("noIndexReason", () => {
  it("blames the unit, or the missing overlap", () => {
    expect(noIndexReason("no_records_in_kilos", 3)).toMatch(
      /no convierte a kilos/,
    );
    expect(noIndexReason(undefined, 3)).toMatch(/al menos 3 días/);
  });
});

describe("unattributedReason", () => {
  it("joins both causes with singular and plural forms", () => {
    expect(unattributedReason(1, 1)).toMatch(
      /^1 pesada no dice .*; 1 nombra más de uno/,
    );
    expect(unattributedReason(2, 3)).toMatch(
      /^2 pesadas no dicen .*; 3 nombran más de uno/,
    );
    expect(unattributedReason(0, 2)).toMatch(/^2 nombran/);
    expect(unattributedReason(4, 0)).toMatch(
      /^4 pesadas no dicen en qué cultivo se recogió\. /,
    );
  });
});
