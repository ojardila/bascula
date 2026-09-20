import { describe, expect, it } from "vitest";
import {
  cellKey, cellsFromRecords, daysOfWeek, emptyCell, formatKg, plannedWrites,
  workerLabel, type SheetCell,
} from "./planilla";
import type { WorkRecord, Worker } from "../../api/types";

const maria: Worker = {
  id: "w-maria",
  name: "María",
  lastName: "Restrepo",
  documentType: "CC",
  documentNumber: "1",
  tag: "12",
  phone: null,
  address: null,
  city: null,
  country: "CO",
  photoUrl: null,
  startedAt: null,
  status: "active",
};

const record = (over: Partial<WorkRecord>): WorkRecord => ({
  id: "r1",
  workerId: maria.id,
  workerName: "María Restrepo",
  activityId: "a1",
  activityName: "Recoleccion",
  category: "cosecha",
  payMode: "work_unit",
  unitLabel: "kg",
  plotIds: ["p1"],
  plotNames: ["El Alto"],
  plotCropIds: ["c1"],
  plotCropNames: ["Café"],
  dateFrom: "2026-08-26",
  dateTo: "2026-08-26",
  quantity: 41,
  rateCents: null,
  estimatedAmountCents: 3280000,
  amountIsEstimate: true,
  note: null,
  settled: false,
  status: "active",
  ...over,
});

describe("daysOfWeek", () => {
  it("returns Monday through Sunday of that week", () => {
    expect(daysOfWeek("2026-08-24")).toEqual([
      "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27",
      "2026-08-28", "2026-08-29", "2026-08-30",
    ]);
  });
});

describe("cellsFromRecords", () => {
  it("puts an existing weighing in its cell and leaves the rest blank", () => {
    const days = daysOfWeek("2026-08-24");
    const cells = cellsFromRecords([maria], days, [record({})]);
    expect(cells[cellKey(maria.id, "2026-08-26")].text).toBe("41");
    expect(cells[cellKey(maria.id, "2026-08-26")].recordId).toBe("r1");
    expect(cells[cellKey(maria.id, "2026-08-24")].text).toBe("");
  });

  it("writes a decimal with a comma, the way the form types it", () => {
    expect(formatKg(38.5)).toBe("38,5");
  });
});

describe("plannedWrites", () => {
  const days = daysOfWeek("2026-08-24");
  const today = "2026-09-20";

  function sheet(over: Record<string, Partial<SheetCell>>): Record<string, SheetCell> {
    const cells = cellsFromRecords([maria], days, [record({})]);
    for (const [k, v] of Object.entries(over)) {
      cells[k] = { ...(cells[k] ?? emptyCell()), ...v };
    }
    return cells;
  }

  it("creates a cell that was blank and now has kilos", () => {
    const { writes, errors } = plannedWrites(
      [maria],
      days,
      sheet({ [cellKey(maria.id, "2026-08-24")]: { text: "40" } }),
      today,
    );
    expect(errors).toEqual([]);
    expect(writes).toEqual([
      { kind: "create", workerId: maria.id, day: "2026-08-24", quantity: 40 },
    ]);
  });

  it("updates a cell whose quantity changed", () => {
    const { writes } = plannedWrites(
      [maria],
      days,
      sheet({ [cellKey(maria.id, "2026-08-26")]: { text: "50", recordId: "r1", original: "41" } }),
      today,
    );
    expect(writes).toEqual([{ kind: "update", recordId: "r1", quantity: 50 }]);
  });

  it("removes a cell that was cleared", () => {
    const { writes } = plannedWrites(
      [maria],
      days,
      sheet({ [cellKey(maria.id, "2026-08-26")]: { text: "", recordId: "r1", original: "41" } }),
      today,
    );
    expect(writes).toEqual([{ kind: "remove", recordId: "r1" }]);
  });

  it("does not touch a settled cell even if the text was edited", () => {
    const { writes } = plannedWrites(
      [maria],
      days,
      sheet({
        [cellKey(maria.id, "2026-08-26")]: {
          text: "99", recordId: "r1", original: "41", settled: true,
        },
      }),
      today,
    );
    expect(writes).toEqual([]);
  });

  it("skips days after today", () => {
    const { writes } = plannedWrites(
      [maria],
      ["2026-09-21"],
      { [cellKey(maria.id, "2026-09-21")]: { text: "10", recordId: null, settled: false, original: "" } },
      today,
    );
    expect(writes).toEqual([]);
  });
});

describe("workerLabel", () => {
  it("joins given name and last name", () => {
    expect(workerLabel(maria)).toBe("María Restrepo");
  });
});
