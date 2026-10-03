// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { cellKey, cellsFromRecords, plannedWrites } from "./planilla";
import type { WorkRecord, Worker } from "../../api/types";

const maria: Worker = {
  id: "w-maria", name: "María", lastName: "Restrepo", documentType: "CC",
  documentNumber: "1", tag: "12", phone: null, address: null, city: null,
  country: "CO", photoUrl: null, startedAt: null, status: "active",
};

const record = (over: Partial<WorkRecord>): WorkRecord => ({
  id: "r1", workerId: maria.id, workerName: "María Restrepo", activityId: "a1",
  activityName: "Recoleccion", category: "cosecha", payMode: "work_unit", unitLabel: "kg",
  plotIds: ["p1"], plotNames: ["El Alto"], plotCropIds: ["c1"], plotCropNames: ["Café"],
  dateFrom: "2026-08-26", dateTo: "2026-08-26", quantity: 41, rateCents: null,
  estimatedAmountCents: 3280000, amountIsEstimate: true, note: null, settled: false,
  status: "active", ...over,
});

const day = "2026-08-26";

describe("cellsFromRecords", () => {
  it("skips voided records and records outside the grid", () => {
    const cells = cellsFromRecords([maria], [day], [
      record({ id: "gone", status: "inactive" }),
      record({ id: "other", workerId: "w-nobody" }),
      record({ id: "late", dateFrom: "2026-08-30" }),
    ]);
    expect(cells[cellKey(maria.id, day)]).toEqual({ text: "", recordId: null, settled: false, original: "" });
  });

  it("adds a second weighing to a first whose text does not parse as a number", () => {
    const cells = cellsFromRecords([maria], [day], [
      record({ id: "a", quantity: 1e21 }),
      record({ id: "b", quantity: 5 }),
    ]);
    const cell = cells[cellKey(maria.id, day)];
    expect(cell.text).toBe("5");
    expect(cell.records).toBe(2);
  });

  it("counts a third weighing on a cell already built from two", () => {
    const cells = cellsFromRecords([maria], [day], [
      record({ id: "a", quantity: 1 }),
      record({ id: "b", quantity: 2 }),
      record({ id: "c", quantity: 3 }),
    ]);
    expect(cells[cellKey(maria.id, day)].records).toBe(3);
    expect(cells[cellKey(maria.id, day)].text).toBe("6");
  });
});

describe("plannedWrites", () => {
  it("writes nothing for a missing cell or a blanked cell with no record", () => {
    expect(plannedWrites([maria], [day], {}, day)).toEqual({ writes: [], errors: [] });
    const cells = { [cellKey(maria.id, day)]: { text: "", recordId: null, settled: false, original: "4" } };
    expect(plannedWrites([maria], [day], cells, day)).toEqual({ writes: [], errors: [] });
  });
});
