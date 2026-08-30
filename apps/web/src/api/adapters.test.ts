/**
 * The translation between the server's vocabulary and the interface's.
 *
 * These are the cheapest tests in the repository and among the most useful,
 * because `adapters.ts` is where a whole class of bug now lives: the app no
 * longer reads the server's fields directly, so a wrong mapping here is
 * invisible everywhere else until a number is wrong on a payslip.
 *
 * Three of the cases below are regressions of things that were actually broken
 * against the real API and are marked as such.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_REFS,
  cropLabel,
  day,
  dayOrNull,
  payModeFromWire,
  payModeToWire,
  quantityFromWire,
  quantityToWire,
  rateSourceFromWire,
  rateSourceToWire,
  roleFromWire,
  roleToWire,
  toActivity,
  toBalance,
  toLedgerEntry,
  toPayables,
  toPlot,
  toWorkRecord,
  toWorker,
  type Refs,
} from "./adapters";
import type {
  WireActivity,
  WireEmployee,
  WirePayables,
  WirePlot,
  WireWorkerPublic,
  WireWorkRecord,
} from "./wire";

/* ------------------------------------------------------------------ */

describe("dates arrive as instants and are business days", () => {
  it("slices rather than parses", () => {
    // REGRESSION. A Postgres `date` reaches us as midnight UTC. Parsing it
    // into a Date and formatting it back moves it a day earlier for everybody
    // west of Greenwich — which is every user this product has — and books an
    // evening's coffee into the wrong week.
    expect(day("2026-08-27T00:00:00Z")).toBe("2026-08-27");
    expect(day("2026-01-01T00:00:00Z")).toBe("2026-01-01");
  });

  it("treats an absent date as absent, not as the epoch", () => {
    expect(day(null)).toBe("");
    expect(dayOrNull(null)).toBeNull();
    expect(dayOrNull(undefined)).toBeNull();
  });
});

describe("quantities", () => {
  it("accepts the number the server sends and the string it might", () => {
    // `json.Number` marshals as a bare JSON literal, so this arrives as a
    // number; the string form is tolerated because the column is text.
    expect(quantityFromWire(38.5)).toBe(38.5);
    expect(quantityFromWire("38.5")).toBe(38.5);
    expect(quantityFromWire("38.50")).toBe(38.5);
    expect(quantityFromWire(null)).toBe(0);
    expect(quantityFromWire("")).toBe(0);
  });

  it("goes back as a NUMBER, not a string", () => {
    // REGRESSION. The Go request struct types quantity as `json.Number` and
    // decodes with UseNumber(); unmarshalling a quoted string into one is an
    // error, which surfaces as a 400 "malformed request body" naming no field.
    expect(typeof quantityToWire(38.5)).toBe("number");
    expect(quantityToWire(38.5)).toBe(38.5);
  });

  it("does not send a float's noise to be stored", () => {
    // 0.1 + 0.2 stringifies as 0.30000000000000004, and the quantity is one of
    // the two factors in round(quantity x rate).
    expect(quantityToWire(0.1 + 0.2)).toBe(0.3);
    expect(quantityToWire(Number.NaN)).toBe(0);
  });
});

describe("enums", () => {
  it("renames the role in both directions", () => {
    expect(roleFromWire("admin")).toBe("administrator");
    expect(roleToWire("administrator")).toBe("admin");
    // The other two are spelled the same on both sides.
    expect(roleFromWire("owner")).toBe("owner");
    expect(roleToWire("weigher")).toBe("weigher");
  });

  it("translates the Spanish pay schemes", () => {
    expect(payModeFromWire("unidad_trabajo")).toBe("work_unit");
    expect(payModeFromWire("contrato")).toBe("contract");
    expect(payModeFromWire("tiempo")).toBe("time_unit");
    expect(payModeToWire("work_unit")).toBe("unidad_trabajo");
    expect(payModeToWire("contract")).toBe("contrato");
  });

  it("collapses the two frozen rate sources and keeps the open one", () => {
    // The distinction the user needs is "is this figure final or provisional",
    // not where a final number came from.
    expect(rateSourceFromWire("explicit")).toBe("fixed");
    expect(rateSourceFromWire("activity_dated")).toBe("fixed");
    expect(rateSourceFromWire("weekly_price")).toBe("weekly_price");
    // Going back, "fixed" means the activity's dated rate: `explicit` belongs
    // to a work record, and the server rejects it on an activity.
    expect(rateSourceToWire("fixed")).toBe("activity_dated");
    expect(rateSourceToWire("weekly_price")).toBe("weekly_price");
  });
});

