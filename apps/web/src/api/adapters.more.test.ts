// SPDX-License-Identifier: MIT
/**
 * The adapters' fallbacks: what each one turns a missing, empty or unknown
 * field into. Every `??` here is a decision about what an absence means, and
 * these pin the ones the first file leaves unchecked.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_REFS,
  payModeToWire,
  quantityFromWire,
  toActivity,
  toBalance,
  toCustomer,
  toFarmUser,
  toLabelBatch,
  toLedgerEntry,
  toPayables,
  toPaymentReceipt,
  toPlot,
  toWorkRecord,
  toWorker,
  type Refs,
} from "./adapters";

// The wire types are wide; each case builds only the fields it is about.
const wire = <T>(o: Record<string, unknown>) => o as unknown as T;

describe("numbers and pay modes", () => {
  it("reads an unreadable quantity as zero", () => {
    expect(quantityFromWire("abc")).toBe(0);
    expect(quantityFromWire(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("sends an unknown pay mode as a work unit", () => {
    expect(payModeToWire("nonsense" as never)).toBe("unidad_trabajo");
  });
});

describe("farm users", () => {
  it("turns absent fields into visible absences, never into 'active'", () => {
    const u = toFarmUser(wire({ id: "u1", role: "weigher", createdAt: null }));
    expect(u).toMatchObject({
      email: "",
      name: "",
      status: "unknown",
      createdAt: null,
    });
    expect("lastLoginAt" in u).toBe(false);
    expect(
      toFarmUser(
        wire({ id: "u2", role: "admin", status: "ACTIVE", lastLoginAt: null }),
      ).status,
    ).toBe("active");
  });
});

describe("workers and balances", () => {
  it("fills a team member's missing last name and tag with null", () => {
    const w = toWorker(
      wire({
        id: "w1",
        name: "Cuadrilla",
        kind: "equipo",
        members: [{ id: "m1", name: "Ana" }],
        deletedAt: null,
      }),
    );
    expect(w.kind).toBe("equipo");
    expect(w.members?.[0]).toMatchObject({ lastName: null, tag: null });
    expect(w.team).toBeNull();
  });

  it("counts somebody as on the payroll unless the list says otherwise", () => {
    expect(toBalance(wire({ workerId: "w1", balanceCents: 0 })).active).toBe(
      true,
    );
    expect(
      toBalance(wire({ workerId: "w1", balanceCents: 0, active: false }))
        .active,
    ).toBe(false);
  });
});

describe("the ledger", () => {
  it("names a movement by its note, then its kind, then the raw kind", () => {
    const base = {
      id: "e1",
      workerId: "w1",
      amountCents: 1,
      date: "2026-09-10",
    };
    expect(
      toLedgerEntry(wire({ ...base, kind: "pago", note: "  Sábado  " }))
        .concept,
    ).toBe("Sábado");
    expect(
      toLedgerEntry(wire({ ...base, kind: "pago", note: "   " })).concept,
    ).toBe("Pago");
    expect(toLedgerEntry(wire({ ...base, kind: "rarito" })).concept).toBe(
      "rarito",
    );
  });

  it("a receipt from before the newer fields still renders", () => {
    const r = toPaymentReceipt(
      wire({
        id: "p1",
        workerId: "w1",
        date: "2026-09-10",
        method: "efectivo",
        paidCents: 100,
        previousBalanceCents: 100,
        currentWeekCents: 0,
        deductions: [],
        deductionsCents: 0,
        remainingCents: 0,
        settlementId: "s1",
      }),
    );
    expect(r).toMatchObject({
      currentWeekFrom: null,
      currentWeekTo: null,
      settlementIds: ["s1"],
      reversed: false,
      kind: "pago",
      note: null,
      receivedByName: null,
    });
    const withWeek = toPaymentReceipt(
      wire({
        id: "p2",
        workerId: "w1",
        date: "2026-09-10",
        deductions: [
          { concept: "Anticipo", amountCents: 5, date: "2026-09-08T12:00:00Z" },
        ],
        currentWeekFrom: "2026-09-07",
        currentWeekTo: "2026-09-13",
      }),
    );
    expect(withWeek.currentWeekFrom).toBe("2026-09-07");
    expect(withWeek.currentWeekTo).toBe("2026-09-13");
    expect(withWeek.settlementIds).toEqual([]);
  });

  it("payables with no tasks or debts are empty lists, and a debt keeps its concept", () => {
    expect(
      toPayables(
        wire({ grossCents: 0, balanceCents: 0, totalCents: 0 }),
        EMPTY_REFS,
      ),
    ).toMatchObject({ workRecords: [], debts: [] });
    const p = toPayables(
      wire({
        tasks: [
          {
            payableId: "x1",
            activity: "Guadañada",
            date: "2026-09-10",
            weekStart: "2026-09-07",
            payScheme: "tiempo",
            quantity: "1",
            unitId: "u-missing",
            rateCents: 10,
            rateSource: "activity_dated",
            amountCents: 10,
          },
        ],
        debts: [
          {
            id: "d1",
            workerId: "w1",
            kind: "anticipo",
            amountCents: -5,
            date: "2026-09-09",
          },
        ],
        grossCents: 10,
        balanceCents: 5,
        totalCents: 5,
      }),
      EMPTY_REFS,
    );
    expect(p.workRecords[0]).toMatchObject({ plotNames: [], unitLabel: null });
    expect(p.debts[0].concept).toBe("Anticipo");
  });
});

describe("plots, activities and work records", () => {
  const refs: Refs = { ...EMPTY_REFS, units: new Map([["u1", "kg"]]) };

  it("a plot without crops has none, and deleted crops are dropped", () => {
    expect(toPlot(wire({ id: "p1", name: "El Alto" })).crops).toEqual([]);
    const p = toPlot(
      wire({
        id: "p1",
        name: "El Alto",
        crops: [
          { id: "c1", cropType: "Café", deletedAt: null },
          { id: "c2", cropType: "Plátano", deletedAt: "2026-01-01T00:00:00Z" },
        ],
      }),
    );
    expect(p.crops.map((c) => c.id)).toEqual(["c1"]);
  });

  it("an activity's unit is named only when the refs know it", () => {
    const a = {
      id: "a1",
      name: "Recolección",
      category: "cosecha",
      payScheme: "unidad_trabajo",
      rateSource: "activity_dated",
    };
    expect(toActivity(wire({ ...a, unitId: "u1" }), refs).workUnit).toBe("kg");
    expect(toActivity(wire({ ...a, unitId: "u9" }), refs).workUnit).toBeNull();
  });

  it("a work record with no plots or crops lists none", () => {
    const r = toWorkRecord(
      wire({
        id: "r1",
        workerId: "w1",
        activityId: "a1",
        payScheme: "tiempo",
        dateFrom: "2026-09-10",
        dateTo: "2026-09-10",
        quantity: "1",
      }),
    );
    expect(r).toMatchObject({
      plotIds: [],
      plotCropIds: [],
      plotNames: [],
      workerName: "—",
    });
  });
});

describe("customers and label batches", () => {
  it("a deleted customer is inactive", () => {
    expect(
      toCustomer(wire({ id: "c1", deletedAt: "2026-01-01T00:00:00Z" })).status,
    ).toBe("inactive");
    expect(toCustomer(wire({ id: "c2", deletedAt: null })).status).toBe(
      "active",
    );
  });

  it("a label batch maps every label, and none when there are none", () => {
    const b = toLabelBatch(
      wire({
        id: "b1",
        stockMoveId: "m1",
        count: 1,
        labels: [
          {
            code: "L-1",
            product: "Urea",
            storageUnit: "bulto",
            qty: "2",
            warehouse: "Bodega",
            plot: "El Alto",
            localDay: "2026-09-10",
          },
        ],
      }),
    );
    expect(b.labels[0]).toEqual({
      code: "L-1",
      productName: "Urea",
      storageUnit: "bulto",
      qty: "2",
      warehouseName: "Bodega",
      plotName: "El Alto",
      date: "2026-09-10",
    });
    expect(
      toLabelBatch(wire({ id: "b2", stockMoveId: "m2", count: 0 })).labels,
    ).toEqual([]);
  });
});
