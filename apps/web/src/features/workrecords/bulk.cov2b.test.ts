// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { filterWorkers } from "./bulk";
import type { Worker } from "../../api/types";

const person = (id: string, name: string, tag: string | null): Worker => ({
  id, name, lastName: "", documentType: "CC", documentNumber: id, tag,
  phone: null, address: null, city: null, country: "CO", photoUrl: null,
  startedAt: null, status: "active",
});

describe("filterWorkers by basket number", () => {
  it("puts a worker whose number does not match, or who has none, after the exact match", () => {
    const noTag = person("a", "Lote 4", null);
    const otherTag = person("b", "Grupo 4", "12");
    const exact = person("c", "Ana", "4");
    expect(filterWorkers([noTag, otherTag, exact], "4").map((w) => w.id)).toEqual(["c", "a", "b"]);
  });
});