/* ------------------------------------------------------------------ */

const employee: WireEmployee = {
  id: "w1",
  name: "María",
  lastName: "Restrepo",
  documentType: "CC",
  docId: "1053812345",
  tag: "12",
  phone: "3001112233",
  address: "Vereda El Alto",
  city: null,
  municipality: "Chinchiná",
  country: "Colombia",
  photoId: "photo-1",
  createdAt: "2026-01-05T00:00:00Z",
  deletedAt: null,
};

describe("workers", () => {
  it("renames the document and derives the status from the tombstone", () => {
    const w = toWorker(employee);
    expect(w.documentNumber).toBe("1053812345");
    expect(w.status).toBe("active");
    expect(toWorker({ ...employee, deletedAt: "2026-05-01T00:00:00Z" }).status).toBe(
      "inactive",
    );
  });

  it("falls back to the municipality when there is no city", () => {
    expect(toWorker(employee).city).toBe("Chinchiná");
  });

  it("does not invent a photo URL out of a media id", () => {
    // `photoId` points into a store that does not exist. Building a URL from
    // it would produce a broken image where an initial belongs.
    expect(toWorker(employee).photoUrl).toBeNull();
  });

  it("reads the weigher's four-field projection as a different response", () => {
    const narrow: WireWorkerPublic = { id: "w1", name: "María", lastName: null, tag: "12" };
    const w = toWorker(narrow);
    expect(w.name).toBe("María");
    // Everything withheld comes back empty rather than undefined, so one table
    // renders both shapes and the SERVER stays the thing that decides.
    expect(w.documentNumber).toBe("");
    expect(w.phone).toBeNull();
    expect(w.lastName).toBe("");
  });
});

describe("balances", () => {
  it("keeps the day a day", () => {
    const b = toBalance({
      workerId: "w1",
      earnedCents: 5_080_000,
      paidCents: 3_000_000,
      deductedCents: 0,
      balanceCents: 2_080_000,
      lastMovementOn: "2026-08-27T00:00:00Z",
      active: true,
    });
    expect(b.balanceCents).toBe(2_080_000);
    expect(b.lastMovementOn).toBe("2026-08-27");
  });
});

describe("the ledger has no concept column", () => {
  const base = {
    id: "l1",
    workerId: "w1",
    amountCents: -3_000_000,
    date: "2026-08-27T00:00:00Z",
    settlementId: null,
    method: "efectivo" as const,
    reversesId: null,
    createdAt: "2026-08-27T10:00:00Z",
  };

  it("prefers what somebody typed about this movement", () => {
    expect(toLedgerEntry({ ...base, kind: "pago", note: "Abono en efectivo" }).concept).toBe(
      "Abono en efectivo",
    );
  });

  it("names the kind when there is no note", () => {
    expect(toLedgerEntry({ ...base, kind: "pago", note: null }).concept).toBe("Pago");
    expect(toLedgerEntry({ ...base, kind: "devengo", note: "  " }).concept).toBe(
      "Liquidación de labores",
    );
  });

  it("keeps the sign the ledger stores", () => {
    expect(toLedgerEntry({ ...base, kind: "pago", note: null }).amountCents).toBe(-3_000_000);
  });

  it("does not invent a receipt number", () => {
    expect(toLedgerEntry({ ...base, kind: "pago", note: null }).receiptNumber).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

const plot: WirePlot = {
  id: "p1",
  name: "El Alto",
  areaHa: 4.2,
  computedAreaHa: 5.71,
  department: "Caldas",
  municipality: "Chinchiná",
  location: null,
  boundary: { type: "Polygon", coordinates: [] },
  createdAt: "2026-01-01T00:00:00Z",
  deletedAt: null,
  crops: [
    {
      id: "c1",
      plotId: "p1",
      cropTypeId: "ct1",
      cropType: "Café",
      varietyId: "v1",
      variety: "Castillo",
      areaHa: 4.2,
      plantedOn: "2023-03-01T00:00:00Z",
      removedOn: null,
      deletedAt: null,
    },
    // A crop taken out is still in the payload; the list must not show it.
    {
      id: "c2",
      plotId: "p1",
      cropTypeId: "ct2",
      cropType: "Plátano",
      varietyId: null,
      variety: null,
      areaHa: 0.5,
      plantedOn: null,
      removedOn: "2026-02-01T00:00:00Z",
      deletedAt: "2026-02-01T00:00:00Z",
    },
  ],
};

describe("plots", () => {
  it("keeps both hectare figures", () => {
    const p = toPlot(plot);
    expect(p.areaHa).toBe(4.2);
    expect(p.computedAreaHa).toBe(5.71);
  });

  it("passes the geometry through untouched", () => {
    expect(toPlot(plot).boundary).toEqual({ type: "Polygon", coordinates: [] });
  });

  it("drops the crops that were taken out", () => {
    const p = toPlot(plot);
    expect(p.crops).toHaveLength(1);
    expect(p.crops[0].cropTypeName).toBe("Café");
    expect(p.crops[0].varietyName).toBe("Castillo");
    expect(p.crops[0].plantedAt).toBe("2023-03-01");
  });

  it("labels a crop with its variety when it has one", () => {
    expect(cropLabel(plot.crops[0])).toBe("Café · Castillo");
    expect(cropLabel(plot.crops[1])).toBe("Plátano");
  });
});

/* ------------------------------------------------------------------ */

const refs: Refs = {
  workers: new Map([["w1", "María Restrepo"]]),
  activities: new Map([
    ["a1", { name: "Recolección de café", category: "cosecha", payMode: "work_unit" }],
  ]),
  units: new Map([["u1", "kg"]]),
  plots: new Map([["p1", "El Alto"]]),
  crops: new Map([["c1", "Café · Castillo"]]),
};

const record: WireWorkRecord = {
  estimatedAmountCents: 3_080_000,
  amountIsEstimate: false,
  id: "r1",
  workerId: "w1",
  activityId: "a1",
  payScheme: "unidad_trabajo",
  rateSource: "activity_dated",
  startedAt: "2026-08-27T05:00:00Z",
  endedAt: null,
  dateFrom: "2026-08-27T00:00:00Z",
  dateTo: "2026-08-27T00:00:00Z",
  weekStart: "2026-08-24T00:00:00Z",
  quantity: 38.5,
  unitId: "u1",
  rateCents: 80_000,
  amountCents: 3_080_000,
  note: null,
  createdBy: "u-owner",
  createdAt: "2026-08-27T18:00:00Z",
  deletedAt: null,
  plotIds: ["p1"],
  plotCropIds: ["c1"],
  settled: false,
};

describe("work records are joined client-side", () => {
  it("resolves every name the server did not send", () => {
    const r = toWorkRecord(record, refs);
    expect(r.workerName).toBe("María Restrepo");
    expect(r.activityName).toBe("Recolección de café");
    expect(r.category).toBe("cosecha");
    expect(r.unitLabel).toBe("kg");
    expect(r.plotNames).toEqual(["El Alto"]);
    expect(r.plotCropNames).toEqual(["Café · Castillo"]);
    expect(r.payMode).toBe("work_unit");
    expect(r.quantity).toBe(38.5);
    expect(r.estimatedAmountCents).toBe(3_080_000);
  });

  it("shows a dash, not a blank, for an id it cannot resolve", () => {
    // A blank in the Lotes column reads as "no plot", which is a different and
    // comfortable fact. A dash reads as "the name is missing", which is true.
    const r = toWorkRecord(record, EMPTY_REFS);
    expect(r.workerName).toBe("—");
    expect(r.activityName).toBe("—");
    expect(r.plotNames).toEqual(["—"]);
    expect(r.unitLabel).toBeNull();
  });

  it("carries what unfrozen work is worth, and marks it an estimate", () => {
    // This used to assert zero, which is how every harvest record in the
    // console came to read $0 — settled ones included. A price the week has
    // not frozen yet is still a price: the server applies the week's rate and
    // sends what a settlement would post today.
    const open = toWorkRecord(
      {
        ...record,
        rateSource: "weekly_price",
        rateCents: null,
        amountCents: null,
        estimatedAmountCents: 3_080_000,
        amountIsEstimate: true,
      },
      refs,
    );
    expect(open.rateCents).toBeNull();
    expect(open.estimatedAmountCents).toBe(3_080_000);
    expect(open.amountIsEstimate).toBe(true);
  });

  it("stops calling the amount an estimate once a settlement froze it", () => {
    const settled = toWorkRecord(
      { ...record, estimatedAmountCents: 3_080_000, amountIsEstimate: false },
      refs,
    );
    expect(settled.amountIsEstimate).toBe(false);
  });

  it("carries a withheld amount as null, and never as zero or final", () => {
    // What the weigher's record looks like on the wire: the four money keys
    // are absent, not null. The old adapter read them through `?? 0` and
    // `?? r.rateCents === null`, which turned "you may not see this" into
    // "$0, and that is final" — a number the farm would read as a weighing
    // worth nothing. There is no render site that can reach it today, because
    // every one of them sits behind `can("money.read")`; this is the assertion
    // that keeps that from being the only thing between the console and it.
    const {
      rateCents: _rate,
      amountCents: _amount,
      estimatedAmountCents: _estimated,
      amountIsEstimate: _isEstimate,
      ...withheld
    } = { ...record, rateSource: "weekly_price" as const };

    const r = toWorkRecord(withheld, refs);
    expect(r.estimatedAmountCents).toBeNull();
    expect(r.amountIsEstimate).toBeNull();
    expect(r.rateCents).toBeNull();
    // The rest of the row survives: he still sees whom he weighed and how much.
    expect(r.quantity).toBe(38.5);
    expect(r.workerName).toBe("María Restrepo");
    expect(r.settled).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("activities", () => {
  const activity: WireActivity = {
    id: "a1",
    name: "Recolección de café",
    categoryId: "cat1",
    category: "cosecha",
    payScheme: "unidad_trabajo",
    rateSource: "activity_dated",
    unitId: "u1",
    archivedAt: null,
    rate: {
      validFrom: "2026-01-01T00:00:00Z",
      rateCents: 80_000,
      timeUnit: null,
      customQty: null,
      customUnit: null,
    },
  };

  it("resolves the unit and reads the rate off the rate", () => {
    const a = toActivity(activity, refs);
    expect(a.workUnit).toBe("kg");
    expect(a.defaultRateCents).toBe(80_000);
    expect(a.payMode).toBe("work_unit");
    expect(a.rateSource).toBe("fixed");
    expect(a.status).toBe("active");
  });

  it("leaves the rate UNDEFINED when there is none, never zero", () => {
    // This is the weigher's projection: the `rate` key is absent entirely. A
    // zero would render as "$0", which is a claim about the price rather than
    // an absence of one.
    const { rate: _drop, ...withheld } = activity;
    const a = toActivity(withheld as WireActivity, refs);
    expect(a.defaultRateCents).toBeUndefined();
  });

  it("derives the status from archivedAt", () => {
    expect(toActivity({ ...activity, archivedAt: "2026-06-01T00:00:00Z" }, refs).status).toBe(
      "inactive",
    );
  });
});

/* ------------------------------------------------------------------ */

describe("payables", () => {
  const payables: WirePayables = {
    workerId: "w1",
    tasks: [
      {
        payableId: "r1",
        activityId: "a1",
        activity: "Recolección de café",
        payScheme: "unidad_trabajo",
        rateSource: "activity_dated",
        quantity: 38.5,
        unitId: "u1",
        date: "2026-08-27T00:00:00Z",
        weekStart: "2026-08-24T00:00:00Z",
        rateCents: 80_000,
        amountCents: 3_080_000,
        voided: false,
      },
    ],
    debts: [
      {
        id: "l9",
        workerId: "w1",
        kind: "anticipo",
        amountCents: -900_000,
        date: "2026-08-20T00:00:00Z",
        settlementId: null,
        method: "efectivo",
        note: "Anticipo del lunes",
        reversesId: null,
        createdAt: "2026-08-20T12:00:00Z",
      },
    ],
    balance: {
      workerId: "w1",
      earnedCents: 0,
      paidCents: 0,
      deductedCents: 0,
      balanceCents: -900_000,
      lastMovementOn: "2026-08-20T00:00:00Z",
      active: true,
    },
    grossCents: 3_080_000,
    balanceCents: -900_000,
    totalCents: 2_180_000,
  };

  it("uses the server's arithmetic and does not redo it", () => {
    // The debt is ALREADY inside balanceCents. Subtracting it again here would
    // charge the worker twice for the same advance — the exact bug a derived
    // balance exists to prevent, arrived at by being helpful.
    const p = toPayables(payables, refs);
    expect(p.grossCents).toBe(3_080_000);
    expect(p.balanceCents).toBe(-900_000);
    expect(p.totalCents).toBe(2_180_000);
    expect(p.totalCents).toBe(p.balanceCents + p.grossCents);
  });

  it("shows the debts, with the words somebody wrote", () => {
    const p = toPayables(payables, refs);
    expect(p.debts).toHaveLength(1);
    expect(p.debts[0].concept).toBe("Anticipo del lunes");
    expect(p.debts[0].amountCents).toBe(-900_000);
  });

  it("carries the unit label onto the pending line", () => {
    const p = toPayables(payables, refs);
    expect(p.workRecords[0].unitLabel).toBe("kg");
    expect(p.workRecords[0].dateFrom).toBe("2026-08-27");
    expect(p.workRecords[0].amountCents).toBe(3_080_000);
  });
});
